import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  useEffect,
} from "react";
import { client, xml, jid as xmppJid } from "@xmpp/client";
import { useSettings } from "./SettingsContext";
import { useXmppPersistence } from "@/hooks/useXmppPersistence";
import { XmppStreamManager } from "@/lib/xmppStreamManagement";
import { XmppFeatureDetector } from "@/lib/xmppFeatureDetector";
import { XmppMessageHandler } from "@/lib/xmppMessageHandler";
import { 
  XmppMessage, 
  XmppContact, 
  XmppConversation, 
  MucRoom, 
  MessageStatus, 
  PresenceShow,
  RoomOccupant,
  RoomRole,
  RoomAffiliation,
  ConnectionInfo,
  ServerFeatures,
  MamQuery,
  MamResult,
  QueuedMessage
} from "@/types/xmpp";
import { xmppStorage } from '@/lib/xmppStorage';

type ConnectionState = "disconnected" | "connecting" | "connected" | "authenticating" | "resuming" | "error";
type UiConnectionState = "connected" | "reconnecting" | "offline";

type XmppContextType = {
  // Connection & state
  connectionState: ConnectionState;
  uiConnection: UiConnectionState;
  connectionInfo: ConnectionInfo;
  serverFeatures: ServerFeatures;
  
  // Core data
  conversations: XmppConversation[];
  contacts: XmppContact[];
  rooms: MucRoom[];
  
  // User state
  userPresence: { presence: PresenceShow; status?: string };
  nickname: string;
  effectiveJid: string;
  
  // Connection management
  connect: () => Promise<boolean>;
  disconnect: () => Promise<void>;
  
  // Roster management
  fetchRoster: () => Promise<void>;
  loadRoster: () => Promise<void>;
  addContact: (jid: string, name?: string) => Promise<boolean>;
  removeContact: (jid: string) => Promise<boolean>;
  subscribeToPresence: (jid: string) => Promise<boolean>;
  unsubscribeFromPresence: (jid: string) => Promise<boolean>;
  
  // Presence management
  setPresence: (presence: PresenceShow, status?: string) => void;
  queryLastActivity: (jid: string) => Promise<Date | null>;
  
  // Direct messaging
  sendMessage: (toBareJid: string, body: string) => Promise<boolean>;
  startConversation: (bareJid: string, name?: string) => void;
  markMessageRead: (messageId: string, conversationJid: string) => void;
  markConversationRead: (bareJid: string) => void;
  
  // Message history & management
  loadConversationHistory: (bareJid: string, before?: string) => Promise<void>;
  retractMessage: (conversationJid: string, messageId: string, reason?: string) => Promise<boolean>;
  hideMessage: (conversationJid: string, messageId: string) => void;
  deleteMessageLocally: (conversationJid: string, messageId: string) => void;
  
  // Conversation management
  archiveConversation: (bareJid: string, archived?: boolean) => void;
  removeConversation: (bareJid: string) => void;
  pinConversation: (bareJid: string, pinned?: boolean) => void;
  
  // Room/MUC functionality
  createRoom: (roomName: string, nick: string, password?: string) => Promise<boolean>;
  joinRoom: (roomJid: string, nick: string, password?: string) => Promise<boolean>;
  leaveRoom: (roomJid: string) => void;
  destroyRoom: (roomJid: string, reason?: string) => Promise<boolean>;
  sendRoomMessage: (roomJid: string, body: string) => Promise<boolean>;
  inviteToRoom: (roomJid: string, userJid: string, reason?: string) => void;
  kickFromRoom: (roomJid: string, nick: string, reason?: string) => void;
  banFromRoom: (roomJid: string, jid: string, reason?: string) => void;
  setRoomAffiliation: (roomJid: string, jid: string, affiliation: RoomAffiliation) => void;
  muteRoom: (roomJid: string, muted: boolean) => void;
  loadRoomHistory: (roomJid: string, before?: string) => Promise<void>;
  markRoomRead: (roomJid: string) => void;
  archiveRoom: (roomJid: string, archived?: boolean) => void;
  removeRoom: (roomJid: string) => void;
  
  // Discovery
  listMucServices: () => Promise<string[]>;
  listRooms: (serviceJid: string) => Promise<Array<{jid: string; name: string}>>;
  searchUsers: (searchTerm: string) => Promise<Array<{jid: string; name: string}>>;
  refreshRooms: () => Promise<void>;
  
  // Typing indicators
  sendTypingNotification: (to: string, state: 'composing' | 'paused' | 'active') => void;
  
  // Diagnostics
  lastError: string | null;
  lastAttemptAt: Date | null;
  runWebSocketDiagnostics: () => Promise<{success: boolean; details: string}>;
  
  // Utilities
  setNickname: (nickname: string) => void;
  clearStorage: () => void;
  getOfflineQueue: () => QueuedMessage[];
};

const XmppContext = createContext<XmppContextType | null>(null);

export const useXmpp = () => {
  const ctx = useContext(XmppContext);
  if (!ctx) throw new Error("useXmpp must be used within XmppProvider");
  return ctx;
};

export const XmppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { settings } = useSettings();

  // Core refs
  const xmppRef = useRef<ReturnType<typeof client> | null>(null);
  const genRef = useRef(0);
  const myBareJidRef = useRef<string>("");
  const manualDisconnectRef = useRef(false);
  const connectingRef = useRef(false);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectBackoffRef = useRef(1000);
  const reconnectGraceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const keepAliveTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Managers
  const streamManagerRef = useRef<XmppStreamManager>();
  const featureDetectorRef = useRef<XmppFeatureDetector>();
  const messageHandlerRef = useRef<XmppMessageHandler>();

  // State
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [showReconnecting, setShowReconnecting] = useState(false);
  const [conversations, setConversations] = useState<XmppConversation[]>([]);
  const [contacts, setContacts] = useState<XmppContact[]>([]);
  const [loadingRoster, setLoadingRoster] = useState(false);
  const [rooms, setRooms] = useState<MucRoom[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastAttemptAt, setLastAttemptAt] = useState<Date | null>(null);
  const [userPresence, setUserPresence] = useState<{ presence: PresenceShow; status?: string }>({ presence: 'available' });
  const [nickname, setNickname] = useState<string>(settings?.xmpp?.username || '');
  const [serverFeatures, setServerFeatures] = useState<ServerFeatures>({
    streamManagement: false,
    messageDeliveryReceipts: false,
    chatMarkers: false,
    messageArchiveManagement: false,
    messageRetraction: false,
    lastActivity: false,
    messageCarbons: false,
    rosterVersioning: false,
    presenceSubscription: false,
    muc: false,
    mucAdmin: false,
    mucOwner: false,
    sipFileTransfer: false,
    httpFileUpload: false,
    ping: false,
    time: false,
    softwareVersion: false,
    entityCapabilities: false,
  });

  // Conversation management functions
  const ensureConversation = useCallback((bareJid: string, init?: Partial<XmppConversation>) => {
    setConversations(prev => {
      const idx = prev.findIndex(c => c.jid === bareJid);
      if (idx === -1) {
        const name = init?.name || bareJid?.split("@")?.[0] || 'Unknown';
        const conv: XmppConversation = {
          jid: bareJid,
          name,
          messages: [],
          unreadCount: 0,
          lastActivity: new Date(0),
          hasMoreHistory: true,
          ...init,
        };
        return [conv, ...prev];
      } else {
        const copy = prev.slice();
        copy[idx] = { ...prev[idx], ...init };
        return copy;
      }
    });
  }, []);

  const ensureContact = useCallback((bareJid: string, init?: Partial<XmppContact>) => {
    setContacts(prev => {
      const idx = prev.findIndex(c => c.jid === bareJid);
      if (idx === -1) {
        const contact: XmppContact = {
          jid: bareJid,
          name: bareJid?.split("@")?.[0] || 'Unknown',
          subscription: 'none',
          presence: 'unavailable',
          ...init,
        };
        return [contact, ...prev];
      } else {
        const copy = prev.slice();
        copy[idx] = { ...prev[idx], ...init };
        return copy;
      }
    });
  }, []);

  const ensureRoom = useCallback((roomJid: string, init?: Partial<MucRoom>) => {
    setRooms(prev => {
      const canonicalJid = xmppJid(roomJid).bare().toString();
      const idx = prev.findIndex(r => xmppJid(r.jid).bare().toString() === canonicalJid);
      
      if (idx === -1) {
        const room: MucRoom = {
          jid: canonicalJid,
          name: canonicalJid?.split("@")?.[0] || 'Unknown',
          nick: '',
          joined: false,
          isOwner: false,
          isMuted: false,
          occupants: [],
          messages: [],
          unreadCount: 0,
          lastActivity: new Date(0),
          hasMoreHistory: true,
          ...init,
        };
        return [room, ...prev];
      } else {
        const copy = prev.slice();
        copy[idx] = { ...prev[idx], ...init };
        return copy;
      }
    });
  }, []);

  // Initialize managers
  useEffect(() => {
    const onReconnect = () => {
      console.log('Stream resumed, fetching missed data');
      fetchRoster();
    };
    
    const onStanzaAck = (count: number) => {
      console.log('Stanzas acknowledged:', count);
    };

    streamManagerRef.current = new XmppStreamManager(onReconnect, onStanzaAck);
    featureDetectorRef.current = new XmppFeatureDetector();
    messageHandlerRef.current = new XmppMessageHandler(
      handleIncomingMessage,
      handleMessageStatusUpdate,
      handleTypingIndicator
    );

    // Load offline queue
    streamManagerRef.current.loadOfflineQueue();
    
    // Cleanup on unmount
    return () => {
      if (keepAliveTimerRef.current) {
        clearInterval(keepAliveTimerRef.current);
        keepAliveTimerRef.current = null;
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (reconnectGraceTimerRef.current) {
        clearTimeout(reconnectGraceTimerRef.current);
        reconnectGraceTimerRef.current = null;
      }
    };
  }, []);

  // Connection info
  const connectionInfo: ConnectionInfo = useMemo(() => ({
    state: connectionState,
    lastConnected: undefined, // TODO: track this
    lastDisconnected: undefined, // TODO: track this
    errorMessage: lastError || undefined,
    retryCount: 0, // TODO: track this
    serverFeatures: Object.keys(serverFeatures).filter(key => serverFeatures[key as keyof ServerFeatures]),
    streamManagement: streamManagerRef.current?.getStreamState() || {
      enabled: false,
      resumed: false,
      inboundCount: 0,
      outboundCount: 0,
      unackedStanzas: []
    },
    isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true
  }), [connectionState, lastError, serverFeatures]);

  // Persistence
  const currentAccount = myBareJidRef.current || (settings?.xmpp ? `${settings.xmpp.username}@${settings.xmpp.domain}` : null);

  const { clearStorage } = useXmppPersistence({
    currentAccount,
    conversations,
    rooms,
    connectionState,
    onHydrateConversations: setConversations,
    onHydrateRooms: setRooms,
    onRejoinRooms: async (roomJids) => {
      for (const roomJid of roomJids) {
        const room = rooms.find(r => r.jid === roomJid);
        if (room && room.nick) {
          await joinRoom(roomJid, room.nick);
        }
      }
    },
    onLoadRecentHistory: async (conversationJids) => {
      for (const jid of conversationJids) {
        await loadConversationHistory(jid);
      }
    },
  });

  // Helper functions
  const bumpGen = () => { genRef.current += 1; return genRef.current; };

  const startReconnectGrace = useCallback(() => {
    setShowReconnecting(true);
    if (reconnectGraceTimerRef.current) {
      clearTimeout(reconnectGraceTimerRef.current);
    }
    reconnectGraceTimerRef.current = setTimeout(() => {
      setShowReconnecting(false);
      reconnectGraceTimerRef.current = null;
    }, 10000);
  }, []);

  const clearReconnectGrace = useCallback(() => {
    if (reconnectGraceTimerRef.current) {
      clearTimeout(reconnectGraceTimerRef.current);
      reconnectGraceTimerRef.current = null;
    }
    setShowReconnecting(false);
  }, []);

  // Optimized message handlers with efficient deduplication
  const handleIncomingMessage = useCallback((message: XmppMessage) => {
    const fromBare = xmppJid(message.from).bare().toString();
    
    if (message.type === 'chat') {
      // Direct message
      ensureConversation(fromBare);
      setConversations(prev => {
        const idx = prev.findIndex(c => c.jid === fromBare);
        if (idx === -1) return prev;
        
        const conv = prev[idx];
        
        // Efficient deduplication - check by ID and originId
        const existingMessage = conv.messages.find(m => 
          m.id === message.id || 
          (m.originId && message.originId && m.originId === message.originId)
        );
        if (existingMessage) return prev;
        
        // Binary search insertion for better performance with large message lists
        const messages = [...conv.messages];
        const insertIndex = messages.findIndex(m => m.timestamp > message.timestamp);
        if (insertIndex === -1) {
          messages.push(message);
        } else {
          messages.splice(insertIndex, 0, message);
        }
        
        const updated: XmppConversation = {
          ...conv,
          messages,
          lastActivity: message.timestamp > conv.lastActivity ? message.timestamp : conv.lastActivity,
          unreadCount: conv.unreadCount + (!message.isFromArchive ? 1 : 0),
        };
        
        const copy = [...prev];
        copy[idx] = updated;
        return copy;
      });
    } else if (message.type === 'groupchat') {
      // Room message with same optimization
      const roomJid = fromBare;
      setRooms(prev => {
        const idx = prev.findIndex(r => r.jid === roomJid);
        if (idx === -1) return prev;
        
        const room = prev[idx];
        
        // Efficient deduplication
        const existingMessage = room.messages.find(m => 
          m.id === message.id || 
          (m.originId && message.originId && m.originId === message.originId)
        );
        if (existingMessage) return prev;
        
        // Binary search insertion
        const messages = [...room.messages];
        const insertIndex = messages.findIndex(m => m.timestamp > message.timestamp);
        if (insertIndex === -1) {
          messages.push(message);
        } else {
          messages.splice(insertIndex, 0, message);
        }
        
        const updated: MucRoom = {
          ...room,
          messages,
          lastActivity: message.timestamp > room.lastActivity ? message.timestamp : room.lastActivity,
          unreadCount: room.unreadCount + (!message.isFromArchive ? 1 : 0),
        };
        
        const copy = [...prev];
        copy[idx] = updated;
        return copy;
      });
    }
  }, [ensureConversation]);

  const handleMessageStatusUpdate = useCallback((messageId: string, status: MessageStatus, from: string) => {
    const fromBare = xmppJid(from).bare().toString();
    
    setConversations(prev => {
      const idx = prev.findIndex(c => c.jid === fromBare);
      if (idx === -1) return prev;
      
      const conv = prev[idx];
      const messages = conv.messages.map(m => 
        (m.id === messageId || m.originId === messageId) ? { ...m, status } : m
      );
      
      const copy = prev.slice();
      copy[idx] = { ...conv, messages };
      return copy;
    });
  }, []);

  const handleTypingIndicator = useCallback((from: string, state: 'composing' | 'paused' | 'active') => {
    const fromBare = xmppJid(from).bare().toString();
    
    setConversations(prev => {
      const idx = prev.findIndex(c => c.jid === fromBare);
      if (idx === -1) return prev;
      
      const conv = prev[idx];
      const copy = prev.slice();
      copy[idx] = { 
        ...conv, 
        isTyping: state === 'composing',
        lastTypingFrom: from
      };
      return copy;
    });
  }, []);


  // Connection management
  const connect = useCallback(async (): Promise<boolean> => {
    if (!settings?.xmpp) {
      setLastError("XMPP settings not configured");
      return false;
    }

    if (connectingRef.current || connectionState === 'connected') {
      console.log("Connection already in progress or connected");
      return false;
    }

    // Clear any existing reconnect timeout
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    connectingRef.current = true;
    const gen = bumpGen();

    try {
      setConnectionState("connecting");
      setLastAttemptAt(new Date());
      setLastError(null);
      manualDisconnectRef.current = false;

      const { websocketUrl, domain, username, password } = settings.xmpp;
      const fullJid = `${username}@${domain}`;

      console.log("Connecting to XMPP server:", { websocketUrl, domain, username });

      // Clean up existing client first
      if (xmppRef.current) {
        try {
          await xmppRef.current.stop();
        } catch (error) {
          console.warn("Error stopping existing XMPP client:", error);
        }
        xmppRef.current = null;
      }

      const xmpp = client({
        service: websocketUrl,
        domain,
        username,
        password,
        resource: sessionStorage.getItem('xmpp-resource') || `lovable-webclient-${Date.now()}`,
      });

      xmppRef.current = xmpp;
      sessionStorage.setItem('xmpp-resource', xmpp.jid?.resource || `lovable-webclient-${Date.now()}`);
      myBareJidRef.current = fullJid;

      // Set up managers
      streamManagerRef.current?.setXmppClient(xmpp);
      featureDetectorRef.current?.setXmppClient(xmpp);
      messageHandlerRef.current?.setXmppClient(xmpp);

      // Set up event handlers
      xmpp.on("status", (status) => {
        if (gen !== genRef.current) return;
        
        console.log(`XMPP status: ${status} at ${new Date().toISOString()}`);
        
        if (status === "online") {
          setConnectionState("connected");
          clearReconnectGrace();
          reconnectBackoffRef.current = 1000;
          
          // Clear any reconnect timeout on successful connection
          if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
            reconnectTimeoutRef.current = null;
          }
          
          // Post-connection setup with optimized ordering
          setTimeout(async () => {
            if (gen !== genRef.current) return;
            
            try {
              // Phase 1: Critical - Discover server features
              const features = await featureDetectorRef.current?.discoverServerFeatures();
              if (features) {
                setServerFeatures(features);
              }
              
              // Phase 2: Critical - Enable features and load roster
              if (features?.streamManagement) {
                await streamManagerRef.current?.enableStreamManagement();
              }
              
              if (features?.messageCarbons) {
                await featureDetectorRef.current?.enableMessageCarbons();
              }
              
              // Load roster
              await fetchRoster();
              
              // Send initial presence
              setPresence(userPresence.presence, userPresence.status);
              
              // Send queued messages
              await streamManagerRef.current?.sendQueuedMessages();
              
              // Start keep-alive ping
              startKeepAlivePing();
              
              // Phase 3: Non-critical - Defer optional operations
              setTimeout(() => {
                if (gen !== genRef.current) return;
                
                // Background: Load conversation history (debounced, non-blocking)
                // Background: Discover MUC services (non-blocking, failures are OK)
                featureDetectorRef.current?.discoverMucServices().catch(err => {
                  console.debug('MUC discovery failed (non-critical):', err.message);
                });
                
                // Background: Sync rooms with server to clean up stale rooms
                syncRoomsWithServer().catch(err => {
                  console.debug('Room sync failed (non-critical):', err.message);
                });
              }, 2000); // Wait 2 seconds for stability
              
            } catch (error) {
              console.error("Post-connection setup failed:", error);
              // Don't crash, continue with degraded functionality
            }
          }, 100);
          
        } else if (status === "disconnect") {
          if (!manualDisconnectRef.current) {
            console.log("Unexpected disconnect, scheduling reconnect");
            scheduleReconnect();
          }
        } else if (status === "offline") {
          setConnectionState("disconnected");
        }
      });

      xmpp.on("error", (error) => {
        if (gen !== genRef.current) return;
        console.error("XMPP error:", error);
        setConnectionState("error");
        setLastError(error.message || "Connection error");
        
        if (!manualDisconnectRef.current) {
          scheduleReconnect();
        }
      });

      // Message handling
      xmpp.on("stanza", (stanza) => {
        if (gen !== genRef.current) return;
        
        // Count inbound stanzas for stream management
        streamManagerRef.current?.countInboundStanza();
        
        // Handle stream management stanzas
        if (streamManagerRef.current?.handleStreamManagement(stanza)) {
          return;
        }
        
        if (stanza.is("message")) {
          messageHandlerRef.current?.handleMessage(stanza);
        } else if (stanza.is("presence")) {
          handlePresence(stanza);
        }
      });

      await xmpp.start();
      return true;

    } catch (error) {
      console.error("Connection failed:", error);
      setConnectionState("error");
      setLastError(error instanceof Error ? error.message : "Connection failed");
      
      if (!manualDisconnectRef.current) {
        scheduleReconnect();
      }
      
      return false;
    } finally {
      connectingRef.current = false;
    }
  }, [settings?.xmpp, userPresence, clearReconnectGrace]);

  const disconnect = useCallback(async () => {
    manualDisconnectRef.current = true;
    clearReconnectGrace();
    stopKeepAlivePing();
    
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (xmppRef.current) {
      try {
        await xmppRef.current.stop();
      } catch (error) {
        console.error("Disconnect error:", error);
      }
      xmppRef.current = null;
    }

    setConnectionState("disconnected");
  }, [clearReconnectGrace]);

  // Keep-alive ping to prevent disconnections
  const startKeepAlivePing = useCallback(() => {
    stopKeepAlivePing(); // Clear any existing timer
    
    keepAliveTimerRef.current = setInterval(async () => {
      if (connectionState !== 'connected' || !featureDetectorRef.current) {
        return;
      }
      
      try {
        const latency = await featureDetectorRef.current.ping();
        if (latency !== null) {
          console.debug(`Keep-alive ping: ${latency}ms`);
        } else {
          console.warn('Keep-alive ping failed, connection may be unstable');
        }
      } catch (error) {
        console.error('Keep-alive ping error:', error);
      }
    }, 30000); // Ping every 30 seconds
  }, [connectionState]);

  const stopKeepAlivePing = useCallback(() => {
    if (keepAliveTimerRef.current) {
      clearInterval(keepAliveTimerRef.current);
      keepAliveTimerRef.current = null;
    }
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (manualDisconnectRef.current) return;

    startReconnectGrace();
    stopKeepAlivePing(); // Stop keep-alive when disconnected
    
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }

    const delay = Math.min(reconnectBackoffRef.current, 30000);
    console.log(`Scheduling reconnect in ${delay}ms`);

    reconnectTimeoutRef.current = setTimeout(() => {
      if (manualDisconnectRef.current) return;
      
      console.log("Attempting reconnect...");
      reconnectBackoffRef.current = Math.min(reconnectBackoffRef.current * 1.5, 30000);
      
      connect().catch(console.error);
    }, delay);
  }, [startReconnectGrace, stopKeepAlivePing, connect]);

  // Presence handling
  const handlePresence = useCallback((stanza: any) => {
    const from = stanza.attrs.from || "";
    const fromBare = xmppJid(from).bare().toString();

    // MUC presence
    const mucUser = stanza.getChild("x", "http://jabber.org/protocol/muc#user");
    if (mucUser && from.includes("/")) {
      const roomJid = fromBare;
      const nick = from?.split("/")?.[1] || from;
      const item = mucUser.getChild("item");
      const role: RoomRole = (item?.attrs?.role as RoomRole) || 'none';
      const affiliation: RoomAffiliation = (item?.attrs?.affiliation as RoomAffiliation) || 'none';
      const jid = item?.attrs?.jid as string | undefined;
      const type = stanza.attrs.type;

      setRooms(prev => {
        const idx = prev.findIndex(r => r.jid === roomJid);
        if (idx === -1) return prev;
        
        const room = prev[idx];
        let occupants = [...room.occupants];
        const oi = occupants.findIndex(o => o.nick === nick);

        if (type === "unavailable") {
          if (oi !== -1) occupants.splice(oi, 1);
        } else {
          const show = stanza.getChildText("show");
          const presence: PresenceShow = 
            type === "unavailable" ? "unavailable" :
            show === "dnd" ? "dnd" :
            show === "away" || show === "xa" ? "away" :
            "available";

          const occ: RoomOccupant = { nick, jid, role, affiliation, presence };
          if (oi === -1) occupants.push(occ);
          else occupants[oi] = { ...occupants[oi], ...occ };
        }

        const self = occupants.find(o => o.nick === room.nick);
        const isOwner = self?.affiliation === "owner";

        const copy = prev.slice();
        copy[idx] = { ...room, occupants, isOwner };
        return copy;
      });
      return;
    }

    // Regular presence
    ensureContact(fromBare);
    const type = stanza.attrs.type || "available";
    const show = stanza.getChildText("show");
    const status = stanza.getChildText("status");
    
    const presence: PresenceShow =
      type === "unavailable" ? "unavailable" :
      show === "dnd" ? "dnd" :
      show === "away" ? "away" :
      show === "xa" ? "xa" :
      "available";

    setContacts(prev => prev.map(c => 
      c.jid === fromBare ? { ...c, presence, status } : c
    ));
  }, [ensureContact]);

  // Roster management
  const fetchRoster = useCallback(async () => {
    // Store client reference to avoid race condition
    const client = xmppRef.current;
    if (!client || !client.iqCaller) return;

    setLoadingRoster(true);
    
    try {
      const rosterIq = xml("iq", { type: "get", id: crypto.randomUUID() }, 
        xml("query", "jabber:iq:roster")
      );
      
      // Check connection again before sending
      if (!client.iqCaller) {
        console.warn('XMPP client disconnected before roster fetch');
        return;
      }

      // Create timeout promise (30s timeout)
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('TimeoutError')), 30000);
      });

      // Race between IQ request and timeout
      const res: any = await Promise.race([
        client.iqCaller.request(rosterIq),
        timeoutPromise
      ]);

      const items = res.getChild("query", "jabber:iq:roster")?.getChildren("item") ?? [];
      
      const contactList: XmppContact[] = items.map((item: any) => ({
        jid: item.attrs.jid,
        name: item.attrs.name || item.attrs.jid?.split("@")?.[0] || 'Unknown',
        subscription: item.attrs.subscription || 'none',
        presence: 'unavailable' as PresenceShow,
        ask: item.attrs.ask,
        approved: item.attrs.approved === 'true'
      }));
      
      setContacts(contactList);
      
      // Query last activity for each contact if supported (non-blocking)
      if (serverFeatures.lastActivity) {
        // Run in background, don't block
        setTimeout(() => {
          contactList.forEach(async (contact) => {
            try {
              const lastSeen = await featureDetectorRef.current?.queryLastActivity(contact.jid);
              if (lastSeen) {
                setContacts(prev => prev.map(c => 
                  c.jid === contact.jid ? { ...c, lastSeen } : c
                ));
              }
            } catch (err) {
              // Ignore individual failures
              console.debug(`Failed to get last activity for ${contact.jid}`);
            }
          });
        }, 500);
      }
      
    } catch (error) {
      console.error("Failed to load roster:", error);
      // Don't crash, continue with empty roster
    } finally {
      setLoadingRoster(false);
    }
  }, [serverFeatures.lastActivity]);

  const addContact = useCallback(async (jid: string, name?: string): Promise<boolean> => {
    if (!xmppRef.current) return false;

    try {
      // Add to roster
      const rosterIq = xml("iq", { type: "set", id: crypto.randomUUID() },
        xml("query", "jabber:iq:roster",
          xml("item", { jid, name: name || jid?.split("@")?.[0] || 'Unknown' })
        )
      );
      
      await xmppRef.current.iqCaller.request(rosterIq);
      
      // Subscribe to presence
      await subscribeToPresence(jid);
      
      return true;
    } catch (error) {
      console.error("Failed to add contact:", error);
      return false;
    }
  }, []);

  const removeContact = useCallback(async (jid: string): Promise<boolean> => {
    if (!xmppRef.current) return false;

    try {
      // Remove from roster
      const rosterIq = xml("iq", { type: "set", id: crypto.randomUUID() },
        xml("query", "jabber:iq:roster",
          xml("item", { jid, subscription: "remove" })
        )
      );
      
      await xmppRef.current.iqCaller.request(rosterIq);
      
      setContacts(prev => prev.filter(c => c.jid !== jid));
      return true;
    } catch (error) {
      console.error("Failed to remove contact:", error);
      return false;
    }
  }, []);

  const subscribeToPresence = useCallback(async (jid: string): Promise<boolean> => {
    if (!xmppRef.current) return false;

    try {
      const presenceStanza = xml("presence", { to: jid, type: "subscribe" });
      await xmppRef.current.send(presenceStanza);
      return true;
    } catch (error) {
      console.error("Failed to subscribe to presence:", error);
      return false;
    }
  }, []);

  const unsubscribeFromPresence = useCallback(async (jid: string): Promise<boolean> => {
    if (!xmppRef.current) return false;

    try {
      const presenceStanza = xml("presence", { to: jid, type: "unsubscribe" });
      await xmppRef.current.send(presenceStanza);
      return true;
    } catch (error) {
      console.error("Failed to unsubscribe from presence:", error);
      return false;
    }
  }, []);

  const setPresence = useCallback((presence: PresenceShow, status?: string) => {
    setUserPresence({ presence, status });
    
    if (!xmppRef.current || connectionState !== 'connected') return;

    let presenceStanza;
    
    if (presence === 'unavailable') {
      presenceStanza = xml("presence", { type: "unavailable" });
    } else {
      presenceStanza = xml("presence");
      
      if (presence !== 'available') {
        presenceStanza.append(xml("show", {}, presence));
      }
    }

    if (status) {
      presenceStanza.append(xml("status", {}, status));
    }

    xmppRef.current.send(presenceStanza).catch(console.error);
  }, [connectionState]);

  const queryLastActivity = useCallback(async (jid: string): Promise<Date | null> => {
    if (!featureDetectorRef.current) return null;
    return await featureDetectorRef.current.queryLastActivity(jid);
  }, []);

  // Direct messaging
  const sendMessage = useCallback(async (toBareJid: string, body: string): Promise<boolean> => {
    if (!messageHandlerRef.current) return false;

    try {
      // Queue if offline
      if (connectionState !== 'connected') {
        streamManagerRef.current?.queueMessage({
          to: toBareJid,
          body,
          type: 'chat',
          priority: 'normal'
        });
        return false;
      }

      // Generate message ID first  
      const messageId = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      
      // Add to conversation locally with optimistic UI
      ensureConversation(toBareJid);
      const message: XmppMessage = {
        id: messageId,
        originId: messageId,
        from: myBareJidRef.current,
        to: toBareJid,
        body,
        timestamp: new Date(),
        type: 'chat',
        status: 'sent' // Optimistic status
      };
      
      setConversations(prev => {
        const idx = prev.findIndex(c => c.jid === toBareJid);
        if (idx === -1) return prev;
        
        const conv = prev[idx];
        
        // Check for duplicates
        const existingMessage = conv.messages.find(m => m.id === messageId);
        if (existingMessage) return prev;
        
        const updated: XmppConversation = {
          ...conv,
          messages: [...conv.messages, message],
          lastActivity: new Date()
        };
        
        const copy = [...prev];
        copy[idx] = updated;
        return copy;
      });

      // Send message asynchronously (non-blocking)
      messageHandlerRef.current.sendMessage(toBareJid, body, 'chat', { originId: messageId })
        .catch((error) => {
          console.error('Failed to send message:', error);
          // Update status to error on failure
          setConversations(prev => {
            const idx = prev.findIndex(c => c.jid === toBareJid);
            if (idx === -1) return prev;
            
            const conv = prev[idx];
            const messages = conv.messages.map(m => 
              m.id === messageId ? { ...m, status: 'error' as MessageStatus } : m
            );
            
            const copy = [...prev];
            copy[idx] = { ...conv, messages };
            return copy;
          });
        });

      return true;
    } catch (error) {
      console.error("Failed to send message:", error);
      return false;
    }
  }, [connectionState, ensureConversation]);

  const startConversation = useCallback((bareJid: string, name?: string) => {
    ensureConversation(bareJid, { name });
    ensureContact(bareJid, { name });
  }, [ensureConversation, ensureContact]);

  const markMessageRead = useCallback((messageId: string, conversationJid: string) => {
    if (!messageHandlerRef.current) return;
    
    // Send read marker if supported
    if (serverFeatures.chatMarkers) {
      messageHandlerRef.current.sendChatMarker(conversationJid, messageId, 'displayed');
    }
  }, [serverFeatures.chatMarkers]);

  const markConversationRead = useCallback((bareJid: string) => {
    setConversations(prev => prev.map(conv => 
      conv.jid === bareJid ? { ...conv, unreadCount: 0 } : conv
    ));
  }, []);

  const loadConversationHistory = useCallback(async (bareJid: string, before?: string): Promise<void> => {
    if (!messageHandlerRef.current || !serverFeatures.messageArchiveManagement) return;

    try {
      const query: MamQuery = {
        with: bareJid,
        max: 50,
        before
      };

      const result = await messageHandlerRef.current.queryMessageArchive(query);
      
      setConversations(prev => {
        const idx = prev.findIndex(c => c.jid === bareJid);
        if (idx === -1) return prev;
        
        const conv = prev[idx];
        const copy = prev.slice();
        copy[idx] = { 
          ...conv, 
          hasMoreHistory: !result.complete,
          mamBefore: result.last
        };
        return copy;
      });
      
    } catch (error) {
      console.error("Failed to load conversation history:", error);
    }
  }, [serverFeatures.messageArchiveManagement]);

  const retractMessage = useCallback(async (conversationJid: string, messageId: string, reason?: string): Promise<boolean> => {
    if (!messageHandlerRef.current) return false;

    try {
      const success = await messageHandlerRef.current.retractMessage(conversationJid, messageId, reason);
      
      if (success) {
        // Mark locally as retracted
        setConversations(prev => {
          const idx = prev.findIndex(c => c.jid === conversationJid);
          if (idx === -1) return prev;
          
          const conv = prev[idx];
          const messages = conv.messages.map(m => 
            m.id === messageId ? { 
              ...m, 
              isRetracted: true,
              retractedBy: myBareJidRef.current,
              retractedAt: new Date(),
              body: '[Message retracted]'
            } : m
          );
          
          const copy = prev.slice();
          copy[idx] = { ...conv, messages };
          return copy;
        });
      }
      
      return success;
    } catch (error) {
      console.error("Failed to retract message:", error);
      return false;
    }
  }, []);

  const hideMessage = useCallback((conversationJid: string, messageId: string) => {
    // Local UI hide - add a hidden flag or filter
    setConversations(prev => {
      const idx = prev.findIndex(c => c.jid === conversationJid);
      if (idx === -1) return prev;
      
      const conv = prev[idx];
      const messages = conv.messages.filter(m => m.id !== messageId);
      
      const copy = prev.slice();
      copy[idx] = { ...conv, messages };
      return copy;
    });
  }, []);

  const deleteMessageLocally = useCallback((conversationJid: string, messageId: string) => {
    hideMessage(conversationJid, messageId);
  }, [hideMessage]);

  const archiveConversation = useCallback((bareJid: string, archived: boolean = true) => {
    setConversations(prev => prev.map(conv => 
      conv.jid === bareJid ? { ...conv, archived } : conv
    ));
  }, []);

  const removeConversation = useCallback((bareJid: string) => {
    setConversations(prev => prev.filter(conv => conv.jid !== bareJid));
  }, []);

  const pinConversation = useCallback((bareJid: string, pinned: boolean = true) => {
    setConversations(prev => prev.map(conv => 
      conv.jid === bareJid ? { ...conv, pinned } : conv
    ));
  }, []);

  // Room functionality
  const createRoom = useCallback(async (roomName: string, nick: string, password?: string): Promise<boolean> => {
    // Implementation for creating rooms
    // This would depend on the specific server configuration
    return false;
  }, []);

  const handleRoomNotFound = useCallback((roomJid: string) => {
    console.warn('Room no longer exists on server, removing:', roomJid);
    
    // Remove from state
    setRooms(prev => prev.filter(r => r.jid !== roomJid));
    
    // Remove from storage
    xmppStorage.deleteRoom(roomJid);
  }, []);

  const joinRoom = useCallback(async (roomJid: string, nick: string, password?: string): Promise<boolean> => {
    if (!xmppRef.current || connectionState !== 'connected') return false;

    try {
      ensureRoom(roomJid, { nick });
      
      const presenceStanza = xml("presence", { to: `${roomJid}/${nick}` },
        xml("x", "http://jabber.org/protocol/muc",
          password ? xml("password", {}, password) : null
        )
      );

      await xmppRef.current.send(presenceStanza);
      
      // Wait for join confirmation with timeout
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Room join timeout'));
        }, 5000);

        const checkJoin = setInterval(() => {
          const room = rooms.find(r => r.jid === roomJid);
          if (room?.joined) {
            clearTimeout(timeout);
            clearInterval(checkJoin);
            resolve();
          }
        }, 100);
      });
      
      setRooms(prev => prev.map(room => 
        room.jid === roomJid ? { ...room, joined: true, nick } : room
      ));
      
      return true;
    } catch (error: any) {
      console.error("Failed to join room:", error);
      
      // Check if room doesn't exist or join failed
      if (error?.message?.includes('item-not-found') || 
          error?.message?.includes('gone') ||
          error?.message?.includes('timeout') ||
          error?.condition === 'item-not-found' ||
          error?.condition === 'gone') {
        handleRoomNotFound(roomJid);
      }
      
      return false;
    }
  }, [ensureRoom, handleRoomNotFound, rooms, connectionState]);

  const leaveRoom = useCallback((roomJid: string) => {
    if (!xmppRef.current || connectionState !== 'connected') return;

    const room = rooms.find(r => r.jid === roomJid);
    if (!room) return;

    const presenceStanza = xml("presence", { 
      to: `${roomJid}/${room.nick}`, 
      type: "unavailable" 
    });

    xmppRef.current.send(presenceStanza).catch(console.error);
    
    setRooms(prev => prev.map(room => 
      room.jid === roomJid ? { ...room, joined: false, occupants: [] } : room
    ));
  }, [rooms]);

  const destroyRoom = useCallback(async (roomJid: string, reason?: string): Promise<boolean> => {
    // Implementation for destroying rooms (requires owner privileges)
    return false;
  }, []);

  const sendRoomMessage = useCallback(async (roomJid: string, body: string): Promise<boolean> => {
    if (!messageHandlerRef.current || connectionState !== 'connected') return false;

    try {
      // Generate message ID first
      const messageId = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      
      // Add to room locally with optimistic UI
      const message: XmppMessage = {
        id: messageId,
        originId: messageId,
        from: `${roomJid}/${rooms.find(r => r.jid === roomJid)?.nick || 'me'}`,
        to: roomJid,
        body,
        timestamp: new Date(),
        type: 'groupchat',
        status: 'sent' // Optimistic status
      };
      
      setRooms(prev => {
        const idx = prev.findIndex(r => r.jid === roomJid);
        if (idx === -1) return prev;
        
        const room = prev[idx];
        
        // Check for duplicates
        const existingMessage = room.messages.find(m => m.id === messageId);
        if (existingMessage) return prev;
        
        const updated: MucRoom = {
          ...room,
          messages: [...room.messages, message],
          lastActivity: new Date()
        };
        
        const copy = [...prev];
        copy[idx] = updated;
        return copy;
      });

      // Send message asynchronously (non-blocking)
      messageHandlerRef.current.sendMessage(roomJid, body, 'groupchat', { originId: messageId })
        .catch((error) => {
          console.error('Failed to send room message:', error);
          // Update status to error on failure
          setRooms(prev => {
            const idx = prev.findIndex(r => r.jid === roomJid);
            if (idx === -1) return prev;
            
            const room = prev[idx];
            const messages = room.messages.map(m => 
              m.id === messageId ? { ...m, status: 'error' as MessageStatus } : m
            );
            
            const copy = [...prev];
            copy[idx] = { ...room, messages };
            return copy;
          });
        });

      return true;
    } catch (error: any) {
      console.error("Failed to send room message:", error);
      
      // Check if room doesn't exist
      if (error?.message?.includes('item-not-found') || 
          error?.message?.includes('gone') ||
          error?.condition === 'item-not-found' ||
          error?.condition === 'gone') {
        handleRoomNotFound(roomJid);
      }
      
      return false;
    }
  }, [rooms, handleRoomNotFound]);

  const inviteToRoom = useCallback((roomJid: string, userJid: string, reason?: string) => {
    if (!xmppRef.current) return;

    const inviteStanza = xml("message", { to: roomJid },
      xml("x", "http://jabber.org/protocol/muc#user",
        xml("invite", { to: userJid },
          reason ? xml("reason", {}, reason) : null
        )
      )
    );

    xmppRef.current.send(inviteStanza).catch(console.error);
  }, []);

  const kickFromRoom = useCallback((roomJid: string, nick: string, reason?: string) => {
    // Implementation for kicking users (requires moderator privileges)
  }, []);

  const banFromRoom = useCallback((roomJid: string, jid: string, reason?: string) => {
    // Implementation for banning users (requires admin privileges)
  }, []);

  const setRoomAffiliation = useCallback((roomJid: string, jid: string, affiliation: RoomAffiliation) => {
    // Implementation for setting room affiliations (requires admin/owner privileges)
  }, []);

  const muteRoom = useCallback((roomJid: string, muted: boolean) => {
    setRooms(prev => prev.map(room => 
      room.jid === roomJid ? { ...room, isMuted: muted } : room
    ));
  }, []);

  const loadRoomHistory = useCallback(async (roomJid: string, before?: string): Promise<void> => {
    if (!messageHandlerRef.current || !serverFeatures.messageArchiveManagement) return;

    try {
      const query: MamQuery = {
        with: roomJid,
        max: 50,
        before
      };

      const result = await messageHandlerRef.current.queryMessageArchive(query);
      
      setRooms(prev => {
        const idx = prev.findIndex(r => r.jid === roomJid);
        if (idx === -1) return prev;
        
        const room = prev[idx];
        const copy = prev.slice();
        copy[idx] = { 
          ...room, 
          hasMoreHistory: !result.complete,
          mamBefore: result.last
        };
        return copy;
      });
      
    } catch (error) {
      console.error("Failed to load room history:", error);
    }
  }, [serverFeatures.messageArchiveManagement]);

  const markRoomRead = useCallback((roomJid: string) => {
    setRooms(prev => prev.map(room => 
      room.jid === roomJid ? { ...room, unreadCount: 0 } : room
    ));
  }, []);

  const archiveRoom = useCallback((roomJid: string, archived: boolean = true) => {
    setRooms(prev => prev.map(room => 
      room.jid === roomJid ? { ...room, archived } : room
    ));
  }, []);

  const removeRoom = useCallback((roomJid: string) => {
    setRooms(prev => prev.filter(room => room.jid !== roomJid));
  }, []);

  // Discovery
  const listMucServices = useCallback(async (): Promise<string[]> => {
    if (!featureDetectorRef.current) return [];
    return await featureDetectorRef.current.discoverMucServices();
  }, []);

  const listRooms = useCallback(async (serviceJid: string): Promise<Array<{jid: string; name: string}>> => {
    if (!xmppRef.current) return [];

    try {
      const discoItemsIq = xml("iq", {
        type: "get",
        to: serviceJid,
        id: crypto.randomUUID()
      }, xml("query", { xmlns: "http://jabber.org/protocol/disco#items" }));

      const response = await xmppRef.current.iqCaller.request(discoItemsIq);
      const query = response.getChild("query", "http://jabber.org/protocol/disco#items");

      if (!query) return [];

      const items = query.getChildren("item");
      return items.map((item: any) => ({
        jid: item.attrs.jid,
        name: item.attrs.name || item.attrs.jid?.split("@")?.[0] || 'Unknown'
      })).filter(Boolean);
    } catch (error) {
      console.error("Failed to list rooms:", error);
      return [];
    }
  }, []);

  const syncRoomsWithServer = useCallback(async (): Promise<void> => {
    if (connectionState !== 'connected') return;
    
    try {
      console.log('Syncing rooms with server...');
      
      // Get all MUC services
      const services = await listMucServices();
      if (services.length === 0) {
        console.log('No MUC services found');
        return;
      }
      
      // Get all rooms from all services
      const allServerRooms: Set<string> = new Set();
      for (const service of services) {
        const serviceRooms = await listRooms(service);
        serviceRooms.forEach(room => allServerRooms.add(room.jid));
      }
      
      // Find rooms that exist locally but not on server
      const staleRooms = rooms.filter(room => !allServerRooms.has(room.jid));
      
      if (staleRooms.length > 0) {
        console.log(`Found ${staleRooms.length} stale room(s), removing:`, staleRooms.map(r => r.jid));
        
        // Remove stale rooms from state
        setRooms(prev => prev.filter(room => allServerRooms.has(room.jid)));
        
        // Remove from storage
        const storage = require('@/lib/xmppStorage').xmppStorage;
        staleRooms.forEach(room => storage.deleteRoom(room.jid));
        
        // Show toast notification
        const { toast } = require('@/hooks/use-toast');
        toast({
          title: 'Rooms Cleaned Up',
          description: `Removed ${staleRooms.length} room(s) that no longer exist on the server.`,
        });
      } else {
        console.log('All local rooms are valid');
      }
    } catch (error) {
      console.error('Failed to sync rooms with server:', error);
    }
  }, [connectionState, listMucServices, listRooms, rooms]);

  const refreshRooms = useCallback(async (): Promise<void> => {
    await syncRoomsWithServer();
  }, [syncRoomsWithServer]);

  const loadRoster = useCallback(async (): Promise<void> => {
    // Store client reference to avoid race condition
    const client = xmppRef.current;
    if (!client || !client.iqCaller || connectionState !== 'connected' || loadingRoster) return;
    
    setLoadingRoster(true);
    try {
      console.log("Loading roster...");
      const iq = xml('iq', { type: 'get', id: crypto.randomUUID() });
      
      const rosterQuery = xml('query', { xmlns: 'jabber:iq:roster' });
      iq.append(rosterQuery);
      
      // Check connection again before sending
      if (!client.iqCaller) {
        console.warn('XMPP client disconnected before roster load');
        return;
      }

      // Create timeout promise (30s timeout)
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('TimeoutError')), 30000);
      });

      // Race between IQ request and timeout
      const result = await Promise.race([
        client.iqCaller.request(iq),
        timeoutPromise
      ]);

      const query = result?.getChild('query', 'jabber:iq:roster');
      
      if (query) {
        const items = query.getChildren('item');
        const rosterContacts: XmppContact[] = [];
        
        for (const item of items) {
          const jid = item.attrs.jid;
          const name = item.attrs.name;
          const subscription = item.attrs.subscription;
          
          if (jid) {
            const contact: XmppContact = {
              jid,
              name: name || jid.split('@')[0] || 'Unknown',
              subscription: subscription as any || 'none',
              presence: 'unavailable',
            };
            rosterContacts.push(contact);
          }
        }
        
        console.log(`Loaded ${rosterContacts.length} contacts from roster`);
        setContacts(rosterContacts);
      }
      
    } catch (error) {
      console.error("Failed to load roster:", error);
      // Don't crash, continue with degraded functionality
    } finally {
      setLoadingRoster(false);
    }
  }, [connectionState, loadingRoster]);

  const searchUsers = useCallback(async (searchTerm: string): Promise<Array<{jid: string; name: string}>> => {
    if (!searchTerm.trim()) return [];
    
    // First search through current contacts
    const contactMatches = contacts
      .filter(contact => 
        contact.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        contact.jid.toLowerCase().includes(searchTerm.toLowerCase())
      )
      .map(contact => ({
        jid: contact.jid,
        name: contact.name
      }));
    
    // If searching for what looks like a JID, add it to results
    const mucJidPattern = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (mucJidPattern.test(searchTerm.trim()) && !contactMatches.find(c => c.jid === searchTerm.trim())) {
      contactMatches.push({
        jid: searchTerm.trim(),
        name: searchTerm.split('@')[0] || searchTerm.trim()
      });
    }
    
    return contactMatches;
  }, [contacts]);

  // Typing indicators
  const sendTypingNotification = useCallback((to: string, state: 'composing' | 'paused' | 'active') => {
    if (!messageHandlerRef.current) return;
    messageHandlerRef.current.sendTypingNotification(to, state);
  }, []);

  // Diagnostics
  const runWebSocketDiagnostics = useCallback(async (): Promise<{success: boolean; details: string}> => {
    // Implementation for WebSocket diagnostics
    return { success: true, details: "Diagnostics not implemented" };
  }, []);

  const getOfflineQueue = useCallback((): QueuedMessage[] => {
    return streamManagerRef.current?.getOfflineQueue() || [];
  }, []);

  // UI state
  const uiConnection: UiConnectionState = useMemo(() => {
    if (connectionState === "connected") return "connected";
    if (showReconnecting) return "reconnecting";
    return "offline";
  }, [connectionState, showReconnecting]);

  const effectiveJid = myBareJidRef.current || '';

  const contextValue: XmppContextType = {
    // Connection & state
    connectionState,
    uiConnection,
    connectionInfo,
    serverFeatures,
    
    // Core data
    conversations,
    contacts,
    rooms,
    
    // User state
    userPresence,
    nickname,
    effectiveJid,
    
    // Connection management
    connect,
    disconnect,
    
    // Roster management
    fetchRoster,
    loadRoster,
    addContact,
    removeContact,
    subscribeToPresence,
    unsubscribeFromPresence,
    
    // Presence management
    setPresence,
    queryLastActivity,
    
    // Direct messaging
    sendMessage,
    startConversation,
    markMessageRead,
    markConversationRead,
    
    // Message history & management
    loadConversationHistory,
    retractMessage,
    hideMessage,
    deleteMessageLocally,
    
    // Conversation management
    archiveConversation,
    removeConversation,
    pinConversation,
    
    // Room/MUC functionality
    createRoom,
    joinRoom,
    leaveRoom,
    destroyRoom,
    sendRoomMessage,
    inviteToRoom,
    kickFromRoom,
    banFromRoom,
    setRoomAffiliation,
    muteRoom,
    loadRoomHistory,
    markRoomRead,
    archiveRoom,
    removeRoom,
    
    // Discovery
    listMucServices,
    listRooms,
    searchUsers,
    refreshRooms,
    
    // Typing indicators
    sendTypingNotification,
    
    // Diagnostics
    lastError,
    lastAttemptAt,
    runWebSocketDiagnostics,
    
    // Utilities
    setNickname,
    clearStorage,
    getOfflineQueue,
  };

  return (
    <XmppContext.Provider value={contextValue}>
      {children}
    </XmppContext.Provider>
  );
};