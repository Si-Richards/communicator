import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { client, xml, jid as xmppJid } from "@xmpp/client";
import debug from "@xmpp/debug";
import { useSettings } from "./SettingsContext";

// If you already have MessageStatus in '@/types/xmpp', you can import it.
// Keeping an internal version here to avoid coupling.
type MessageStatus = "sending" | "sent" | "delivered" | "read" | "error";

/** ---------- Shapes expected by DirectChatView ---------- */
export type ChatMessage = {
  id: string;            // stanza id (we control this for receipts/markers)
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

type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

type Ctx = {
  connectionState: ConnectionState;
  conversations: Conversation[];
  contacts: Contact[];
  connect: () => Promise<boolean>;
  disconnect: () => Promise<void>;
  sendMessage: (toBareJid: string, body: string) => Promise<boolean>;
  startConversation: (bareJid: string) => void;
  loadConversationHistory: (bareJid: string) => Promise<void>;
  markMessageRead: (messageId: string, to: string) => void;       // kept to match your existing signature
  markConversationRead: (bareJid: string) => void;
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

  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);

  /** ---------- helpers ---------- */

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
      if (conv.messages.some(m => m.id === msg.id)) return prev; // dedupe by id

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

  /** ---------- roster/presence ---------- */

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
    const fromBare = xmppJid(stanza.attrs.from).bare().toString();
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

  /** ---------- messages/receipts/markers ---------- */

  const handleIncomingMessage = useCallback((stanza: any) => {
    const body = stanza.getChildText("body");
    const fromBare = xmppJid(stanza.attrs.from).bare().toString();
    const toBare = xmppJid(stanza.attrs.to).bare().toString();
    const stanzaId = stanza.attrs.id || crypto.randomUUID();

    // Delay (MAM/offline)
    const delay = stanza.getChild("delay", "urn:xmpp:delay");
    const when = delay?.attrs?.stamp ? new Date(delay.attrs.stamp) : new Date();

    // Receipts & markers namespaces
    const receiptsNS = "urn:xmpp:receipts";
    const markersNS = "urn:xmpp:chat-markers:0";

    // if peer requested a receipt, send it
    const request = stanza.getChild("request", receiptsNS);
    if (request && body) {
      const received = xml(
        "message",
        { to: stanza.attrs.from, type: "chat", id: crypto.randomUUID() },
        xml("received", receiptsNS, { id: stanzaId })
      );
      xmppRef.current?.send(received).catch(console.error);
    }

    // If we got a <received/> or <displayed/>, advance our outgoing status
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

    if (!body) return; // nothing to display

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

  /** ---------- connect/disconnect ---------- */

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

    // stop previous
    if (xmppRef.current) {
      try { await xmppRef.current.stop(); } catch {}
      xmppRef.current = null;
    }

    setConnectionState("connecting");
    const myGen = bumpGen();
    myBareJidRef.current = `${username}@${domain}`;

    const xmpp = client({ service: ws, domain, username, password, resource });
    debug(xmpp, false);

    xmpp.on("status", (s: string) => {
      if (genRef.current !== myGen) return;
      if (s === "online") setConnectionState("connected");
      if (s === "disconnect" || s === "disconnecting") setConnectionState("disconnected");
    });

    xmpp.on("error", (err: any) => {
      if (genRef.current !== myGen) return;
      console.error("XMPP error:", err);
      setConnectionState("error");
    });

    xmpp.on("stanza", (stanza: any) => {
      if (genRef.current !== myGen) return;
      if (stanza.is("message")) return handleIncomingMessage(stanza);
      if (stanza.is("presence")) return handlePresence(stanza);
    });

    xmpp.on("online", async () => {
      if (genRef.current !== myGen) return;
      try {
        await xmpp.send(xml("presence")); // announce available
        await fetchRoster();
      } catch (e) {
        console.warn("Post-online init failed:", e);
      }
    });

    try {
      await xmpp.start();
      xmppRef.current = xmpp;
      return true;
    } catch (e) {
      console.error("XMPP start failed:", e);
      setConnectionState("error");
      return false;
    }
  }, [fetchRoster, handleIncomingMessage, handlePresence, settings?.xmpp]);

  const disconnect = useCallback(async () => {
    if (xmppRef.current) {
      try { await xmppRef.current.stop(); } catch {}
      xmppRef.current = null;
    }
    setConnectionState("disconnected");
    // keep conversations/contacts for offline view
  }, []);

  /** ---------- send / read ---------- */

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

  // Signature kept to match your existing usage elsewhere:
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

      // last incoming message from peer
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

  /** ---------- MAM history with RSM <before/> paging ---------- */

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
        xml("x", "jabber:x:data",
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

      // Extract results
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

      // RSM fin
      const fin = res.getChild("fin", "urn:xmpp:mam:2");
      const rsm = fin?.getChild("set", "http://jabber.org/protocol/rsm");
      const first = rsm?.getChildText("first") || null;
      const complete = fin?.attrs?.complete === "true";

      setConversations(prev => {
        const idx = prev.findIndex(c => c.jid === bareJid);
        if (idx === -1) return prev;
        const conv = prev[idx];

        // Merge dedup + sort ASC
        const dedup = new Map(conv.messages.map(m => [m.id, m]));
        for (const m of msgs) dedup.set(m.id, m);
        const merged = Array.from(dedup.values()).sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

        const copy = prev.slice();
        copy[idx] = {
          ...conv,
          messages: merged,
          mamBefore: first,            // next <before/> anchor
          hasMoreHistory: !complete,   // button visibility
        };
        return copy;
      });
    } catch (e) {
      console.error("MAM query failed", e);
      // Prevent infinite "Load earlier" on repeated failures
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

  /** ---------- public value ---------- */

  const value = useMemo<Ctx>(() => ({
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
  ]);

  return <XmppContext.Provider value={value}>{children}</XmppContext.Provider>;
};
