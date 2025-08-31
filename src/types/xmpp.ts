export interface XmppMessage {
  id: string;
  from: string;
  to: string;
  body: string;
  timestamp: Date;
  type: 'chat' | 'groupchat';
  threadId?: string;
  edited?: boolean;
  retracted?: boolean;
  receipt?: 'sent' | 'delivered' | 'read';
  marker?: 'received' | 'displayed';
  delay?: Date;
  fileUrl?: string;
  fileName?: string;
  fileSize?: number;
  fileType?: string;
  reactions?: Array<{ emoji: string; from: string }>;
}

export interface XmppContact {
  jid: string;
  name: string;
  subscription: 'none' | 'to' | 'from' | 'both';
  presence: 'available' | 'away' | 'dnd' | 'xa' | 'unavailable';
  status?: string;
  lastSeen?: Date;
  avatar?: string;
  vCard?: {
    fullName?: string;
    email?: string;
    phone?: string;
    organization?: string;
  };
}

export interface XmppThread {
  id: string;
  type: 'chat' | 'groupchat';
  jid: string;
  name: string;
  lastMessage?: XmppMessage;
  unreadCount: number;
  isPinned: boolean;
  isMuted: boolean;
  isHidden: boolean;
  participants?: Array<{
    jid: string;
    name: string;
    role?: 'owner' | 'admin' | 'member' | 'visitor';
    affiliation?: 'owner' | 'admin' | 'member' | 'outcast' | 'none';
  }>;
  subject?: string;
  bookmark?: {
    autoJoin: boolean;
    nick?: string;
  };
}

export interface XmppRoom {
  jid: string;
  name: string;
  subject?: string;
  description?: string;
  occupants: Array<{
    jid: string;
    nick: string;
    role: 'moderator' | 'participant' | 'visitor' | 'none';
    affiliation: 'owner' | 'admin' | 'member' | 'outcast' | 'none';
    presence: 'available' | 'unavailable';
  }>;
  config?: {
    persistent: boolean;
    public: boolean;
    membersOnly: boolean;
    moderated: boolean;
    passwordProtected: boolean;
  };
}

export interface XmppConnectionStatus {
  status: 'disconnected' | 'connecting' | 'connected' | 'resuming' | 'reconnecting' | 'error';
  error?: string;
  resumeSupported: boolean;
  streamId?: string;
}

export interface TypingIndicator {
  jid: string;
  threadId: string;
  isTyping: boolean;
  timestamp: Date;
}

export interface XmppFeatureFlags {
  enableStreamManagement: boolean;
  enableCarbons: boolean;
  enableMAM: boolean;
  enableMUC: boolean;
  enableHTTPUpload: boolean;
  enableVCard: boolean;
  enableBlocking: boolean;
  enableReceipts: boolean;
  enableMarkers: boolean;
  enableTyping: boolean;
  enableEdit: boolean;
  enableRetract: boolean;
  enableReactions: boolean;
}

export interface MessagingEventHandlers {
  onMessage?: (message: XmppMessage) => void;
  onReceipt?: (messageId: string, from: string, type: 'delivered' | 'read') => void;
  onMarker?: (messageId: string, from: string, type: 'received' | 'displayed') => void;
  onTyping?: (indicator: TypingIndicator) => void;
  onPresence?: (contact: XmppContact) => void;
  onRoomEvent?: (roomJid: string, event: string, data: any) => void;
  onError?: (error: Error) => void;
  onConnectionStatus?: (status: XmppConnectionStatus) => void;
}

export interface XmppConfig {
  serviceUrl?: string;
  domain?: string;
  resource?: string;
  getCredentials?: () => Promise<{ jid: string; password: string }>;
  existingClient?: any;
  features?: Partial<XmppFeatureFlags>;
  onEvents?: Partial<MessagingEventHandlers>;
  getUploadAuthHeaders?: () => Promise<Record<string, string>>;
}

export interface OutboxMessage {
  id: string;
  to: string;
  body: string;
  type: 'chat' | 'groupchat';
  timestamp: Date;
  retries: number;
}