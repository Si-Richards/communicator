// Enhanced message handling with XEP support
import { xml, jid as xmppJid } from '@xmpp/client';
import { XmppMessage, MessageStatus, MamQuery, MamResult } from '@/types/xmpp';

export class XmppMessageHandler {
  private xmpp: any = null;
  private onMessageReceived?: (message: XmppMessage) => void;
  private onMessageStatusUpdate?: (messageId: string, status: MessageStatus, from: string) => void;
  private onTypingIndicator?: (from: string, state: 'composing' | 'paused' | 'active') => void;

  constructor(
    onMessageReceived?: (message: XmppMessage) => void,
    onMessageStatusUpdate?: (messageId: string, status: MessageStatus, from: string) => void,
    onTypingIndicator?: (from: string, state: 'composing' | 'paused' | 'active') => void
  ) {
    this.onMessageReceived = onMessageReceived;
    this.onMessageStatusUpdate = onMessageStatusUpdate;
    this.onTypingIndicator = onTypingIndicator;
  }

  setXmppClient(xmpp: any) {
    this.xmpp = xmpp;
  }

  // Send a message with full XEP support
  async sendMessage(
    to: string, 
    body: string, 
    type: 'chat' | 'groupchat' = 'chat',
    options: {
      requestReceipt?: boolean;
      markable?: boolean;
      originId?: string;
    } = {}
  ): Promise<string> {
    if (!this.xmpp) throw new Error('XMPP client not available');

    const messageId = options.originId || crypto.randomUUID();
    const stanzaId = crypto.randomUUID();

    const messageStanza = xml('message', {
      to,
      type,
      id: stanzaId
    }, xml('body', {}, body));

    // XEP-0359: Stable and Unique Stanza IDs
    if (options.originId) {
      messageStanza.append(xml('origin-id', {
        xmlns: 'urn:xmpp:sid:0',
        id: options.originId
      }));
    }

    // XEP-0184: Message Delivery Receipts
    if (options.requestReceipt !== false && type === 'chat') {
      messageStanza.append(xml('request', { xmlns: 'urn:xmpp:receipts' }));
    }

    // XEP-0333: Chat Markers
    if (options.markable !== false) {
      messageStanza.append(xml('markable', { xmlns: 'urn:xmpp:chat-markers:0' }));
    }

    await this.xmpp.send(messageStanza);
    return messageId;
  }

  // Handle incoming messages
  handleMessage(stanza: any): XmppMessage | null {
    const from = stanza.attrs.from;
    const to = stanza.attrs.to;
    const type = stanza.attrs.type || 'chat';
    const stanzaId = stanza.attrs.id;

    // Check for message retraction first
    const retractElement = stanza.getChild('apply-to', 'urn:xmpp:fasten:0')?.getChild('retract', 'urn:xmpp:message-retract:0');
    if (retractElement) {
      const retractedId = stanza.getChild('apply-to', 'urn:xmpp:fasten:0')?.attrs.id;
      if (retractedId) {
        return {
          id: retractedId,
          from,
          to,
          body: '[Message retracted]',
          timestamp: new Date(),
          type,
          isRetracted: true,
          retractedBy: xmppJid(from).bare().toString(),
          retractedAt: new Date()
        };
      }
    }

    const body = stanza.getChildText('body');
    if (!body) {
      // Check for chat state notifications or other non-body messages
      this.handleChatStateNotification(stanza);
      this.handleDeliveryReceipt(stanza);
      this.handleChatMarker(stanza);
      return null;
    }

    // Parse timestamp
    let timestamp = new Date();
    let delayedFrom: string | undefined;
    let delayedStamp: Date | undefined;

    // XEP-0203: Delayed Delivery
    const delay = stanza.getChild('delay', 'urn:xmpp:delay');
    if (delay) {
      delayedStamp = new Date(delay.attrs.stamp);
      delayedFrom = delay.attrs.from;
      timestamp = delayedStamp;
    }

    // XEP-0359: Stable and Unique Stanza IDs
    const originId = stanza.getChild('origin-id', 'urn:xmpp:sid:0')?.attrs.id;
    
    // Build message object
    const message: XmppMessage = {
      id: originId || stanzaId || crypto.randomUUID(),
      from,
      to,
      body,
      timestamp,
      type,
      stanzaId,
      originId,
      delayedFrom,
      delayedStamp,
      isFromArchive: !!delay,
      requestReceipt: !!stanza.getChild('request', 'urn:xmpp:receipts'),
      markable: !!stanza.getChild('markable', 'urn:xmpp:chat-markers:0')
    };

    // Send delivery receipt if requested
    if (message.requestReceipt && type === 'chat') {
      this.sendDeliveryReceipt(from, message.id);
    }

    this.onMessageReceived?.(message);
    return message;
  }

  // Handle chat state notifications (XEP-0085)
  private handleChatStateNotification(stanza: any) {
    const from = stanza.attrs.from;
    
    // Check for composing, paused, etc.
    if (stanza.getChild('composing', 'http://jabber.org/protocol/chatstates')) {
      this.onTypingIndicator?.(from, 'composing');
    } else if (stanza.getChild('paused', 'http://jabber.org/protocol/chatstates')) {
      this.onTypingIndicator?.(from, 'paused');
    } else if (stanza.getChild('active', 'http://jabber.org/protocol/chatstates')) {
      this.onTypingIndicator?.(from, 'active');
    }
  }

  // Handle delivery receipts (XEP-0184)
  private handleDeliveryReceipt(stanza: any) {
    const from = stanza.attrs.from;
    const received = stanza.getChild('received', 'urn:xmpp:receipts');
    
    if (received) {
      const messageId = received.attrs.id;
      if (messageId) {
        this.onMessageStatusUpdate?.(messageId, 'delivered', from);
      }
    }
  }

  // Handle chat markers (XEP-0333)
  private handleChatMarker(stanza: any) {
    const from = stanza.attrs.from;
    
    const received = stanza.getChild('received', 'urn:xmpp:chat-markers:0');
    const displayed = stanza.getChild('displayed', 'urn:xmpp:chat-markers:0');
    
    if (received) {
      const messageId = received.attrs.id;
      if (messageId) {
        this.onMessageStatusUpdate?.(messageId, 'delivered', from);
      }
    }
    
    if (displayed) {
      const messageId = displayed.attrs.id;
      if (messageId) {
        this.onMessageStatusUpdate?.(messageId, 'read', from);
      }
    }
  }

  // Send delivery receipt
  async sendDeliveryReceipt(to: string, messageId: string) {
    if (!this.xmpp) return;

    const receiptStanza = xml('message', {
      to,
      id: crypto.randomUUID()
    }, xml('received', {
      xmlns: 'urn:xmpp:receipts',
      id: messageId
    }));

    try {
      await this.xmpp.send(receiptStanza);
    } catch (error) {
      console.error('Failed to send delivery receipt:', error);
    }
  }

  // Send chat marker
  async sendChatMarker(to: string, messageId: string, marker: 'received' | 'displayed') {
    if (!this.xmpp) return;

    const markerStanza = xml('message', {
      to,
      id: crypto.randomUUID()
    }, xml(marker, {
      xmlns: 'urn:xmpp:chat-markers:0',
      id: messageId
    }));

    try {
      await this.xmpp.send(markerStanza);
    } catch (error) {
      console.error('Failed to send chat marker:', error);
    }
  }

  // Send typing notification
  async sendTypingNotification(to: string, state: 'composing' | 'paused' | 'active') {
    if (!this.xmpp) return;

    const stateStanza = xml('message', {
      to,
      type: 'chat',
      id: crypto.randomUUID()
    }, xml(state, { xmlns: 'http://jabber.org/protocol/chatstates' }));

    try {
      await this.xmpp.send(stateStanza);
    } catch (error) {
      console.error('Failed to send typing notification:', error);
    }
  }

  // MAM query (XEP-0313)
  async queryMessageArchive(query: MamQuery): Promise<MamResult> {
    if (!this.xmpp) throw new Error('XMPP client not available');

    const queryId = query.queryId || crypto.randomUUID();
    const mamQuery = xml('query', { xmlns: 'urn:xmpp:mam:2', queryid: queryId });

    // Add query parameters
    if (query.with || query.start || query.end) {
      const xForm = xml('x', { xmlns: 'jabber:x:data', type: 'submit' },
        xml('field', { var: 'FORM_TYPE', type: 'hidden' },
          xml('value', {}, 'urn:xmpp:mam:2')
        )
      );

      if (query.with) {
        xForm.append(xml('field', { var: 'with' },
          xml('value', {}, query.with)
        ));
      }

      if (query.start) {
        xForm.append(xml('field', { var: 'start' },
          xml('value', {}, query.start.toISOString())
        ));
      }

      if (query.end) {
        xForm.append(xml('field', { var: 'end' },
          xml('value', {}, query.end.toISOString())
        ));
      }

      mamQuery.append(xForm);
    }

    // Add RSM (Result Set Management)
    if (query.max || query.before || query.after) {
      const rsm = xml('set', { xmlns: 'http://jabber.org/protocol/rsm' });
      
      if (query.max) {
        rsm.append(xml('max', {}, query.max.toString()));
      }
      
      if (query.before) {
        rsm.append(xml('before', {}, query.before));
      }
      
      if (query.after) {
        rsm.append(xml('after', {}, query.after));
      }

      mamQuery.append(rsm);
    }

    const iq = xml('iq', {
      type: 'set',
      id: crypto.randomUUID()
    }, mamQuery);

    try {
      const response = await this.xmpp.iqCaller.request(iq);
      const fin = response.getChild('fin', 'urn:xmpp:mam:2');
      const rsm = fin?.getChild('set', 'http://jabber.org/protocol/rsm');

      return {
        messages: [], // Messages are received via forwarded stanzas
        complete: fin?.attrs.complete === 'true',
        first: rsm?.getChildText('first'),
        last: rsm?.getChildText('last'),
        count: rsm?.getChildText('count') ? parseInt(rsm.getChildText('count')) : undefined,
        queryId
      };
    } catch (error) {
      console.error('MAM query failed:', error);
      throw error;
    }
  }

  // Retract message (XEP-0424)
  async retractMessage(to: string, messageId: string, reason?: string): Promise<boolean> {
    if (!this.xmpp) return false;

    try {
      const retractStanza = xml('message', {
        to,
        type: 'chat',
        id: crypto.randomUUID()
      },
        xml('apply-to', {
          xmlns: 'urn:xmpp:fasten:0',
          id: messageId
        },
          xml('retract', { xmlns: 'urn:xmpp:message-retract:0' },
            reason ? xml('reason', {}, reason) : null
          )
        )
      );

      await this.xmpp.send(retractStanza);
      return true;
    } catch (error) {
      console.error('Failed to retract message:', error);
      return false;
    }
  }
}