// MUC service and room caching to avoid repeated queries

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  expiresAt: number;
}

class XmppMucCache {
  private serviceCache: CacheEntry<string[]> | null = null;
  private roomCache: Map<string, CacheEntry<Array<{jid: string; name: string}>>> = new Map();
  private serviceCacheDuration = 5 * 60 * 1000; // 5 minutes
  private roomCacheDuration = 2 * 60 * 1000; // 2 minutes
  private pendingRequests: Map<string, Promise<any>> = new Map();

  getCachedServices(): string[] | null {
    if (!this.serviceCache) return null;
    
    const now = Date.now();
    if (now > this.serviceCache.expiresAt) {
      this.serviceCache = null;
      return null;
    }
    
    return this.serviceCache.data;
  }

  setCachedServices(services: string[]): void {
    const now = Date.now();
    this.serviceCache = {
      data: services,
      timestamp: now,
      expiresAt: now + this.serviceCacheDuration
    };
  }

  getCachedRooms(serviceJid: string): Array<{jid: string; name: string}> | null {
    const cached = this.roomCache.get(serviceJid);
    if (!cached) return null;
    
    const now = Date.now();
    if (now > cached.expiresAt) {
      this.roomCache.delete(serviceJid);
      return null;
    }
    
    return cached.data;
  }

  setCachedRooms(serviceJid: string, rooms: Array<{jid: string; name: string}>): void {
    const now = Date.now();
    this.roomCache.set(serviceJid, {
      data: rooms,
      timestamp: now,
      expiresAt: now + this.roomCacheDuration
    });
  }

  // Prevent duplicate simultaneous requests
  async deduplicateRequest<T>(key: string, requestFn: () => Promise<T>): Promise<T> {
    const pending = this.pendingRequests.get(key);
    if (pending) {
      return pending as Promise<T>;
    }

    const promise = requestFn().finally(() => {
      this.pendingRequests.delete(key);
    });

    this.pendingRequests.set(key, promise);
    return promise;
  }

  clearCache(): void {
    this.serviceCache = null;
    this.roomCache.clear();
    this.pendingRequests.clear();
  }

  clearServiceCache(): void {
    this.serviceCache = null;
  }

  clearRoomCache(serviceJid?: string): void {
    if (serviceJid) {
      this.roomCache.delete(serviceJid);
    } else {
      this.roomCache.clear();
    }
  }
}

export const mucCache = new XmppMucCache();
