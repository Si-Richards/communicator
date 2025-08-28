/**
 * Core XMPP utilities
 */

import { xml } from '@xmpp/client';

export class XmppUtils {
  /**
   * Generate a unique stanza ID
   */
  static generateId(): string {
    return Math.random().toString(36).substring(2) + Date.now().toString(36);
  }

  /**
   * Create an IQ stanza
   */
  static createIq(type: 'get' | 'set' | 'result' | 'error', to?: string, from?: string): any {
    const attrs: any = {
      type,
      id: this.generateId()
    };
    
    if (to) attrs.to = to;
    if (from) attrs.from = from;
    
    return xml('iq', attrs);
  }

  /**
   * Create a message stanza
   */
  static createMessage(type: 'chat' | 'groupchat' | 'normal' = 'chat', to?: string, from?: string): any {
    const attrs: any = {
      type,
      id: this.generateId()
    };
    
    if (to) attrs.to = to;
    if (from) attrs.from = from;
    
    return xml('message', attrs);
  }

  /**
   * Create a presence stanza
   */
  static createPresence(type?: 'subscribe' | 'subscribed' | 'unsubscribe' | 'unsubscribed' | 'unavailable', to?: string, from?: string): any {
    const attrs: any = {};
    
    if (type) attrs.type = type;
    if (to) attrs.to = to;
    if (from) attrs.from = from;
    
    return xml('presence', attrs);
  }

  /**
   * Extract text content from XML element
   */
  static getTextContent(element: any): string {
    if (!element) return '';
    
    if (typeof element === 'string') return element;
    if (element.text) return element.text();
    if (element.getText) return element.getText();
    
    return '';
  }

  /**
   * Find child element by name
   */
  static findChild(element: any, name: string, namespace?: string): any {
    if (!element || !element.getChild) return null;
    
    return element.getChild(name, namespace);
  }

  /**
   * Find all child elements by name
   */
  static findChildren(element: any, name: string, namespace?: string): any[] {
    if (!element || !element.getChildren) return [];
    
    return element.getChildren(name, namespace);
  }

  /**
   * Get attribute value
   */
  static getAttribute(element: any, name: string): string | undefined {
    if (!element || !element.attrs) return undefined;
    
    return element.attrs[name];
  }

  /**
   * Parse timestamp from various formats
   */
  static parseTimestamp(timestamp: string | undefined): Date {
    if (!timestamp) return new Date();
    
    try {
      // Handle ISO 8601 format
      if (timestamp.includes('T')) {
        return new Date(timestamp);
      }
      
      // Handle YYYYMMDDTHH:MM:SS format
      if (timestamp.length === 15 && timestamp.includes('T')) {
        const year = timestamp.substring(0, 4);
        const month = timestamp.substring(4, 6);
        const day = timestamp.substring(6, 8);
        const hour = timestamp.substring(9, 11);
        const minute = timestamp.substring(11, 13);
        const second = timestamp.substring(13, 15);
        
        return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
      }
      
      // Fallback to Date constructor
      return new Date(timestamp);
    } catch (error) {
      return new Date();
    }
  }

  /**
   * Format timestamp for XMPP
   */
  static formatTimestamp(date: Date = new Date()): string {
    return date.toISOString();
  }

  /**
   * Create RSM (Result Set Management) query
   */
  static createRsmQuery(options: {
    max?: number;
    before?: string;
    after?: string;
    index?: number;
  } = {}): any {
    const set = xml('set', { xmlns: 'http://jabber.org/protocol/rsm' });
    
    if (options.max !== undefined) {
      set.c('max').t(options.max.toString());
    }
    
    if (options.before !== undefined) {
      if (options.before === '') {
        set.c('before');
      } else {
        set.c('before').t(options.before);
      }
    }
    
    if (options.after) {
      set.c('after').t(options.after);
    }
    
    if (options.index !== undefined) {
      set.c('index').t(options.index.toString());
    }
    
    return set;
  }

  /**
   * Parse RSM result
   */
  static parseRsmResult(element: any): {
    first?: string;
    last?: string;
    count?: number;
    index?: number;
  } {
    const result: any = {};
    
    if (!element) return result;
    
    const set = this.findChild(element, 'set', 'http://jabber.org/protocol/rsm');
    if (!set) return result;
    
    const first = this.findChild(set, 'first');
    if (first) {
      result.first = this.getTextContent(first);
      const index = this.getAttribute(first, 'index');
      if (index) result.index = parseInt(index, 10);
    }
    
    const last = this.findChild(set, 'last');
    if (last) {
      result.last = this.getTextContent(last);
    }
    
    const count = this.findChild(set, 'count');
    if (count) {
      result.count = parseInt(this.getTextContent(count), 10);
    }
    
    return result;
  }

  /**
   * Debounce function utility
   */
  static debounce<T extends (...args: any[]) => any>(
    func: T,
    wait: number
  ): (...args: Parameters<T>) => void {
    let timeout: NodeJS.Timeout;
    
    return (...args: Parameters<T>) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => func(...args), wait);
    };
  }

  /**
   * Safe JSON parse
   */
  static safeJsonParse<T>(json: string, fallback: T): T {
    try {
      return JSON.parse(json);
    } catch {
      return fallback;
    }
  }

  /**
   * Safe JSON stringify
   */
  static safeJsonStringify(obj: any): string {
    try {
      return JSON.stringify(obj);
    } catch {
      return '{}';
    }
  }
}