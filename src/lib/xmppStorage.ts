/**
 * XMPP Data Persistence Layer
 * Handles saving/loading conversations and rooms per account
 */

import { Conversation, MucRoom, ChatMessage, RoomMessage } from '@/contexts/XmppContext';

const STORAGE_VERSION = '1.0.0';
const MAX_MESSAGES_PER_CONVERSATION = 100;
const MAX_MESSAGES_PER_ROOM = 100;

interface StoredData {
  version: string;
  accounts: Record<string, AccountData>;
}

interface AccountData {
  conversations: Conversation[];
  rooms: MucRoom[];
  lastSync: string;
}

export class XmppStorage {
  private storageKey = 'xmpp-data';
  private currentAccount: string | null = null;
  private saveTimeout: NodeJS.Timeout | null = null;

  setAccount(bareJid: string) {
    this.currentAccount = bareJid;
  }

  private getStorageData(): StoredData {
    try {
      const stored = localStorage.getItem(this.storageKey);
      if (!stored) {
        return { version: STORAGE_VERSION, accounts: {} };
      }
      
      const data = JSON.parse(stored) as StoredData;
      
      // Version migration (if needed in future)
      if (data.version !== STORAGE_VERSION) {
        console.log('Storage version mismatch, resetting');
        return { version: STORAGE_VERSION, accounts: {} };
      }
      
      return data;
    } catch (error) {
      console.error('Error reading XMPP storage:', error);
      return { version: STORAGE_VERSION, accounts: {} };
    }
  }

  private saveStorageData(data: StoredData) {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(data));
    } catch (error) {
      console.error('Error saving XMPP storage:', error);
    }
  }

  private trimMessages(messages: (ChatMessage | RoomMessage)[], maxCount: number) {
    if (messages.length <= maxCount) return messages;
    
    // Keep most recent messages, but ensure we have both sent and received
    const sorted = [...messages].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    return sorted.slice(0, maxCount);
  }

  saveConversations(conversations: Conversation[]) {
    if (!this.currentAccount) return;
    
    // Debounce saves
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
    
    this.saveTimeout = setTimeout(() => {
      const data = this.getStorageData();
      
      // Trim messages and prepare for storage
      const trimmedConversations = conversations.map(conv => ({
        ...conv,
        messages: this.trimMessages(conv.messages, MAX_MESSAGES_PER_CONVERSATION),
        lastActivity: conv.lastActivity,
      }));
      
      data.accounts[this.currentAccount!] = {
        ...data.accounts[this.currentAccount!],
        conversations: trimmedConversations,
        lastSync: new Date().toISOString(),
      };
      
      this.saveStorageData(data);
    }, 1000);
  }

  saveRooms(rooms: MucRoom[]) {
    if (!this.currentAccount) return;
    
    // Debounce saves
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
    
    this.saveTimeout = setTimeout(() => {
      const data = this.getStorageData();
      
      // Trim messages and prepare for storage
      const trimmedRooms = rooms.map(room => ({
        ...room,
        messages: this.trimMessages(room.messages, MAX_MESSAGES_PER_ROOM),
        lastActivity: room.lastActivity,
      }));
      
      data.accounts[this.currentAccount!] = {
        ...data.accounts[this.currentAccount!],
        rooms: trimmedRooms,
        lastSync: new Date().toISOString(),
      };
      
      this.saveStorageData(data);
    }, 1000);
  }

  loadConversations(): Conversation[] {
    if (!this.currentAccount) return [];
    
    const data = this.getStorageData();
    const accountData = data.accounts[this.currentAccount];
    
    if (!accountData?.conversations) return [];
    
    // Restore Date objects
    return accountData.conversations.map(conv => ({
      ...conv,
      lastActivity: new Date(conv.lastActivity),
      messages: conv.messages.map(msg => ({
        ...msg,
        timestamp: new Date(msg.timestamp),
      })),
    }));
  }

  loadRooms(): MucRoom[] {
    if (!this.currentAccount) return [];
    
    const data = this.getStorageData();
    const accountData = data.accounts[this.currentAccount];
    
    if (!accountData?.rooms) return [];
    
    // Restore Date objects
    return accountData.rooms.map(room => ({
      ...room,
      lastActivity: new Date(room.lastActivity),
      messages: room.messages.map(msg => ({
        ...msg,
        timestamp: new Date(msg.timestamp),
      })),
    }));
  }

  getJoinedRooms(): string[] {
    if (!this.currentAccount) return [];
    
    const rooms = this.loadRooms();
    return rooms.filter(room => room.joined).map(room => room.jid);
  }

  getRecentConversations(): string[] {
    if (!this.currentAccount) return [];
    
    const conversations = this.loadConversations();
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7 days ago
    
    return conversations
      .filter(conv => conv.lastActivity > cutoff)
      .map(conv => conv.jid);
  }

  clearAccount(bareJid?: string) {
    const accountToClear = bareJid || this.currentAccount;
    if (!accountToClear) return;
    
    const data = this.getStorageData();
    delete data.accounts[accountToClear];
    this.saveStorageData(data);
  }

  clearAll() {
    localStorage.removeItem(this.storageKey);
  }
}

// Export singleton instance
export const xmppStorage = new XmppStorage();
