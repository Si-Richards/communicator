/**
 * XEP-0030: Service Discovery
 * Discovers server and service capabilities
 */

import { xml } from '@xmpp/client';
import { XmppClient } from '../core/client';
import { XmppEventBus } from '../core/eventBus';
import { XmppUtils } from '../core/utils';
import { JidUtils } from '../core/jid';
import { logger } from '@/lib/logger';

export interface ServerFeatures {
  // Core features
  streamManagement: boolean; // XEP-0198
  messageDeliveryReceipts: boolean; // XEP-0184
  chatMarkers: boolean; // XEP-0333
  messageArchiveManagement: boolean; // XEP-0313
  messageRetraction: boolean; // XEP-0424
  lastActivity: boolean; // XEP-0012
  messageCarbons: boolean; // XEP-0280
  
  // Roster and presence
  rosterVersioning: boolean; // RFC 6121
  presenceSubscription: boolean;
  
  // MUC features
  muc: boolean; // XEP-0045
  mucAdmin: boolean;
  mucOwner: boolean;
  
  // File transfer
  sipFileTransfer: boolean; // XEP-0234
  httpFileUpload: boolean; // XEP-0363
  
  // Privacy
  blocking: boolean; // XEP-0191
  
  // Other useful features
  ping: boolean; // XEP-0199
  time: boolean; // XEP-0202
  softwareVersion: boolean; // XEP-0092
  entityCapabilities: boolean; // XEP-0115
  
  // vCard
  vcard: boolean; // XEP-0054
  vcardUpdate: boolean; // XEP-0153
  avatar: boolean; // XEP-0084
}

export class DiscoManager {
  private client: XmppClient;
  private eventBus: XmppEventBus;
  private features: ServerFeatures;
  private pendingQueries = new Map<string, (result: any) => void>();

  constructor(client: XmppClient, eventBus: XmppEventBus) {
    this.client = client;
    this.eventBus = eventBus;
    this.features = this.getDefaultFeatures();
  }

  async discoverServerFeatures(): Promise<ServerFeatures> {
    const config = this.client.getConfig();
    if (!config || !this.client.isConnected()) {
      return this.features;
    }

    try {
      const serverJid = config.domain;
      const info = await this.queryInfo(serverJid);
      
      this.parseFeatures(info);
      
      // Also check stream features
      this.checkStreamFeatures();
      
      logger.info('Discovered server features', this.features);
      this.eventBus.emit('disco:featuresDiscovered', { features: this.features });
      
      return this.features;
    } catch (error) {
      logger.error('Error discovering server features:', error);
      return this.features;
    }
  }

  async queryInfo(jid: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const iq = XmppUtils.createIq('get', jid);
      const query = xml('query', { xmlns: 'http://jabber.org/protocol/disco#info' });
      iq.cnode(query);

      const queryId = iq.attrs.id;
      
      this.pendingQueries.set(queryId, (result) => {
        if (result.error) {
          reject(new Error(result.error));
        } else {
          resolve(result);
        }
      });

      // Set timeout
      setTimeout(() => {
        if (this.pendingQueries.has(queryId)) {
          this.pendingQueries.delete(queryId);
          reject(new Error('Disco query timeout'));
        }
      }, 10000);

      this.client.send(iq).catch(reject);
    });
  }

  async queryItems(jid: string): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const iq = XmppUtils.createIq('get', jid);
      const query = xml('query', { xmlns: 'http://jabber.org/protocol/disco#items' });
      iq.cnode(query);

      const queryId = iq.attrs.id;
      
      this.pendingQueries.set(queryId, (result) => {
        if (result.error) {
          reject(new Error(result.error));
        } else {
          resolve(result.items || []);
        }
      });

      // Set timeout
      setTimeout(() => {
        if (this.pendingQueries.has(queryId)) {
          this.pendingQueries.delete(queryId);
          reject(new Error('Disco items query timeout'));
        }
      }, 10000);

      this.client.send(iq).catch(reject);
    });
  }

  async discoverMucServices(): Promise<string[]> {
    const config = this.client.getConfig();
    if (!config) return [];

    try {
      const items = await this.queryItems(config.domain);
      const mucServices: string[] = [];

      for (const item of items) {
        const jid = item.jid;
        if (jid && (jid.includes('conference') || jid.includes('muc') || jid.includes('rooms'))) {
          try {
            const info = await this.queryInfo(jid);
            if (this.isMucService(info)) {
              mucServices.push(jid);
            }
          } catch (error) {
            logger.debug('Error querying MUC service:', jid, error);
          }
        }
      }

      return mucServices;
    } catch (error) {
      logger.error('Error discovering MUC services:', error);
      return [];
    }
  }

  canHandle(stanza: any): boolean {
    const query = XmppUtils.findChild(stanza, 'query');
    if (!query) return false;
    
    const xmlns = query.attrs?.xmlns;
    return xmlns === 'http://jabber.org/protocol/disco#info' || 
           xmlns === 'http://jabber.org/protocol/disco#items';
  }

  handleStanza(stanza: any): void {
    const id = stanza.attrs.id;
    const type = stanza.attrs.type;
    
    const resolver = this.pendingQueries.get(id);
    if (!resolver) return;
    
    this.pendingQueries.delete(id);

    if (type === 'error') {
      const error = XmppUtils.findChild(stanza, 'error');
      const errorText = error ? XmppUtils.getTextContent(error) : 'Unknown error';
      resolver({ error: errorText });
      return;
    }

    const query = XmppUtils.findChild(stanza, 'query');
    if (!query) {
      resolver({ error: 'No query element' });
      return;
    }

    const xmlns = query.attrs?.xmlns;
    
    if (xmlns === 'http://jabber.org/protocol/disco#info') {
      this.handleInfoResult(query, resolver);
    } else if (xmlns === 'http://jabber.org/protocol/disco#items') {
      this.handleItemsResult(query, resolver);
    }
  }

  getFeatures(): ServerFeatures {
    return { ...this.features };
  }

  isFeatureSupported(feature: keyof ServerFeatures): boolean {
    return this.features[feature];
  }

  private handleInfoResult(query: any, resolver: (result: any) => void): void {
    const features: string[] = [];
    const identities: any[] = [];

    // Parse features
    const featureElements = XmppUtils.findChildren(query, 'feature');
    for (const feature of featureElements) {
      const varAttr = XmppUtils.getAttribute(feature, 'var');
      if (varAttr) {
        features.push(varAttr);
      }
    }

    // Parse identities
    const identityElements = XmppUtils.findChildren(query, 'identity');
    for (const identity of identityElements) {
      identities.push({
        category: XmppUtils.getAttribute(identity, 'category'),
        type: XmppUtils.getAttribute(identity, 'type'),
        name: XmppUtils.getAttribute(identity, 'name')
      });
    }

    resolver({ features, identities });
  }

  private handleItemsResult(query: any, resolver: (result: any) => void): void {
    const items: any[] = [];

    const itemElements = XmppUtils.findChildren(query, 'item');
    for (const item of itemElements) {
      items.push({
        jid: XmppUtils.getAttribute(item, 'jid'),
        name: XmppUtils.getAttribute(item, 'name'),
        node: XmppUtils.getAttribute(item, 'node')
      });
    }

    resolver({ items });
  }

  private parseFeatures(result: any): void {
    const features = result.features || [];
    
    // Core features
    this.features.streamManagement = features.includes('urn:xmpp:sm:3');
    this.features.messageDeliveryReceipts = features.includes('urn:xmpp:receipts');
    this.features.chatMarkers = features.includes('urn:xmpp:chat-markers:0');
    this.features.messageArchiveManagement = features.includes('urn:xmpp:mam:2');
    this.features.messageRetraction = features.includes('urn:xmpp:message-retract:0');
    this.features.lastActivity = features.includes('jabber:iq:last');
    this.features.messageCarbons = features.includes('urn:xmpp:carbons:2');
    
    // Roster and presence
    this.features.rosterVersioning = features.includes('urn:xmpp:features:rosterver');
    this.features.presenceSubscription = features.includes('http://jabber.org/protocol/pubsub#subscribe');
    
    // MUC features
    this.features.muc = features.includes('http://jabber.org/protocol/muc');
    this.features.mucAdmin = features.includes('http://jabber.org/protocol/muc#admin');
    this.features.mucOwner = features.includes('http://jabber.org/protocol/muc#owner');
    
    // File transfer
    this.features.httpFileUpload = features.includes('urn:xmpp:http:upload:0');
    this.features.sipFileTransfer = features.includes('urn:xmpp:jingle:apps:file-transfer:5');
    
    // Privacy
    this.features.blocking = features.includes('urn:xmpp:blocking');
    
    // Other features
    this.features.ping = features.includes('urn:xmpp:ping');
    this.features.time = features.includes('urn:xmpp:time');
    this.features.softwareVersion = features.includes('jabber:iq:version');
    this.features.entityCapabilities = features.includes('http://jabber.org/protocol/caps');
    
    // vCard
    this.features.vcard = features.includes('vcard-temp');
    this.features.vcardUpdate = features.includes('vcard-temp:x:update');
    this.features.avatar = features.includes('urn:xmpp:avatar:metadata');
  }

  private checkStreamFeatures(): void {
    // Stream features are typically announced during connection
    // This is a placeholder for additional stream feature checking
  }

  private isMucService(info: any): boolean {
    const identities = info.identities || [];
    return identities.some((identity: any) => 
      identity.category === 'conference' && identity.type === 'text'
    );
  }

  private getDefaultFeatures(): ServerFeatures {
    return {
      streamManagement: false,
      messageDeliveryReceipts: false,
      chatMarkers: false,
      messageArchiveManagement: false,
      messageRetraction: false,
      lastActivity: false,
      messageCarbons: false,
      rosterVersioning: false,
      presenceSubscription: false,
      muc: false,
      mucAdmin: false,
      mucOwner: false,
      sipFileTransfer: false,
      httpFileUpload: false,
      blocking: false,
      ping: false,
      time: false,
      softwareVersion: false,
      entityCapabilities: false,
      vcard: false,
      vcardUpdate: false,
      avatar: false
    };
  }
}
