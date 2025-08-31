/**
 * Message Processing Utilities
 * Optimized message handling, deduplication, and formatting
 */

import { XmppMessage } from '@/types/xmpp';

export class MessageProcessor {
  private static instance: MessageProcessor;
  private messageCache = new Map<string, XmppMessage>();
  private duplicateTracker = new Set<string>();

  static getInstance(): MessageProcessor {
    if (!MessageProcessor.instance) {
      MessageProcessor.instance = new MessageProcessor();
    }
    return MessageProcessor.instance;
  }

  /**
   * Generate canonical ID for message deduplication
   */
  getCanonicalId(message: XmppMessage): string {
    // Priority: originId > id > content hash
    if (message.originId) return message.originId;
    if (message.id) return message.id;
    
    // Generate content-based hash for deduplication
    const contentKey = [
      message.from,
      message.to,
      message.body,
      message.timestamp.getTime(),
      message.type || 'chat'
    ].join('|');
    
    return this.simpleHash(contentKey);
  }

  /**
   * Add message with deduplication and sorting
   */
  addMessage(existingMessages: XmppMessage[], newMessage: XmppMessage): XmppMessage[] {
    const canonicalId = this.getCanonicalId(newMessage);
    
    // Check for duplicates
    if (this.duplicateTracker.has(canonicalId)) {
      return existingMessages;
    }

    // Mark as processed
    this.duplicateTracker.add(canonicalId);
    this.messageCache.set(canonicalId, newMessage);

    // Binary search insertion for performance
    const insertIndex = this.findInsertIndex(existingMessages, newMessage);
    const newMessages = [...existingMessages];
    newMessages.splice(insertIndex, 0, newMessage);

    // Maintain cache size
    this.maintainCacheSize();

    return newMessages;
  }

  /**
   * Batch process multiple messages
   */
  batchAddMessages(existingMessages: XmppMessage[], newMessages: XmppMessage[]): XmppMessage[] {
    let result = existingMessages;
    
    // Sort new messages by timestamp first
    const sortedNew = [...newMessages].sort((a, b) => 
      a.timestamp.getTime() - b.timestamp.getTime()
    );

    // Add each message
    for (const message of sortedNew) {
      result = this.addMessage(result, message);
    }

    return result;
  }

  /**
   * Update message status by canonical ID
   */
  updateMessageStatus(
    messages: XmppMessage[], 
    messageId: string, 
    status: XmppMessage['status']
  ): XmppMessage[] {
    return messages.map(msg => {
      const canonicalId = this.getCanonicalId(msg);
      if (canonicalId === messageId || msg.id === messageId || msg.originId === messageId) {
        return { ...msg, status };
      }
      return msg;
    });
  }

  /**
   * Find optimal insertion index using binary search
   */
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

  /**
   * Maintain cache size for memory efficiency
   */
  private maintainCacheSize() {
    const maxCacheSize = 10000;
    const maxDuplicateTracker = 50000;

    if (this.messageCache.size > maxCacheSize) {
      // Remove oldest 20% of messages
      const entries = Array.from(this.messageCache.entries());
      const messagesToRemove = Math.floor(entries.length * 0.2);
      
      // Sort by timestamp and remove oldest
      entries.sort((a, b) => a[1].timestamp.getTime() - b[1].timestamp.getTime());
      
      for (let i = 0; i < messagesToRemove; i++) {
        this.messageCache.delete(entries[i][0]);
      }
    }

    if (this.duplicateTracker.size > maxDuplicateTracker) {
      // Clear oldest half of duplicate tracker
      const trackerArray = Array.from(this.duplicateTracker);
      this.duplicateTracker.clear();
      
      // Keep newer half (rough estimate)
      const keepFrom = Math.floor(trackerArray.length / 2);
      for (let i = keepFrom; i < trackerArray.length; i++) {
        this.duplicateTracker.add(trackerArray[i]);
      }
    }
  }

  /**
   * Simple hash function for content-based IDs
   */
  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return `hash_${Math.abs(hash).toString(36)}`;
  }

  /**
   * Get message by canonical ID
   */
  getMessage(canonicalId: string): XmppMessage | undefined {
    return this.messageCache.get(canonicalId);
  }

  /**
   * Clear cache (useful for logout/account switch)
   */
  clearCache() {
    this.messageCache.clear();
    this.duplicateTracker.clear();
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    return {
      cacheSize: this.messageCache.size,
      duplicateTrackerSize: this.duplicateTracker.size,
    };
  }
}

// Export singleton instance
export const messageProcessor = MessageProcessor.getInstance();
