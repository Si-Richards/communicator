/**
 * XEP-0198: Stream Management
 * Provides reliable message delivery and session resumption
 */

import { xml } from '@xmpp/client';
import { XmppClient } from '../core/client';
import { XmppEventBus } from '../core/eventBus';
import { XmppUtils } from '../core/utils';
import { logger } from '@/lib/logger';

interface StreamState {
  enabled: boolean;
  resumed: boolean;
  id?: string;
  location?: string;
  inboundCount: number;
  outboundCount: number;
  lastAckedCount: number;
  ackTimer?: NodeJS.Timeout;
  resumptionTime?: number;
}

interface UnackedStanza {
  id: string;
  stanza: any;
  timestamp: Date;
}

export class StreamManager {
  private client: XmppClient;
  private eventBus: XmppEventBus;
  private state: StreamState;
  private unackedStanzas: UnackedStanza[] = [];
  private maxUnackedStanzas = 100;
  private ackRequestInterval = 5000; // 5 seconds
  private isSupported = false;

  constructor(client: XmppClient, eventBus: XmppEventBus) {
    this.client = client;
    this.eventBus = eventBus;
    this.state = this.getInitialState();
    
    this.setupEventHandlers();
  }

  async enableIfSupported(): Promise<boolean> {
    if (!this.client.isConnected()) {
      return false;
    }

    try {
      // Check if stream management is supported
      const features = await this.checkStreamFeatures();
      
      if (!features.streamManagement) {
        logger.info('Stream management not supported by server');
        return false;
      }

      this.isSupported = true;
      
      // Try to resume first if we have a previous session
      if (this.state.id && this.state.location) {
        const resumed = await this.attemptResume();
        if (resumed) {
          return true;
        }
      }

      // Enable new stream management session
      return await this.enable();
    } catch (error) {
      logger.error('Error enabling stream management:', error);
      return false;
    }
  }

  canHandle(stanza: any): boolean {
    const name = stanza.name;
    const xmlns = stanza.attrs?.xmlns;
    
    return (
      (name === 'enabled' && xmlns === 'urn:xmpp:sm:3') ||
      (name === 'resumed' && xmlns === 'urn:xmpp:sm:3') ||
      (name === 'failed' && xmlns === 'urn:xmpp:sm:3') ||
      (name === 'r' && xmlns === 'urn:xmpp:sm:3') ||
      (name === 'a' && xmlns === 'urn:xmpp:sm:3')
    );
  }

  handleStanza(stanza: any): void {
    const name = stanza.name;
    
    switch (name) {
      case 'enabled':
        this.handleEnabled(stanza);
        break;
      case 'resumed':
        this.handleResumed(stanza);
        break;
      case 'failed':
        this.handleFailed(stanza);
        break;
      case 'r':
        this.handleAckRequest();
        break;
      case 'a':
        this.handleAck(stanza);
        break;
    }
  }

  trackOutboundStanza(stanza: any): void {
    if (!this.state.enabled) return;
    
    const stanzaName = stanza.name;
    if (stanzaName === 'message' || stanzaName === 'presence' || stanzaName === 'iq') {
      this.state.outboundCount++;
      
      // Store for potential resend
      this.unackedStanzas.push({
        id: stanza.attrs.id || XmppUtils.generateId(),
        stanza: stanza,
        timestamp: new Date()
      });

      // Limit unacked stanzas
      if (this.unackedStanzas.length > this.maxUnackedStanzas) {
        this.unackedStanzas.shift();
      }

      this.saveState();
    }
  }

  countInboundStanza(): void {
    if (this.state.enabled) {
      this.state.inboundCount++;
    }
  }

  cleanup(): void {
    if (this.state.ackTimer) {
      clearInterval(this.state.ackTimer);
      this.state.ackTimer = undefined;
    }
  }

  private async checkStreamFeatures(): Promise<{ streamManagement: boolean }> {
    // This would typically check the stream features
    // For now, we'll assume it's supported if we can send the enable stanza
    return { streamManagement: true };
  }

  private async enable(): Promise<boolean> {
    try {
      const enable = xml('enable', { 
        xmlns: 'urn:xmpp:sm:3',
        resume: 'true'
      });

      await this.client.send(enable);
      logger.debug('Sent stream management enable');
      return true;
    } catch (error) {
      logger.error('Error enabling stream management:', error);
      return false;
    }
  }

  private async attemptResume(): Promise<boolean> {
    if (!this.state.id) return false;

    try {
      const resume = xml('resume', {
        xmlns: 'urn:xmpp:sm:3',
        previd: this.state.id,
        h: this.state.inboundCount.toString()
      });

      await this.client.send(resume);
      logger.debug('Sent stream management resume');
      return true;
    } catch (error) {
      logger.error('Error resuming stream:', error);
      return false;
    }
  }

  private handleEnabled(stanza: any): void {
    const id = stanza.attrs.id;
    const location = stanza.attrs.location;
    const resume = stanza.attrs.resume;

    this.state.enabled = true;
    this.state.id = id;
    this.state.location = location;
    this.state.resumed = false;
    this.state.inboundCount = 0;
    this.state.outboundCount = 0;
    this.state.lastAckedCount = 0;
    this.unackedStanzas = [];

    this.saveState();
    this.startAckTimer();

    logger.info('Stream management enabled', { id, location, resume });
    this.eventBus.emit('stream:enabled', { id, location, resume });
  }

  private handleResumed(stanza: any): void {
    const previd = stanza.attrs.previd;
    const h = parseInt(stanza.attrs.h || '0', 10);

    this.state.resumed = true;
    this.state.enabled = true;

    // Remove acked stanzas
    this.removeAckedStanzas(h);

    this.saveState();
    this.startAckTimer();

    // Resend unacked stanzas
    this.resendUnackedStanzas();

    logger.info('Stream management resumed', { previd, h });
    this.eventBus.emit('stream:resumed', { previd, h });
  }

  private handleFailed(stanza: any): void {
    logger.warn('Stream management failed', stanza.attrs);
    this.resetState();
    this.eventBus.emit('stream:failed', { reason: stanza.attrs });
  }

  private handleAckRequest(): void {
    this.sendAck();
  }

  private handleAck(stanza: any): void {
    const h = parseInt(stanza.attrs.h || '0', 10);
    this.removeAckedStanzas(h);
    this.state.lastAckedCount = h;
    this.saveState();
  }

  private sendAck(): void {
    if (!this.state.enabled) return;

    const ack = xml('a', {
      xmlns: 'urn:xmpp:sm:3',
      h: this.state.inboundCount.toString()
    });

    this.client.send(ack).catch(error => {
      logger.error('Error sending ack:', error);
    });
  }

  private requestAck(): void {
    if (!this.state.enabled) return;

    const request = xml('r', { xmlns: 'urn:xmpp:sm:3' });
    
    this.client.send(request).catch(error => {
      logger.error('Error requesting ack:', error);
    });
  }

  private removeAckedStanzas(h: number): void {
    const ackedCount = h - this.state.lastAckedCount;
    if (ackedCount > 0) {
      this.unackedStanzas.splice(0, ackedCount);
      logger.debug(`Removed ${ackedCount} acked stanzas`);
    }
  }

  private resendUnackedStanzas(): void {
    for (const unacked of this.unackedStanzas) {
      this.client.send(unacked.stanza).catch(error => {
        logger.error('Error resending stanza:', error);
      });
    }
    
    if (this.unackedStanzas.length > 0) {
      logger.info(`Resent ${this.unackedStanzas.length} unacked stanzas`);
    }
  }

  private startAckTimer(): void {
    if (this.state.ackTimer) {
      clearInterval(this.state.ackTimer);
    }

    this.state.ackTimer = setInterval(() => {
      if (this.unackedStanzas.length > 0) {
        this.requestAck();
      }
    }, this.ackRequestInterval);
  }

  private resetState(): void {
    this.state = this.getInitialState();
    this.unackedStanzas = [];
    this.cleanup();
    this.saveState();
  }

  private getInitialState(): StreamState {
    // Try to load from storage
    const stored = this.loadState();
    if (stored) {
      return stored;
    }

    return {
      enabled: false,
      resumed: false,
      inboundCount: 0,
      outboundCount: 0,
      lastAckedCount: 0
    };
  }

  private saveState(): void {
    try {
      const stateToSave = {
        ...this.state,
        ackTimer: undefined // Don't serialize timer
      };
      localStorage.setItem('xmpp_stream_state', JSON.stringify(stateToSave));
    } catch (error) {
      logger.error('Error saving stream state:', error);
    }
  }

  private loadState(): StreamState | null {
    try {
      const stored = localStorage.getItem('xmpp_stream_state');
      return stored ? JSON.parse(stored) : null;
    } catch (error) {
      logger.error('Error loading stream state:', error);
      return null;
    }
  }

  private setupEventHandlers(): void {
    this.eventBus.on('stanza:sent', ({ stanza }) => {
      this.trackOutboundStanza(stanza);
    });

    this.eventBus.on('stanza:received', () => {
      this.countInboundStanza();
    });

    this.eventBus.on('client:offline', () => {
      this.cleanup();
    });
  }
}