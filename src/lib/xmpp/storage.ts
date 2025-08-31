import { XmppMessage, XmppThread, XmppContact, XmppRoom, OutboxMessage } from '../../types/xmpp';

class XmppStorage {
  private dbName = 'xmpp-messaging';
  private version = 1;
  private db: IDBDatabase | null = null;

  async init(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);

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
          messagesStore.createIndex('threadId', 'threadId');
          messagesStore.createIndex('timestamp', 'timestamp');
          messagesStore.createIndex('from', 'from');
        }

        // Threads store
        if (!db.objectStoreNames.contains('threads')) {
          const threadsStore = db.createObjectStore('threads', { keyPath: 'id' });
          threadsStore.createIndex('jid', 'jid');
          threadsStore.createIndex('type', 'type');
        }

        // Roster store
        if (!db.objectStoreNames.contains('roster')) {
          const rosterStore = db.createObjectStore('roster', { keyPath: 'jid' });
          rosterStore.createIndex('name', 'name');
          rosterStore.createIndex('presence', 'presence');
        }

        // Rooms store
        if (!db.objectStoreNames.contains('rooms')) {
          const roomsStore = db.createObjectStore('rooms', { keyPath: 'jid' });
          roomsStore.createIndex('name', 'name');
        }

        // Outbox store
        if (!db.objectStoreNames.contains('outbox')) {
          const outboxStore = db.createObjectStore('outbox', { keyPath: 'id' });
          outboxStore.createIndex('timestamp', 'timestamp');
        }

        // Hidden flags store
        if (!db.objectStoreNames.contains('hiddenFlags')) {
          db.createObjectStore('hiddenFlags', { keyPath: 'id' });
        }

        // Bookmarks store
        if (!db.objectStoreNames.contains('bookmarks')) {
          const bookmarksStore = db.createObjectStore('bookmarks', { keyPath: 'jid' });
          bookmarksStore.createIndex('autoJoin', 'autoJoin');
        }
      };
    });
  }

  private async getStore(storeName: string, mode: IDBTransactionMode = 'readonly'): Promise<IDBObjectStore> {
    if (!this.db) throw new Error('Database not initialized');
    const transaction = this.db.transaction(storeName, mode);
    return transaction.objectStore(storeName);
  }

  // Messages
  async saveMessage(message: XmppMessage): Promise<void> {
    const store = await this.getStore('messages', 'readwrite');
    await new Promise<void>((resolve, reject) => {
      const request = store.put(message);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async getMessages(threadId: string, limit = 50, offset = 0): Promise<XmppMessage[]> {
    const store = await this.getStore('messages');
    const index = store.index('threadId');
    
    return new Promise((resolve, reject) => {
      const messages: XmppMessage[] = [];
      let count = 0;
      let skipped = 0;

      const request = index.openCursor(IDBKeyRange.only(threadId), 'prev');
      
      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (!cursor || count >= limit) {
          resolve(messages);
          return;
        }

        if (skipped < offset) {
          skipped++;
          cursor.continue();
          return;
        }

        messages.push(cursor.value);
        count++;
        cursor.continue();
      };

      request.onerror = () => reject(request.error);
    });
  }

  async updateMessage(messageId: string, updates: Partial<XmppMessage>): Promise<void> {
    const store = await this.getStore('messages', 'readwrite');
    
    return new Promise((resolve, reject) => {
      const getRequest = store.get(messageId);
      
      getRequest.onsuccess = () => {
        const message = getRequest.result;
        if (message) {
          const updatedMessage = { ...message, ...updates };
          const putRequest = store.put(updatedMessage);
          putRequest.onsuccess = () => resolve();
          putRequest.onerror = () => reject(putRequest.error);
        } else {
          resolve();
        }
      };
      
      getRequest.onerror = () => reject(getRequest.error);
    });
  }

  // Threads
  async saveThread(thread: XmppThread): Promise<void> {
    const store = await this.getStore('threads', 'readwrite');
    await new Promise<void>((resolve, reject) => {
      const request = store.put(thread);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async getThreads(): Promise<XmppThread[]> {
    const store = await this.getStore('threads');
    
    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getThread(threadId: string): Promise<XmppThread | null> {
    const store = await this.getStore('threads');
    
    return new Promise((resolve, reject) => {
      const request = store.get(threadId);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  // Roster
  async saveContact(contact: XmppContact): Promise<void> {
    const store = await this.getStore('roster', 'readwrite');
    await new Promise<void>((resolve, reject) => {
      const request = store.put(contact);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async getRoster(): Promise<XmppContact[]> {
    const store = await this.getStore('roster');
    
    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // Outbox
  async addToOutbox(message: OutboxMessage): Promise<void> {
    const store = await this.getStore('outbox', 'readwrite');
    await new Promise<void>((resolve, reject) => {
      const request = store.put(message);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async getOutboxMessages(): Promise<OutboxMessage[]> {
    const store = await this.getStore('outbox');
    
    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async removeFromOutbox(messageId: string): Promise<void> {
    const store = await this.getStore('outbox', 'readwrite');
    await new Promise<void>((resolve, reject) => {
      const request = store.delete(messageId);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  // Hidden flags
  async setHiddenFlag(id: string, type: 'message' | 'thread'): Promise<void> {
    const store = await this.getStore('hiddenFlags', 'readwrite');
    await new Promise<void>((resolve, reject) => {
      const request = store.put({ id, type, timestamp: new Date() });
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async isHidden(id: string): Promise<boolean> {
    const store = await this.getStore('hiddenFlags');
    
    return new Promise((resolve, reject) => {
      const request = store.get(id);
      request.onsuccess = () => resolve(!!request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // Clear data
  async clearMessages(threadId?: string): Promise<void> {
    const store = await this.getStore('messages', 'readwrite');
    
    if (threadId) {
      const index = store.index('threadId');
      return new Promise((resolve, reject) => {
        const request = index.openCursor(IDBKeyRange.only(threadId));
        
        request.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest).result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          } else {
            resolve();
          }
        };
        
        request.onerror = () => reject(request.error);
      });
    } else {
      return new Promise((resolve, reject) => {
        const request = store.clear();
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    }
  }

  async clearAllData(): Promise<void> {
    if (!this.db) return;
    
    const storeNames = ['messages', 'threads', 'roster', 'rooms', 'outbox', 'hiddenFlags', 'bookmarks'];
    
    for (const storeName of storeNames) {
      const store = await this.getStore(storeName, 'readwrite');
      await new Promise<void>((resolve, reject) => {
        const request = store.clear();
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    }
  }
}

export const xmppStorage = new XmppStorage();