/**
 * Chat Performance Optimizations
 * Utilities for reducing re-renders and improving performance
 */

import { useCallback, useMemo, useRef } from 'react';
import { XmppMessage } from '@/types/xmpp';

/**
 * Throttle function calls to prevent excessive updates
 */
export function throttle<T extends (...args: any[]) => any>(
  func: T,
  limit: number
): (...args: Parameters<T>) => void {
  let inThrottle: boolean;
  return function (this: any, ...args: Parameters<T>) {
    if (!inThrottle) {
      func.apply(this, args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limit);
    }
  };
}

/**
 * Debounce function calls to prevent rapid consecutive calls
 */
export function debounce<T extends (...args: any[]) => any>(
  func: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: NodeJS.Timeout;
  return function (this: any, ...args: Parameters<T>) {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => func.apply(this, args), delay);
  };
}

/**
 * Memoization utility for expensive computations
 */
export class MemoCache<K, V> {
  private cache = new Map<string, V>();
  private maxSize: number;

  constructor(maxSize: number = 1000) {
    this.maxSize = maxSize;
  }

  get(key: K, computeFn: () => V): V {
    const keyStr = JSON.stringify(key);
    
    if (this.cache.has(keyStr)) {
      return this.cache.get(keyStr)!;
    }

    const value = computeFn();
    this.set(keyStr, value);
    return value;
  }

  private set(key: string, value: V) {
    if (this.cache.size >= this.maxSize) {
      // Remove oldest entry (simple LRU)
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    
    this.cache.set(key, value);
  }

  clear() {
    this.cache.clear();
  }
}

/**
 * Optimized message list sorting
 */
export const optimizedMessageSort = (() => {
  const cache = new MemoCache<{ messages: XmppMessage[]; timestamp: number }, XmppMessage[]>(100);
  
  return (messages: XmppMessage[]): XmppMessage[] => {
    if (messages.length === 0) return messages;
    
    // Use the newest message timestamp as cache key
    const newestTimestamp = Math.max(...messages.map(m => m.timestamp.getTime()));
    
    return cache.get(
      { messages, timestamp: newestTimestamp },
      () => [...messages].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
    );
  };
})();

/**
 * Optimized conversation filtering
 */
export const optimizedConversationFilter = (() => {
  const cache = new MemoCache<{
    items: any[];
    searchTerm: string;
    showArchived: boolean;
    timestamp: number;
  }, any[]>(50);

  return (
    items: any[],
    searchTerm: string,
    showArchived: boolean
  ): any[] => {
    if (items.length === 0) return items;

    // Use latest activity as cache key
    const latestActivity = Math.max(...items.map(item => 
      item.lastActivity?.getTime() || 0
    ));

    return cache.get(
      { items, searchTerm, showArchived, timestamp: latestActivity },
      () => {
        return items.filter(item => {
          const matchesSearch = !searchTerm || 
            item.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
            item.jid?.toLowerCase().includes(searchTerm.toLowerCase());
          
          const matchesArchive = showArchived || !item.isArchived;
          
          return matchesSearch && matchesArchive;
        });
      }
    );
  };
})();

/**
 * React hook for optimized search
 */
export function useOptimizedSearch<T>(
  items: T[],
  searchTerm: string,
  searchFn: (item: T, term: string) => boolean,
  dependencies: any[] = []
) {
  const debouncedSearch = useMemo(
    () => debounce((term: string) => term, 300),
    []
  );

  const debouncedTerm = useMemo(() => {
    debouncedSearch(searchTerm);
    return searchTerm;
  }, [searchTerm, debouncedSearch]);

  return useMemo(() => {
    if (!debouncedTerm) return items;
    return items.filter(item => searchFn(item, debouncedTerm));
  }, [items, debouncedTerm, searchFn, ...dependencies]);
}

/**
 * React hook for optimized sorting
 */
export function useOptimizedSort<T>(
  items: T[],
  sortFn: (a: T, b: T) => number,
  dependencies: any[] = []
) {
  return useMemo(() => {
    if (items.length === 0) return items;
    return [...items].sort(sortFn);
  }, [items, sortFn, ...dependencies]);
}

/**
 * Hook for throttled callbacks
 */
export function useThrottledCallback<T extends (...args: any[]) => any>(
  callback: T,
  delay: number
): T {
  const throttledFn = useMemo(
    () => throttle(callback, delay),
    [callback, delay]
  );

  return throttledFn as T;
}

/**
 * Hook for debounced callbacks
 */
export function useDebouncedCallback<T extends (...args: any[]) => any>(
  callback: T,
  delay: number
): T {
  const debouncedFn = useMemo(
    () => debounce(callback, delay),
    [callback, delay]
  );

  return debouncedFn as T;
}

/**
 * Hook for stable object references
 */
export function useStableReference<T>(value: T): T {
  const ref = useRef<T>(value);
  const previousValueRef = useRef<T>(value);

  // Only update if the value has actually changed
  if (JSON.stringify(value) !== JSON.stringify(previousValueRef.current)) {
    ref.current = value;
    previousValueRef.current = value;
  }

  return ref.current;
}

/**
 * Batch state updates utility
 */
export class BatchStateUpdater {
  private updates: (() => void)[] = [];
  private timeoutId: NodeJS.Timeout | null = null;

  add(updateFn: () => void) {
    this.updates.push(updateFn);
    
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
    }

    this.timeoutId = setTimeout(() => {
      this.flush();
    }, 16); // Next frame
  }

  flush() {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }

    const updates = [...this.updates];
    this.updates = [];

    // Execute all updates in a batch
    updates.forEach(update => update());
  }
}

// Export singleton batch updater
export const batchStateUpdater = new BatchStateUpdater();