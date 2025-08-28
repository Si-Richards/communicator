import { XmppClient, XmppConnectionConfig, ConnectionState } from './core/client';
import { XmppEventBus } from './core/eventBus';
import { StreamManager } from './modules/stream';
import { DiscoManager } from './modules/disco';
import { RosterPresenceManager } from './modules/rosterPresence';
import { MessageManager } from './modules/messages';
import { MucManager } from './modules/muc';
import { FileUploadManager } from './modules/fileUpload';
import { VCardManager } from './modules/vcard';
import { BlockingManager } from './modules/blocking';
import { StorageManager } from './persistence/storage';
import { logger } from '@/lib/logger';

export interface XmppServiceConfig extends XmppConnectionConfig {
  // Additional service-level config can go here
}

export class XmppService {
  private client: XmppClient;
  private eventBus: XmppEventBus;
  
  // Managers
  private streamManager: StreamManager;
  private discoManager: DiscoManager;
  private rosterPresenceManager: RosterPresenceManager;
  private messageManager: MessageManager;
  private mucManager: MucManager;
  private fileUploadManager: FileUploadManager;
  private vcardManager: VCardManager;
  private blockingManager: BlockingManager;
  private storageManager: StorageManager;

  constructor() {
    this.eventBus = new XmppEventBus();
    this.client = new XmppClient(this.eventBus);
    
    // Initialize managers
    this.streamManager = new StreamManager(this.client, this.eventBus);
    this.discoManager = new DiscoManager(this.client, this.eventBus);
    this.rosterPresenceManager = new RosterPresenceManager(this.client, this.eventBus);
    this.messageManager = new MessageManager(this.client, this.eventBus);
    this.mucManager = new MucManager(this.client, this.eventBus);
    this.fileUploadManager = new FileUploadManager(this.client, this.eventBus);
    this.vcardManager = new VCardManager(this.client, this.eventBus);
    this.blockingManager = new BlockingManager(this.client, this.eventBus);
    this.storageManager = new StorageManager(this.eventBus);

    this.setupEventHandlers();
  }

  // Connection methods
  async connect(config: XmppServiceConfig): Promise<void> {
    try {
      await this.client.connect(config);
      
      // Initialize features after connection
      await this.initializeFeatures();
      
      // Load persisted data
      await this.storageManager.loadPersistedData();
      
      logger.info('XMPP service connected and initialized');
    } catch (error) {
      logger.error('Failed to connect XMPP service:', error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    await this.client.disconnect();
    this.cleanup();
  }

  getConnectionState(): ConnectionState {
    return this.client.getConnectionState();
  }

  isConnected(): boolean {
    return this.client.isConnected();
  }

  // Event subscription
  on<T = any>(event: string, callback: (data: T) => void): () => void {
    return this.eventBus.on(event, callback);
  }

  once<T = any>(event: string, callback: (data: T) => void): () => void {
    return this.eventBus.once(event, callback);
  }

  off(event: string, callback?: (data: any) => void): void {
    this.eventBus.off(event, callback);
  }

  // Manager access
  getRosterPresenceManager(): RosterPresenceManager {
    return this.rosterPresenceManager;
  }

  getMessageManager(): MessageManager {
    return this.messageManager;
  }

  getMucManager(): MucManager {
    return this.mucManager;
  }

  getFileUploadManager(): FileUploadManager {
    return this.fileUploadManager;
  }

  getVCardManager(): VCardManager {
    return this.vcardManager;
  }

  getBlockingManager(): BlockingManager {
    return this.blockingManager;
  }

  getStorageManager(): StorageManager {
    return this.storageManager;
  }

  getDiscoManager(): DiscoManager {
    return this.discoManager;
  }

  getStreamManager(): StreamManager {
    return this.streamManager;
  }

  // Utility methods
  getEventBus(): XmppEventBus {
    return this.eventBus;
  }

  getClient(): XmppClient {
    return this.client;
  }

  private async initializeFeatures(): Promise<void> {
    try {
      // Discover server features
      await this.discoManager.discoverServerFeatures();
      
      // Enable stream management if supported
      await this.streamManager.enableIfSupported();
      
      // Enable message carbons if supported
      await this.messageManager.enableCarbonsIfSupported();
      
      // Fetch roster
      await this.rosterPresenceManager.fetchRoster();
      
      // Send initial presence
      await this.rosterPresenceManager.sendInitialPresence();
      
      logger.info('XMPP features initialized');
    } catch (error) {
      logger.error('Error initializing XMPP features:', error);
    }
  }

  private setupEventHandlers(): void {
    // Handle connection events
    this.eventBus.on('client:online', () => {
      this.initializeFeatures().catch(console.error);
    });

    this.eventBus.on('client:offline', () => {
      this.cleanup();
    });

    // Handle stanzas
    this.eventBus.on('stanza:received', ({ stanza }) => {
      this.routeStanza(stanza);
    });
  }

  private routeStanza(stanza: any): void {
    const name = stanza.name;
    const type = stanza.attrs.type;

    try {
      switch (name) {
        case 'message':
          this.messageManager.handleStanza(stanza);
          break;
        case 'presence':
          this.rosterPresenceManager.handlePresenceStanza(stanza);
          break;
        case 'iq':
          this.routeIqStanza(stanza);
          break;
        default:
          logger.debug('Unhandled stanza:', name, type);
      }
    } catch (error) {
      logger.error('Error routing stanza:', error, stanza);
    }
  }

  private routeIqStanza(stanza: any): void {
    // Check for specific namespaces and route accordingly
    const query = stanza.getChild('query');
    const xmlns = query?.attrs?.xmlns;

    if (xmlns) {
      switch (xmlns) {
        case 'jabber:iq:roster':
          this.rosterPresenceManager.handleRosterStanza(stanza);
          break;
        case 'http://jabber.org/protocol/disco#info':
        case 'http://jabber.org/protocol/disco#items':
          this.discoManager.handleStanza(stanza);
          break;
        default:
          // Check other managers
          if (this.streamManager.canHandle(stanza)) {
            this.streamManager.handleStanza(stanza);
          } else if (this.mucManager.canHandle(stanza)) {
            this.mucManager.handleStanza(stanza);
          } else if (this.fileUploadManager.canHandle(stanza)) {
            this.fileUploadManager.handleStanza(stanza);
          } else if (this.vcardManager.canHandle(stanza)) {
            this.vcardManager.handleStanza(stanza);
          } else if (this.blockingManager.canHandle(stanza)) {
            this.blockingManager.handleStanza(stanza);
          }
          break;
      }
    } else {
      // Route based on child elements for non-query IQs
      if (this.streamManager.canHandle(stanza)) {
        this.streamManager.handleStanza(stanza);
      } else if (this.mucManager.canHandle(stanza)) {
        this.mucManager.handleStanza(stanza);
      } else if (this.fileUploadManager.canHandle(stanza)) {
        this.fileUploadManager.handleStanza(stanza);
      } else if (this.vcardManager.canHandle(stanza)) {
        this.vcardManager.handleStanza(stanza);
      } else if (this.blockingManager.canHandle(stanza)) {
        this.blockingManager.handleStanza(stanza);
      }
    }
  }

  private cleanup(): void {
    // Clean up any ongoing operations
    this.streamManager.cleanup();
    this.messageManager.cleanup();
    this.mucManager.cleanup();
    this.fileUploadManager.cleanup();
    this.vcardManager.cleanup();
    this.blockingManager.cleanup();
  }
}