import React, { createContext, useContext, useState, useEffect, ReactNode, useCallback, useRef } from 'react';
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
  effectiveJid: string;
  lastError: string | null;
  lastAttemptAt: Date | null;
  connect: () => Promise<boolean>;
  disconnect: () => void;
  sendMessage: (to: string, body: string) => Promise<boolean>;
  addContact: (jid: string) => void;
  removeContact: (jid: string) => void;
  setPresence: (show?: 'away' | 'dnd' | 'xa', status?: string) => void;
  startConversation: (jid: string) => void;
  runWebSocketDiagnostics: () => Promise<{ success: boolean; details: string; }>;
  ping: () => Promise<boolean>;
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
  const [effectiveJid, setEffectiveJid] = useState<string>('');
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastAttemptAt, setLastAttemptAt] = useState<Date | null>(null);
  const [reconnectAttempts, setReconnectAttempts] = useState(0);
  const [reconnectTimeout, setReconnectTimeout] = useState<NodeJS.Timeout | null>(null);
  const [conflictCount, setConflictCount] = useState(0);
  const [lastConflictTime, setLastConflictTime] = useState<number>(0);
  const [currentResource, setCurrentResource] = useState<string>('');
  const clientRef = useRef<any>(null);

  const connect = useCallback(async (): Promise<boolean> => {
    if (!settings.xmpp.username || !settings.xmpp.password) {
      const errorMsg = 'Username and password are required';
      setLastError(errorMsg);
      toast({
        title: 'XMPP Connection Failed',
        description: errorMsg,
        variant: 'destructive'
      });
      return false;
    }

    // Prevent multiple simultaneous connection attempts
    if (isConnecting || (clientRef.current && connectionState === 'connected')) {
      return connectionState === 'connected';
    }

    return new Promise<boolean>((resolve) => {
      // Clear any pending reconnect timeout
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        setReconnectTimeout(null);
      }

        setIsConnecting(true);
      setConnectionState('connecting');
      setLastAttemptAt(new Date());
      setLastError(null);
      
      // Generate unique resource - always auto-generated per tab
      const timestamp = Date.now();
      const random = Math.random().toString(36).substr(2, 9);
      const tabId = crypto.getRandomValues(new Uint32Array(1))[0].toString(36);
      const resource = `web-client-${timestamp}-${random}-${tabId}`;
      
      setCurrentResource(resource);
      console.log(`XMPP connecting with resource: ${resource}`);
      
      const newClient = client({
        service: settings.xmpp.websocketUrl,
        domain: settings.xmpp.domain,
        username: settings.xmpp.username,
        password: settings.xmpp.password,
        resource
      });

      // Connection events with enhanced error handling
      newClient.on('error', (err: Error) => {
        const errorMsg = err.message || 'Unknown XMPP error';
        console.error('XMPP Error:', err);
        setLastError(errorMsg);
        
        // Handle conflict errors with flood protection
        if (errorMsg.includes('conflict')) {
          const currentTime = Date.now();
          const timeSinceLastConflict = currentTime - lastConflictTime;
          
          // Update conflict tracking
          setLastConflictTime(currentTime);
          if (timeSinceLastConflict < 30000) { // Within 30 seconds
            setConflictCount(prev => prev + 1);
          } else {
            setConflictCount(1); // Reset if more than 30s
          }
          
          console.log(`XMPP conflict detected (${conflictCount + 1}/2 in 30s), resource was: ${currentResource}`);
          
          // Stop reconnecting if too many conflicts in short time
          if (conflictCount >= 1) { // Max 2 conflicts in 30s
            console.error('XMPP Too many conflicts, stopping auto-reconnect to prevent flood');
            setLastError('Too many resource conflicts. Please check if another session is active.');
            setConnectionState('error');
            setIsConnecting(false);
            toast({
              title: 'XMPP Resource Conflict',
              description: 'Too many conflicts detected. Please check if you have another session open.',
              variant: 'destructive'
            });
            return;
          }
          
          setConnectionState('disconnected');
          setIsConnecting(false);
          
          // Auto-reconnect with new resource after delay
          if (settings.xmpp.autoConnect) {
            const jitterDelay = 1000 + Math.random() * 2000; // 1-3s jitter
            console.log(`XMPP regenerating resource and reconnecting in ${Math.round(jitterDelay)}ms...`);
            const timeout = setTimeout(() => {
              connect();
            }, jitterDelay);
            setReconnectTimeout(timeout);
          }
          return;
        }
        
        // Handle other connection errors with exponential backoff
        if (errorMsg.includes('ECONNERROR') || errorMsg.includes('WebSocket')) {
          console.log('XMPP connection error, scheduling reconnect with backoff');
          setConnectionState('error');
          setIsConnecting(false);
          
          if (settings.xmpp.autoConnect) {
            scheduleReconnect();
          }
          
          toast({
            title: 'XMPP Connection Error',
            description: `${errorMsg}. ${settings.xmpp.autoConnect ? 'Retrying...' : ''}`,
            variant: 'destructive'
          });
          return;
        }
        
        setConnectionState('error');
        setIsConnecting(false);
        toast({
          title: 'XMPP Connection Error',
          description: errorMsg,
          variant: 'destructive'
        });
      });

      newClient.on('offline', () => {
        console.log('XMPP offline');
        setConnectionState('disconnected');
        setEffectiveJid('');
        
        // Auto-reconnect on unexpected disconnection
        if (settings.xmpp.autoConnect && connectionState === 'connected') {
          scheduleReconnect();
        }
      });

      let connectionTimeout: NodeJS.Timeout | null = null;

      newClient.on('online', (address: any) => {
        if (connectionTimeout) {
          clearTimeout(connectionTimeout);
          connectionTimeout = null;
        }
        
        const jidString = address.toString();
        console.log('XMPP online as', jidString);
        setConnectionState('connected');
        setEffectiveJid(jidString);
        setReconnectAttempts(0); // Reset reconnect counter on successful connection
        setConflictCount(0); // Reset conflict counter on successful connection
        setLastError(null);
        setIsConnecting(false);
        
        toast({
          title: 'XMPP Connected',
          description: `Connected as ${jidString}`
        });
        
        // Send initial presence
        newClient.send(xml('presence')).catch(console.error);
        
        // Request roster
        newClient.send(
          xml('iq', { type: 'get', id: 'roster' },
            xml('query', { xmlns: 'jabber:iq:roster' })
          )
        ).catch(console.error);
        
        resolve(true);
      });

      // Message handling - accept both chat and normal message types
      newClient.on('stanza', (stanza: any) => {
        if (stanza.is('message') && (stanza.attrs.type === 'chat' || stanza.attrs.type === 'normal' || !stanza.attrs.type)) {
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

      // Initialize references before starting for immediate availability
      clientRef.current = newClient;
      setXmppClient(newClient);
      
      // Set connection timeout (10 seconds)
      connectionTimeout = setTimeout(() => {
        console.error('XMPP connection timeout');
        setLastError('Connection timeout - server did not respond');
        setConnectionState('error');
        setIsConnecting(false);
        newClient.stop().catch(console.error);
        resolve(false);
      }, 10000);
      
      (async () => {
        try {
          await newClient.start();
        } catch (error) {
        if (connectionTimeout) {
          clearTimeout(connectionTimeout);
          connectionTimeout = null;
        }
        
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error('XMPP connection failed:', error);
        setLastError(errorMsg);
        setConnectionState('error');
        setIsConnecting(false);
        
        // Schedule reconnect on startup failure if auto-connect enabled
        if (settings.xmpp.autoConnect) {
          scheduleReconnect();
        }
        
        toast({
          title: 'XMPP Connection Failed',
          description: errorMsg,
          variant: 'destructive'
        });
          resolve(false);
        }
      })();
    });
  }, [settings.xmpp, toast, isConnecting, connectionState, reconnectTimeout]);

  const scheduleReconnect = useCallback(() => {
    if (reconnectTimeout) return; // Already scheduled
    
    // Limited retry attempts - max 2 attempts only
    if (reconnectAttempts >= 2) {
      console.error('XMPP Max reconnection attempts reached');
      setLastError('Connection failed after 2 attempts. Please check your credentials.');
      return;
    }
    
    const delayMs = reconnectAttempts === 0 ? 2000 : 5000; // 2s then 5s
    const jitterMs = Math.random() * 500; // Small jitter
    const totalDelay = delayMs + jitterMs;
    
    console.log(`XMPP scheduling reconnect in ${Math.round(totalDelay)}ms (attempt ${reconnectAttempts + 1})`);
    
    const timeout = setTimeout(() => {
      setReconnectAttempts(prev => prev + 1);
      setReconnectTimeout(null);
      connect();
    }, totalDelay);
    
    setReconnectTimeout(timeout);
  }, [reconnectAttempts, reconnectTimeout, connect]);

  const disconnect = useCallback(() => {
    // Clear any pending reconnect
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      setReconnectTimeout(null);
    }
    
    if (clientRef.current) {
      clientRef.current.stop().catch(console.error);
      clientRef.current = null;
    }
    if (xmppClient) {
      xmppClient.stop().catch(console.error);
      setXmppClient(null);
    }
    setConnectionState('disconnected');
    setEffectiveJid('');
    setConversations([]);
    setContacts([]);
    setReconnectAttempts(0);
    setConflictCount(0);
    setCurrentResource('');
  }, [xmppClient, reconnectTimeout]);

  const sendMessage = useCallback(async (to: string, body: string): Promise<boolean> => {
    // Auto-ensure connectivity
    if (!clientRef.current || connectionState !== 'connected') {
      console.log('XMPP sendMessage: Not connected, attempting to connect...');
      const connected = await connect();
      if (!connected) {
        toast({
          title: 'Cannot Send Message',
          description: 'Unable to connect to XMPP server',
          variant: 'destructive'
        });
        return false;
      }
    }

    try {
      const message = xml(
        'message',
        { type: 'chat', to },
        xml('body', {}, body)
      );

      await clientRef.current.send(message);
      
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
  }, [connectionState, settings.xmpp, toast]);

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

  const runWebSocketDiagnostics = useCallback(async (): Promise<{ success: boolean; details: string; }> => {
    return new Promise((resolve) => {
      const wsUrl = settings.xmpp.websocketUrl;
      let result = { success: false, details: '' };
      let details: string[] = [];
      
      try {
        details.push(`🔍 Testing WebSocket connection to: ${wsUrl}`);
        
        const ws = new WebSocket(wsUrl, ['xmpp']);
        const startTime = Date.now();
        
        const timeout = setTimeout(() => {
          ws.close();
          details.push(`⏱️ Connection timeout after 10 seconds`);
          details.push(`❌ Likely causes: DNS resolution failure, firewall blocking, or wrong URL`);
          result = { success: false, details: details.join('\n') };
          resolve(result);
        }, 10000);
        
        ws.onopen = () => {
          clearTimeout(timeout);
          const duration = Date.now() - startTime;
          details.push(`✅ WebSocket opened successfully in ${duration}ms`);
          details.push(`🔗 Protocol: ${ws.protocol || 'none negotiated'}`);
          details.push(`📡 Ready state: ${ws.readyState} (OPEN)`);
          ws.close(1000, 'Diagnostic complete');
        };
        
        ws.onclose = (event) => {
          clearTimeout(timeout);
          details.push(`🔌 WebSocket closed: code=${event.code}, reason="${event.reason}"`);
          
          if (event.code === 1000) {
            details.push(`✅ Clean closure - WebSocket handshake successful`);
            result.success = true;
          } else if (event.code === 1006) {
            details.push(`❌ Abnormal closure - likely handshake failure`);
            details.push(`💡 Check: CORS/Origin policy, TLS certificate, or wrong WebSocket path`);
          } else if (event.code === 1002) {
            details.push(`❌ Protocol error - server rejected WebSocket upgrade`);
            details.push(`💡 Check: WebSocket listener configuration, subprotocol support`);
          } else {
            details.push(`❌ Unexpected closure code`);
          }
          
          result = { success: result.success, details: details.join('\n') };
          resolve(result);
        };
        
        ws.onerror = (error) => {
          clearTimeout(timeout);
          details.push(`❌ WebSocket error occurred`);
          details.push(`💡 Common causes: Network unreachable, DNS failure, TLS mismatch`);
          result = { success: false, details: details.join('\n') };
          resolve(result);
        };
        
      } catch (error) {
        details.push(`❌ Failed to create WebSocket: ${error}`);
        result = { success: false, details: details.join('\n') };
        resolve(result);
      }
    });
  }, [settings.xmpp.websocketUrl]);

  const ping = useCallback(async (): Promise<boolean> => {
    if (!clientRef.current || connectionState !== 'connected') {
      return false;
    }

    try {
      const pingIq = xml(
        'iq',
        { type: 'get', to: settings.xmpp.domain, id: `ping_${Date.now()}` },
        xml('ping', { xmlns: 'urn:xmpp:ping' })
      );

      await clientRef.current.send(pingIq);
      return true;
    } catch (error) {
      console.error('XMPP ping failed:', error);
      return false;
    }
  }, [connectionState, settings.xmpp.domain]);

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
      effectiveJid,
      lastError,
      lastAttemptAt,
      connect,
      disconnect,
      sendMessage,
      addContact,
      removeContact,
      setPresence,
      startConversation,
      runWebSocketDiagnostics,
      ping
    }}>
      {children}
    </XmppContext.Provider>
  );
};