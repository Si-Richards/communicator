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
}

export interface XmppContact {
  jid: string;
  name: string;
  subscription: 'none' | 'to' | 'from' | 'both';
  presence: 'available' | 'away' | 'dnd' | 'xa' | 'unavailable';
  status?: string;
}

export interface XmppConversation {
  jid: string;
  name: string;
  messages: XmppMessage[];
  unreadCount: number;
  lastActivity: Date;
  hasMoreHistory?: boolean;
  mamQueryId?: string;
}

export interface MamQuery {
  with?: string;
  start?: Date;
  end?: Date;
  before?: string;
  after?: string;
  max?: number;
}

export interface MamResult {
  messages: XmppMessage[];
  complete: boolean;
  first?: string;
  last?: string;
  count?: number;
}