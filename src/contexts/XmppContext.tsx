import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { client, xml, jid as xmppJid } from "@xmpp/client";
import { useSettings } from "./SettingsContext";
import { useXmppPersistence } from "@/hooks/useXmppPersistence";

/* ---------- Shared types ---------- */
export type MessageStatus = "sending" | "sent" | "delivered" | "read" | "error";

export type ChatMessage = {
  id: string;            // stanza id (used for receipts/markers)
  from: string;          // full JID or bare
  to: string;            // JID
  body: string;
  timestamp: Date;
  status?: MessageStatus; // only meaningful for outgoing
  isFromArchive?: boolean;
};

export type Conversation = {
  jid: string;                  // bare JID of peer
  name: string;
  messages: ChatMessage[];
  unreadCount: number;
  lastActivity: Date;
  hasMoreHistory?: boolean;     // RSM: if false => no more pages
  mamBefore?: string | null;    // RSM cursor
};

export type Contact = {
  jid: string;                  // bare
  name: string;
  presence: "available" | "away" | "dnd" | "unavailable";
};

/* ---------- MUC types ---------- */
export type RoomRole = "moderator" | "participant" | "visitor" | "none" | undefined;
export type RoomAffiliation = "owner" | "admin" | "member" | "outcast" | "none" | undefined;

export type RoomOccupant = {
  nick: string;
  jid?: string;                 // may be omitted depending on room config
  role?: RoomRole;
  affiliation?: RoomAffiliation;
  presence: "available" | "away" | "dnd" | "xa" | "unavailable";
};

export type RoomMessage = ChatMessage; // same shape works for room messages

export type MucRoom = {
  jid: string;                  // room@conference.example.com
  name: string;                 // friendly name (default = localpart)
  nick: string;                 // our nickname in the room (when joined)
  joined: boolean;
  isOwner?: boolean;            // convenience flag (derived from our occupant)
  isMuted?: boolean;            // local UI mute
  occupants: RoomOccupant[];
  messages: RoomMessage[];
  unreadCount: number;
  lastActivity: Date;
  hasMoreHistory?: boolean;     // for MAM paging
  mamBefore?: string | null;    // RSM cursor
};

type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

type Ctx = {
  // direct
  connectionState: ConnectionState;
  conversations: Conversation[];
  contacts: Contact[];
  connect: () => Promise<boolean>;
  disconnect: () => Promise<void>;
  sendMessage: (toBareJid: string, body: string) => Promise<boolean>;
  startConversation: (bareJid: string) => void;
  loadConversationHistory: (bareJid: string) => Promise<void>;
  markMessageRead: (messageId: string, to: string) => void;
  markConversationRead: (bareJid: string) => void;

  // muc
  rooms: MucRoom[];
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
  loadRoomHistory: (roomJid: string) => Promise<void>;
  markRoomRead: (roomJid: string) => void;

  listMucServices: () => Promise<string[]>;
  listRooms: (serviceJid: string) => Promise<Array<{jid: string; name: string}>>;
  // diagnostics (for SettingsPage)
  effectiveJid: string;
  lastError: string | null;
  lastAttemptAt: Date | null;
  runWebSocketDiagnostics: () => Promise<{success: boolean; details: string}>;
};

const XmppContext = createContext<Ctx | null>(null);
export const useXmpp = () => {
  const ctx = useContext(XmppContext);
  if (!ctx) throw new Error("useXmpp must be used within XmppProvider");
  return ctx;
};

export const XmppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { settings } = useSettings();

  const xmppRef = useRef<ReturnType<typeof client> | null>(null);
  const genRef = useRef(0); // generation guard for event staleness
  const myBareJidRef = useRef<string>("");
  const outboxRef = useRef<Array<{ toBareJid: string; body: string; id: string }>>([]);
  const manualDisconnectRef = useRef(false);
  const pingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const pingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectBackoffRef = useRef(1000); // Start with 1 second

  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [rooms, setRooms] = useState<MucRoom[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastAttemptAt, setLastAttemptAt] = useState<Date | null>(null);

  /* ---------- persistence ---------- */

  const handleHydrateConversations = useCallback((storedConversations: Conversation[]) => {
    setConversations(storedConversations);
  }, []);

  const handleHydrateRooms = useCallback((storedRooms: MucRoom[]) => {
    setRooms(storedRooms);
  }, []);

  const rejoinRoomsRef = useRef<string[]>([]);
  const loadHistoryRef = useRef<string[]>([]);

  const handleRejoinRooms = useCallback((roomJids: string[]) => {
    rejoinRoomsRef.current = roomJids;
  }, []);

  const handleLoadRecentHistory = useCallback((conversationJids: string[]) => {
    loadHistoryRef.current = conversationJids;
  }, []);

  const currentAccount = myBareJidRef.current || (settings?.xmpp ? `${settings.xmpp.username}@${settings.xmpp.domain}` : null);

  const { clearStorage } = useXmppPersistence({
    currentAccount,
    conversations,
    rooms,
    connectionState,
    onHydrateConversations: handleHydrateConversations,
    onHydrateRooms: handleHydrateRooms,
    onRejoinRooms: handleRejoinRooms,
    onLoadRecentHistory: handleLoadRecentHistory,
  });

  /* ---------- helpers ---------- */

  const bumpGen = () => { genRef.current += 1; return genRef.current; };

  const ensureConversation = useCallback((bareJid: string, init?: Partial<Conversation>) => {
    setConversations(prev => {
      const idx = prev.findIndex(c => c.jid === bareJid);
      if (idx === -1) {
        const name = init?.name || bareJid.split("@")[0];
        const conv: Conversation = {
          jid: bareJid,
          name,
          messages: [],
          unreadCount: 0,
          lastActivity: new Date(0),
          hasMoreHistory: true,
          mamBefore: null,
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

  const appendMessage = useCallback((bareJid: string, msg: ChatMessage, incoming: boolean) => {
    setConversations(prev => {
      const idx = prev.findIndex(c => c.jid === bareJid);
      if (idx === -1) return prev;
      const conv = prev[idx];
      if (conv.messages.some(m => m.id === msg.id)) return prev; // dedupe

      const updated: Conversation = {
        ...conv,
        messages: [...conv.messages, msg].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime()),
        lastActivity: msg.timestamp > conv.lastActivity ? msg.timestamp : conv.lastActivity,
        unreadCount: conv.unreadCount + (incoming && !msg.isFromArchive ? 1 : 0),
      };
      const copy = prev.slice();
      copy[idx] = updated;
      return copy;
    });
  }, []);

  const updateOutgoingStatus = useCallback((bareJid: string, stanzaId: string, status: MessageStatus) => {
    setConversations(prev => {
      const idx = prev.findIndex(c => c.jid === bareJid);
      if (idx === -1) return prev;
      const conv = prev[idx];
      const messages = conv.messages.map(m => (m.id === stanzaId ? { ...m, status } : m));
      const copy = prev.slice();
      copy[idx] = { ...conv, messages };
      return copy;
    });
  }, []);

  const ensureContact = useCallback((bare: string) => {
    setContacts(prev => {
      if (prev.some(c => c.jid === bare)) return prev;
      return [{ jid: bare, name: bare.split("@")[0], presence: "unavailable" }, ...prev];
    });
  }, []);

  const ensureRoom = useCallback((roomJid: string, init?: Partial<MucRoom>) => {
    setRooms(prev => {
      // Canonicalize JID to prevent duplicates
      const canonicalJid = xmppJid(roomJid).bare().toString();
      
      // Find existing room by canonical JID
      const idx = prev.findIndex(r => xmppJid(r.jid).bare().toString() === canonicalJid);
      
      if (idx === -1) {
        const room: MucRoom = {
          jid: canonicalJid,
          name: canonicalJid.split("@")[0],
          nick: init?.nick || "",
          joined: init?.joined ?? false,
          isOwner: init?.isOwner ?? false,
          isMuted: init?.isMuted ?? false,
          occupants: init?.occupants ?? [],
          messages: init?.messages ?? [],
          unreadCount: 0,
          lastActivity: new Date(0),
          hasMoreHistory: true,
          mamBefore: null,
          ...init,
        };
        return [room, ...prev];
      } else {
        // Merge with existing room
        const existing = prev[idx];
        const copy = prev.slice();
        copy[idx] = { 
          ...existing, 
          ...init,
          // Merge messages and deduplicate
          messages: init?.messages ? 
            [...existing.messages, ...init.messages]
              .filter((msg, i, arr) => arr.findIndex(m => m.id === msg.id) === i)
              .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime()) :
            existing.messages,
          // Merge occupants
          occupants: init?.occupants ? init.occupants : existing.occupants,
        };
        return copy;
      }
    });
  }, []);

  /* ---------- roster/presence ---------- */

  const fetchRoster = useCallback(async () => {
    if (!xmppRef.current) return;
    try {
      const rosterIq = xml("iq", { type: "get", id: crypto.randomUUID() }, xml("query", "jabber:iq:roster"));
      const res: any = await xmppRef.current.iqCaller.request(rosterIq);
      const items = res.getChild("query", "jabber:iq:roster")?.getChildren("item") ?? [];
      const list: Contact[] = items.map((it: any) => ({
        jid: it.attrs.jid,
        name: it.attrs.name || it.attrs.jid.split("@")[0],
        presence: "unavailable",
      }));
      setContacts(list);
    } catch (e) {
      console.warn("Roster fetch failed:", e);
    }
  }, []);

  const handlePresence = useCallback((stanza: any) => {
    const from = stanza.attrs.from || "";
    const fromBare = xmppJid(from).bare().toString();

    // MUC presence: from = roomJid/nick and contains <x xmlns='http://jabber.org/protocol/muc#user'>
    const mucUser = stanza.getChild("x", "http://jabber.org/protocol/muc#user");
    if (mucUser && from.includes("/")) {
      const roomJid = fromBare;
      const nick = from.split("/")[1];

      // occupant item has role/affiliation and possibly real JID
      const item = mucUser.getChild("item");
      const role: RoomRole = (item?.attrs?.role as RoomRole) || undefined;
      const affiliation: RoomAffiliation = (item?.attrs?.affiliation as RoomAffiliation) || undefined;
      const jid = item?.attrs?.jid as string | undefined;
      const type = stanza.attrs.type; // 'unavailable' means leaving

      setRooms(prev => {
        const idx = prev.findIndex(r => r.jid === roomJid);
        if (idx === -1) return prev;
        const room = prev[idx];

        let occupants = [...room.occupants];
        const oi = occupants.findIndex(o => o.nick === nick);

        if (type === "unavailable") {
          if (oi !== -1) occupants.splice(oi, 1);
        } else {
          const occ: RoomOccupant = { nick, jid, role, affiliation, presence: "available" };
          if (oi === -1) occupants.push(occ);
          else occupants[oi] = { ...occupants[oi], ...occ };
        }

        // Derive isOwner flag based on our own nick
        const self = occupants.find(o => o.nick === room.nick);
        const isOwner = self?.affiliation === "owner";

        const copy = prev.slice();
        copy[idx] = { ...room, occupants, isOwner };
        return copy;
      });
      return;
    }

    // regular (non-MUC) presence
    ensureContact(fromBare);
    const type = stanza.attrs.type || "available";
    const show = stanza.getChildText("show");
    const presence: Contact["presence"] =
      type === "unavailable" ? "unavailable" :
      show === "dnd" ? "dnd" :
      show === "away" || show === "xa" ? "away" :
      "available";

    setContacts(prev => prev.map(c => c.jid === fromBare ? { ...c, presence } : c));
  }, [ensureContact]);

  /* ---------- message routing ---------- */

  const handleIncomingDirectMessage = useCallback((stanza: any) => {
    const body = stanza.getChildText("body");
    const fromBare = xmppJid(stanza.attrs.from).bare().toString();
    const toBare = xmppJid(stanza.attrs.to).bare().toString();
    const stanzaId = stanza.attrs.id || crypto.randomUUID();

    const delay = stanza.getChild("delay", "urn:xmpp:delay");
    const when = delay?.attrs?.stamp ? new Date(delay.attrs.stamp) : new Date();

    const receiptsNS = "urn:xmpp:receipts";
    const markersNS = "urn:xmpp:chat-markers:0";

    // receipts/markers updates
    const receivedEl = stanza.getChild("received", receiptsNS);
    const displayedEl = stanza.getChild("displayed", markersNS);
    if (receivedEl?.attrs?.id) {
      const peer = fromBare === myBareJidRef.current ? toBare : fromBare;
      updateOutgoingStatus(peer, receivedEl.attrs.id, "delivered");
    }
    if (displayedEl?.attrs?.id) {
      const peer = fromBare === myBareJidRef.current ? toBare : fromBare;
      updateOutgoingStatus(peer, displayedEl.attrs.id, "read");
    }

    // send receipt if requested
    const request = stanza.getChild("request", receiptsNS);
    if (request && body) {
      const received = xml(
        "message",
        { to: stanza.attrs.from, type: "chat", id: crypto.randomUUID() },
        xml("received", receiptsNS, { id: stanzaId })
      );
      xmppRef.current?.send(received).catch(console.error);
    }

    if (!body) return;

    ensureConversation(fromBare, { name: fromBare.split("@")[0] });
    ensureContact(fromBare);
    appendMessage(fromBare, {
      id: stanzaId,
      from: stanza.attrs.from,
      to: stanza.attrs.to,
      body,
      timestamp: when,
      isFromArchive: Boolean(delay),
    }, /*incoming*/ true);
  }, [appendMessage, ensureContact, ensureConversation, updateOutgoingStatus]);

  const handleIncomingRoomMessage = useCallback((stanza: any) => {
    const body = stanza.getChildText("body");
    if (!body) return;

    const type = stanza.attrs.type; // 'groupchat'
    if (type !== "groupchat") return;

    const from = stanza.attrs.from || ""; // roomJid/nick
    const roomJid = xmppJid(from).bare().toString();
    const senderNick = from.split("/")[1] || "";
    const stanzaId = stanza.attrs.id || crypto.randomUUID();

    const delay = stanza.getChild("delay", "urn:xmpp:delay");
    const when = delay?.attrs?.stamp ? new Date(delay.attrs.stamp) : new Date();

    // Ensure room exists
    setRooms(prev => {
      const idx = prev.findIndex(r => r.jid === roomJid);
      if (idx === -1) {
        const room: MucRoom = {
          jid: roomJid,
          name: roomJid.split("@")[0],
          nick: "", // unknown until we join
          joined: false,
          isOwner: false,
          isMuted: false,
          occupants: [],
          messages: [],
          unreadCount: 0,
          lastActivity: new Date(0),
          hasMoreHistory: true,
          mamBefore: null,
        };
        return [room, ...prev];
      }
      return prev;
    });

    // Append message
    setRooms(prev => {
      const idx = prev.findIndex(r => r.jid === roomJid);
      if (idx === -1) return prev;
      const room = prev[idx];

      // Dedup
      if (room.messages.some(m => m.id === stanzaId)) return prev;

      const isOwn = senderNick && room.nick && senderNick === room.nick;
      const msg: RoomMessage = {
        id: stanzaId,
        from,
        to: roomJid,
        body,
        timestamp: when,
        // status only used for our local echo; incoming msgs don't need it
        isFromArchive: Boolean(delay),
      };

      const newMessages = [...room.messages, msg].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
      const unreadDelta = (!isOwn && !msg.isFromArchive) ? 1 : 0;

      const copy = prev.slice();
      copy[idx] = {
        ...room,
        messages: newMessages,
        lastActivity: msg.timestamp > room.lastActivity ? msg.timestamp : room.lastActivity,
        unreadCount: room.unreadCount + unreadDelta,
      };
      return copy;
    });
  }, []);

  /* ---------- connect/disconnect ---------- */

  const connect = useCallback(async (): Promise<boolean> => {
    const ws = settings?.xmpp?.websocketUrl;
    const domain = settings?.xmpp?.domain;
    const username = settings?.xmpp?.username;
    const password = settings?.xmpp?.password;
    const resource = settings?.xmpp?.resource || "web";

    if (!ws || !domain || !username || !password) {
      console.error("XMPP connect: missing settings");
      setConnectionState("error");
      return false;
    }

    if (xmppRef.current) {
      try { await xmppRef.current.stop(); } catch {}
      xmppRef.current = null;
    }

    setConnectionState("connecting");
    const myGen = bumpGen();
    myBareJidRef.current = `${username}@${domain}`;

    const xmpp = client({ service: ws, domain, username, password, resource });

    xmpp.on("status", (s: string) => {
      if (genRef.current !== myGen) return;
      console.log(`XMPP status: ${s} at ${new Date().toISOString()}`);
      
      if (s === "online") {
        setConnectionState("connected");
        reconnectBackoffRef.current = 1000; // Reset backoff on successful connection
      }
      if (s === "disconnect" || s === "disconnecting") {
        setConnectionState("disconnected");
        if (!manualDisconnectRef.current) {
          console.log("Unexpected disconnect, scheduling reconnect");
          scheduleReconnect("status_disconnect");
        }
      }
    });

    xmpp.on("error", (err: any) => {
      if (genRef.current !== myGen) return;
      console.error("XMPP error:", err);
      setConnectionState("error");
      if (!manualDisconnectRef.current) {
        scheduleReconnect("error");
      }
    });

    // Try to capture WebSocket close events for diagnostics
    try {
      if (xmpp.transport?.socket) {
        xmpp.transport.socket.addEventListener('close', (event: CloseEvent) => {
          if (genRef.current !== myGen) return;
          console.log(`WebSocket closed: code=${event.code}, reason="${event.reason}" at ${new Date().toISOString()}`);
        });
      }
    } catch (e) {
      // Safely ignore if transport internals differ
    }

    xmpp.on("stanza", (stanza: any) => {
      if (genRef.current !== myGen) return;
      if (stanza.is("message")) {
        const t = stanza.attrs.type;
        if (t === "groupchat") return handleIncomingRoomMessage(stanza);
        return handleIncomingDirectMessage(stanza);
      }
      if (stanza.is("presence")) return handlePresence(stanza);
    });

    xmpp.on("online", async () => {
      if (genRef.current !== myGen) return;
      try {
        await xmpp.send(xml("presence")); // announce available
        await fetchRoster();
        
        // Start keepalive pings
        startKeepalive(xmpp, myGen);
        
        // Re-join previously joined rooms
        setTimeout(async () => {
          for (const roomJid of rejoinRoomsRef.current) {
            try {
              const room = rooms.find(r => r.jid === roomJid);
              if (room && room.nick) {
                console.log(`Re-joining room: ${roomJid} as ${room.nick}`);
                ensureRoom(roomJid, { nick: room.nick, joined: true });
                const mucX = xml("x", "http://jabber.org/protocol/muc");
                const presence = xml("presence", { to: `${roomJid}/${room.nick}` }, mucX);
                await xmpp.send(presence);
              }
            } catch (e) {
              console.error("Re-join room failed", e);
            }
          }
        }, 500);
        
        // Load recent conversation history
        setTimeout(async () => {
          for (const jid of loadHistoryRef.current) {
            try {
              console.log(`Loading history for conversation: ${jid}`);
              ensureConversation(jid);
              const conv = conversations.find(c => c.jid === jid);
              const before = conv?.mamBefore ?? "";
              const queryId = crypto.randomUUID();

              const iq = xml(
                "iq",
                { type: "set", id: queryId },
                xml("query", "urn:xmpp:mam:2",
                  xml("x", { xmlns: "jabber:x:data", type: "submit" },
                    xml("field", { var: "FORM_TYPE", type: "hidden" }, xml("value", {}, "urn:xmpp:mam:2")),
                    xml("field", { var: "with" }, xml("value", {}, jid)),
                  ),
                  xml("set", "http://jabber.org/protocol/rsm",
                    before === "" ? xml("before") : xml("before", {}, before),
                    xml("max", {}, "10"),
                  )
                )
              );

              await xmpp.iqCaller.request(iq);
            } catch (e) {
              console.error(`Loading history for ${jid} failed:`, e);
            }
          }
        }, 1000);
      } catch (e) {
        console.warn("Post-online init failed:", e);
      }
    });

    try {
      manualDisconnectRef.current = false; // Reset manual disconnect flag
      await xmpp.start();
      xmppRef.current = xmpp;
      return true;
    } catch (e) {
      console.error("XMPP start failed:", e);
      setConnectionState("error");
      return false;
    }
  }, [fetchRoster, handleIncomingDirectMessage, handleIncomingRoomMessage, handlePresence, settings?.xmpp]);

  /* ---------- keepalive and reconnection ---------- */

  const startKeepalive = useCallback((xmpp: ReturnType<typeof client>, generation: number) => {
    // Clear any existing ping interval
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current);
    }

    console.log("Starting keepalive pings");
    pingIntervalRef.current = setInterval(async () => {
      if (genRef.current !== generation || !xmpp) return;

      try {
        const domain = settings?.xmpp?.domain;
        if (!domain) return;

        const pingId = crypto.randomUUID();
        const ping = xml("iq", { type: "get", to: domain, id: pingId },
          xml("ping", "urn:xmpp:ping")
        );

        console.log(`Sending keepalive ping at ${new Date().toISOString()}`);

        // Set a timeout for the ping
        pingTimeoutRef.current = setTimeout(() => {
          if (genRef.current === generation) {
            console.log("Ping timeout, triggering reconnect");
            scheduleReconnect("ping_timeout");
          }
        }, 10000); // 10 second timeout

        const response = await xmpp.iqCaller.request(ping, 10000);
        
        // Clear timeout on successful response
        if (pingTimeoutRef.current) {
          clearTimeout(pingTimeoutRef.current);
          pingTimeoutRef.current = null;
        }
        
        console.log(`Keepalive pong received at ${new Date().toISOString()}`);
      } catch (e) {
        if (genRef.current === generation) {
          console.error("Keepalive ping failed:", e);
          scheduleReconnect("ping_failed");
        }
      }
    }, 60000); // Ping every 60 seconds
  }, [settings?.xmpp?.domain]);

  const scheduleReconnect = useCallback((reason: string) => {
    if (manualDisconnectRef.current) {
      console.log("Skipping reconnect - manual disconnect");
      return;
    }

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }

    const delay = Math.min(reconnectBackoffRef.current, 30000); // Cap at 30 seconds
    console.log(`Scheduling reconnect in ${delay}ms due to: ${reason}`);

    reconnectTimeoutRef.current = setTimeout(async () => {
      if (manualDisconnectRef.current) return;

      console.log(`Attempting reconnect due to: ${reason}`);
      try {
        const success = await connect();
        if (!success) {
          // Double the backoff for next attempt
          reconnectBackoffRef.current = Math.min(reconnectBackoffRef.current * 2, 30000);
          scheduleReconnect("reconnect_failed");
        }
      } catch (e) {
        console.error("Reconnect attempt failed:", e);
        reconnectBackoffRef.current = Math.min(reconnectBackoffRef.current * 2, 30000);
        scheduleReconnect("reconnect_exception");
      }
    }, delay);

    // Increase backoff for next time
    reconnectBackoffRef.current = Math.min(reconnectBackoffRef.current * 2, 30000);
  }, [connect]);

  const disconnect = useCallback(async () => {
    manualDisconnectRef.current = true;
    
    // Clear keepalive timers
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }
    if (pingTimeoutRef.current) {
      clearTimeout(pingTimeoutRef.current);
      pingTimeoutRef.current = null;
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    
    if (xmppRef.current) {
      try { await xmppRef.current.stop(); } catch {}
      xmppRef.current = null;
    }
    setConnectionState("disconnected");
    // Keep conversations/rooms/contacts locally for offline UI
  }, []);

  /* ---------- direct send / read / history ---------- */

  const sendMessage = useCallback(async (toBareJid: string, text: string) => {
    const xmpp = xmppRef.current;
    if (!xmpp) return false;
    const to = xmppJid(toBareJid).bare().toString();
    const id = crypto.randomUUID();

    ensureConversation(to);
    ensureContact(to);

    // local echo
    appendMessage(to, {
      id,
      from: myBareJidRef.current,
      to,
      body: text,
      timestamp: new Date(),
      status: "sending",
    }, /*incoming*/ false);

    const msg = xml(
      "message",
      { to, type: "chat", id },
      xml("body", {}, text),
      xml("request", "urn:xmpp:receipts"),
      xml("markable", "urn:xmpp:chat-markers:0"),
    );

    try {
      await xmpp.send(msg);
      updateOutgoingStatus(to, id, "sent");
      return true;
    } catch (e) {
      console.error("send failed", e);
      updateOutgoingStatus(to, id, "error");
      return false;
    }
  }, [appendMessage, ensureContact, ensureConversation, updateOutgoingStatus]);

  const markMessageRead = useCallback((messageId: string, to: string) => {
    const xmpp = xmppRef.current;
    if (!xmpp) return;
    const toBare = xmppJid(to).bare().toString();
    const marker = xml(
      "message",
      { to: toBare, type: "chat", id: crypto.randomUUID() },
      xml("displayed", "urn:xmpp:chat-markers:0", { id: messageId })
    );
    xmpp.send(marker).catch(console.error);
  }, []);

  const markConversationRead = useCallback((bareJid: string) => {
    const xmpp = xmppRef.current;
    if (!xmpp) return;
    const peer = xmppJid(bareJid).bare().toString();

    setConversations(prev => {
      const idx = prev.findIndex(c => c.jid === peer);
      if (idx === -1) return prev;
      const conv = prev[idx];

      const lastIncoming = [...conv.messages]
        .reverse()
        .find(m => xmppJid(m.from).bare().toString() === peer && m.id);

      if (lastIncoming?.id) {
        const marker = xml(
          "message",
          { to: peer, type: "chat", id: crypto.randomUUID() },
          xml("displayed", "urn:xmpp:chat-markers:0", { id: lastIncoming.id })
        );
        xmpp.send(marker).catch(console.error);
      }

      const copy = prev.slice();
      copy[idx] = { ...conv, unreadCount: 0 };
      return copy;
    });
  }, []);

  const loadConversationHistory = useCallback(async (bareJid: string) => {
    const xmpp = xmppRef.current;
    if (!xmpp) throw new Error("Not connected");

    ensureConversation(bareJid);

    const conv = conversations.find(c => c.jid === bareJid);
    const before = conv?.mamBefore ?? ""; // empty <before/> = last page
    const queryId = crypto.randomUUID();

    const iq = xml(
      "iq",
      { type: "set", id: queryId },
      xml("query", "urn:xmpp:mam:2",
        xml("x", { xmlns: "jabber:x:data", type: "submit" },
          xml("field", { var: "FORM_TYPE", type: "hidden" }, xml("value", {}, "urn:xmpp:mam:2")),
          xml("field", { var: "with" }, xml("value", {}, bareJid)),
        ),
        xml("set", "http://jabber.org/protocol/rsm",
          before === "" ? xml("before") : xml("before", {}, before),
          xml("max", {}, "20"),
        )
      )
    );

    try {
      const res: any = await xmpp.iqCaller.request(iq);
      const results = res.getChildren("result", "urn:xmpp:mam:2");
      const msgs: ChatMessage[] = [];
      for (const r of results) {
        const fwd = r.getChild("forwarded", "urn:xmpp:forward:0");
        const msg = fwd?.getChild("message");
        if (!msg) continue;
        const body = msg.getChildText("body");
        if (!body) continue;
        const delay = fwd.getChild("delay", "urn:xmpp:delay");
        const stamp = delay?.attrs?.stamp ? new Date(delay.attrs.stamp) : new Date();
        const id = msg.attrs.id || r.attrs.id || crypto.randomUUID();
        msgs.push({
          id,
          from: msg.attrs.from,
          to: msg.attrs.to,
          body,
          timestamp: stamp,
          isFromArchive: true,
        });
      }

      const fin = res.getChild("fin", "urn:xmpp:mam:2");
      const rsm = fin?.getChild("set", "http://jabber.org/protocol/rsm");
      const first = rsm?.getChildText("first") || null;
      const complete = fin?.attrs?.complete === "true";

      setConversations(prev => {
        const idx = prev.findIndex(c => c.jid === bareJid);
        if (idx === -1) return prev;
        const conv = prev[idx];
        const dedup = new Map(conv.messages.map(m => [m.id, m]));
        for (const m of msgs) dedup.set(m.id, m);
        const merged = Array.from(dedup.values()).sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

        const copy = prev.slice();
        copy[idx] = {
          ...conv,
          messages: merged,
          mamBefore: first,
          hasMoreHistory: !complete,
        };
        return copy;
      });
    } catch (e) {
      console.error("MAM query failed", e);
      setConversations(prev => {
        const idx = prev.findIndex(c => c.jid === bareJid);
        if (idx === -1) return prev;
        const copy = prev.slice();
        copy[idx] = { ...prev[idx], hasMoreHistory: false };
        return copy;
      });
      throw e;
    }
  }, [conversations, ensureConversation]);

  /* ---------- MUC API ---------- */

  const createRoom = useCallback(async (roomName: string, nick: string, password?: string) => {
    const xmpp = xmppRef.current;
    if (!xmpp) return false;
    const confHost = `conference.${settings?.xmpp?.domain}`;
    const roomJid = `${roomName}@${confHost}`;

    // join to create
    const mucX = xml("x", "http://jabber.org/protocol/muc");
    if (password) mucX.append(xml("password", {}, password));

    const presence = xml("presence", { to: `${roomJid}/${nick}` }, mucX);

    try {
      ensureRoom(roomJid, { nick, joined: true });
      await xmpp.send(presence);
      return true;
    } catch (e) {
      console.error("createRoom failed", e);
      return false;
    }
  }, [ensureRoom, settings?.xmpp?.domain]);

  const joinRoom = useCallback(async (roomJid: string, nick: string, password?: string) => {
    const xmpp = xmppRef.current;
    if (!xmpp) return false;

    const mucX = xml("x", "http://jabber.org/protocol/muc");
    if (password) mucX.append(xml("password", {}, password));
    const presence = xml("presence", { to: `${roomJid}/${nick}` }, mucX);

    try {
      ensureRoom(roomJid, { nick, joined: true });
      await xmpp.send(presence);
      return true;
    } catch (e) {
      console.error("joinRoom failed", e);
      return false;
    }
  }, [ensureRoom]);

  const leaveRoom = useCallback((roomJid: string) => {
    const xmpp = xmppRef.current;
    if (!xmpp) return;

    const room = rooms.find(r => r.jid === roomJid);
    if (!room || !room.nick) return;

    const presence = xml("presence", { to: `${roomJid}/${room.nick}`, type: "unavailable" });
    xmpp.send(presence).catch(console.error);

    // Remove room entirely from the list
    setRooms(prev => prev.filter(r => r.jid !== roomJid));
  }, [rooms]);

  const destroyRoom = useCallback(async (roomJid: string, reason?: string) => {
    const xmpp = xmppRef.current;
    if (!xmpp) return false;

    try {
      const destroy = xml("destroy", { jid: roomJid });
      if (reason) destroy.append(xml("reason", {}, reason));
      const iq = xml("iq", { type: "set", to: roomJid, id: `destroy_${crypto.randomUUID()}` },
        xml("query", "http://jabber.org/protocol/muc#owner", destroy)
      );
      await xmpp.send(iq);
      setRooms(prev => prev.filter(r => r.jid !== roomJid));
      return true;
    } catch (e) {
      console.error("destroyRoom failed", e);
      return false;
    }
  }, []);

  const sendRoomMessage = useCallback(async (roomJid: string, body: string) => {
    const xmpp = xmppRef.current;
    if (!xmpp) return false;

    const room = rooms.find(r => r.jid === roomJid);
    if (!room || !room.joined) return false;

    const id = crypto.randomUUID();
    const message = xml(
      "message",
      { type: "groupchat", to: roomJid, id },
      xml("body", {}, body),
    );

    // local echo
    setRooms(prev => {
      const idx = prev.findIndex(r => r.jid === roomJid);
      if (idx === -1) return prev;
      const room = prev[idx];
      const msg: RoomMessage = {
        id,
        from: `${roomJid}/${room.nick}`,
        to: roomJid,
        body,
        timestamp: new Date(),
        status: "sending",
      };
      const copy = prev.slice();
      copy[idx] = {
        ...room,
        messages: [...room.messages, msg],
        lastActivity: msg.timestamp,
      };
      return copy;
    });

    try {
      await xmpp.send(message);
      // mark as sent
      setRooms(prev => {
        const idx = prev.findIndex(r => r.jid === roomJid);
        if (idx === -1) return prev;
        const room = prev[idx];
        const messages = room.messages.map(m => m.id === id ? { ...m, status: "sent" as MessageStatus } : m);
        const copy = prev.slice();
        copy[idx] = { ...room, messages };
        return copy;
      });
      return true;
    } catch (e) {
      console.error("sendRoomMessage failed", e);
      setRooms(prev => {
        const idx = prev.findIndex(r => r.jid === roomJid);
        if (idx === -1) return prev;
        const room = prev[idx];
        const messages = room.messages.map(m => m.id === id ? { ...m, status: "error" as MessageStatus } : m);
        const copy = prev.slice();
        copy[idx] = { ...room, messages };
        return copy;
      });
      return false;
    }
  }, [rooms]);

  const inviteToRoom = useCallback((roomJid: string, userJid: string, reason?: string) => {
    const xmpp = xmppRef.current;
    if (!xmpp) return;

    const invite = xml("invite", { to: userJid });
    if (reason) invite.append(xml("reason", {}, reason));

    const msg = xml("message", { to: roomJid },
      xml("x", "http://jabber.org/protocol/muc#user", invite)
    );
    xmpp.send(msg).catch(console.error);
  }, []);

  const kickFromRoom = useCallback((roomJid: string, nick: string, reason?: string) => {
    const xmpp = xmppRef.current;
    if (!xmpp) return;

    const item = xml("item", { nick, role: "none" });
    if (reason) item.append(xml("reason", {}, reason));

    const iq = xml("iq", { type: "set", to: roomJid, id: `kick_${crypto.randomUUID()}` },
      xml("query", "http://jabber.org/protocol/muc#admin", item)
    );
    xmpp.send(iq).catch(console.error);
  }, []);

  const banFromRoom = useCallback((roomJid: string, jid: string, reason?: string) => {
    const xmpp = xmppRef.current;
    if (!xmpp) return;

    const item = xml("item", { jid, affiliation: "outcast" });
    if (reason) item.append(xml("reason", {}, reason));

    const iq = xml("iq", { type: "set", to: roomJid, id: `ban_${crypto.randomUUID()}` },
      xml("query", "http://jabber.org/protocol/muc#admin", item)
    );
    xmpp.send(iq).catch(console.error);
  }, []);

  const setRoomAffiliation = useCallback((roomJid: string, jid: string, affiliation: RoomAffiliation) => {
    const xmpp = xmppRef.current;
    if (!xmpp) return;

    const iq = xml("iq", { type: "set", to: roomJid, id: `aff_${crypto.randomUUID()}` },
      xml("query", "http://jabber.org/protocol/muc#admin",
        xml("item", { jid, affiliation })
      )
    );
    xmpp.send(iq).catch(console.error);
  }, []);

  const muteRoom = useCallback((roomJid: string, muted: boolean) => {
    setRooms(prev => prev.map(r => r.jid === roomJid ? { ...r, isMuted: muted } : r));
  }, []);

  const loadRoomHistory = useCallback(async (roomJid: string) => {
    const xmpp = xmppRef.current;
    if (!xmpp) throw new Error("Not connected");

    // Ensure room exists
    ensureRoom(roomJid);

    const room = rooms.find(r => r.jid === roomJid);
    const before = room?.mamBefore ?? ""; // empty before => last page
    const queryId = crypto.randomUUID();

    // MAM query to the room JID (MUC archive lives at the room)
    const iq = xml(
      "iq",
      { type: "set", to: roomJid, id: queryId },
      xml("query", "urn:xmpp:mam:2",
        xml("x", { xmlns: "jabber:x:data", type: "submit" },
          xml("field", { var: "FORM_TYPE", type: "hidden" }, xml("value", {}, "urn:xmpp:mam:2")),
        ),
        xml("set", "http://jabber.org/protocol/rsm",
          before === "" ? xml("before") : xml("before", {}, before),
          xml("max", {}, "20"),
        )
      )
    );

    try {
      const res: any = await xmpp.iqCaller.request(iq);
      const results = res.getChildren("result", "urn:xmpp:mam:2");

      const msgs: RoomMessage[] = [];
      for (const r of results) {
        const fwd = r.getChild("forwarded", "urn:xmpp:forward:0");
        const msg = fwd?.getChild("message");
        if (!msg) continue;
        const body = msg.getChildText("body");
        if (!body) continue;
        const delay = fwd.getChild("delay", "urn:xmpp:delay");
        const stamp = delay?.attrs?.stamp ? new Date(delay.attrs.stamp) : new Date();
        const id = msg.attrs.id || r.attrs.id || crypto.randomUUID();
        msgs.push({
          id,
          from: msg.attrs.from || roomJid,
          to: roomJid,
          body,
          timestamp: stamp,
          isFromArchive: true,
        });
      }

      const fin = res.getChild("fin", "urn:xmpp:mam:2");
      const rsm = fin?.getChild("set", "http://jabber.org/protocol/rsm");
      const first = rsm?.getChildText("first") || null;
      const complete = fin?.attrs?.complete === "true";

      setRooms(prev => {
        const idx = prev.findIndex(r => r.jid === roomJid);
        if (idx === -1) return prev;
        const room = prev[idx];

        const dedup = new Map(room.messages.map(m => [m.id, m]));
        for (const m of msgs) dedup.set(m.id, m);
        const merged = Array.from(dedup.values()).sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

        const copy = prev.slice();
        copy[idx] = {
          ...room,
          messages: merged,
          mamBefore: first,
          hasMoreHistory: !complete,
        };
        return copy;
      });
    } catch (e) {
      console.error("Room MAM query failed", e);
      setRooms(prev => {
        const idx = prev.findIndex(r => r.jid === roomJid);
        if (idx === -1) return prev;
        const copy = prev.slice();
        copy[idx] = { ...prev[idx], hasMoreHistory: false };
        return copy;
      });
      throw e;
    }
  }, [rooms, ensureRoom]);

  const markRoomRead = useCallback((roomJid: string) => {
    setRooms(prev => prev.map(r => r.jid === roomJid ? { ...r, unreadCount: 0 } : r));
  }, []);

  const listMucServices = useCallback(async (): Promise<string[]> => {
    const xmpp = xmppRef.current;
    if (!xmpp) throw new Error("Not connected");
    
    const domain = settings?.xmpp?.domain;
    if (!domain) throw new Error("No domain configured");
    
    const iq = xml("iq", { type: "get", to: domain, id: crypto.randomUUID() },
      xml("query", "http://jabber.org/protocol/disco#items")
    );
    
    try {
      const res: any = await xmpp.iqCaller.request(iq);
      const items = res.getChild("query", "http://jabber.org/protocol/disco#items")?.getChildren("item") ?? [];
      const services: string[] = [];
      
      for (const item of items) {
        const jid = item.attrs?.jid;
        if (jid && jid.includes("conference")) {
          services.push(jid);
        }
      }
      
      // Fallback to default conference service if none found
      if (services.length === 0) {
        services.push(`conference.${domain}`);
      }
      
      return services;
    } catch (e) {
      console.error("Failed to discover MUC services:", e);
      return [`conference.${domain}`]; // fallback
    }
  }, [settings?.xmpp?.domain]);

  const listRooms = useCallback(async (serviceJid: string): Promise<Array<{jid: string; name: string}>> => {
    const xmpp = xmppRef.current;
    if (!xmpp) throw new Error("Not connected");
    
    const iq = xml("iq", { type: "get", to: serviceJid, id: crypto.randomUUID() },
      xml("query", "http://jabber.org/protocol/disco#items")
    );
    
    try {
      const res: any = await xmpp.iqCaller.request(iq);
      const items = res.getChild("query", "http://jabber.org/protocol/disco#items")?.getChildren("item") ?? [];
      
      return items.map((item: any) => ({
        jid: item.attrs?.jid || "",
        name: item.attrs?.name || item.attrs?.jid?.split("@")[0] || "Unknown Room"
      })).filter((room: any) => room.jid);
    } catch (e) {
      console.error("Failed to list rooms:", e);
      return [];
    }
  }, []);

  const runWebSocketDiagnostics = useCallback(async () => {
    setLastAttemptAt(new Date());
    setLastError(null);
    try {
      const ws = settings?.xmpp?.websocketUrl;
      if (!ws) {
        return { success: false, details: 'No WebSocket URL configured' };
      }
      
      const success = await connect();
      if (!success) {
        setLastError("Connection failed during diagnostics");
        return { success: false, details: 'Connection failed during diagnostics' };
      }
      return { success: true, details: 'WebSocket connection successful' };
    } catch (e: any) {
      const errorMsg = `Diagnostics failed: ${e?.message || String(e)}`;
      setLastError(errorMsg);
      return { success: false, details: errorMsg };
    }
  }, [connect, settings?.xmpp?.websocketUrl]);

  /* ---------- value ---------- */

  const effectiveJid = myBareJidRef.current || `${settings?.xmpp?.username || ''}@${settings?.xmpp?.domain || ''}`;

  const value = useMemo<Ctx>(() => ({
    // direct
    connectionState,
    conversations,
    contacts,
    connect,
    disconnect,
    sendMessage,
    startConversation: (bareJid: string) => ensureConversation(xmppJid(bareJid).bare().toString()),
    loadConversationHistory,
    markMessageRead,
    markConversationRead,

    // muc
    rooms,
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

    // room discovery
    listMucServices,
    listRooms,

    // diagnostics
    effectiveJid,
    lastError,
    lastAttemptAt,
    runWebSocketDiagnostics,
  }), [
    connectionState,
    conversations,
    contacts,
    connect,
    disconnect,
    sendMessage,
    ensureConversation,
    loadConversationHistory,
    markMessageRead,
    markConversationRead,
    rooms,
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
    listMucServices,
    listRooms,
    effectiveJid,
    lastError,
    lastAttemptAt,
    runWebSocketDiagnostics,
  ]);

  return <XmppContext.Provider value={value}>{children}</XmppContext.Provider>;
};
