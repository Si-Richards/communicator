/**
 * Message Management
 * Handles XEP-0184 (Delivery Receipts), XEP-0333 (Chat Markers),
 * XEP-0085 (Chat State Notifications), XEP-0280 (Message Carbons),
 * XEP-0308 (Last Message Correction), XEP-0424 (Message Retraction)
 */

import { xml } from '@xmpp/client';
import { XmppClient } from '../core/client';
import { XmppEventBus } from '../core/eventBus';
import { XmppUtils } from '../core/utils';
import { JidUtils } from '../core/jid';
import { logger } from '@/lib/logger';

export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'error';

export interface XmppMessage {
  id: string;
  from: string;
  to: string;
  body: string;
  timestamp: Date;
  type: 'chat' | 'groupchat';
  status?: MessageStatus;
  stanzaId?: string;
  originId?: string;
  isFromArchive?: boolean;
  isRetracted?: boolean;
  retractedBy?: string;
  retractedAt?: Date;
  isEdited?: boolean;
  editedAt?: Date;
  replaceId?: string;
  delayedFrom?: string;
  delayedStamp?: Date;
  requestReceipt?: boolean;
  markable?: boolean;
  received?: boolean;
  displayed?: boolean;
  // XEP-0461 Message Replies
  replyTo?: {
    id: string;
    to?: string;
  };
}

export interface TypingIndicator {
  from: string;
  state: 'composing' | 'paused' | 'active' | 'inactive' | 'gone';
  timestamp: Date;
}

export class MessageManager {
  private client: XmppClient;
  private eventBus: XmppEventBus;
  private carbonsEnabled = false;
  private messageStatusMap = new Map<string, MessageStatus>();

  constructor(client: XmppClient, eventBus: XmppEventBus) {
    this.client = client;
    this.eventBus = eventBus;
  }

  async enableCarbonsIfSupported(): Promise<boolean> {
    try {
      const iq = XmppUtils.createIq('set');
      const enable = xml('enable', { xmlns: 'urn:xmpp:carbons:2' });
      iq.cnode(enable);

      await this.client.send(iq);
      this.carbonsEnabled = true;
      
      logger.info('Message carbons enabled');
      return true;
    } catch (error) {
      logger.debug('Message carbons not supported or failed to enable:', error);
      return false;
    }
  }

  async sendMessage(
    to: string, 
    body: string, 
    type: 'chat' | 'groupchat' = 'chat',
    options: {
      requestReceipt?: boolean;
      markable?: boolean;
      originId?: string;
      replaceId?: string;
      replyTo?: { id: string; to?: string };
    } = {}
  ): Promise<string> {
    const messageId = XmppUtils.generateId();
    const originId = options.originId || XmppUtils.generateId();
    
    const message = XmppUtils.createMessage(type, to);
    message.attrs.id = messageId;
    message.c('body').t(body);
    
    // XEP-0359: Unique and Stable Stanza IDs
    message.c('origin-id', { 
      xmlns: 'urn:xmpp:sid:0',
      id: originId
    });

    // XEP-0184: Message Delivery Receipts
    if (options.requestReceipt) {
      message.c('request', { xmlns: 'urn:xmpp:receipts' });
    }

    // XEP-0333: Chat Markers
    if (options.markable) {
      message.c('markable', { xmlns: 'urn:xmpp:chat-markers:0' });
    }

    // XEP-0308: Last Message Correction
    if (options.replaceId) {
      message.c('replace', { 
        xmlns: 'urn:xmpp:message-correct:0',
        id: options.replaceId
      });
    }

    // XEP-0461: Message Replies
    if (options.replyTo) {
      message.c('reply', { 
        xmlns: 'urn:xmpp:reply:0',
        id: options.replyTo.id,
        ...(options.replyTo.to && { to: options.replyTo.to })
      });
    }

    try {
      await this.client.send(message);
      this.messageStatusMap.set(originId, 'sent');
      
      logger.debug('Message sent:', { to, messageId, originId });
      
      // Emit sent message event
      const sentMessage: XmppMessage = {
        id: originId,
        from: this.client.getConfig()?.username + '@' + this.client.getConfig()?.domain || '',
        to,
        body,
        timestamp: new Date(),
        type,
        status: 'sent',
        originId,
        requestReceipt: options.requestReceipt,
        markable: options.markable,
        replaceId: options.replaceId,
        replyTo: options.replyTo
      };
      
      this.eventBus.emit('message:sent', { message: sentMessage });
      
      return originId;
    } catch (error) {
      logger.error('Error sending message:', error);
      this.messageStatusMap.set(originId, 'error');
      throw error;
    }
  }

  async sendTypingNotification(to: string, state: 'composing' | 'paused' | 'active'): Promise<void> {
    const message = XmppUtils.createMessage('chat', to);
    message.c(state, { xmlns: 'http://jabber.org/protocol/chatstates' });

    try {
      await this.client.send(message);
      logger.debug('Typing notification sent:', { to, state });
    } catch (error) {
      logger.error('Error sending typing notification:', error);
    }
  }

  async sendDeliveryReceipt(to: string, messageId: string): Promise<void> {
    const message = XmppUtils.createMessage('chat', to);
    message.c('received', { 
      xmlns: 'urn:xmpp:receipts',
      id: messageId
    });

    try {
      await this.client.send(message);
      logger.debug('Delivery receipt sent:', { to, messageId });
    } catch (error) {
      logger.error('Error sending delivery receipt:', error);
    }
  }

  async sendChatMarker(to: string, messageId: string, marker: 'received' | 'displayed'): Promise<void> {
    const message = XmppUtils.createMessage('chat', to);
    message.c(marker, { 
      xmlns: 'urn:xmpp:chat-markers:0',
      id: messageId
    });

    try {
      await this.client.send(message);
      logger.debug('Chat marker sent:', { to, messageId, marker });
    } catch (error) {
      logger.error('Error sending chat marker:', error);
    }
  }

  async retractMessage(to: string, messageId: string, reason?: string): Promise<boolean> {
    try {
      const message = XmppUtils.createMessage('chat', to);
      const retract = xml('apply-to', { 
        xmlns: 'urn:xmpp:fasten:0',
        id: messageId
      });
      
      const retractElement = xml('retract', { xmlns: 'urn:xmpp:message-retract:0' });
      if (reason) {
        retractElement.c('reason').t(reason);
      }
      
      retract.cnode(retractElement);
      message.cnode(retract);

      await this.client.send(message);
      
      logger.info('Message retracted:', { to, messageId, reason });
      
      // Emit retraction event
      this.eventBus.emit('message:retracted', { 
        messageId, 
        to, 
        reason,
        retractedAt: new Date()
      });
      
      return true;
    } catch (error) {
      logger.error('Error retracting message:', error);
      return false;
    }
  }

  handleStanza(stanza: any): void {
    const type = stanza.attrs.type;
    
    if (type === 'error') {
      this.handleMessageError(stanza);
      return;
    }

    // Check for message carbons first
    const carbonReceived = XmppUtils.findChild(stanza, 'received', 'urn:xmpp:carbons:2');
    const carbonSent = XmppUtils.findChild(stanza, 'sent', 'urn:xmpp:carbons:2');
    
    if (carbonReceived || carbonSent) {
      this.handleMessageCarbon(stanza, carbonReceived ? 'received' : 'sent');
      return;
    }

    // Handle delivery receipts
    const receipt = XmppUtils.findChild(stanza, 'received', 'urn:xmpp:receipts');
    if (receipt) {
      this.handleDeliveryReceipt(stanza, receipt);
      return;
    }

    // Handle chat markers
    const chatMarker = this.findChatMarker(stanza);
    if (chatMarker) {
      this.handleChatMarker(stanza, chatMarker);
      return;
    }

    // Handle chat state notifications
    const chatState = this.findChatState(stanza);
    if (chatState) {
      this.handleChatStateNotification(stanza, chatState);
      return;
    }

    // Handle message retraction
    const retraction = this.findRetraction(stanza);
    if (retraction) {
      this.handleMessageRetraction(stanza, retraction);
      return;
    }

    // Handle regular message
    const body = XmppUtils.findChild(stanza, 'body');
    if (body) {
      this.handleRegularMessage(stanza);
    }
  }

  cleanup(): void {
    this.messageStatusMap.clear();
  }

  private handleRegularMessage(stanza: any): void {
    const message = this.parseMessage(stanza);
    if (!message) return;

    logger.debug('Received message:', message);
    this.eventBus.emit('message:received', { message });

    // Send delivery receipt if requested
    const request = XmppUtils.findChild(stanza, 'request', 'urn:xmpp:receipts');
    if (request && message.type === 'chat') {
      this.sendDeliveryReceipt(message.from, message.id).catch(console.error);
    }
  }

  private handleMessageCarbon(stanza: any, direction: 'sent' | 'received'): void {
    const carbon = XmppUtils.findChild(stanza, direction, 'urn:xmpp:carbons:2');
    const forwarded = XmppUtils.findChild(carbon, 'forwarded', 'urn:xmpp:forward:0');
    const messageStanza = XmppUtils.findChild(forwarded, 'message');
    
    if (!messageStanza) return;

    const message = this.parseMessage(messageStanza);
    if (!message) return;

    logger.debug('Received carbon message:', { direction, messageId: message.id });
    this.eventBus.emit('message:carbon', { message, direction });
  }

  private handleDeliveryReceipt(stanza: any, receipt: any): void {
    const messageId = XmppUtils.getAttribute(receipt, 'id');
    const from = stanza.attrs.from;
    
    if (messageId) {
      this.messageStatusMap.set(messageId, 'delivered');
      this.eventBus.emit('message:statusUpdate', { 
        messageId, 
        status: 'delivered',
        from: JidUtils.toBare(from)
      });
      
      logger.debug('Message delivered:', messageId);
    }
  }

  private handleChatMarker(stanza: any, marker: any): void {
    const markerType = marker.name;
    const messageId = XmppUtils.getAttribute(marker, 'id');
    const from = stanza.attrs.from;
    
    if (messageId && (markerType === 'received' || markerType === 'displayed')) {
      const status = markerType === 'displayed' ? 'read' : 'delivered';
      this.messageStatusMap.set(messageId, status as MessageStatus);
      
      this.eventBus.emit('message:statusUpdate', { 
        messageId, 
        status,
        from: JidUtils.toBare(from)
      });
      
      logger.debug('Chat marker received:', markerType, messageId);
    }
  }

  private handleChatStateNotification(stanza: any, chatState: any): void {
    const state = chatState.name;
    const from = stanza.attrs.from;
    
    const indicator: TypingIndicator = {
      from: JidUtils.toBare(from),
      state: state as any,
      timestamp: new Date()
    };
    
    this.eventBus.emit('typing:indicator', { indicator });
    logger.debug('Chat state notification:', state, from);
  }

  private handleMessageRetraction(stanza: any, retraction: any): void {
    const applyTo = XmppUtils.findChild(stanza, 'apply-to', 'urn:xmpp:fasten:0');
    const messageId = XmppUtils.getAttribute(applyTo, 'id');
    const retractElement = XmppUtils.findChild(applyTo, 'retract', 'urn:xmpp:message-retract:0');
    const reason = XmppUtils.getTextContent(XmppUtils.findChild(retractElement, 'reason'));
    const from = stanza.attrs.from;
    
    if (messageId) {
      this.eventBus.emit('message:retracted', { 
        messageId,
        retractedBy: JidUtils.toBare(from),
        retractedAt: new Date(),
        reason
      });
      
      logger.debug('Message retraction received:', messageId, reason);
    }
  }

  private handleMessageError(stanza: any): void {
    const id = stanza.attrs.id;
    const error = XmppUtils.findChild(stanza, 'error');
    const errorText = error ? XmppUtils.getTextContent(error) : 'Unknown error';
    
    if (id) {
      this.messageStatusMap.set(id, 'error');
      this.eventBus.emit('message:statusUpdate', { 
        messageId: id, 
        status: 'error',
        error: errorText
      });
    }
    
    logger.error('Message error:', errorText);
  }

  private parseMessage(stanza: any): XmppMessage | null {
    const from = stanza.attrs.from;
    const to = stanza.attrs.to;
    const id = stanza.attrs.id;
    const type = stanza.attrs.type || 'chat';
    
    const body = XmppUtils.getTextContent(XmppUtils.findChild(stanza, 'body'));
    if (!body || !from) return null;

    // Parse timestamp
    let timestamp = new Date();
    const delay = XmppUtils.findChild(stanza, 'delay', 'urn:xmpp:delay');
    if (delay) {
      const stamp = XmppUtils.getAttribute(delay, 'stamp');
      if (stamp) {
        timestamp = XmppUtils.parseTimestamp(stamp);
      }
    }

    // Parse stanza ID and origin ID
    const stanzaId = XmppUtils.getAttribute(
      XmppUtils.findChild(stanza, 'stanza-id', 'urn:xmpp:sid:0'), 
      'id'
    );
    const originId = XmppUtils.getAttribute(
      XmppUtils.findChild(stanza, 'origin-id', 'urn:xmpp:sid:0'), 
      'id'
    );

    // Check for message correction
    const replace = XmppUtils.findChild(stanza, 'replace', 'urn:xmpp:message-correct:0');
    const replaceId = replace ? XmppUtils.getAttribute(replace, 'id') : undefined;

    // Check for markable
    const markable = XmppUtils.findChild(stanza, 'markable', 'urn:xmpp:chat-markers:0');
    const requestReceipt = XmppUtils.findChild(stanza, 'request', 'urn:xmpp:receipts');

    // XEP-0461: Message Replies
    const reply = XmppUtils.findChild(stanza, 'reply', 'urn:xmpp:reply:0');
    const replyTo = reply ? {
      id: XmppUtils.getAttribute(reply, 'id'),
      to: XmppUtils.getAttribute(reply, 'to')
    } : undefined;

    const message: XmppMessage = {
      id: originId || stanzaId || id || XmppUtils.generateId(),
      from: JidUtils.toBare(from),
      to: JidUtils.toBare(to || ''),
      body,
      timestamp,
      type: type as 'chat' | 'groupchat',
      stanzaId,
      originId,
      isEdited: !!replaceId,
      replaceId,
      markable: !!markable,
      requestReceipt: !!requestReceipt,
      replyTo
    };

    return message;
  }

  private findChatMarker(stanza: any): any {
    const markers = ['received', 'displayed', 'acknowledged'];
    for (const marker of markers) {
      const element = XmppUtils.findChild(stanza, marker, 'urn:xmpp:chat-markers:0');
      if (element) return element;
    }
    return null;
  }

  private findChatState(stanza: any): any {
    const states = ['composing', 'paused', 'active', 'inactive', 'gone'];
    for (const state of states) {
      const element = XmppUtils.findChild(stanza, state, 'http://jabber.org/protocol/chatstates');
      if (element) return element;
    }
    return null;
  }

  private findRetraction(stanza: any): any {
    const applyTo = XmppUtils.findChild(stanza, 'apply-to', 'urn:xmpp:fasten:0');
    if (applyTo) {
      return XmppUtils.findChild(applyTo, 'retract', 'urn:xmpp:message-retract:0');
    }
    return null;
  }
}