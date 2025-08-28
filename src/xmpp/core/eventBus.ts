type EventCallback<T = any> = (data: T) => void;

export class XmppEventBus {
  private listeners: Map<string, Set<EventCallback>> = new Map();

  on<T = any>(event: string, callback: EventCallback<T>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    
    this.listeners.get(event)!.add(callback);
    
    // Return unsubscribe function
    return () => {
      const eventListeners = this.listeners.get(event);
      if (eventListeners) {
        eventListeners.delete(callback);
        if (eventListeners.size === 0) {
          this.listeners.delete(event);
        }
      }
    };
  }

  once<T = any>(event: string, callback: EventCallback<T>): () => void {
    const onceCallback = (data: T) => {
      callback(data);
      unsubscribe();
    };
    
    const unsubscribe = this.on(event, onceCallback);
    return unsubscribe;
  }

  emit<T = any>(event: string, data: T): void {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      eventListeners.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error(`Error in event listener for ${event}:`, error);
        }
      });
    }
  }

  off(event: string, callback?: EventCallback): void {
    if (!callback) {
      this.listeners.delete(event);
      return;
    }

    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      eventListeners.delete(callback);
      if (eventListeners.size === 0) {
        this.listeners.delete(event);
      }
    }
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }

  getEventNames(): string[] {
    return Array.from(this.listeners.keys());
  }

  getListenerCount(event: string): number {
    return this.listeners.get(event)?.size || 0;
  }
}