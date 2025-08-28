import { Client, client as createClient } from '@xmpp/client';
import { XmppEventBus } from './eventBus';
import { logger } from '@/lib/logger';

export interface XmppConnectionConfig {
  websocketUrl: string;
  domain: string;
  username: string;
  password: string;
  resource?: string;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'authenticating' | 'resuming' | 'error';

export class XmppClient {
  private client: Client | null = null;
  private config: XmppConnectionConfig | null = null;
  private eventBus: XmppEventBus;
  private connectionState: ConnectionState = 'disconnected';
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private baseRetryDelay = 1000;

  constructor(eventBus: XmppEventBus) {
    this.eventBus = eventBus;
  }

  async connect(config: XmppConnectionConfig): Promise<void> {
    try {
      this.config = config;
      this.setConnectionState('connecting');

      const service = `${config.websocketUrl}?domain=${config.domain}`;
      
      this.client = createClient({
        service,
        domain: config.domain,
        resource: config.resource || 'webclient',
        username: config.username,
        password: config.password,
      });

      this.setupEventHandlers();

      await this.client.start();
      
      logger.info('XMPP client connected successfully');
      this.setConnectionState('connected');
      this.reconnectAttempts = 0;
      
    } catch (error) {
      logger.error('Failed to connect XMPP client:', error);
      this.setConnectionState('error');
      this.scheduleReconnect();
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.client) {
      try {
        await this.client.stop();
      } catch (error) {
        logger.error('Error stopping XMPP client:', error);
      }
      this.client = null;
    }

    this.setConnectionState('disconnected');
  }

  getClient(): Client | null {
    return this.client;
  }

  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  getConfig(): XmppConnectionConfig | null {
    return this.config;
  }

  isConnected(): boolean {
    return this.connectionState === 'connected' && this.client?.status === 'online';
  }

  send(stanza: any): Promise<void> {
    if (!this.isConnected() || !this.client) {
      throw new Error('XMPP client not connected');
    }
    return this.client.send(stanza);
  }

  private setupEventHandlers(): void {
    if (!this.client) return;

    this.client.on('online', (address) => {
      logger.info('XMPP client online:', address.toString());
      this.setConnectionState('connected');
      this.eventBus.emit('client:online', { address: address.toString() });
    });

    this.client.on('offline', () => {
      logger.info('XMPP client offline');
      this.setConnectionState('disconnected');
      this.eventBus.emit('client:offline', {});
      this.scheduleReconnect();
    });

    this.client.on('error', (error) => {
      logger.error('XMPP client error:', error);
      this.setConnectionState('error');
      this.eventBus.emit('client:error', { error });
      this.scheduleReconnect();
    });

    this.client.on('stanza', (stanza) => {
      this.eventBus.emit('stanza:received', { stanza });
    });

    this.client.on('status', (status) => {
      logger.debug('XMPP client status:', status);
      if (status === 'connecting') {
        this.setConnectionState('connecting');
      } else if (status === 'authenticating') {
        this.setConnectionState('authenticating');
      }
    });
  }

  private setConnectionState(state: ConnectionState): void {
    if (this.connectionState !== state) {
      const previousState = this.connectionState;
      this.connectionState = state;
      this.eventBus.emit('connection:stateChanged', { 
        state, 
        previousState,
        timestamp: new Date()
      });
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.reconnectAttempts >= this.maxReconnectAttempts) {
      return;
    }

    const delay = Math.min(
      this.baseRetryDelay * Math.pow(2, this.reconnectAttempts),
      30000 // Max 30 seconds
    );

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.reconnectAttempts++;
      
      if (this.config && this.reconnectAttempts <= this.maxReconnectAttempts) {
        logger.info(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
        try {
          await this.connect(this.config);
        } catch (error) {
          // Will schedule another reconnect on error
        }
      }
    }, delay);
  }
}