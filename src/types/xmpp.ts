export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'error';

export type PresenceShow = 'available' | 'away' | 'dnd' | 'xa' | 'unavailable';

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
  // XEP-0203 Delayed Delivery
  delayedFrom?: string;
  delayedStamp?: Date;
  // XEP-0184 Delivery Receipts
  requestReceipt?: boolean;
  // XEP-0333 Chat Markers
  markable?: boolean;
  received?: boolean;
  displayed?: boolean;
  // XEP-0461 Message Replies
  replyTo?: {
    id: string;
    to?: string;
  };
}

export interface XmppContact {
  jid: string;
  name: string;
  subscription: 'none' | 'to' | 'from' | 'both';
  presence: PresenceShow;
  status?: string;
  // XEP-0012 Last Activity
  lastSeen?: Date;
  // Avatar/vCard info
  avatar?: string;
  // Roster push tracking
  ask?: 'subscribe';
  approved?: boolean;
}

export interface XmppConversation {
  jid: string;
  name: string;
  messages: XmppMessage[];
  unreadCount: number;
  lastActivity: Date;
  hasMoreHistory?: boolean;
  mamQueryId?: string;
  // RSM (Result Set Management) for pagination
  mamBefore?: string;
  mamAfter?: string;
  mamFirst?: string;
  mamLast?: string;
  mamCount?: number;
  // UI state
  archived?: boolean;
  pinned?: boolean;
  // Typing indicators
  isTyping?: boolean;
  lastTypingFrom?: string;
}

export interface MamQuery {
  with?: string;
  start?: Date;
  end?: Date;
  before?: string;
  after?: string;
  max?: number;
  queryId?: string;
}

export interface MamResult {
  messages: XmppMessage[];
  complete: boolean;
  first?: string;
  last?: string;
  count?: number;
  queryId?: string;
}

export type RoomAffiliation = 'owner' | 'admin' | 'member' | 'outcast' | 'none';
export type RoomRole = 'moderator' | 'participant' | 'visitor' | 'none';

export interface RoomOccupant {
  nick: string;
  jid?: string;
  affiliation: RoomAffiliation;
  role: RoomRole;
  presence: PresenceShow;
  status?: string;
  // XEP-0012 Last Activity for room occupants
  lastSeen?: Date;
}

export interface MucRoom {
  jid: string;
  name: string;
  nick: string;
  subject?: string;
  messages: XmppMessage[];
  occupants: RoomOccupant[];
  unreadCount: number;
  lastActivity: Date;
  joined: boolean;
  isOwner: boolean;
  isMuted: boolean;
  hasMoreHistory?: boolean;
  mamQueryId?: string;
  // RSM pagination
  mamBefore?: string;
  mamAfter?: string;
  mamFirst?: string;
  mamLast?: string;
  mamCount?: number;
  // UI state
  archived?: boolean;
  pinned?: boolean;
  // Room configuration
  password?: string;
  membersOnly?: boolean;
  moderated?: boolean;
  persistent?: boolean;
  public?: boolean;
  // XEP-0045 MUC specific
  roomConfig?: {
    title?: string;
    description?: string;
    maxUsers?: number;
    allowInvites?: boolean;
    allowPrivateMessages?: boolean;
    changeSubject?: boolean;
    enableLogging?: boolean;
    membersOnly?: boolean;
    moderated?: boolean;
    passwordProtected?: boolean;
    persistent?: boolean;
    publicRoom?: boolean;
  };
}

// XEP-0198 Stream Management
export interface StreamManagement {
  enabled: boolean;
  resumed: boolean;
  id?: string;
  location?: string;
  inboundCount: number;
  outboundCount: number;
  unackedStanzas: Array<{
    id: string;
    stanza: any;
    timestamp: Date;
  }>;
  ackTimer?: NodeJS.Timeout;
  resumptionTime?: number;
}

// XEP-0280 Message Carbons
export interface MessageCarbon {
  direction: 'sent' | 'received';
  originalFrom: string;
  originalTo: string;
  forwardedMessage: XmppMessage;
}

// Offline message queue
export interface QueuedMessage {
  id: string;
  to: string;
  body: string;
  type: 'chat' | 'groupchat';
  timestamp: Date;
  priority: 'normal' | 'high';
  retryCount: number;
  maxRetries: number;
}

// Connection state with detailed info
export interface ConnectionInfo {
  state: 'disconnected' | 'connecting' | 'connected' | 'authenticating' | 'resuming' | 'error';
  lastConnected?: Date;
  lastDisconnected?: Date;
  errorMessage?: string;
  retryCount: number;
  nextRetryIn?: number;
  serverFeatures: string[];
  streamManagement: StreamManagement;
  // Network quality indicators
  latency?: number;
  isOnline: boolean;
}

// Feature discovery results
export interface ServerFeatures {
  // Core features
  streamManagement: boolean; // XEP-0198
  messageDeliveryReceipts: boolean; // XEP-0184
  chatMarkers: boolean; // XEP-0333
  messageArchiveManagement: boolean; // XEP-0313
  messageRetraction: boolean; // XEP-0424
  lastActivity: boolean; // XEP-0012
  messageCarbons: boolean; // XEP-0280
  
  // Roster and presence
  rosterVersioning: boolean; // RFC 6121
  presenceSubscription: boolean;
  
  // MUC features
  muc: boolean; // XEP-0045
  mucAdmin: boolean;
  mucOwner: boolean;
  
  // File transfer
  sipFileTransfer: boolean; // XEP-0234
  httpFileUpload: boolean; // XEP-0363
  
  // Other useful features
  ping: boolean; // XEP-0199
  time: boolean; // XEP-0202
  softwareVersion: boolean; // XEP-0092
  entityCapabilities: boolean; // XEP-0115
}

// Typing indicators
export interface TypingIndicator {
  from: string;
  state: 'composing' | 'paused' | 'active' | 'inactive' | 'gone';
  timestamp: Date;
}

// Message reactions (future extensibility)
export interface MessageReaction {
  messageId: string;
  from: string;
  reaction: string; // emoji or reaction code
  timestamp: Date;
}
