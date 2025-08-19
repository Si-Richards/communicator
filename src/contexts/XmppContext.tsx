import React, { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';
import { client, xml } from '@xmpp/client';
import { useSettings } from './SettingsContext';
import { useToast } from '@/hooks/use-toast';

export interface XmppMessage {
  id: string;
  from: string;
  to: string;
  body: string;
  timestamp: Date;
  type: 'chat' | 'groupchat';
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
}

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

interface XmppContextType {
  connectionState: ConnectionState;
  conversations: XmppConversation[];
  contacts: XmppContact[];
  connect: () => Promise<boolean>;
  disconnect: () => void;
  sendMessage: (to: string, body: string) => Promise<boolean>;
  addContact: (jid: string) => void;
  removeContact: (jid: string) => void;
  setPresence: (show?: 'away' | 'dnd' | 'xa', status?: string) => void;
  startConversation: (jid: string) => void;
}

const XmppContext = createContext<XmppContextType | undefined>(undefined);

export const useXmpp = () => {
  const context = useContext(XmppContext);
  if (!context) {
    throw new Error('useXmpp must be used within an XmppProvider');
  }
  return context;
};

interface XmppProviderProps {
  children: ReactNode;
}

export const XmppProvider: React.FC<XmppProviderProps> = ({ children }) => {
  const { settings } = useSettings();
  const { toast } = useToast();
  
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [conversations, setConversations] = useState<XmppConversation[]>([]);
  const [contacts, setContacts] = useState<XmppContact[]>([]);
  const [xmppClient, setXmppClient] = useState<any>(null);
  const [isConnecting, setIsConnecting] = useState(false);

  const connect = useCallback(async (): Promise<boolean> => {
    if (!settings.xmpp.username || !settings.xmpp.password) {
      toast({
        title: 'XMPP Connection Failed',
        description: 'Username and password are required',
        variant: 'destructive'
      });
      return false;
    }

    // Prevent multiple simultaneous connection attempts
    if (isConnecting || (xmppClient && connectionState === 'connected')) {
      return connectionState === 'connected';
    }

    try {
      setIsConnecting(true);
      setConnectionState('connecting');
      
      // Generate unique resource if not specified
      const resource = settings.xmpp.resource || `web-client-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      
      const newClient = client({
        service: settings.xmpp.websocketUrl,
        domain: settings.xmpp.domain,
        username: settings.xmpp.username,
        password: settings.xmpp.password,
        resource
      });

      // Connection events
      newClient.on('error', (err: Error) => {
        console.error('XMPP Error:', err);
        
        // Handle conflict errors gracefully - don't set error state
        if (err.message?.includes('conflict')) {
          console.log('XMPP connection conflict detected, will retry with new resource');
          setConnectionState('disconnected');
          setIsConnecting(false);
          return;
        }
        
        setConnectionState('error');
        setIsConnecting(false);
        toast({
          title: 'XMPP Connection Error',
          description: err.message,
          variant: 'destructive'
        });
      });

      newClient.on('offline', () => {
        console.log('XMPP offline');
        setConnectionState('disconnected');
      });

      newClient.on('online', (address: any) => {
        console.log('XMPP online as', address.toString());
        setConnectionState('connected');
        toast({
          title: 'XMPP Connected',
          description: `Connected as ${address.toString()}`
        });
        
        // Send initial presence
        newClient.send(xml('presence')).catch(console.error);
        
        // Request roster
        newClient.send(
          xml('iq', { type: 'get', id: 'roster' },
            xml('query', { xmlns: 'jabber:iq:roster' })
          )
        ).catch(console.error);
      });

      // Message handling
      newClient.on('stanza', (stanza: any) => {
        if (stanza.is('message') && stanza.attrs.type === 'chat') {
          const from = stanza.attrs.from;
          const body = stanza.getChildText('body');
          
          if (body) {
            const message: XmppMessage = {
              id: `${Date.now()}-${Math.random()}`,
              from: from.split('/')[0], // Remove resource
              to: stanza.attrs.to,
              body,
              timestamp: new Date(),
              type: 'chat'
            };
            
            addMessageToConversation(message);
          }
        } else if (stanza.is('presence')) {
          handlePresenceUpdate(stanza);
        } else if (stanza.is('iq') && stanza.attrs.id === 'roster') {
          handleRosterUpdate(stanza);
        }
      });

      await newClient.start();
      setXmppClient(newClient);
      setIsConnecting(false);
      return true;
    } catch (error) {
      console.error('XMPP connection failed:', error);
      setConnectionState('error');
      setIsConnecting(false);
      toast({
        title: 'XMPP Connection Failed',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive'
      });
      return false;
    } finally {
      setIsConnecting(false);
    }
  }, [settings.xmpp, toast, isConnecting, xmppClient, connectionState]);

  const disconnect = useCallback(() => {
    if (xmppClient) {
      xmppClient.stop().catch(console.error);
      setXmppClient(null);
    }
    setConnectionState('disconnected');
    setConversations([]);
    setContacts([]);
  }, [xmppClient]);

  const sendMessage = useCallback(async (to: string, body: string): Promise<boolean> => {
    if (!xmppClient || connectionState !== 'connected') {
      toast({
        title: 'Cannot Send Message',
        description: 'Not connected to XMPP server',
        variant: 'destructive'
      });
      return false;
    }

    try {
      const message = xml(
        'message',
        { type: 'chat', to },
        xml('body', {}, body)
      );

      await xmppClient.send(message);
      
      // Add to local conversation
      const sentMessage: XmppMessage = {
        id: `${Date.now()}-${Math.random()}`,
        from: `${settings.xmpp.username}@${settings.xmpp.domain}`,
        to,
        body,
        timestamp: new Date(),
        type: 'chat'
      };
      
      addMessageToConversation(sentMessage, true);
      return true;
    } catch (error) {
      console.error('Failed to send message:', error);
      toast({
        title: 'Message Send Failed',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive'
      });
      return false;
    }
  }, [xmppClient, connectionState, settings.xmpp, toast]);

  const addContact = useCallback((jid: string) => {
    if (!xmppClient || connectionState !== 'connected') return;

    const subscribeStanza = xml(
      'presence',
      { type: 'subscribe', to: jid }
    );
    
    xmppClient.send(subscribeStanza).catch(console.error);
  }, [xmppClient, connectionState]);

  const removeContact = useCallback((jid: string) => {
    if (!xmppClient || connectionState !== 'connected') return;

    const unsubscribeStanza = xml(
      'presence',
      { type: 'unsubscribe', to: jid }
    );
    
    xmppClient.send(unsubscribeStanza).catch(console.error);
  }, [xmppClient, connectionState]);

  const setPresence = useCallback((show?: 'away' | 'dnd' | 'xa', status?: string) => {
    if (!xmppClient || connectionState !== 'connected') return;

    const presenceStanza = xml('presence');
    if (show) {
      presenceStanza.append(xml('show', {}, show));
    }
    if (status) {
      presenceStanza.append(xml('status', {}, status));
    }
    
    xmppClient.send(presenceStanza).catch(console.error);
  }, [xmppClient, connectionState]);

  const startConversation = useCallback((jid: string) => {
    setConversations(prev => {
      const existingConv = prev.find(conv => conv.jid === jid);
      if (existingConv) return prev;
      
      const newConv: XmppConversation = {
        jid,
        name: jid.split('@')[0],
        messages: [],
        unreadCount: 0,
        lastActivity: new Date()
      };
      
      return [newConv, ...prev];
    });
  }, []);

  const addMessageToConversation = (message: XmppMessage, sent = false) => {
    const contactJid = sent ? message.to : message.from;
    
    setConversations(prev => {
      const existingConv = prev.find(conv => conv.jid === contactJid);
      
      if (existingConv) {
        return prev.map(conv => {
          if (conv.jid === contactJid) {
            return {
              ...conv,
              messages: [...conv.messages, message],
              lastActivity: message.timestamp,
              unreadCount: sent ? conv.unreadCount : conv.unreadCount + 1
            };
          }
          return conv;
        });
      } else {
        // Create new conversation
        const newConv: XmppConversation = {
          jid: contactJid,
          name: contactJid.split('@')[0], // Use local part as name initially
          messages: [message],
          unreadCount: sent ? 0 : 1,
          lastActivity: message.timestamp
        };
        return [newConv, ...prev];
      }
    });
  };

  const handlePresenceUpdate = (stanza: any) => {
    const from = stanza.attrs.from;
    const show = stanza.getChildText('show') || 'available';
    const status = stanza.getChildText('status');
    const type = stanza.attrs.type;
    
    const bareJid = from.split('/')[0];
    const presence = type === 'unavailable' ? 'unavailable' : 
                    show === 'away' ? 'away' :
                    show === 'dnd' ? 'dnd' :
                    show === 'xa' ? 'xa' : 'available';

    setContacts(prev => prev.map(contact => 
      contact.jid === bareJid 
        ? { ...contact, presence, status }
        : contact
    ));
  };

  const handleRosterUpdate = (stanza: any) => {
    const query = stanza.getChild('query', 'jabber:iq:roster');
    if (!query) return;

    const items = query.getChildren('item');
    const rosterContacts: XmppContact[] = items.map((item: any) => ({
      jid: item.attrs.jid,
      name: item.attrs.name || item.attrs.jid.split('@')[0],
      subscription: item.attrs.subscription || 'none',
      presence: 'unavailable'
    }));

    setContacts(rosterContacts);
  };

  // Auto-connect if enabled
  useEffect(() => {
    if (settings.xmpp.autoConnect && connectionState === 'disconnected') {
      connect();
    }
  }, [settings.xmpp.autoConnect, connectionState, connect]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

  return (
    <XmppContext.Provider value={{
      connectionState,
      conversations,
      contacts,
      connect,
      disconnect,
      sendMessage,
      addContact,
      removeContact,
      setPresence,
      startConversation
    }}>
      {children}
    </XmppContext.Provider>
  );
};