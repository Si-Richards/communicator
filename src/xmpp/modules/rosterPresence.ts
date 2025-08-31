/**
 * Roster and Presence Management
 * Handles XEP-0012 (Last Activity), roster management, and presence
 */

import { xml } from '@xmpp/client';
import { XmppClient } from '../core/client';
import { XmppEventBus } from '../core/eventBus';
import { XmppUtils } from '../core/utils';
import { JidUtils } from '../core/jid';
import { logger } from '@/lib/logger';

export interface XmppContact {
  jid: string;
  name: string;
  subscription: 'none' | 'to' | 'from' | 'both';
  presence: PresenceShow;
  status?: string;
  lastSeen?: Date;
  avatar?: string;
  ask?: 'subscribe';
  approved?: boolean;
}

export type PresenceShow = 'available' | 'away' | 'dnd' | 'xa' | 'unavailable';

export class RosterPresenceManager {
  private client: XmppClient;
  private eventBus: XmppEventBus;
  private contacts = new Map<string, XmppContact>();
  private pendingQueries = new Map<string, (result: any) => void>();

  constructor(client: XmppClient, eventBus: XmppEventBus) {
    this.client = client;
    this.eventBus = eventBus;
  }

  async fetchRoster(): Promise<XmppContact[]> {
    if (!this.client.isConnected()) {
      return Array.from(this.contacts.values());
    }

    try {
      const iq = XmppUtils.createIq('get');
      const query = xml('query', { xmlns: 'jabber:iq:roster' });
      iq.cnode(query);

      const result = await this.sendIqQuery(iq);
      const items = result.items || [];
      
      for (const item of items) {
        const contact: XmppContact = {
          jid: item.jid,
          name: item.name || JidUtils.toDisplayName(item.jid),
          subscription: item.subscription || 'none',
          presence: 'unavailable',
          ask: item.ask,
          approved: item.approved
        };
        
        this.contacts.set(JidUtils.toBare(item.jid), contact);
      }

      logger.info(`Fetched roster with ${items.length} contacts`);
      this.eventBus.emit('roster:updated', { contacts: Array.from(this.contacts.values()) });
      
      return Array.from(this.contacts.values());
    } catch (error) {
      logger.error('Error fetching roster:', error);
      return Array.from(this.contacts.values());
    }
  }

  async addContact(jid: string, name?: string): Promise<void> {
    const bareJid = JidUtils.toBare(jid);
    
    // Add to roster
    const iq = XmppUtils.createIq('set');
    const query = xml('query', { xmlns: 'jabber:iq:roster' });
    const item = xml('item', { 
      jid: bareJid,
      name: name || JidUtils.toDisplayName(bareJid)
    });
    query.cnode(item);
    iq.cnode(query);

    await this.client.send(iq);

    // Send subscription request
    await this.subscribeToPresence(bareJid);
    
    logger.info('Added contact:', bareJid);
  }

  async removeContact(jid: string): Promise<void> {
    const bareJid = JidUtils.toBare(jid);
    
    // Remove from roster
    const iq = XmppUtils.createIq('set');
    const query = xml('query', { xmlns: 'jabber:iq:roster' });
    const item = xml('item', { 
      jid: bareJid,
      subscription: 'remove'
    });
    query.cnode(item);
    iq.cnode(query);

    await this.client.send(iq);
    
    this.contacts.delete(bareJid);
    this.eventBus.emit('roster:updated', { contacts: Array.from(this.contacts.values()) });
    
    logger.info('Removed contact:', bareJid);
  }

  async subscribeToPresence(jid: string): Promise<void> {
    const presence = XmppUtils.createPresence('subscribe', JidUtils.toBare(jid));
    await this.client.send(presence);
    logger.debug('Sent subscription request to:', jid);
  }

  async unsubscribeFromPresence(jid: string): Promise<void> {
    const presence = XmppUtils.createPresence('unsubscribe', JidUtils.toBare(jid));
    await this.client.send(presence);
    logger.debug('Sent unsubscription request to:', jid);
  }

  async setPresence(show?: PresenceShow, status?: string): Promise<void> {
    const presence = XmppUtils.createPresence();
    
    if (show && show !== 'available') {
      presence.c('show').t(show);
    }
    
    if (status) {
      presence.c('status').t(status);
    }

    await this.client.send(presence);
    logger.debug('Set presence:', { show, status });
  }

  async sendInitialPresence(): Promise<void> {
    await this.setPresence('available');
  }

  async queryLastActivity(jid: string): Promise<Date | null> {
    try {
      const iq = XmppUtils.createIq('get', JidUtils.toBare(jid));
      const query = xml('query', { xmlns: 'jabber:iq:last' });
      iq.cnode(query);

      const result = await this.sendIqQuery(iq);
      
      if (result.seconds !== undefined) {
        const lastActivityTime = new Date(Date.now() - (result.seconds * 1000));
        
        // Update contact's last seen
        const contact = this.contacts.get(JidUtils.toBare(jid));
        if (contact) {
          contact.lastSeen = lastActivityTime;
          this.eventBus.emit('contact:updated', { contact });
        }
        
        return lastActivityTime;
      }
      
      return null;
    } catch (error) {
      logger.debug('Error querying last activity for:', jid, error);
      return null;
    }
  }

  handlePresenceStanza(stanza: any): void {
    const from = stanza.attrs.from;
    const type = stanza.attrs.type;
    
    if (!from) return;
    
    const bareFrom = JidUtils.toBare(from);
    
    switch (type) {
      case 'subscribe':
        this.handleSubscriptionRequest(bareFrom);
        break;
      case 'subscribed':
        this.handleSubscriptionApproved(bareFrom);
        break;
      case 'unsubscribe':
        this.handleUnsubscriptionRequest(bareFrom);
        break;
      case 'unsubscribed':
        this.handleUnsubscriptionApproved(bareFrom);
        break;
      case 'unavailable':
        this.updateContactPresence(bareFrom, 'unavailable');
        break;
      default:
        // Available presence
        this.handleAvailablePresence(stanza, bareFrom);
        break;
    }
  }

  handleRosterStanza(stanza: any): void {
    const query = XmppUtils.findChild(stanza, 'query', 'jabber:iq:roster');
    if (!query) return;

    const items = XmppUtils.findChildren(query, 'item');
    
    for (const item of items) {
      const jid = XmppUtils.getAttribute(item, 'jid');
      const name = XmppUtils.getAttribute(item, 'name');
      const subscription = XmppUtils.getAttribute(item, 'subscription');
      const ask = XmppUtils.getAttribute(item, 'ask');
      
      if (!jid) continue;
      
      const bareJid = JidUtils.toBare(jid);
      
      if (subscription === 'remove') {
        this.contacts.delete(bareJid);
      } else {
        const existingContact = this.contacts.get(bareJid);
        const contact: XmppContact = {
          jid: bareJid,
          name: name || JidUtils.toDisplayName(bareJid),
          subscription: subscription as any || 'none',
          presence: existingContact?.presence || 'unavailable',
          status: existingContact?.status,
          lastSeen: existingContact?.lastSeen,
          avatar: existingContact?.avatar,
          ask: ask as any,
          approved: existingContact?.approved
        };
        
        this.contacts.set(bareJid, contact);
      }
    }
    
    this.eventBus.emit('roster:updated', { contacts: Array.from(this.contacts.values()) });
  }

  getContacts(): XmppContact[] {
    return Array.from(this.contacts.values());
  }

  getContact(jid: string): XmppContact | undefined {
    return this.contacts.get(JidUtils.toBare(jid));
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
          reject(new Error('Query timeout'));
        }
      }, 10000);

      this.client.send(iq).catch(reject);
    });
  }

  private handleSubscriptionRequest(from: string): void {
    logger.info('Received subscription request from:', from);
    this.eventBus.emit('presence:subscriptionRequest', { from });
    
    // Auto-approve for now (could be configurable)
    this.approveSubscription(from);
  }

  private async approveSubscription(jid: string): Promise<void> {
    const presence = XmppUtils.createPresence('subscribed', jid);
    await this.client.send(presence);
    
    // Also request subscription back
    await this.subscribeToPresence(jid);
    
    logger.info('Approved subscription for:', jid);
  }

  private handleSubscriptionApproved(from: string): void {
    logger.info('Subscription approved by:', from);
    this.eventBus.emit('presence:subscriptionApproved', { from });
  }

  private handleUnsubscriptionRequest(from: string): void {
    logger.info('Received unsubscription request from:', from);
    this.eventBus.emit('presence:unsubscriptionRequest', { from });
  }

  private handleUnsubscriptionApproved(from: string): void {
    logger.info('Unsubscription approved by:', from);
    this.eventBus.emit('presence:unsubscriptionApproved', { from });
  }

  private handleAvailablePresence(stanza: any, from: string): void {
    const show = XmppUtils.getTextContent(XmppUtils.findChild(stanza, 'show')) || 'available';
    const status = XmppUtils.getTextContent(XmppUtils.findChild(stanza, 'status'));
    
    this.updateContactPresence(from, show as PresenceShow, status);
  }

  private updateContactPresence(jid: string, presence: PresenceShow, status?: string): void {
    const contact = this.contacts.get(jid);
    if (contact) {
      contact.presence = presence;
      contact.status = status;
      
      if (presence === 'unavailable') {
        contact.lastSeen = new Date();
      }
      
      this.eventBus.emit('contact:updated', { contact });
    }
  }
}