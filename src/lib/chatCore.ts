/**
 * Core Chat State Management
 * Unified XMPP stack with normalized state and optimized updates
 */

import { XmppMessage, XmppConversation, MucRoom, XmppContact } from '@/types/xmpp';
import { EventEmitter } from 'events';

export interface ChatItem {
  id: string;
  type: 'conversation' | 'room';
  jid: string;
  name: string;
  lastMessage?: XmppMessage;
  lastActivity: Date;
  unreadCount: number;
  messages: XmppMessage[];
  isArchived: boolean;
  isMuted: boolean;
  // Room specific
  isOwner?: boolean;
  joined?: boolean;
  occupants?: string[];
  subject?: string;
}

export interface ChatState {
  items: Map<string, ChatItem>;
  contacts: Map<string, XmppContact>;
  selectedItemId: string | null;
  searchTerm: string;
  sortBy: 'newest' | 'a-z' | 'z-a';
  showArchived: boolean;
}

export class ChatCore extends EventEmitter {
  private state: ChatState = {
    items: new Map(),
    contacts: new Map(),
    selectedItemId: null,
    searchTerm: '',
    sortBy: 'newest',
    showArchived: false,
  };

  private messageProcessor: MessageProcessor;
  private updateQueue = new Set<string>();
  private batchUpdateTimer: NodeJS.Timeout | null = null;
  private currentUserJid: string | null = null;

  constructor() {
    super();
    this.messageProcessor = new MessageProcessor();
  }

  setCurrentUserJid(jid: string) {
    this.currentUserJid = jid;
  }

  getCurrentUserJid(): string | null {
    return this.currentUserJid;
  }

  // State getters
  getState(): Readonly<ChatState> {
    return { ...this.state };
  }

  getItem(jid: string): ChatItem | undefined {
    return this.state.items.get(jid);
  }

  getSelectedItem(): ChatItem | undefined {
    if (!this.state.selectedItemId) return undefined;
    return this.state.items.get(this.state.selectedItemId);
  }

  getFilteredItems(): ChatItem[] {
    const items = Array.from(this.state.items.values());
    
    // Filter by search term and archive status
    const filtered = items.filter(item => {
      const matchesSearch = !this.state.searchTerm || 
        item.name.toLowerCase().includes(this.state.searchTerm.toLowerCase()) ||
        item.jid.toLowerCase().includes(this.state.searchTerm.toLowerCase());
      
      const matchesArchive = this.state.showArchived || !item.isArchived;
      
      return matchesSearch && matchesArchive;
    });

    // Sort items
    return this.sortItems(filtered);
  }

  private sortItems(items: ChatItem[]): ChatItem[] {
    switch (this.state.sortBy) {
      case 'newest':
        return items.sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());
      case 'a-z':
        return items.sort((a, b) => a.name.localeCompare(b.name));
      case 'z-a':
        return items.sort((a, b) => b.name.localeCompare(a.name));
      default:
        return items;
    }
  }

  // State mutations
  setSelectedItem(jid: string | null) {
    this.state.selectedItemId = jid;
    this.emit('selectedItemChanged', jid);
  }

  setSearchTerm(term: string) {
    this.state.searchTerm = term;
    this.emit('searchChanged', term);
  }

  setSortBy(sortBy: 'newest' | 'a-z' | 'z-a') {
    this.state.sortBy = sortBy;
    this.emit('sortChanged', sortBy);
  }

  setShowArchived(show: boolean) {
    this.state.showArchived = show;
    this.emit('archiveFilterChanged', show);
  }

  // Data mutations
  upsertConversation(conversation: XmppConversation) {
    const item: ChatItem = {
      id: conversation.jid,
      type: 'conversation',
      jid: conversation.jid,
      name: this.getContactName(conversation.jid) || conversation.jid,
      lastMessage: conversation.messages[conversation.messages.length - 1],
      lastActivity: conversation.lastActivity,
      unreadCount: conversation.unreadCount,
      messages: conversation.messages,
      isArchived: conversation.archived || false,
      isMuted: false, // Default to false until muted property is available
    };

    this.state.items.set(conversation.jid, item);
    this.queueUpdate(conversation.jid);
  }

  upsertRoom(room: MucRoom) {
    const item: ChatItem = {
      id: room.jid,
      type: 'room',
      jid: room.jid,
      name: room.name || room.jid,
      lastMessage: room.messages[room.messages.length - 1],
      lastActivity: room.lastActivity,
      unreadCount: room.unreadCount,
      messages: room.messages,
      isArchived: room.archived || false,
      isMuted: room.isMuted || false,
      isOwner: room.isOwner,
      joined: room.joined,
      occupants: room.occupants?.map(o => o.nick) || [],
      subject: room.subject,
    };

    this.state.items.set(room.jid, item);
    this.queueUpdate(room.jid);
  }

  addMessage(jid: string, message: XmppMessage) {
    const item = this.state.items.get(jid);
    if (!item) return;

    // Use message processor for deduplication and optimization
    const processedMessages = this.messageProcessor.addMessage(item.messages, message);
    
    item.messages = processedMessages;
    item.lastMessage = message;
    item.lastActivity = message.timestamp;
    
    // Update unread count if not from current user
    if (!message.from?.includes(this.getCurrentUserJid() || '') && item.id !== this.state.selectedItemId) {
      item.unreadCount++;
    }

    this.queueUpdate(jid);
  }

  markAsRead(jid: string) {
    const item = this.state.items.get(jid);
    if (!item) return;

    item.unreadCount = 0;
    this.queueUpdate(jid);
  }

  archiveItem(jid: string) {
    const item = this.state.items.get(jid);
    if (!item) return;

    item.isArchived = true;
    this.queueUpdate(jid);
  }

  unarchiveItem(jid: string) {
    const item = this.state.items.get(jid);
    if (!item) return;

    item.isArchived = false;
    this.queueUpdate(jid);
  }

  deleteItem(jid: string): void {
    const item = this.state.items.get(jid);
    if (!item) return;

    this.state.items.delete(jid);
    
    // Emit specific deletion events for persistence
    if (item.type === 'conversation') {
      this.emit('conversationDeleted', { jid });
    } else if (item.type === 'room') {
      this.emit('roomDeleted', { jid });
    }
    
    this.emit('itemDeleted', { jid });
    
    // If deleting selected item, clear selection
    if (this.state.selectedItemId === jid) {
      this.state.selectedItemId = null;
      this.emit('selectedItemChanged', { jid: null });
    }
  }

  updateContact(contact: XmppContact) {
    this.state.contacts.set(contact.jid, contact);
    
    // Update item name if it exists
    const item = this.state.items.get(contact.jid);
    if (item) {
      item.name = contact.name || contact.jid;
      this.queueUpdate(contact.jid);
    }
  }

  private getContactName(jid: string): string | undefined {
    return this.state.contacts.get(jid)?.name;
  }

  private queueUpdate(jid: string) {
    this.updateQueue.add(jid);
    
    if (this.batchUpdateTimer) {
      clearTimeout(this.batchUpdateTimer);
    }

    this.batchUpdateTimer = setTimeout(() => {
      const updatedJids = Array.from(this.updateQueue);
      this.updateQueue.clear();
      this.emit('itemsUpdated', updatedJids);
    }, 16); // ~60fps batching
  }

  // Bulk operations for initial hydration
  hydrateConversations(conversations: XmppConversation[]) {
    conversations.forEach(conv => {
      this.upsertConversation(conv);
    });
  }

  hydrateRooms(rooms: MucRoom[]) {
    rooms.forEach(room => {
      this.upsertRoom(room);
    });
  }

  hydrateContacts(contacts: XmppContact[]) {
    contacts.forEach(contact => {
      this.updateContact(contact);
    });
  }
}

class MessageProcessor {
  private messageCache = new Map<string, XmppMessage>();

  addMessage(existingMessages: XmppMessage[], newMessage: XmppMessage): XmppMessage[] {
    // Generate canonical ID for deduplication
    const canonicalId = this.getCanonicalId(newMessage);
    
    // Check for duplicates
    if (this.messageCache.has(canonicalId)) {
      return existingMessages;
    }

    // Cache the message
    this.messageCache.set(canonicalId, newMessage);

    // Binary search insertion for performance
    const insertIndex = this.findInsertIndex(existingMessages, newMessage);
    const newMessages = [...existingMessages];
    newMessages.splice(insertIndex, 0, newMessage);

    // Maintain cache size
    if (this.messageCache.size > 10000) {
      this.trimCache();
    }

    return newMessages;
  }

  private getCanonicalId(message: XmppMessage): string {
    // Use originId if available, otherwise fallback to id, then generate hash
    if (message.originId) return message.originId;
    if (message.id) return message.id;
    
    // Generate hash from content for deduplication
    return `${message.from}-${message.to}-${message.body}-${message.timestamp.getTime()}`;
  }

  private findInsertIndex(messages: XmppMessage[], newMessage: XmppMessage): number {
    let left = 0;
    let right = messages.length;

    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      if (messages[mid].timestamp.getTime() < newMessage.timestamp.getTime()) {
        left = mid + 1;
      } else {
        right = mid;
      }
    }

    return left;
  }

  private trimCache() {
    // Remove oldest entries to maintain performance
    const entries = Array.from(this.messageCache.entries());
    entries.sort((a, b) => a[1].timestamp.getTime() - b[1].timestamp.getTime());
    
    // Keep newest 8000 messages
    const toKeep = entries.slice(-8000);
    this.messageCache.clear();
    toKeep.forEach(([id, message]) => {
      this.messageCache.set(id, message);
    });
  }
}

// Export singleton instance
export const chatCore = new ChatCore();
