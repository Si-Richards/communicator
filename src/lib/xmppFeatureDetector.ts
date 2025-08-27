// XEP feature detection and server capabilities
import { xml } from '@xmpp/client';
import { ServerFeatures } from '@/types/xmpp';

export class XmppFeatureDetector {
  private xmpp: any = null;
  private features: ServerFeatures = {
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
    ping: false,
    time: false,
    softwareVersion: false,
    entityCapabilities: false,
  };

  constructor() {}

  setXmppClient(xmpp: any) {
    this.xmpp = xmpp;
  }

  getFeatures(): ServerFeatures {
    return { ...this.features };
  }

  // Discover server features
  async discoverServerFeatures(serverJid?: string): Promise<ServerFeatures> {
    if (!this.xmpp) return this.features;

    const targetJid = serverJid || this.xmpp.jid?.domain;
    if (!targetJid) return this.features;

    try {
      // Service discovery info
      const discoInfoIq = xml('iq', {
        type: 'get',
        to: targetJid,
        id: crypto.randomUUID()
      }, xml('query', { xmlns: 'http://jabber.org/protocol/disco#info' }));

      const response = await this.xmpp.iqCaller.request(discoInfoIq);
      const query = response.getChild('query', 'http://jabber.org/protocol/disco#info');

      if (query) {
        this.parseDiscoFeatures(query);
      }

      // Also check stream features
      this.parseStreamFeatures();

      console.log('Discovered server features:', this.features);
      return this.features;
    } catch (error) {
      console.error('Failed to discover server features:', error);
      return this.features;
    }
  }

  // Parse disco#info features
  private parseDiscoFeatures(query: any) {
    const features = query.getChildren('feature');
    
    for (const feature of features) {
      const featureVar = feature.attrs.var;
      
      switch (featureVar) {
        // Stream Management
        case 'urn:xmpp:sm:3':
        case 'urn:xmpp:sm:2':
          this.features.streamManagement = true;
          break;
          
        // Message Delivery Receipts
        case 'urn:xmpp:receipts':
          this.features.messageDeliveryReceipts = true;
          break;
          
        // Chat Markers
        case 'urn:xmpp:chat-markers:0':
          this.features.chatMarkers = true;
          break;
          
        // Message Archive Management
        case 'urn:xmpp:mam:2':
        case 'urn:xmpp:mam:1':
          this.features.messageArchiveManagement = true;
          break;
          
        // Message Retraction
        case 'urn:xmpp:message-retract:0':
          this.features.messageRetraction = true;
          break;
          
        // Last Activity
        case 'jabber:iq:last':
          this.features.lastActivity = true;
          break;
          
        // Message Carbons
        case 'urn:xmpp:carbons:2':
          this.features.messageCarbons = true;
          break;
          
        // Roster Versioning
        case 'urn:xmpp:features:rosterver':
          this.features.rosterVersioning = true;
          break;
          
        // Presence Subscription
        case 'urn:xmpp:features:pre-approval':
          this.features.presenceSubscription = true;
          break;
          
        // MUC
        case 'http://jabber.org/protocol/muc':
          this.features.muc = true;
          break;
        case 'http://jabber.org/protocol/muc#admin':
          this.features.mucAdmin = true;
          break;
        case 'http://jabber.org/protocol/muc#owner':
          this.features.mucOwner = true;
          break;
          
        // File Transfer
        case 'urn:xmpp:jingle:apps:file-transfer:5':
          this.features.sipFileTransfer = true;
          break;
        case 'urn:xmpp:http:upload:0':
          this.features.httpFileUpload = true;
          break;
          
        // Other useful features
        case 'urn:xmpp:ping':
          this.features.ping = true;
          break;
        case 'urn:xmpp:time':
          this.features.time = true;
          break;
        case 'jabber:iq:version':
          this.features.softwareVersion = true;
          break;
        case 'http://jabber.org/protocol/caps':
          this.features.entityCapabilities = true;
          break;
      }
    }
  }

  // Parse stream features (from connection handshake)
  private parseStreamFeatures() {
    // Stream management is usually advertised in stream features
    // This would be called during the connection process
    // For now, we rely on disco#info detection
  }

  // Enable message carbons if supported
  async enableMessageCarbons(): Promise<boolean> {
    if (!this.xmpp || !this.features.messageCarbons) return false;

    try {
      const enableIq = xml('iq', {
        type: 'set',
        id: crypto.randomUUID()
      }, xml('enable', { xmlns: 'urn:xmpp:carbons:2' }));

      await this.xmpp.iqCaller.request(enableIq);
      console.log('Message carbons enabled');
      return true;
    } catch (error) {
      console.error('Failed to enable message carbons:', error);
      return false;
    }
  }

  // Query last activity of a contact (XEP-0012)
  async queryLastActivity(jid: string): Promise<Date | null> {
    if (!this.xmpp || !this.features.lastActivity) return null;

    try {
      const lastActivityIq = xml('iq', {
        type: 'get',
        to: jid,
        id: crypto.randomUUID()
      }, xml('query', { xmlns: 'jabber:iq:last' }));

      const response = await this.xmpp.iqCaller.request(lastActivityIq);
      const query = response.getChild('query', 'jabber:iq:last');
      
      if (query && query.attrs.seconds) {
        const secondsAgo = parseInt(query.attrs.seconds);
        return new Date(Date.now() - (secondsAgo * 1000));
      }
      
      return null;
    } catch (error) {
      console.error('Failed to query last activity for', jid, error);
      return null;
    }
  }

  // Send ping to check connection
  async ping(targetJid?: string): Promise<number | null> {
    if (!this.xmpp || !this.features.ping) return null;

    const startTime = Date.now();
    const target = targetJid || this.xmpp.jid?.domain;

    try {
      const pingIq = xml('iq', {
        type: 'get',
        to: target,
        id: crypto.randomUUID()
      }, xml('ping', { xmlns: 'urn:xmpp:ping' }));

      await this.xmpp.iqCaller.request(pingIq);
      return Date.now() - startTime;
    } catch (error) {
      console.error('Ping failed:', error);
      return null;
    }
  }

  // Discover MUC services
  async discoverMucServices(): Promise<string[]> {
    if (!this.xmpp) return [];

    const serverJid = this.xmpp.jid?.domain;
    if (!serverJid) return [];

    try {
      const discoItemsIq = xml('iq', {
        type: 'get',
        to: serverJid,
        id: crypto.randomUUID()
      }, xml('query', { xmlns: 'http://jabber.org/protocol/disco#items' }));

      const response = await this.xmpp.iqCaller.request(discoItemsIq);
      const query = response.getChild('query', 'http://jabber.org/protocol/disco#items');

      if (!query) return [];

      const services = [];
      const items = query.getChildren('item');

      for (const item of items) {
        const itemJid = item.attrs.jid;
        if (itemJid && (itemJid.includes('conference') || itemJid.includes('muc'))) {
          // Verify it's actually a MUC service
          try {
            const serviceInfo = await this.discoverServiceInfo(itemJid);
            if (serviceInfo.includes('http://jabber.org/protocol/muc')) {
              services.push(itemJid);
            }
          } catch (error) {
            // Skip services that don't respond
          }
        }
      }

      return services;
    } catch (error) {
      console.error('Failed to discover MUC services:', error);
      return [];
    }
  }

  // Discover service info for a specific JID
  async discoverServiceInfo(serviceJid: string): Promise<string[]> {
    if (!this.xmpp) return [];

    try {
      const discoInfoIq = xml('iq', {
        type: 'get',
        to: serviceJid,
        id: crypto.randomUUID()
      }, xml('query', { xmlns: 'http://jabber.org/protocol/disco#info' }));

      const response = await this.xmpp.iqCaller.request(discoInfoIq);
      const query = response.getChild('query', 'http://jabber.org/protocol/disco#info');

      if (!query) return [];

      const features = query.getChildren('feature');
      return features.map(f => f.attrs.var).filter(Boolean);
    } catch (error) {
      console.error('Failed to discover service info for', serviceJid, error);
      return [];
    }
  }
}
