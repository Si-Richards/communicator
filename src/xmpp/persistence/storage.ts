/**
 * XMPP Storage Manager
 * Handles persistence of conversations, contacts, rooms, and other XMPP data
 */

import { XmppEventBus } from '../core/eventBus';
import { XmppUtils } from '../core/utils';
import { logger } from '@/lib/logger';

interface StorageData {
  version: string;
  accounts: Record<string, AccountData>;
}

interface AccountData {
  contacts: any[];
  conversations: any[];
  rooms: any[];
  bookmarks: any[];
  settings: any;
  lastSync: string;
  deletedConversations?: string[];
  deletedRooms?: string[];
}

export class StorageManager {
  private eventBus: XmppEventBus;
  private currentAccount: string | null = null;
  private readonly storageKey = 'xmpp_data';
  private readonly version = '1.0';
  private readonly maxMessages = 50; // Keep last 50 messages per conversation
  private debounceTimeout: NodeJS.Timeout | null = null;

  constructor(eventBus: XmppEventBus) {
    this.eventBus = eventBus;
    this.setupEventHandlers();
  }

  setAccount(bareJid: string): void {
    this.currentAccount = bareJid;
    this.ensureAccountExists();
  }

  async loadPersistedData(): Promise<void> {
    if (!this.currentAccount) return;

    try {
      const data = this.getStorageData();
      const accountData = data.accounts[this.currentAccount];
      
      if (accountData) {
        // Emit events to restore data
        if (accountData.contacts.length > 0) {
          this.eventBus.emit('storage:contactsLoaded', { 
            contacts: this.deserializeDates(accountData.contacts)
          });
        }
        
        if (accountData.conversations.length > 0) {
          this.eventBus.emit('storage:conversationsLoaded', { 
            conversations: this.deserializeDates(accountData.conversations)
          });
        }
        
        if (accountData.rooms.length > 0) {
          this.eventBus.emit('storage:roomsLoaded', { 
            rooms: this.deserializeDates(accountData.rooms)
          });
        }
        
        if (accountData.bookmarks.length > 0) {
          this.eventBus.emit('storage:bookmarksLoaded', { 
            bookmarks: accountData.bookmarks
          });
        }
        
        logger.info('Persisted data loaded for account:', this.currentAccount);
      }
    } catch (error) {
      logger.error('Error loading persisted data:', error);
    }
  }

  saveContacts(contacts: any[]): void {
    this.debouncedSave(() => {
      const data = this.getStorageData();
      if (this.currentAccount) {
        data.accounts[this.currentAccount].contacts = this.serializeDates(contacts);
        data.accounts[this.currentAccount].lastSync = new Date().toISOString();
        this.setStorageData(data);
      }
    });
  }

  saveConversations(conversations: any[]): void {
    this.debouncedSave(() => {
      const data = this.getStorageData();
      if (this.currentAccount) {
        // Trim messages to prevent storage bloat
        const trimmedConversations = conversations.map(conv => ({
          ...conv,
          messages: (conv.messages || []).slice(-this.maxMessages)
        }));
        
        data.accounts[this.currentAccount].conversations = this.serializeDates(trimmedConversations);
        data.accounts[this.currentAccount].lastSync = new Date().toISOString();
        this.setStorageData(data);
      }
    });
  }

  saveRooms(rooms: any[]): void {
    this.debouncedSave(() => {
      const data = this.getStorageData();
      if (this.currentAccount) {
        // Trim messages to prevent storage bloat
        const trimmedRooms = rooms.map(room => ({
          ...room,
          messages: (room.messages || []).slice(-this.maxMessages)
        }));
        
        data.accounts[this.currentAccount].rooms = this.serializeDates(trimmedRooms);
        data.accounts[this.currentAccount].lastSync = new Date().toISOString();
        this.setStorageData(data);
      }
    });
  }

  saveBookmarks(bookmarks: any[]): void {
    this.debouncedSave(() => {
      const data = this.getStorageData();
      if (this.currentAccount) {
        data.accounts[this.currentAccount].bookmarks = bookmarks;
        data.accounts[this.currentAccount].lastSync = new Date().toISOString();
        this.setStorageData(data);
      }
    });
  }

  saveSettings(settings: any): void {
    this.debouncedSave(() => {
      const data = this.getStorageData();
      if (this.currentAccount) {
        data.accounts[this.currentAccount].settings = settings;
        data.accounts[this.currentAccount].lastSync = new Date().toISOString();
        this.setStorageData(data);
      }
    });
  }

  getJoinedRooms(): string[] {
    if (!this.currentAccount) return [];
    
    try {
      const data = this.getStorageData();
      const accountData = data.accounts[this.currentAccount];
      
      if (accountData && accountData.rooms) {
        return accountData.rooms
          .filter((room: any) => room.joined)
          .map((room: any) => room.jid);
      }
    } catch (error) {
      logger.error('Error getting joined rooms:', error);
    }
    
    return [];
  }

  getRecentConversations(days = 7): string[] {
    if (!this.currentAccount) return [];
    
    try {
      const data = this.getStorageData();
      const accountData = data.accounts[this.currentAccount];
      
      if (accountData && accountData.conversations) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);
        
        return accountData.conversations
          .filter((conv: any) => {
            const lastActivity = new Date(conv.lastActivity);
            return lastActivity > cutoff;
          })
          .map((conv: any) => conv.jid);
      }
    } catch (error) {
      logger.error('Error getting recent conversations:', error);
    }
    
    return [];
  }

  clearAccount(bareJid?: string): void {
    const targetAccount = bareJid || this.currentAccount;
    if (!targetAccount) return;
    
    try {
      const data = this.getStorageData();
      delete data.accounts[targetAccount];
      this.setStorageData(data);
      
      logger.info('Cleared storage for account:', targetAccount);
    } catch (error) {
      logger.error('Error clearing account data:', error);
    }
  }

  clearAll(): void {
    try {
      localStorage.removeItem(this.storageKey);
      logger.info('Cleared all XMPP storage');
    } catch (error) {
      logger.error('Error clearing all storage:', error);
    }
  }

  deleteConversation(jid: string): void {
    if (!this.currentAccount) return;
    
    const data = this.getStorageData();
    const accountData = data.accounts[this.currentAccount];
    
    if (accountData) {
      // Remove from conversations
      accountData.conversations = accountData.conversations.filter(
        (c: any) => c.jid !== jid
      );
      
      // Add to deleted list
      if (!accountData.deletedConversations) {
        accountData.deletedConversations = [];
      }
      if (!accountData.deletedConversations.includes(jid)) {
        accountData.deletedConversations.push(jid);
      }
      
      this.setStorageData(data);
    }
  }
  
  deleteRoom(jid: string): void {
    if (!this.currentAccount) return;
    
    const data = this.getStorageData();
    const accountData = data.accounts[this.currentAccount];
    
    if (accountData) {
      // Remove from rooms
      accountData.rooms = accountData.rooms.filter(
        (r: any) => r.jid !== jid
      );
      
      // Add to deleted list
      if (!accountData.deletedRooms) {
        accountData.deletedRooms = [];
      }
      if (!accountData.deletedRooms.includes(jid)) {
        accountData.deletedRooms.push(jid);
      }
      
      this.setStorageData(data);
    }
  }
  
  getDeletedConversations(): string[] {
    if (!this.currentAccount) return [];
    
    const data = this.getStorageData();
    const accountData = data.accounts[this.currentAccount];
    return accountData?.deletedConversations || [];
  }
  
  getDeletedRooms(): string[] {
    if (!this.currentAccount) return [];
    
    const data = this.getStorageData();
    const accountData = data.accounts[this.currentAccount];
    return accountData?.deletedRooms || [];
  }

  private setupEventHandlers(): void {
    // Listen for data changes and save automatically
    this.eventBus.on('roster:updated', ({ contacts }) => {
      this.saveContacts(contacts);
    });
    
    this.eventBus.on('conversations:updated', ({ conversations }) => {
      this.saveConversations(conversations);
    });
    
    this.eventBus.on('rooms:updated', ({ rooms }) => {
      this.saveRooms(rooms);
    });
    
    // Handle deletions
    this.eventBus.on('conversationDeleted', ({ jid }) => {
      this.deleteConversation(jid);
    });
    
    this.eventBus.on('roomDeleted', ({ jid }) => {
      this.deleteRoom(jid);
    });
    
    this.eventBus.on('room:bookmarked', ({ room }) => {
      // Load current bookmarks and add new one
      const data = this.getStorageData();
      if (this.currentAccount) {
        const bookmarks = data.accounts[this.currentAccount].bookmarks || [];
        const existing = bookmarks.find((b: any) => b.jid === room.jid);
        
        if (!existing) {
          bookmarks.push({
            jid: room.jid,
            name: room.name,
            nick: room.nick,
            timestamp: new Date().toISOString()
          });
          this.saveBookmarks(bookmarks);
        }
      }
    });
    
    this.eventBus.on('room:bookmarkRemoved', ({ room }) => {
      // Load current bookmarks and remove
      const data = this.getStorageData();
      if (this.currentAccount) {
        const bookmarks = data.accounts[this.currentAccount].bookmarks || [];
        const filtered = bookmarks.filter((b: any) => b.jid !== room.jid);
        this.saveBookmarks(filtered);
      }
    });
  }

  private getStorageData(): StorageData {
    try {
      const stored = localStorage.getItem(this.storageKey);
      if (stored) {
        const data = JSON.parse(stored);
        // Ensure version compatibility
        if (data.version === this.version) {
          return data;
        }
      }
    } catch (error) {
      logger.error('Error reading storage data:', error);
    }
    
    // Return default structure
    return {
      version: this.version,
      accounts: {}
    };
  }

  private setStorageData(data: StorageData): void {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(data));
    } catch (error) {
      logger.error('Error saving storage data:', error);
      
      // Handle storage quota exceeded
      if (error instanceof Error && error.name === 'QuotaExceededError') {
        this.handleStorageQuotaExceeded();
      }
    }
  }

  private ensureAccountExists(): void {
    if (!this.currentAccount) return;
    
    const data = this.getStorageData();
    if (!data.accounts[this.currentAccount]) {
      data.accounts[this.currentAccount] = {
        contacts: [],
        conversations: [],
        rooms: [],
        bookmarks: [],
        settings: {},
        lastSync: new Date().toISOString()
      };
      this.setStorageData(data);
    }
  }

  private serializeDates(obj: any): any {
    return JSON.parse(JSON.stringify(obj, (key, value) => {
      if (value instanceof Date) {
        return { __type: 'Date', value: value.toISOString() };
      }
      return value;
    }));
  }

  private deserializeDates(obj: any): any {
    return JSON.parse(JSON.stringify(obj), (key, value) => {
      if (value && typeof value === 'object' && value.__type === 'Date') {
        return new Date(value.value);
      }
      return value;
    });
  }

  private debouncedSave(saveFunction: () => void): void {
    if (this.debounceTimeout) {
      clearTimeout(this.debounceTimeout);
    }
    
    this.debounceTimeout = setTimeout(() => {
      saveFunction();
      this.debounceTimeout = null;
    }, 1000); // Save after 1 second of inactivity
  }

  private handleStorageQuotaExceeded(): void {
    logger.warn('Storage quota exceeded, cleaning up old data');
    
    try {
      const data = this.getStorageData();
      
      // Remove old conversations and rooms for all accounts
      Object.keys(data.accounts).forEach(accountJid => {
        const account = data.accounts[accountJid];
        
        // Keep only recent conversations (last 30 days)
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 30);
        
        account.conversations = account.conversations.filter((conv: any) => {
          const lastActivity = new Date(conv.lastActivity);
          return lastActivity > cutoff;
        });
        
        account.rooms = account.rooms.filter((room: any) => {
          const lastActivity = new Date(room.lastActivity);
          return lastActivity > cutoff;
        });
        
        // Reduce message history further
        account.conversations = account.conversations.map((conv: any) => ({
          ...conv,
          messages: (conv.messages || []).slice(-20)
        }));
        
        account.rooms = account.rooms.map((room: any) => ({
          ...room,
          messages: (room.messages || []).slice(-20)
        }));
      });
      
      this.setStorageData(data);
      logger.info('Storage cleanup completed');
    } catch (error) {
      logger.error('Error during storage cleanup:', error);
    }
  }
}
