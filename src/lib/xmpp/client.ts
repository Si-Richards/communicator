import { client, xml, jid as JID } from '@xmpp/client';
import debug from '@xmpp/debug';
import { XmppConnectionStatus, XmppMessage, XmppContact, MessagingEventHandlers, XmppFeatureFlags } from '../../types/xmpp';
import { xmppStorage } from './storage';

export class XmppClient {
  private client: any;
  private status: XmppConnectionStatus = {
    status: 'disconnected',
    resumeSupported: false
  };
  private eventHandlers: Partial<MessagingEventHandlers> = {};
  private features: XmppFeatureFlags;
  private debugMode = false;
  private messageListeners: Array<(event: any) => void> = [];
  private presenceListeners: Array<(event: any) => void> = [];
  private streamManagementEnabled = false;
  private pendingMessages = new Map<string, any>();

  constructor(
    serviceUrl: string,
    domain: string,
    resource: string,
    features: Partial<XmppFeatureFlags> = {},
    eventHandlers: Partial<MessagingEventHandlers> = {},
    debugMode = false
  ) {
    this.features = {
      enableStreamManagement: true,
      enableCarbons: true,
      enableMAM: true,
      enableMUC: true,
      enableHTTPUpload: true,
      enableVCard: true,
      enableBlocking: true,
      enableReceipts: true,
      enableMarkers: true,
      enableTyping: true,
      enableEdit: true,
      enableRetract: true,
      enableReactions: false,
      ...features
    };

    this.eventHandlers = eventHandlers;
    this.debugMode = debugMode;

    this.client = client({
      service: serviceUrl,
      domain,
      resource
    });

    if (debugMode) {
      debug(this.client, true);
    }

    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    this.client.on('online', (address: any) => {
      this.status = { 
        status: 'connected', 
        resumeSupported: this.streamManagementEnabled,
        streamId: address.toString()
      };
      this.eventHandlers.onConnectionStatus?.(this.status);
      this.requestRoster();
      this.enableFeatures();
      this.flushOutbox();
    });

    this.client.on('offline', () => {
      this.status = { status: 'disconnected', resumeSupported: false };
      this.eventHandlers.onConnectionStatus?.(this.status);
    });

    this.client.on('error', (err: Error) => {
      this.status = { 
        status: 'error', 
        error: err.message, 
        resumeSupported: false 
      };
      this.eventHandlers.onConnectionStatus?.(this.status);
      this.eventHandlers.onError?.(err);
    });

    this.client.on('stanza', (stanza: any) => {
      this.handleStanza(stanza);
    });
  }

  async connect(jid: string, password: string): Promise<void> {
    try {
      this.status = { status: 'connecting', resumeSupported: false };
      this.eventHandlers.onConnectionStatus?.(this.status);
      
      await this.client.start({
        username: JID(jid).local,
        password
      });
    } catch (error) {
      this.status = { 
        status: 'error', 
        error: error instanceof Error ? error.message : 'Connection failed',
        resumeSupported: false 
      };
      this.eventHandlers.onConnectionStatus?.(this.status);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    await this.client.stop();
  }

  getStatus(): XmppConnectionStatus {
    return this.status;
  }

  private async enableFeatures(): Promise<void> {
    if (this.features.enableStreamManagement) {
      await this.enableStreamManagement();
    }

    if (this.features.enableCarbons) {
      await this.enableCarbons();
    }

    // Request initial presence
    await this.sendPresence();
  }

  private async enableStreamManagement(): Promise<void> {
    try {
      const enable = xml('enable', {
        xmlns: 'urn:xmpp:sm:3',
        resume: 'true'
      });
      
      await this.client.send(enable);
      this.streamManagementEnabled = true;
    } catch (error) {
      console.warn('Stream management not available:', error);
    }
  }

  private async enableCarbons(): Promise<void> {
    try {
      const enable = xml('iq', {
        type: 'set',
        id: 'enable-carbons'
      }, xml('enable', { xmlns: 'urn:xmpp:carbons:2' }));
      
      await this.client.send(enable);
    } catch (error) {
      console.warn('Message Carbons not available:', error);
    }
  }

  private async sendPresence(show?: string, status?: string): Promise<void> {
    const presence = xml('presence');
    
    if (show) {
      presence.append(xml('show', {}, show));
    }
    
    if (status) {
      presence.append(xml('status', {}, status));
    }

    // Add capabilities
    presence.append(xml('c', {
      xmlns: 'http://jabber.org/protocol/caps',
      hash: 'sha-1',
      node: 'https://webrtc-app.example.com',
      ver: '1.0.0'
    }));

    await this.client.send(presence);
  }

  private async requestRoster(): Promise<void> {
    try {
      const iq = xml('iq', { type: 'get', id: 'roster-request' },
        xml('query', { xmlns: 'jabber:iq:roster' })
      );
      
      const response = await this.client.iqCaller.request(iq);
      this.handleRosterResult(response);
    } catch (error) {
      console.error('Failed to request roster:', error);
    }
  }

  private handleRosterResult(iq: any): void {
    const query = iq.getChild('query', 'jabber:iq:roster');
    if (!query) return;

    for (const item of query.getChildren('item')) {
      const contact: XmppContact = {
        jid: item.attrs.jid,
        name: item.attrs.name || JID(item.attrs.jid).local,
        subscription: item.attrs.subscription as any,
        presence: 'unavailable'
      };

      xmppStorage.saveContact(contact);
      this.eventHandlers.onPresence?.(contact);
    }
  }

  private handleStanza(stanza: any): void {
    switch (stanza.name) {
      case 'message':
        this.handleMessage(stanza);
        break;
      case 'presence':
        this.handlePresence(stanza);
        break;
      case 'iq':
        this.handleIq(stanza);
        break;
    }
  }

  private async handleMessage(stanza: any): Promise<void> {
    const from = stanza.attrs.from;
    const to = stanza.attrs.to;
    const type = stanza.attrs.type || 'chat';
    const id = stanza.attrs.id;

    // Handle different message types
    const body = stanza.getChildText('body');
    if (!body) {
      // Could be a receipt, marker, typing indicator, etc.
      this.handleMessageEvents(stanza);
      return;
    }

    // Handle delay (XEP-0203)
    const delay = stanza.getChild('delay', 'urn:xmpp:delay');
    const timestamp = delay ? new Date(delay.attrs.stamp) : new Date();

    const message: XmppMessage = {
      id: id || this.generateMessageId(),
      from: JID(from).bare().toString(),
      to: JID(to).bare().toString(),
      body,
      timestamp,
      type: type as 'chat' | 'groupchat',
      threadId: this.getThreadId(from, to, type)
    };

    // Handle file uploads
    const oob = stanza.getChild('x', 'jabber:x:oob');
    if (oob) {
      const url = oob.getChildText('url');
      if (url) {
        message.fileUrl = url;
        message.fileName = url.split('/').pop();
      }
    }

    await xmppStorage.saveMessage(message);
    this.updateThreadWithMessage(message);
    this.eventHandlers.onMessage?.(message);

    // Send receipt if requested
    if (this.features.enableReceipts && stanza.getChild('request', 'urn:xmpp:receipts')) {
      await this.sendReceipt(from, id);
    }
  }

  private handleMessageEvents(stanza: any): void {
    const from = stanza.attrs.from;
    const id = stanza.attrs.id;

    // Handle receipts (XEP-0184)
    const received = stanza.getChild('received', 'urn:xmpp:receipts');
    if (received) {
      const messageId = received.attrs.id;
      this.eventHandlers.onReceipt?.(messageId, from, 'delivered');
      xmppStorage.updateMessage(messageId, { receipt: 'delivered' });
      return;
    }

    // Handle chat markers (XEP-0333)
    const displayed = stanza.getChild('displayed', 'urn:xmpp:chat-markers:0');
    if (displayed) {
      const messageId = displayed.attrs.id;
      this.eventHandlers.onMarker?.(messageId, from, 'displayed');
      xmppStorage.updateMessage(messageId, { marker: 'displayed' });
      return;
    }

    // Handle typing indicators (XEP-0085)
    const composing = stanza.getChild('composing', 'http://jabber.org/protocol/chatstates');
    const paused = stanza.getChild('paused', 'http://jabber.org/protocol/chatstates');
    
    if (composing || paused) {
      const threadId = this.getThreadId(from, stanza.attrs.to, stanza.attrs.type);
      this.eventHandlers.onTyping?({
        jid: from,
        threadId,
        isTyping: !!composing,
        timestamp: new Date()
      });
    }
  }

  private async handlePresence(stanza: any): Promise<void> {
    const from = stanza.attrs.from;
    const type = stanza.attrs.type;
    const show = stanza.getChildText('show') || 'available';
    const status = stanza.getChildText('status');

    const bareJid = JID(from).bare().toString();
    
    // Get existing contact or create new one
    const contacts = await xmppStorage.getRoster();
    let contact = contacts.find(c => c.jid === bareJid);
    
    if (!contact) {
      contact = {
        jid: bareJid,
        name: JID(from).local,
        subscription: 'none',
        presence: 'unavailable'
      };
    }

    // Update presence
    if (type === 'unavailable') {
      contact.presence = 'unavailable';
      contact.lastSeen = new Date();
    } else {
      contact.presence = show as any;
      contact.status = status;
    }

    await xmppStorage.saveContact(contact);
    this.eventHandlers.onPresence?.(contact);
  }

  private handleIq(stanza: any): void {
    // Handle various IQ stanzas
    const type = stanza.attrs.type;
    
    if (type === 'result' || type === 'error') {
      // Handle responses
      return;
    }

    // Handle requests
    const query = stanza.getChild('query');
    if (query) {
      const xmlns = query.attrs.xmlns;
      
      switch (xmlns) {
        case 'jabber:iq:roster':
          this.handleRosterResult(stanza);
          break;
        case 'jabber:iq:last':
          this.handleLastActivity(stanza);
          break;
      }
    }
  }

  private handleLastActivity(stanza: any): void {
    // Handle last activity queries
    const query = stanza.getChild('query', 'jabber:iq:last');
    if (query && stanza.attrs.type === 'get') {
      // Send last activity response
      const response = xml('iq', {
        type: 'result',
        to: stanza.attrs.from,
        id: stanza.attrs.id
      }, xml('query', {
        xmlns: 'jabber:iq:last',
        seconds: '0'
      }));
      
      this.client.send(response);
    }
  }

  async sendMessage(to: string, body: string, type: 'chat' | 'groupchat' = 'chat'): Promise<string> {
    const messageId = this.generateMessageId();
    
    const message = xml('message', {
      to,
      type,
      id: messageId
    });

    message.append(xml('body', {}, body));

    // Add receipt request
    if (this.features.enableReceipts && type === 'chat') {
      message.append(xml('request', { xmlns: 'urn:xmpp:receipts' }));
    }

    // Add chat state
    if (this.features.enableTyping) {
      message.append(xml('active', { xmlns: 'http://jabber.org/protocol/chatstates' }));
    }

    try {
      await this.client.send(message);
      
      // Store sent message
      const xmppMessage: XmppMessage = {
        id: messageId,
        from: this.client.jid.bare().toString(),
        to: JID(to).bare().toString(),
        body,
        timestamp: new Date(),
        type,
        threadId: this.getThreadId(this.client.jid.toString(), to, type)
      };

      await xmppStorage.saveMessage(xmppMessage);
      this.updateThreadWithMessage(xmppMessage);
      
      return messageId;
    } catch (error) {
      // Add to outbox for retry
      await xmppStorage.addToOutbox({
        id: messageId,
        to,
        body,
        type,
        timestamp: new Date(),
        retries: 0
      });
      throw error;
    }
  }

  async sendTyping(to: string, isTyping: boolean): Promise<void> {
    if (!this.features.enableTyping) return;

    const message = xml('message', { to, type: 'chat' });
    
    if (isTyping) {
      message.append(xml('composing', { xmlns: 'http://jabber.org/protocol/chatstates' }));
    } else {
      message.append(xml('paused', { xmlns: 'http://jabber.org/protocol/chatstates' }));
    }

    await this.client.send(message);
  }

  async sendReceipt(to: string, messageId: string): Promise<void> {
    const message = xml('message', { to, type: 'chat' });
    message.append(xml('received', {
      xmlns: 'urn:xmpp:receipts',
      id: messageId
    }));

    await this.client.send(message);
  }

  async sendMarker(to: string, messageId: string, type: 'displayed'): Promise<void> {
    const message = xml('message', { to, type: 'chat' });
    message.append(xml(type, {
      xmlns: 'urn:xmpp:chat-markers:0',
      id: messageId
    }));

    await this.client.send(message);
  }

  private async flushOutbox(): Promise<void> {
    const outboxMessages = await xmppStorage.getOutboxMessages();
    
    for (const msg of outboxMessages) {
      try {
        await this.sendMessage(msg.to, msg.body, msg.type);
        await xmppStorage.removeFromOutbox(msg.id);
      } catch (error) {
        // Increase retry count
        if (msg.retries < 3) {
          await xmppStorage.addToOutbox({
            ...msg,
            retries: msg.retries + 1
          });
        } else {
          await xmppStorage.removeFromOutbox(msg.id);
        }
      }
    }
  }

  private getThreadId(from: string, to: string, type: string): string {
    if (type === 'groupchat') {
      return JID(to).bare().toString();
    }
    
    const jid1 = JID(from).bare().toString();
    const jid2 = JID(to).bare().toString();
    return [jid1, jid2].sort().join('|');
  }

  private async updateThreadWithMessage(message: XmppMessage): Promise<void> {
    let thread = await xmppStorage.getThread(message.threadId);
    
    if (!thread) {
      const isGroupChat = message.type === 'groupchat';
      const otherJid = message.from === this.client.jid.bare().toString() 
        ? message.to 
        : message.from;
      
      thread = {
        id: message.threadId,
        type: message.type,
        jid: isGroupChat ? message.to : otherJid,
        name: isGroupChat ? JID(message.to).local : JID(otherJid).local,
        unreadCount: 0,
        isPinned: false,
        isMuted: false,
        isHidden: false
      };
    }

    thread.lastMessage = message;
    
    // Increment unread count if message is not from us
    if (message.from !== this.client.jid.bare().toString()) {
      thread.unreadCount = (thread.unreadCount || 0) + 1;
    }

    await xmppStorage.saveThread(thread);
  }

  private generateMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  // Public methods for external use
  async joinRoom(roomJid: string, nick?: string): Promise<void> {
    const presence = xml('presence', {
      to: `${roomJid}/${nick || JID(this.client.jid).local}`
    });
    
    presence.append(xml('x', { xmlns: 'http://jabber.org/protocol/muc' }));
    await this.client.send(presence);
  }

  async leaveRoom(roomJid: string): Promise<void> {
    const presence = xml('presence', {
      to: `${roomJid}/${JID(this.client.jid).local}`,
      type: 'unavailable'
    });
    
    await this.client.send(presence);
  }

  async requestHistory(jid: string, before?: Date, max = 50): Promise<void> {
    if (!this.features.enableMAM) return;

    const queryId = `mam_${Date.now()}`;
    const query = xml('iq', { type: 'set', id: queryId },
      xml('query', { xmlns: 'urn:xmpp:mam:2', queryid: queryId },
        xml('x', { xmlns: 'jabber:x:data', type: 'submit' },
          xml('field', { var: 'FORM_TYPE', type: 'hidden' },
            xml('value', {}, 'urn:xmpp:mam:2')
          ),
          xml('field', { var: 'with' },
            xml('value', {}, jid)
          )
        ),
        xml('set', { xmlns: 'http://jabber.org/protocol/rsm' },
          xml('max', {}, max.toString()),
          ...(before ? [xml('before', {}, before.toISOString())] : [])
        )
      )
    );

    await this.client.send(query);
  }

  updateEventHandlers(handlers: Partial<MessagingEventHandlers>): void {
    this.eventHandlers = { ...this.eventHandlers, ...handlers };
  }
}