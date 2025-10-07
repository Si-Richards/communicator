// XMPP Client - Core connection and protocol handling
import { client as createClient, xml, jid } from '@xmpp/client';
import debug from '@xmpp/debug';
import { ConnectionStatus, XmppMessage, ServerFeatures, QueuedMessage } from './types';
import { parseStreamFeatures, logStreamFeatures, type StreamFeatures as ParsedStreamFeatures } from '../xmppStreamFeatures';

interface XmppConfig {
  serviceUrl: string;
  domain: string;
  resource?: string;
  getCredentials: () => Promise<{ jid: string; password: string }>;
}

export class XmppClient {
  private client: ReturnType<typeof createClient> | null = null;
  private config: XmppConfig | null = null;
  private status: ConnectionStatus = 'disconnected';
  private features: ServerFeatures = {
    streamManagement: false,
    messageDeliveryReceipts: false,
    chatMarkers: false,
    messageArchiveManagement: false,
    messageCarbons: false,
    messageRetraction: false,
    lastActivity: false,
    muc: false,
    httpFileUpload: false,
    ping: false,
    blocking: false,
    vcard: false,
  };

  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private baseRetryDelay = 1000;

  private eventListeners: { [event: string]: Function[] } = {};
  private outboxQueue: QueuedMessage[] = [];

  // Stream Management state
  private smEnabled = false;
  private smAdvertised = false; // Server advertised SM in stream features
  private smId: string | null = null;
  private inboundCount = 0;
  private outboundCount = 0;
  private unackedStanzas: Array<{ id: string; stanza: any }> = [];
  private ackThreshold = 3; // Send ack after this many stanzas (reduced from 5)
  private ackTimer: NodeJS.Timeout | null = null;
  private cautionMode = false; // Send ACKs even if SM not formally enabled

  constructor(existingClient?: ReturnType<typeof createClient>) {
    if (existingClient) {
      this.client = existingClient;
      this.setupEventHandlers();
    }
  }

  on(event: string, callback: Function): void {
    if (!this.eventListeners[event]) {
      this.eventListeners[event] = [];
    }
    this.eventListeners[event].push(callback);
  }

  off(event: string, callback?: Function): void {
    if (!this.eventListeners[event]) return;
    
    if (callback) {
      this.eventListeners[event] = this.eventListeners[event].filter(cb => cb !== callback);
    } else {
      this.eventListeners[event] = [];
    }
  }

  private emit(event: string, data?: any): void {
    if (this.eventListeners[event]) {
      this.eventListeners[event].forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error('Event listener error:', error);
        }
      });
    }
  }

  async connect(config: XmppConfig): Promise<void> {
    if (this.client && this.status === 'connected') {
      return; // Already connected
    }

    this.config = config;
    this.setStatus('connecting');

    try {
      const credentials = await config.getCredentials();
      
      // Create client if not provided
      if (!this.client) {
        this.client = createClient({
          service: config.serviceUrl,
          domain: config.domain,
          resource: config.resource || 'webclient',
          username: jid(credentials.jid).local,
          password: credentials.password,
        });

        // Enable debug in development
        if (import.meta.env.DEV) {
          debug(this.client, true);
        }

        this.setupEventHandlers();
      }

      await this.client.start();
      this.reconnectAttempts = 0;
      
    } catch (error) {
      console.error('Failed to connect:', error);
      this.setStatus('error');
      this.scheduleReconnect();
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.stopAckTimer();

    if (this.client) {
      try {
        await this.client.stop();
      } catch (error) {
        console.error('Error stopping client:', error);
      }
    }

    this.setStatus('disconnected');
  }

  async send(stanza: any): Promise<void> {
    if (!this.client || this.status !== 'connected') {
      throw new Error('Client not connected');
    }

    const stanzaId = stanza.attrs.id || this.generateId();
    
    // Track for stream management
    if (this.smEnabled) {
      this.unackedStanzas.push({ id: stanzaId, stanza });
      this.outboundCount++;
    }

    return this.client.send(stanza);
  }

  // Queue message for offline sending
  queueMessage(message: Omit<QueuedMessage, 'id' | 'timestamp' | 'retryCount' | 'maxRetries'>): void {
    const queuedMessage: QueuedMessage = {
      ...message,
      id: this.generateId(),
      timestamp: new Date(),
      retryCount: 0,
      maxRetries: 3,
    };

    this.outboxQueue.push(queuedMessage);
    this.emit('outboxChanged', this.outboxQueue);
  }

  // Send queued messages
  async flushOutbox(): Promise<void> {
    if (this.status !== 'connected' || this.outboxQueue.length === 0) {
      return;
    }

    const queue = [...this.outboxQueue];
    this.outboxQueue = [];

    for (const message of queue) {
      try {
        const messageStanza = xml('message', {
          to: message.to,
          type: message.type,
          id: message.id,
        }, xml('body', {}, message.body));

        // Add delivery receipt request
        messageStanza.append(xml('request', { xmlns: 'urn:xmpp:receipts' }));

        await this.send(messageStanza);
        this.emit('messageSent', message);
      } catch (error) {
        console.error('Failed to send queued message:', error);
        
        if (message.retryCount < message.maxRetries) {
          message.retryCount++;
          this.outboxQueue.push(message);
        } else {
          this.emit('messageError', { message, error });
        }
      }
    }

    this.emit('outboxChanged', this.outboxQueue);
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  getFeatures(): ServerFeatures {
    return { ...this.features };
  }

  getJid(): string | null {
    return this.client?.jid?.toString() || null;
  }

  getUnderlyingClient(): ReturnType<typeof createClient> | null {
    return this.client;
  }

  // Public method to access iqCaller
  async iqRequest(stanza: any): Promise<any> {
    if (!this.client || this.status !== 'connected') {
      throw new Error('Client not connected');
    }
    return this.client.iqCaller.request(stanza);
  }

  generateId(): string {
    return Math.random().toString(36).substring(2, 15);
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status !== status) {
      const previous = this.status;
      this.status = status;
      this.emit('statusChanged', { status, previous });
    }
  }

  private setupEventHandlers(): void {
    if (!this.client) return;

    this.client.on('online', async (address) => {
      console.log('XMPP client online:', address.toString());
      this.setStatus('connected');
      
      // CRITICAL: Check stream features FIRST before disco
      // Stream Management is advertised in stream features, not disco#info
      await this.checkStreamFeaturesForSM();
      
      await this.discoverFeatures();
      await this.enableFeatures();
      await this.flushOutbox();
      
      this.emit('connected', { jid: address.toString() });
    });

    this.client.on('offline', () => {
      console.log('XMPP client offline');
      this.setStatus('disconnected');
      this.emit('disconnected');
      this.scheduleReconnect();
    });

    this.client.on('error', (error) => {
      console.error('XMPP client error:', error);
      this.setStatus('error');
      this.emit('error', error);
      this.scheduleReconnect();
    });

    this.client.on('stanza', (stanza) => {
      this.handleStanza(stanza);
    });

    this.client.on('status', (status) => {
      if (status === 'connecting') {
        this.setStatus('connecting');
      } else if (status === 'authenticating') {
        this.setStatus('authenticating');
      }
    });
  }

  private handleStanza(stanza: any): void {
    // Handle stream management
    if (this.handleStreamManagement(stanza)) {
      return;
    }

    // CRITICAL: ALWAYS count inbound stanzas, even if SM not formally enabled
    // ejabberd enforces ACK limits even when advertising SM as unsupported in disco
    if (['message', 'presence', 'iq'].includes(stanza.name)) {
      this.inboundCount++;
      
      // More aggressive ACK strategy to prevent "Too many unacked stanzas" errors
      const shouldAck = 
        (this.inboundCount % this.ackThreshold === 0) || // Every 3 stanzas
        (stanza.name === 'presence'); // Immediately for presence
      
      if (shouldAck) {
        this.sendAck();
      }
    }

    this.emit('stanza', stanza);
  }

  private handleStreamManagement(stanza: any): boolean {
    const name = stanza.name;
    const xmlns = stanza.attrs.xmlns;

    if (xmlns !== 'urn:xmpp:sm:3') return false;

    switch (name) {
      case 'enabled':
        this.smEnabled = true;
        this.smAdvertised = true;
        this.smId = stanza.attrs.id;
        this.inboundCount = 0;
        this.outboundCount = 0;
        this.cautionMode = false; // SM properly enabled, disable caution mode
        console.log('✅ Stream management enabled:', this.smId);
        this.startAckTimer();
        return true;

      case 'resumed':
        const h = parseInt(stanza.attrs.h) || 0;
        this.processAckedStanzas(h);
        this.emit('streamResumed');
        return true;

      case 'failed':
        console.log('⚠️  Stream resume failed, enabling caution mode');
        this.cautionMode = true; // Enable caution mode to send ACKs anyway
        this.resetStreamManagement();
        this.startAckTimer(); // Start ACK timer in caution mode
        return true;

      case 'a':
        const ackH = parseInt(stanza.attrs.h) || 0;
        this.processAckedStanzas(ackH);
        return true;

      case 'r':
        this.sendAck();
        return true;

      default:
        return false;
    }
  }

  /**
   * Check stream features for Stream Management support
   * CRITICAL: SM is advertised in <stream:features>, NOT in disco#info
   */
  private async checkStreamFeaturesForSM(): Promise<void> {
    if (!this.client) return;

    try {
      // Access the stream features from the client
      // @xmpp/client stores this internally after authentication
      const streamFeatures = (this.client as any).streamFeatures;
      
      if (streamFeatures) {
        const parsed = parseStreamFeatures(streamFeatures);
        logStreamFeatures(parsed);
        
        if (parsed.streamManagement) {
          this.smAdvertised = true;
          this.features.streamManagement = true;
          console.log('✅ Stream Management advertised in stream features');
        } else {
          // Server doesn't advertise SM, but we'll use caution mode anyway
          this.cautionMode = true;
          console.log('⚠️  Stream Management NOT advertised, enabling caution mode (send ACKs anyway)');
        }
      }
    } catch (error) {
      console.error('Failed to check stream features:', error);
      // Enable caution mode as fallback
      this.cautionMode = true;
    }
  }

  private async discoverFeatures(): Promise<void> {
    if (!this.client) return;

    try {
      // Discover server features via disco#info
      // NOTE: Stream Management is NOT reliably advertised here, check stream features instead
      const discoStanza = xml('iq', {
        type: 'get',
        to: this.config?.domain,
        id: this.generateId(),
      }, xml('query', { xmlns: 'http://jabber.org/protocol/disco#info' }));

      const response = await this.client.iqCaller.request(discoStanza);
      const query = response.getChild('query', 'http://jabber.org/protocol/disco#info');
      
      if (query) {
        const features = query.getChildren('feature');
        this.features = {
          // Use smAdvertised from stream features, not disco
          streamManagement: this.smAdvertised,
          messageDeliveryReceipts: features.some(f => f.attrs.var === 'urn:xmpp:receipts'),
          chatMarkers: features.some(f => f.attrs.var === 'urn:xmpp:chat-markers:0'),
          messageArchiveManagement: features.some(f => f.attrs.var === 'urn:xmpp:mam:2'),
          messageCarbons: features.some(f => f.attrs.var === 'urn:xmpp:carbons:2'),
          messageRetraction: features.some(f => f.attrs.var === 'urn:xmpp:message-retract:0'),
          lastActivity: features.some(f => f.attrs.var === 'jabber:iq:last'),
          muc: features.some(f => f.attrs.var === 'http://jabber.org/protocol/muc'),
          httpFileUpload: features.some(f => f.attrs.var === 'urn:xmpp:http:upload:0'),
          ping: features.some(f => f.attrs.var === 'urn:xmpp:ping'),
          blocking: features.some(f => f.attrs.var === 'urn:xmpp:blocking'),
          vcard: features.some(f => f.attrs.var === 'vcard-temp'),
        };
      }

      this.emit('featuresDiscovered', this.features);
    } catch (error) {
      console.error('Failed to discover features:', error);
    }
  }

  private async enableFeatures(): Promise<void> {
    // Enable stream management if advertised
    if (this.smAdvertised || this.features.streamManagement) {
      try {
        const enableStanza = xml('enable', {
          xmlns: 'urn:xmpp:sm:3',
          resume: 'true',
        });
        await this.send(enableStanza);
        
        // Wait for <enabled> response with timeout
        // If no response after 5 seconds, enable caution mode
        setTimeout(() => {
          if (!this.smEnabled && !this.cautionMode) {
            console.log('⚠️  No SM <enabled> response, enabling caution mode');
            this.cautionMode = true;
            this.startAckTimer();
          }
        }, 5000);
      } catch (error) {
        console.error('Failed to enable stream management:', error);
        this.cautionMode = true;
        this.startAckTimer();
      }
    } else {
      // SM not advertised, but enable caution mode anyway
      console.log('⚠️  SM not supported, enabling caution mode');
      this.cautionMode = true;
      this.startAckTimer();
    }

    // Enable message carbons
    if (this.features.messageCarbons) {
      try {
        const enableStanza = xml('iq', {
          type: 'set',
          id: this.generateId(),
        }, xml('enable', { xmlns: 'urn:xmpp:carbons:2' }));
        
        await this.client?.iqCaller.request(enableStanza);
        console.log('Message carbons enabled');
      } catch (error) {
        console.error('Failed to enable carbons:', error);
      }
    }
  }

  private processAckedStanzas(h: number): void {
    const ackedCount = h - (this.outboundCount - this.unackedStanzas.length);
    if (ackedCount > 0) {
      this.unackedStanzas.splice(0, ackedCount);
    }
  }

  private sendAck(): void {
    // CRITICAL: Send ACKs in caution mode even if SM not formally enabled
    // This prevents "Too many unacked stanzas" errors from ejabberd
    if (!this.client || (!this.smEnabled && !this.cautionMode)) return;

    const ackStanza = xml('a', {
      xmlns: 'urn:xmpp:sm:3',
      h: this.inboundCount.toString(),
    });

    // Use send directly without tracking to avoid recursion
    this.client.send(ackStanza).catch(err => {
      console.debug('ACK send failed (expected if SM not enabled):', err.message);
    });
  }

  private startAckTimer(): void {
    if (this.ackTimer) {
      clearInterval(this.ackTimer);
    }

    // Aggressive ACK timer: every 2 seconds (reduced from 3)
    // Send ACKs in both normal mode and caution mode
    this.ackTimer = setInterval(() => {
      if ((this.smEnabled || this.cautionMode) && this.inboundCount > 0) {
        this.sendAck();
      }
    }, 2000);
  }

  private stopAckTimer(): void {
    if (this.ackTimer) {
      clearInterval(this.ackTimer);
      this.ackTimer = null;
    }
  }

  private resetStreamManagement(): void {
    this.smEnabled = false;
    this.smId = null;
    this.inboundCount = 0;
    this.outboundCount = 0;
    this.unackedStanzas = [];
    // Don't stop ACK timer - keep it running in caution mode
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.reconnectAttempts >= this.maxReconnectAttempts) {
      return;
    }

    const delay = Math.min(
      this.baseRetryDelay * Math.pow(2, this.reconnectAttempts),
      30000
    );

    this.setStatus('reconnecting');

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.reconnectAttempts++;

      if (this.config && this.reconnectAttempts <= this.maxReconnectAttempts) {
        console.log(`Reconnecting (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
        try {
          await this.connect(this.config);
        } catch (error) {
          // Will schedule another reconnect
        }
      }
    }, delay);
  }
}