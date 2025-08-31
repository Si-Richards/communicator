// XMPP Types - Core type definitions
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'authenticating' | 'resuming' | 'reconnecting' | 'error' | 'offline';

export interface XmppMessage {
  id: string;
  from: string;
  to: string;
  body: string;
  timestamp: Date;
  type: 'chat' | 'groupchat';
  // XEP-0184 Delivery Receipts
  requestReceipt?: boolean;
  receipt?: 'request' | 'received';
  // XEP-0333 Chat Markers  
  markable?: boolean;
  received?: boolean;
  displayed?: boolean;
  // XEP-0203 Delayed Delivery
  delayedFrom?: string;
  delayedStamp?: Date;
  // XEP-0085 Chat State Notifications
  chatState?: 'active' | 'composing' | 'paused' | 'inactive' | 'gone';
  // XEP-0308 Last Message Correction
  replaces?: string;
  edited?: boolean;
  // XEP-0424 Message Retraction  
  retracted?: boolean;
  retractedBy?: string;
  retractedAt?: Date;
  // Status tracking
  status?: 'sending' | 'sent' | 'delivered' | 'read' | 'error' | 'received';
  error?: string;
  // Archive markers
  isFromArchive?: boolean;
  stanzaId?: string;
  originId?: string;
}

export interface XmppContact {
  jid: string;
  name: string;
  subscription: 'none' | 'to' | 'from' | 'both';
  presence: 'available' | 'away' | 'dnd' | 'xa' | 'unavailable';
  status?: string;
  lastSeen?: Date;
  avatar?: string;
  // Roster management
  ask?: 'subscribe';
  approved?: boolean;
  groups?: string[];
}

export interface XmppConversation {
  jid: string;
  name: string;
  type: 'chat' | 'groupchat';
  messages: XmppMessage[];
  unreadCount: number;
  lastActivity: Date;
  lastMessage?: XmppMessage;
  // UI state
  pinned: boolean;
  muted: boolean;
  hidden: boolean;
  archived: boolean;
  // MAM pagination
  hasMoreHistory: boolean;
  mamBefore?: string;
  mamAfter?: string;
  mamFirst?: string;
  mamLast?: string;
  mamCount?: number;
  // Typing indicators
  isTyping: boolean;
  typingUsers: string[];
}

export interface MucRoom extends XmppConversation {
  type: 'groupchat';
  subject?: string;
  nick: string;
  joined: boolean;
  occupants: RoomOccupant[];
  // Room permissions
  isOwner: boolean;
  isModerator: boolean;
  canInvite: boolean;
  canChangeSubject: boolean;
  // Room configuration
  membersOnly?: boolean;
  moderated?: boolean;
  passwordProtected?: boolean;
  persistent?: boolean;
  public?: boolean;
}

export interface RoomOccupant {
  nick: string;
  jid?: string;
  affiliation: 'owner' | 'admin' | 'member' | 'outcast' | 'none';
  role: 'moderator' | 'participant' | 'visitor' | 'none';
  presence: 'available' | 'away' | 'dnd' | 'xa' | 'unavailable';
  status?: string;
  lastSeen?: Date;
}

export interface FileUpload {
  id: string;
  name: string;
  size: number;
  type: string;
  url?: string;
  progress: number;
  status: 'pending' | 'uploading' | 'uploaded' | 'error';
  error?: string;
}

export interface ServerFeatures {
  streamManagement: boolean;
  messageDeliveryReceipts: boolean;
  chatMarkers: boolean;
  messageArchiveManagement: boolean;
  messageCarbons: boolean;
  messageRetraction: boolean;
  lastActivity: boolean;
  muc: boolean;
  httpFileUpload: boolean;
  ping: boolean;
  blocking: boolean;
  vcard: boolean;
}

export interface FeatureFlags {
  enableStreamManagement: boolean;
  enableCarbons: boolean;
  enableMAM: boolean;
  enableFileUpload: boolean;
  enableTyping: boolean;
  enableReceipts: boolean;
  enableMarkers: boolean;
  enableRetraction: boolean;
  enableReactions: boolean;
}

// Updated ServerFeatures to include enableTyping 
export interface ServerFeaturesWithTyping extends ServerFeatures {
  enableTyping: boolean;
}

export interface MessagingEventHandlers {
  onMessage?: (message: XmppMessage) => void;
  onReceipt?: (messageId: string, from: string) => void;
  onRead?: (messageId: string, from: string) => void;
  onTyping?: (from: string, state: string) => void;
  onPresence?: (contact: XmppContact) => void;
  onRoomEvent?: (room: MucRoom, event: string) => void;
  onError?: (error: Error) => void;
  onConnectionChange?: (status: ConnectionStatus) => void;
}

export interface QueuedMessage {
  id: string;
  to: string;
  body: string;
  type: 'chat' | 'groupchat';
  timestamp: Date;
  retryCount: number;
  maxRetries: number;
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