// XMPP Storage - IndexedDB for messages, localStorage for preferences
import { XmppMessage, XmppConversation, XmppContact, MucRoom } from './types';

const DB_NAME = 'xmpp-messaging';
const DB_VERSION = 1;

interface StoredMessage extends Omit<XmppMessage, 'timestamp' | 'delayedStamp' | 'retractedAt'> {
  timestamp: string;
  delayedStamp?: string;
  retractedAt?: string;
  accountJid: string;
}

interface StoredConversation extends Omit<XmppConversation, 'lastActivity' | 'messages' | 'lastMessage'> {
  lastActivity: string;
  accountJid: string;
}

interface StoredContact extends Omit<XmppContact, 'lastSeen'> {
  lastSeen?: string;
  accountJid: string;
}

interface OutboxMessage {
  id: string;
  to: string;
  body: string;
  type: 'chat' | 'groupchat';
  timestamp: string;
  retryCount: number;
  maxRetries: number;
  accountJid: string;
}

export class XmppStorage {
  private db: IDBDatabase | null = null;
  private currentAccount: string | null = null;

  async initialize(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Messages store
        if (!db.objectStoreNames.contains('messages')) {
          const messagesStore = db.createObjectStore('messages', { keyPath: 'id' });
          messagesStore.createIndex('accountJid', 'accountJid');
          messagesStore.createIndex('conversationJid', ['accountJid', 'conversationJid']);
          messagesStore.createIndex('timestamp', 'timestamp');
        }

        // Conversations store
        if (!db.objectStoreNames.contains('conversations')) {
          const conversationsStore = db.createObjectStore('conversations', { 
            keyPath: ['accountJid', 'jid'] 
          });
          conversationsStore.createIndex('accountJid', 'accountJid');
          conversationsStore.createIndex('lastActivity', 'lastActivity');
        }

        // Contacts store
        if (!db.objectStoreNames.contains('contacts')) {
          const contactsStore = db.createObjectStore('contacts', { 
            keyPath: ['accountJid', 'jid'] 
          });
          contactsStore.createIndex('accountJid', 'accountJid');
        }

        // Outbox store
        if (!db.objectStoreNames.contains('outbox')) {
          const outboxStore = db.createObjectStore('outbox', { keyPath: 'id' });
          outboxStore.createIndex('accountJid', 'accountJid');
          outboxStore.createIndex('timestamp', 'timestamp');
        }

        // Hidden flags store
        if (!db.objectStoreNames.contains('hiddenFlags')) {
          const hiddenStore = db.createObjectStore('hiddenFlags', { 
            keyPath: ['accountJid', 'messageId'] 
          });
          hiddenStore.createIndex('accountJid', 'accountJid');
        }

        // Bookmarks store
        if (!db.objectStoreNames.contains('bookmarks')) {
          const bookmarksStore = db.createObjectStore('bookmarks', { 
            keyPath: ['accountJid', 'jid'] 
          });
          bookmarksStore.createIndex('accountJid', 'accountJid');
        }
      };
    });
  }

  setAccount(bareJid: string): void {
    this.currentAccount = bareJid;
  }

  // Messages
  async saveMessage(message: XmppMessage, conversationJid: string): Promise<void> {
    if (!this.db || !this.currentAccount) return;

    const storedMessage: StoredMessage & { conversationJid: string } = {
      ...message,
      timestamp: message.timestamp.toISOString(),
      delayedStamp: message.delayedStamp?.toISOString(),
      retractedAt: message.retractedAt?.toISOString(),
      accountJid: this.currentAccount,
      conversationJid,
    };

    const transaction = this.db.transaction(['messages'], 'readwrite');
    await transaction.objectStore('messages').put(storedMessage);
  }

  async getMessages(conversationJid: string, limit: number = 50, before?: string): Promise<XmppMessage[]> {
    if (!this.db || !this.currentAccount) return [];

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['messages'], 'readonly');
      const store = transaction.objectStore('messages');
      const index = store.index('conversationJid');
      const range = IDBKeyRange.only([this.currentAccount, conversationJid]);
      
      const messages: XmppMessage[] = [];
      const request = index.openCursor(range, 'prev');

      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor && messages.length < limit) {
          const stored = cursor.value as StoredMessage & { conversationJid: string };
          
          if (before && stored.timestamp >= before) {
            cursor.continue();
            return;
          }

          messages.push({
            ...stored,
            timestamp: new Date(stored.timestamp),
            delayedStamp: stored.delayedStamp ? new Date(stored.delayedStamp) : undefined,
            retractedAt: stored.retractedAt ? new Date(stored.retractedAt) : undefined,
          });
          
          cursor.continue();
        } else {
          resolve(messages.reverse());
        }
      };

      request.onerror = () => reject(request.error);
    });
  }

  async hideMessage(messageId: string): Promise<void> {
    if (!this.db || !this.currentAccount) return;

    const transaction = this.db.transaction(['hiddenFlags'], 'readwrite');
    await transaction.objectStore('hiddenFlags').put({
      accountJid: this.currentAccount,
      messageId,
      timestamp: new Date().toISOString(),
    });
  }

  async deleteMessage(messageId: string): Promise<void> {
    if (!this.db || !this.currentAccount) return;

    const transaction = this.db.transaction(['messages'], 'readwrite');
    await transaction.objectStore('messages').delete(messageId);
  }

  // Conversations
  async saveConversation(conversation: XmppConversation): Promise<void> {
    if (!this.db || !this.currentAccount) return;

    const { messages, lastMessage, ...conversationData } = conversation;
    const storedConversation: StoredConversation = {
      ...conversationData,
      lastActivity: conversation.lastActivity.toISOString(),
      accountJid: this.currentAccount,
    };

    const transaction = this.db.transaction(['conversations'], 'readwrite');
    await transaction.objectStore('conversations').put(storedConversation);
  }

  async getConversations(): Promise<XmppConversation[]> {
    if (!this.db || !this.currentAccount) return [];

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['conversations'], 'readonly');
      const store = transaction.objectStore('conversations');
      const index = store.index('accountJid');
      const range = IDBKeyRange.only(this.currentAccount);
      
      const conversations: XmppConversation[] = [];
      const request = index.openCursor(range);

      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          const stored = cursor.value as StoredConversation;
          conversations.push({
            ...stored,
            messages: [], // Messages loaded separately
            lastActivity: new Date(stored.lastActivity),
          });
          cursor.continue();
        } else {
          // Sort by last activity
          conversations.sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());
          resolve(conversations);
        }
      };

      request.onerror = () => reject(request.error);
    });
  }

  // Contacts  
  async saveContact(contact: XmppContact): Promise<void> {
    if (!this.db || !this.currentAccount) return;

    const storedContact: StoredContact = {
      ...contact,
      lastSeen: contact.lastSeen?.toISOString(),
      accountJid: this.currentAccount,
    };

    const transaction = this.db.transaction(['contacts'], 'readwrite');
    await transaction.objectStore('contacts').put(storedContact);
  }

  async getContacts(): Promise<XmppContact[]> {
    if (!this.db || !this.currentAccount) return [];

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['contacts'], 'readonly');
      const store = transaction.objectStore('contacts');
      const index = store.index('accountJid');
      const range = IDBKeyRange.only(this.currentAccount);
      
      const contacts: XmppContact[] = [];
      const request = index.openCursor(range);

      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          const stored = cursor.value as StoredContact;
          contacts.push({
            ...stored,
            lastSeen: stored.lastSeen ? new Date(stored.lastSeen) : undefined,
          });
          cursor.continue();
        } else {
          resolve(contacts);
        }
      };

      request.onerror = () => reject(request.error);
    });
  }

  // Outbox
  async queueMessage(message: Omit<OutboxMessage, 'accountJid'>): Promise<void> {
    if (!this.db || !this.currentAccount) return;

    const outboxMessage: OutboxMessage = {
      ...message,
      accountJid: this.currentAccount,
    };

    const transaction = this.db.transaction(['outbox'], 'readwrite');
    await transaction.objectStore('outbox').put(outboxMessage);
  }

  async getQueuedMessages(): Promise<OutboxMessage[]> {
    if (!this.db || !this.currentAccount) return [];

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['outbox'], 'readonly');
      const store = transaction.objectStore('outbox');
      const index = store.index('accountJid');
      const range = IDBKeyRange.only(this.currentAccount);
      
      const messages: OutboxMessage[] = [];
      const request = index.openCursor(range);

      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          messages.push(cursor.value);
          cursor.continue();
        } else {
          resolve(messages);
        }
      };

      request.onerror = () => reject(request.error);
    });
  }

  async removeQueuedMessage(messageId: string): Promise<void> {
    if (!this.db) return;

    const transaction = this.db.transaction(['outbox'], 'readwrite');
    await transaction.objectStore('outbox').delete(messageId);
  }

  // Bookmarks
  async saveBookmark(jid: string, name: string, autoJoin: boolean = false): Promise<void> {
    if (!this.db || !this.currentAccount) return;

    const transaction = this.db.transaction(['bookmarks'], 'readwrite');
    await transaction.objectStore('bookmarks').put({
      accountJid: this.currentAccount,
      jid,
      name,
      autoJoin,
      timestamp: new Date().toISOString(),
    });
  }

  async getBookmarks(): Promise<Array<{ jid: string; name: string; autoJoin: boolean }>> {
    if (!this.db || !this.currentAccount) return [];

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['bookmarks'], 'readonly');
      const store = transaction.objectStore('bookmarks');
      const index = store.index('accountJid');
      const range = IDBKeyRange.only(this.currentAccount);
      
      const bookmarks: Array<{ jid: string; name: string; autoJoin: boolean }> = [];
      const request = index.openCursor(range);

      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          const { jid, name, autoJoin } = cursor.value;
          bookmarks.push({ jid, name, autoJoin });
          cursor.continue();
        } else {
          resolve(bookmarks);
        }
      };

      request.onerror = () => reject(request.error);
    });
  }

  // Clear data
  async clearAccount(): Promise<void> {
    if (!this.db || !this.currentAccount) return;

    const transaction = this.db.transaction(['messages', 'conversations', 'contacts', 'outbox', 'hiddenFlags', 'bookmarks'], 'readwrite');
    
    const stores = ['messages', 'conversations', 'contacts', 'outbox', 'hiddenFlags', 'bookmarks'];
    for (const storeName of stores) {
      const store = transaction.objectStore(storeName);
      const index = store.index('accountJid');
      const range = IDBKeyRange.only(this.currentAccount);
      
      const deleteRequest = index.openCursor(range);
      deleteRequest.onsuccess = () => {
        const cursor = deleteRequest.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
    }
  }

  // Preferences (localStorage)
  getPreference<T>(key: string, defaultValue: T): T {
    if (!this.currentAccount) return defaultValue;
    
    try {
      const stored = localStorage.getItem(`xmpp-pref-${this.currentAccount}-${key}`);
      return stored ? JSON.parse(stored) : defaultValue;
    } catch {
      return defaultValue;
    }
  }

  setPreference<T>(key: string, value: T): void {
    if (!this.currentAccount) return;
    
    try {
      localStorage.setItem(`xmpp-pref-${this.currentAccount}-${key}`, JSON.stringify(value));
    } catch (error) {
      console.warn('Failed to save preference:', error);
    }
  }
}

export const xmppStorage = new XmppStorage();