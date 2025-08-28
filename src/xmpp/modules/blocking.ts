/**
 * Blocking Management (XEP-0191)
 * Handles blocking and unblocking of contacts
 */

import { xml } from '@xmpp/client';
import { XmppClient } from '../core/client';
import { XmppEventBus } from '../core/eventBus';
import { XmppUtils } from '../core/utils';
import { JidUtils } from '../core/jid';
import { logger } from '@/lib/logger';

export class BlockingManager {
  private client: XmppClient;
  private eventBus: XmppEventBus;
  private blockedList = new Set<string>();
  private pendingQueries = new Map<string, (result: any) => void>();

  constructor(client: XmppClient, eventBus: XmppEventBus) {
    this.client = client;
    this.eventBus = eventBus;
  }

  async fetchBlockList(): Promise<string[]> {
    try {
      const iq = XmppUtils.createIq('get');
      const blocklist = xml('blocklist', { xmlns: 'urn:xmpp:blocking' });
      iq.cnode(blocklist);

      const result = await this.sendIqQuery(iq);
      const items = result.items || [];
      
      this.blockedList.clear();
      for (const item of items) {
        this.blockedList.add(item.jid);
      }
      
      logger.info(`Fetched block list with ${items.length} blocked JIDs`);
      this.eventBus.emit('blocking:listUpdated', { 
        blocked: Array.from(this.blockedList) 
      });
      
      return Array.from(this.blockedList);
    } catch (error) {
      logger.error('Error fetching block list:', error);
      return Array.from(this.blockedList);
    }
  }

  async blockContact(jid: string): Promise<boolean> {
    const bareJid = JidUtils.toBare(jid);
    
    try {
      const iq = XmppUtils.createIq('set');
      const block = xml('block', { xmlns: 'urn:xmpp:blocking' });
      const item = xml('item', { jid: bareJid });
      block.cnode(item);
      iq.cnode(block);

      await this.client.send(iq);
      
      this.blockedList.add(bareJid);
      this.eventBus.emit('blocking:contactBlocked', { jid: bareJid });
      
      logger.info('Blocked contact:', bareJid);
      return true;
    } catch (error) {
      logger.error('Error blocking contact:', error);
      return false;
    }
  }

  async unblockContact(jid: string): Promise<boolean> {
    const bareJid = JidUtils.toBare(jid);
    
    try {
      const iq = XmppUtils.createIq('set');
      const unblock = xml('unblock', { xmlns: 'urn:xmpp:blocking' });
      const item = xml('item', { jid: bareJid });
      unblock.cnode(item);
      iq.cnode(unblock);

      await this.client.send(iq);
      
      this.blockedList.delete(bareJid);
      this.eventBus.emit('blocking:contactUnblocked', { jid: bareJid });
      
      logger.info('Unblocked contact:', bareJid);
      return true;
    } catch (error) {
      logger.error('Error unblocking contact:', error);
      return false;
    }
  }

  async unblockAll(): Promise<boolean> {
    try {
      const iq = XmppUtils.createIq('set');
      const unblock = xml('unblock', { xmlns: 'urn:xmpp:blocking' });
      iq.cnode(unblock);

      await this.client.send(iq);
      
      this.blockedList.clear();
      this.eventBus.emit('blocking:allUnblocked', {});
      
      logger.info('Unblocked all contacts');
      return true;
    } catch (error) {
      logger.error('Error unblocking all contacts:', error);
      return false;
    }
  }

  isBlocked(jid: string): boolean {
    return this.blockedList.has(JidUtils.toBare(jid));
  }

  getBlockedList(): string[] {
    return Array.from(this.blockedList);
  }

  canHandle(stanza: any): boolean {
    const blocklist = XmppUtils.findChild(stanza, 'blocklist', 'urn:xmpp:blocking');
    const block = XmppUtils.findChild(stanza, 'block', 'urn:xmpp:blocking');
    const unblock = XmppUtils.findChild(stanza, 'unblock', 'urn:xmpp:blocking');
    
    return !!(blocklist || block || unblock);
  }

  handleStanza(stanza: any): void {
    const id = stanza.attrs.id;
    const type = stanza.attrs.type;
    
    // Handle push notifications for blocking changes
    if (type === 'set') {
      this.handleBlockingPush(stanza);
      return;
    }
    
    // Handle query responses
    const resolver = this.pendingQueries.get(id);
    if (!resolver) return;
    
    this.pendingQueries.delete(id);

    if (type === 'error') {
      const error = XmppUtils.findChild(stanza, 'error');
      const errorText = error ? XmppUtils.getTextContent(error) : 'Unknown error';
      resolver({ error: errorText });
      return;
    }

    const blocklist = XmppUtils.findChild(stanza, 'blocklist', 'urn:xmpp:blocking');
    if (blocklist) {
      this.handleBlocklistResponse(blocklist, resolver);
    } else {
      resolver({ success: true });
    }
  }

  cleanup(): void {
    this.pendingQueries.clear();
  }

  private async sendIqQuery(iq: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const queryId = iq.attrs.id;
      
      this.pendingQueries.set(queryId, (result) => {
        if (result.error) {
          reject(new Error(result.error));
        } else {
          resolve(result);
        }
      });

      setTimeout(() => {
        if (this.pendingQueries.has(queryId)) {
          this.pendingQueries.delete(queryId);
          reject(new Error('Blocking query timeout'));
        }
      }, 10000);

      this.client.send(iq).catch(reject);
    });
  }

  private handleBlocklistResponse(blocklist: any, resolver: (result: any) => void): void {
    const items: Array<{ jid: string }> = [];
    
    const itemElements = XmppUtils.findChildren(blocklist, 'item');
    for (const item of itemElements) {
      const jid = XmppUtils.getAttribute(item, 'jid');
      if (jid) {
        items.push({ jid });
      }
    }

    resolver({ items });
  }

  private handleBlockingPush(stanza: any): void {
    const block = XmppUtils.findChild(stanza, 'block', 'urn:xmpp:blocking');
    const unblock = XmppUtils.findChild(stanza, 'unblock', 'urn:xmpp:blocking');
    
    if (block) {
      const items = XmppUtils.findChildren(block, 'item');
      for (const item of items) {
        const jid = XmppUtils.getAttribute(item, 'jid');
        if (jid) {
          this.blockedList.add(jid);
          this.eventBus.emit('blocking:contactBlocked', { jid });
          logger.info('Contact blocked (push):', jid);
        }
      }
    } else if (unblock) {
      const items = XmppUtils.findChildren(unblock, 'item');
      
      if (items.length === 0) {
        // Unblock all
        this.blockedList.clear();
        this.eventBus.emit('blocking:allUnblocked', {});
        logger.info('All contacts unblocked (push)');
      } else {
        // Unblock specific contacts
        for (const item of items) {
          const jid = XmppUtils.getAttribute(item, 'jid');
          if (jid) {
            this.blockedList.delete(jid);
            this.eventBus.emit('blocking:contactUnblocked', { jid });
            logger.info('Contact unblocked (push):', jid);
          }
        }
      }
    }
    
    this.eventBus.emit('blocking:listUpdated', { 
      blocked: Array.from(this.blockedList) 
    });
  }
}