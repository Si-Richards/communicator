// XEP-0198 Stream Management implementation
import { xml } from '@xmpp/client';
import { StreamManagement, QueuedMessage } from '@/types/xmpp';

export class XmppStreamManager {
  private streamManagement: StreamManagement = {
    enabled: false,
    resumed: false,
    inboundCount: 0,
    outboundCount: 0,
    unackedStanzas: [],
  };

  private offlineQueue: QueuedMessage[] = [];
  private xmpp: any = null;
  private onReconnect?: () => void;
  private onStanzaAck?: (count: number) => void;

  constructor(onReconnect?: () => void, onStanzaAck?: (count: number) => void) {
    this.onReconnect = onReconnect;
    this.onStanzaAck = onStanzaAck;
  }

  setXmppClient(xmpp: any) {
    this.xmpp = xmpp;
  }

  getStreamState(): StreamManagement {
    return { ...this.streamManagement };
  }

  getOfflineQueue(): QueuedMessage[] {
    return [...this.offlineQueue];
  }

  // Enable stream management after authentication
  async enableStreamManagement(): Promise<boolean> {
    if (!this.xmpp) return false;

    try {
      const enableStanza = xml('enable', {
        xmlns: 'urn:xmpp:sm:3',
        resume: 'true'
      });

      await this.xmpp.send(enableStanza);
      return true;
    } catch (error) {
      console.error('Failed to enable stream management:', error);
      return false;
    }
  }

  // Resume stream if possible
  async resumeStream(): Promise<boolean> {
    if (!this.xmpp || !this.streamManagement.id) return false;

    try {
      const resumeStanza = xml('resume', {
        xmlns: 'urn:xmpp:sm:3',
        previd: this.streamManagement.id,
        h: this.streamManagement.inboundCount.toString()
      });

      await this.xmpp.send(resumeStanza);
      return true;
    } catch (error) {
      console.error('Failed to resume stream:', error);
      return false;
    }
  }

  // Handle stream management stanzas
  handleStreamManagement(stanza: any): boolean {
    const name = stanza.name;
    const xmlns = stanza.attrs.xmlns;

    if (xmlns !== 'urn:xmpp:sm:3') return false;

    switch (name) {
      case 'enabled':
        this.streamManagement.enabled = true;
        this.streamManagement.id = stanza.attrs.id;
        this.streamManagement.location = stanza.attrs.location;
        this.streamManagement.resumptionTime = parseInt(stanza.attrs.max) || 300;
        console.log('Stream management enabled:', this.streamManagement.id);
        return true;

      case 'resumed':
        this.streamManagement.resumed = true;
        const prevCount = this.streamManagement.outboundCount;
        this.streamManagement.outboundCount = parseInt(stanza.attrs.h) || 0;
        console.log('Stream resumed:', {
          prevCount,
          newCount: this.streamManagement.outboundCount
        });
        this.processUnackedStanzas(this.streamManagement.outboundCount);
        this.onReconnect?.();
        return true;

      case 'failed':
        console.log('Stream resume failed, starting fresh session');
        this.resetStreamState();
        return true;

      case 'a':
        const ackCount = parseInt(stanza.attrs.h) || 0;
        this.processUnackedStanzas(ackCount);
        this.onStanzaAck?.(ackCount);
        return true;

      case 'r':
        this.sendAck();
        return true;

      default:
        return false;
    }
  }

  // Request acknowledgment from server
  requestAck() {
    if (!this.xmpp || !this.streamManagement.enabled) return;

    const requestStanza = xml('r', { xmlns: 'urn:xmpp:sm:3' });
    this.xmpp.send(requestStanza).catch(console.error);
  }

  // Send acknowledgment to server
  private sendAck() {
    if (!this.xmpp || !this.streamManagement.enabled) return;

    const ackStanza = xml('a', {
      xmlns: 'urn:xmpp:sm:3',
      h: this.streamManagement.inboundCount.toString()
    });
    this.xmpp.send(ackStanza).catch(console.error);
  }

  // Track outbound stanza for potential resend
  trackOutboundStanza(stanza: any, stanzaId: string) {
    if (!this.streamManagement.enabled) return;

    this.streamManagement.unackedStanzas.push({
      id: stanzaId,
      stanza,
      timestamp: new Date()
    });

    this.streamManagement.outboundCount++;

    // Request ack periodically
    if (this.streamManagement.outboundCount % 5 === 0) {
      this.requestAck();
    }
  }

  // Count inbound stanza
  countInboundStanza() {
    if (this.streamManagement.enabled) {
      this.streamManagement.inboundCount++;
    }
  }

  // Process acknowledged stanzas
  private processUnackedStanzas(ackCount: number) {
    const acknowledged = ackCount - (this.streamManagement.outboundCount - this.streamManagement.unackedStanzas.length);
    
    if (acknowledged > 0) {
      this.streamManagement.unackedStanzas.splice(0, acknowledged);
    }
  }

  // Resend unacked stanzas
  async resendUnackedStanzas() {
    if (!this.xmpp || !this.streamManagement.enabled) return;

    for (const unacked of this.streamManagement.unackedStanzas) {
      try {
        await this.xmpp.send(unacked.stanza);
      } catch (error) {
        console.error('Failed to resend stanza:', unacked.id, error);
      }
    }
  }

  // Queue message for offline sending
  queueMessage(message: Omit<QueuedMessage, 'id' | 'timestamp' | 'retryCount' | 'maxRetries'>) {
    const queuedMessage: QueuedMessage = {
      ...message,
      id: crypto.randomUUID(),
      timestamp: new Date(),
      retryCount: 0,
      maxRetries: 3
    };

    this.offlineQueue.push(queuedMessage);
    this.saveOfflineQueue();
  }

  // Send queued messages when back online
  async sendQueuedMessages() {
    if (!this.xmpp || this.offlineQueue.length === 0) return;

    const queue = [...this.offlineQueue];
    this.offlineQueue = [];

    for (const message of queue) {
      try {
        const messageStanza = xml('message', {
          to: message.to,
          type: message.type,
          id: message.id
        }, xml('body', {}, message.body));

        // Add delivery receipt request
        messageStanza.append(xml('request', { xmlns: 'urn:xmpp:receipts' }));

        await this.xmpp.send(messageStanza);
      } catch (error) {
        console.error('Failed to send queued message:', message.id, error);
        
        // Retry logic
        if (message.retryCount < message.maxRetries) {
          message.retryCount++;
          this.offlineQueue.push(message);
        }
      }
    }

    this.saveOfflineQueue();
  }

  // Reset stream state
  resetStreamState() {
    this.streamManagement = {
      enabled: false,
      resumed: false,
      inboundCount: 0,
      outboundCount: 0,
      unackedStanzas: [],
    };
  }

  // Persistence for offline queue
  private saveOfflineQueue() {
    try {
      localStorage.setItem('xmpp_offline_queue', JSON.stringify(this.offlineQueue));
    } catch (error) {
      console.error('Failed to save offline queue:', error);
    }
  }

  loadOfflineQueue() {
    try {
      const saved = localStorage.getItem('xmpp_offline_queue');
      if (saved) {
        this.offlineQueue = JSON.parse(saved).map((msg: any) => ({
          ...msg,
          timestamp: new Date(msg.timestamp)
        }));
      }
    } catch (error) {
      console.error('Failed to load offline queue:', error);
      this.offlineQueue = [];
    }
  }

  clearOfflineQueue() {
    this.offlineQueue = [];
    localStorage.removeItem('xmpp_offline_queue');
  }
}