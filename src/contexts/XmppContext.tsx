import React, { createContext, useContext, useState, useEffect, ReactNode, useCallback, useRef } from 'react';
import { useSettings } from './SettingsContext';
import { useToast } from '@/hooks/use-toast';
import { XmppMessage, XmppContact, XmppConversation, MessageStatus, MamQuery, MamResult } from '@/types/xmpp';

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
  loadConversationHistory: (jid: string) => Promise<void>;
  markMessageRead: (messageId: string, to: string) => void;
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
  const [manualDisconnect, setManualDisconnect] = useState(false);
  const [clientGeneration, setClientGeneration] = useState(0);
  const clientRef = useRef<any>(null);
  const clientGenerationRef = useRef(0);
  const connectInFlightRef = useRef<Promise<boolean> | null>(null);
  const outboxRef = useRef<Array<{id: string, to: string, body: string}>>([]);
  const mamQueryRef = useRef<Map<string, { resolve: Function, reject: Function }>>(new Map());
  const pendingReceiptsRef = useRef<Set<string>>(new Set());
  
  // Dynamic imports for XMPP client
  const clientFactoryRef = useRef<any>(null);
  const xmlRef = useRef<any>(null);
  const isLibraryLoadedRef = useRef(false);

  // Load XMPP library dynamically
  useEffect(() => {
    const loadXmppLibrary = async () => {
      if (isLibraryLoadedRef.current) return;
      
      try {
        console.log('Loading XMPP client library...');
        const xmppModule = await import('@xmpp/client');
        clientFactoryRef.current = xmppModule.client;
        xmlRef.current = xmppModule.xml;
        isLibraryLoadedRef.current = true;
        console.log('XMPP client library loaded successfully');
      } catch (error) {
        console.error('Failed to load XMPP client library:', error);
        toast({
          title: 'XMPP Library Error',
          description: 'Failed to load XMPP client. Please refresh the page.',
          variant: 'destructive'
        });
      }
    };

    loadXmppLibrary();
  }, [toast]);

  // Queue a message for delivery when connected
  const queueMessage = useCallback((to: string, body: string): string => {
    const id = `queued-${Date.now()}-${Math.random()}`;
    outboxRef.current.push({ id, to, body });
    console.log(`XMPP queued message ${id} to ${to} (${outboxRef.current.length} in queue)`);
    return id;
  }, []);

  // Flush all queued messages
  const flushOutbox = useCallback(async (): Promise<void> => {
    if (!clientRef.current || connectionState !== 'connected') {
      console.log('XMPP cannot flush outbox - not connected');
      return;
    }

    const messages = [...outboxRef.current];
    console.log(`XMPP flushing ${messages.length} queued messages`);

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      try {
        const normalizedTo = msg.to.includes('@') ? msg.to : `${msg.to}@${settings.xmpp.domain}`;
        const originId = `${Date.now()}-${Math.random()}`;
        const stanza = xmlRef.current!(
          'message',
          { type: 'chat', to: normalizedTo, id: originId },
          xmlRef.current!('body', {}, msg.body),
          xmlRef.current!('origin-id', { xmlns: 'urn:xmpp:sid:0', id: originId }),
          xmlRef.current!('request', { xmlns: 'urn:xmpp:receipts' })
        );

        await clientRef.current.send(stanza);
        
        // Update existing pending message from 'sending' to 'sent'
        setConversations(prev => prev.map(conv => ({
          ...conv,
          messages: conv.messages.map(message => 
            message.originId === msg.id ? 
              {
                ...message,
                status: 'sent' as MessageStatus,
                originId,
                timestamp: new Date()
              } : message
          )
        })));
        
        // Add a small retry mechanism for robustness
        setTimeout(() => {
          if (outboxRef.current.length > 0) {
            flushOutbox();
          }
        }, 500);

        // Remove from queue after successful send
        outboxRef.current = outboxRef.current.filter(m => m.id !== msg.id);
        console.log(`XMPP sent queued message ${msg.id}`);
      } catch (error) {
        console.error(`XMPP failed to send queued message ${msg.id}:`, error);
        // Keep message in queue and stop flushing on first failure
        break;
      }
    }
  }, [connectionState, settings.xmpp.domain, effectiveJid]);

  // Wait for online state with generation awareness
  const waitForOnline = useCallback(async (generation: number, timeoutMs: number = 12000): Promise<boolean> => {
    return new Promise((resolve) => {
      const start = Date.now();
      const poll = () => {
        // Check if generation is still current
        if (clientGenerationRef.current !== generation) {
          console.log(`XMPP waitForOnline aborting - generation changed from ${generation} to ${clientGenerationRef.current}`);
          resolve(false);
          return;
        }
        
        if (connectionState === 'connected' && clientRef.current) {
          resolve(true);
          return;
        }
        
        if (Date.now() - start > timeoutMs) {
          console.warn(`XMPP waitForOnline timeout after ${timeoutMs}ms`);
          resolve(false);
          return;
        }
        
        setTimeout(poll, 250);
      };
      poll();
    });
  }, [connectionState]);

  // Ensure we have a connected client - safer version without destructive ping
  const ensureConnectedClient = useCallback(async (): Promise<any> => {
    console.log(`XMPP ensureConnectedClient - state: ${connectionState}, hasClient: ${!!clientRef.current}`);
    
    // If connected and we have a client, return immediately
    if (clientRef.current && connectionState === 'connected') {
      return clientRef.current;
    }
    
    // If connecting, wait for it to finish
    if (connectionState === 'connecting') {
      const currentGeneration = clientGenerationRef.current;
      console.log(`XMPP waiting for ongoing connection (generation ${currentGeneration})`);
      const success = await waitForOnline(currentGeneration, 12000);
      if (success && clientRef.current) {
        return clientRef.current;
      }
      throw new Error('Connection attempt timed out or failed');
    }
    
    // If disconnected or error, trigger connect and wait
    if (connectionState === 'disconnected' || connectionState === 'error') {
      console.log('XMPP triggering connect from ensureConnectedClient');
      
      throw new Error('No client available and connection failed');
    }
    
    throw new Error(`Unexpected connection state: ${connectionState}`);
  }, [connectionState, waitForOnline]);

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

    // Check if XMPP library is loaded
    if (!isLibraryLoadedRef.current || !clientFactoryRef.current || !xmlRef.current) {
      const errorMsg = 'XMPP library not loaded yet';
      setLastError(errorMsg);
      toast({
        title: 'XMPP Connection Failed',
        description: errorMsg,
        variant: 'destructive'
      });
      return false;
    }

    // Reset manual disconnect flag
    setManualDisconnect(false);

    // Prevent multiple simultaneous connection attempts, but wait for in-flight connects
    if (clientRef.current && connectionState === 'connected') {
      return true;
    }
    if (isConnecting) {
      // Wait up to 10s for existing connect to complete
      return await new Promise<boolean>((resolve) => {
        const start = Date.now();
        const poll = () => {
          if (connectionState === 'connected') return resolve(true);
          if (Date.now() - start > 10000) return resolve(false);
          setTimeout(poll, 250);
        };
        poll();
      });
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
      
      const newClient = clientFactoryRef.current!({
        service: settings.xmpp.websocketUrl,
        domain: settings.xmpp.domain,
        username: settings.xmpp.username,
        password: settings.xmpp.password,
        resource
      });

      // Window during which we keep "connecting" even if start() throws
      const initialConnectDeadline = Date.now() + 10000;

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
          // During initial connect window, stay in 'connecting' and wait for timeout/online
          if (Date.now() < initialConnectDeadline) {
            console.log('XMPP connection error during initial connect window; waiting for online/timeout');
            return;
          }
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
        const currentGeneration = clientGenerationRef.current;
        console.log(`XMPP offline (generation ${currentGeneration})`);
        setConnectionState('disconnected');
        setEffectiveJid('');
        
        // Auto-reconnect on unexpected disconnection (but not if manually disconnected)
        if (settings.xmpp.autoConnect && connectionState === 'connected' && !manualDisconnect) {
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
        console.log(`XMPP online as ${jidString} (generation ${clientGenerationRef.current})`);
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
        newClient.send(xmlRef.current!('presence')).catch(console.error);
        
        // Enable Message Carbons for conversation sync
        newClient.send(
          xmlRef.current!('iq', { type: 'set', id: 'enable-carbons' },
            xmlRef.current!('enable', { xmlns: 'urn:xmpp:carbons:2' })
          )
        ).catch(console.error);
        
        // Request roster
        newClient.send(
          xmlRef.current!('iq', { type: 'get', id: 'roster' },
            xmlRef.current!('query', { xmlns: 'jabber:iq:roster' })
          )
        ).catch(console.error);
        
        // Load recent message history automatically
        setTimeout(async () => {
          try {
            const recentConversationsQuery = xmlRef.current!(
              'iq',
              { type: 'set', id: 'mam-recent' },
              xmlRef.current!('query', { xmlns: 'urn:xmpp:mam:2', queryid: 'recent' },
                xmlRef.current!('x', { xmlns: 'jabber:x:data', type: 'submit' },
                  xmlRef.current!('field', { var: 'FORM_TYPE', type: 'hidden' },
                    xmlRef.current!('value', {}, 'urn:xmpp:mam:2')
                  )
                ),
                xmlRef.current!('set', { xmlns: 'http://jabber.org/protocol/rsm' },
                  xmlRef.current!('max', {}, '20'),
                  xmlRef.current!('before', {})
                )
              )
            );
            await newClient.send(recentConversationsQuery);
          } catch (error) {
            console.warn('Failed to load recent conversations:', error);
          }
        }, 500);
        
        // Flush any queued messages after successful connection
        setTimeout(() => flushOutbox(), 100);
        
        resolve(true);
      });

      // Enhanced message and stanza handling
      newClient.on('stanza', (stanza: any) => {
        if (stanza.is('message')) {
          handleMessageStanza(stanza);
        } else if (stanza.is('presence')) {
          handlePresenceUpdate(stanza);
        } else if (stanza.is('iq')) {
          handleIQStanza(stanza);
        }
      });

      // Increment generation and initialize references before starting for immediate availability
      const newGeneration = clientGenerationRef.current + 1;
      setClientGeneration(newGeneration);
      clientGenerationRef.current = newGeneration;
      
      // Properly stop old client if exists
      if (clientRef.current) {
        (async () => {
          try {
            await clientRef.current.stop();
          } catch (error) {
            console.warn('Error stopping old client:', error);
          }
        })();
      }
      
      clientRef.current = newClient;
      setXmppClient(newClient);
      
      console.log(`XMPP client generation set to ${newGeneration}`);
      
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
          const errorMsg = error instanceof Error ? error.message : 'Unknown error';
          console.warn('XMPP start() error (will keep waiting for online within timeout):', errorMsg);
          setLastError(errorMsg);
          // Do not change state or schedule reconnect here; wait for online or timeout to handle resolution
        }
      })();
    });
  }, [settings.xmpp, toast, isConnecting, connectionState, reconnectTimeout, flushOutbox]);

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
    // Set manual disconnect flag to prevent auto-reconnect
    setManualDisconnect(true);
    
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
    
    console.log('XMPP manually disconnected');
  }, [xmppClient, reconnectTimeout]);

  const sendMessage = useCallback(async (to: string, body: string): Promise<boolean> => {
    console.log(`XMPP sendMessage to ${to} - state: ${connectionState}`);
    
    const normalizedTo = to.includes('@') ? to : `${to}@${settings.xmpp.domain}`;
    const myBareJid = `${settings.xmpp.username}@${settings.xmpp.domain}`;
    
    // If connected, try immediate send
    if (connectionState === 'connected' && clientRef.current) {
      try {
        const originId = `${Date.now()}-${Math.random()}`;
        const message = xmlRef.current!(
          'message',
          { type: 'chat', to: normalizedTo, id: originId },
          xmlRef.current!('body', {}, body),
          xmlRef.current!('origin-id', { xmlns: 'urn:xmpp:sid:0', id: originId }),
          xmlRef.current!('request', { xmlns: 'urn:xmpp:receipts' }),
          xmlRef.current!('markable', { xmlns: 'urn:xmpp:chat-markers:0' })
        );

        await clientRef.current.send(message);
        
        // Add to local conversation on successful send
        const sentMessage: XmppMessage = {
          id: `${Date.now()}-${Math.random()}`,
          from: myBareJid,
          to: normalizedTo,
          body,
          timestamp: new Date(),
          type: 'chat',
          status: 'sent' as MessageStatus,
          originId
        };
        
        addMessageToConversation(sentMessage, true);
        console.log('XMPP message sent immediately');
        return true;
        
      } catch (error) {
        console.error('XMPP immediate send failed:', error);
        
        // If it's a connectivity error, queue and add pending message to UI
        if (error instanceof TypeError && error.message.includes("Cannot read properties of null") ||
            (error instanceof Error && (error.message.includes('ECONNERROR') || error.message.includes('WebSocket')))) {
          console.log('XMPP connectivity error - queueing message and triggering connect');
          const queuedId = queueMessage(normalizedTo, body);
          
          // Add pending message to UI immediately
          const pendingMessage: XmppMessage = {
            id: `${Date.now()}-${Math.random()}`,
            from: myBareJid,
            to: normalizedTo,
            body,
            timestamp: new Date(),
            type: 'chat',
            status: 'sending' as MessageStatus,
            originId: queuedId
          };
          
          addMessageToConversation(pendingMessage, true);
          
          // Don't await connect() - let it happen in background
          setConnectionState('connecting');
          setLastError(null);
          
          return true; // Message queued, delivery deferred
        }
        
        // Other errors - fail immediately
        toast({
          title: 'Message Send Failed',
          description: error instanceof Error ? error.message : 'Unknown error',
          variant: 'destructive'
        });
        return false;
      }
    }
    
    // Not connected - queue message and add pending message to UI
    console.log('XMPP not connected - queueing message and triggering connect');
    const queuedId = queueMessage(normalizedTo, body);
    
    // Add pending message to UI immediately
    const pendingMessage: XmppMessage = {
      id: `${Date.now()}-${Math.random()}`,
      from: myBareJid,
      to: normalizedTo,
      body,
      timestamp: new Date(),
      type: 'chat',
      status: 'sending' as MessageStatus,
      originId: queuedId
    };
    
    addMessageToConversation(pendingMessage, true);
    
    // Trigger connect by setting connection state
    if (connectionState === 'disconnected' || connectionState === 'error') {
      setConnectionState('connecting');
      setLastError(null);
    }
    
    return true; // Message queued, delivery deferred
  }, [connectionState, settings.xmpp.domain, effectiveJid, queueMessage, toast, settings.xmpp.username]);

  const addContact = useCallback((jid: string) => {
    if (!xmppClient || connectionState !== 'connected') return;

    const subscribeStanza = xmlRef.current!(
      'presence',
      { type: 'subscribe', to: jid }
    );
    
    xmppClient.send(subscribeStanza).catch(console.error);
  }, [xmppClient, connectionState]);

  const removeContact = useCallback((jid: string) => {
    if (!xmppClient || connectionState !== 'connected') return;

    const unsubscribeStanza = xmlRef.current!(
      'presence',
      { type: 'unsubscribe', to: jid }
    );
    
    xmppClient.send(unsubscribeStanza).catch(console.error);
  }, [xmppClient, connectionState]);

  const setPresence = useCallback((show?: 'away' | 'dnd' | 'xa', status?: string) => {
    if (!xmppClient || connectionState !== 'connected') return;

    const presenceStanza = xmlRef.current!('presence');
    if (show) {
      presenceStanza.append(xmlRef.current!('show', {}, show));
    }
    if (status) {
      presenceStanza.append(xmlRef.current!('status', {}, status));
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
            // Check for existing message with same originId to prevent duplicates
            const existingMessageIndex = conv.messages.findIndex(m => 
              m.originId === message.originId || m.stanzaId === message.stanzaId
            );
            
            if (existingMessageIndex >= 0) {
              // Update existing message (e.g., status change from 'sending' to 'sent')
              const updatedMessages = [...conv.messages];
              updatedMessages[existingMessageIndex] = {
                ...updatedMessages[existingMessageIndex],
                ...message,
                // Keep original ID and timestamp for UI consistency unless it's a status update
                id: message.status ? updatedMessages[existingMessageIndex].id : message.id,
                timestamp: message.status ? updatedMessages[existingMessageIndex].timestamp : message.timestamp
              };
              
              return {
                ...conv,
                messages: updatedMessages,
                lastActivity: message.timestamp
              };
            } else {
              // Add new message
              return {
                ...conv,
                messages: [...conv.messages, message],
                lastActivity: message.timestamp,
                unreadCount: sent ? conv.unreadCount : conv.unreadCount + 1
              };
            }
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

  // Enhanced message stanza handler
  const handleMessageStanza = useCallback((stanza: any) => {
    const myBareJid = `${settings.xmpp.username}@${settings.xmpp.domain}`;
    
    // Handle MAM result stanzas first
    const mamResult = stanza.getChild('result', 'urn:xmpp:mam:2');
    if (mamResult) {
      const forwarded = mamResult.getChild('forwarded', 'urn:xmpp:forward:0');
      const innerMessage = forwarded?.getChild('message');
      
      if (innerMessage && innerMessage.getChildText('body')) {
        const delayElement = forwarded.getChild('delay', 'urn:xmpp:delay');
        const timestamp = delayElement ? new Date(delayElement.attrs.stamp) : new Date();
        const originId = innerMessage.getChild('origin-id', 'urn:xmpp:sid:0')?.attrs?.id || innerMessage.attrs.id;
        const bareFrom = (innerMessage.attrs.from || '').split('/')[0];
        const isOutgoing = bareFrom === myBareJid;
        
        const message: XmppMessage = {
          id: `${Date.now()}-${Math.random()}`,
          from: bareFrom,
          to: innerMessage.attrs.to,
          body: innerMessage.getChildText('body'),
          timestamp,
          type: 'chat',
          originId,
          isFromArchive: true
        };
        
        addMessageToConversation(message, isOutgoing);
      }
      return;
    }
    
    // Handle Carbons (message copies) before regular messages
    const sentCarbon = stanza.getChild('sent', 'urn:xmpp:carbons:2');
    const receivedCarbon = stanza.getChild('received', 'urn:xmpp:carbons:2');
    
    if (sentCarbon || receivedCarbon) {
      const forwarded = (sentCarbon || receivedCarbon)?.getChild('forwarded', 'urn:xmpp:forward:0');
      const carbonMessage = forwarded?.getChild('message');
      
      if (carbonMessage && carbonMessage.getChildText('body')) {
        const bareFrom = (carbonMessage.attrs.from || '').split('/')[0];
        const isOutgoing = !!sentCarbon || bareFrom === myBareJid;
        const originId = carbonMessage.getChild('origin-id', 'urn:xmpp:sid:0')?.attrs?.id || carbonMessage.attrs.id;
        
        const message: XmppMessage = {
          id: `${Date.now()}-${Math.random()}`,
          from: bareFrom,
          to: carbonMessage.attrs.to,
          body: carbonMessage.getChildText('body'),
          timestamp: new Date(),
          type: 'chat',
          originId
        };
        
        addMessageToConversation(message, isOutgoing);
      }
      return;
    }
    
    const from = stanza.attrs.from;
    const body = stanza.getChildText('body');
    const type = stanza.attrs.type || 'chat';
    
    // Handle regular messages
    if (body && (type === 'chat' || type === 'normal' || !type)) {
      const delayElement = stanza.getChild('delay', 'urn:xmpp:delay');
      const timestamp = delayElement ? new Date(delayElement.attrs.stamp) : new Date();
      const stanzaId = stanza.getChild('stanza-id', 'urn:xmpp:sid:0')?.attrs?.id;
      const originId = stanza.getChild('origin-id', 'urn:xmpp:sid:0')?.attrs?.id || stanza.attrs.id;
      const isFromArchive = !!delayElement;
      const bareFrom = from.split('/')[0];
      const isOutgoing = bareFrom === myBareJid;
      
      const message: XmppMessage = {
        id: `${Date.now()}-${Math.random()}`,
        from: bareFrom,
        to: stanza.attrs.to,
        body,
        timestamp,
        type: 'chat',
        stanzaId,
        originId,
        isFromArchive
      };
      
      addMessageToConversation(message, isOutgoing);
      
      // Send receipt if requested (not for archived messages or our own messages)
      const receiptRequest = stanza.getChild('request', 'urn:xmpp:receipts');
      if (receiptRequest && !isFromArchive && !isOutgoing && clientRef.current) {
        const receipt = xmlRef.current!(
          'message',
          { to: from },
          xmlRef.current!('received', { xmlns: 'urn:xmpp:receipts', id: stanza.attrs.id })
        );
        clientRef.current.send(receipt).catch(console.error);
      }
    }
    
    // Handle delivery receipts
    const received = stanza.getChild('received', 'urn:xmpp:receipts');
    if (received) {
      const messageId = received.attrs.id;
      updateMessageStatus(messageId, 'delivered');
    }
    
    // Handle chat markers
    const displayed = stanza.getChild('displayed', 'urn:xmpp:chat-markers:0');
    if (displayed) {
      const messageId = displayed.attrs.id;
      updateMessageStatus(messageId, 'read');
    }
  }, [settings.xmpp.username, settings.xmpp.domain]);

  // Enhanced IQ stanza handler
  const handleIQStanza = useCallback((stanza: any) => {
    const id = stanza.attrs.id;
    
    // Handle roster updates
    if (id === 'roster') {
      handleRosterUpdate(stanza);
      return;
    }
    
    // Handle MAM query results
    if (id?.startsWith('mam-')) {
      handleMamResult(stanza);
      return;
    }
    
    // Handle other IQ stanzas as needed
  }, []);

  // Handle MAM query results
  const handleMamResult = useCallback((stanza: any) => {
    const queryId = stanza.attrs.id;
    const query = mamQueryRef.current.get(queryId);
    
    if (!query) return;
    
    const fin = stanza.getChild('fin', 'urn:xmpp:mam:2');
    if (fin) {
      const complete = fin.attrs.complete === 'true';
      const first = fin.getChild('set', 'http://jabber.org/protocol/rsm')?.getChildText('first');
      const last = fin.getChild('set', 'http://jabber.org/protocol/rsm')?.getChildText('last');
      
      query.resolve({
        messages: [], // Messages are handled individually in result stanzas
        complete,
        first,
        last
      });
      
      mamQueryRef.current.delete(queryId);
    }
  }, []);

  // Update message status
  const updateMessageStatus = useCallback((messageId: string, status: MessageStatus) => {
    setConversations(prev => prev.map(conv => ({
      ...conv,
      messages: conv.messages.map(msg => 
        msg.originId === messageId ? { ...msg, status } : msg
      )
    })));
  }, []);

  // Load conversation history using MAM
  const loadConversationHistory = useCallback(async (jid: string): Promise<void> => {
    if (!clientRef.current || connectionState !== 'connected') {
      throw new Error('Not connected to XMPP server');
    }
    
    const queryId = `mam-${Date.now()}-${Math.random()}`;
    
    return new Promise((resolve, reject) => {
      mamQueryRef.current.set(queryId, { resolve, reject });
      
      const query = xmlRef.current!(
        'iq',
        { type: 'set', id: queryId },
        xmlRef.current!('query', { xmlns: 'urn:xmpp:mam:2', queryid: queryId },
          xmlRef.current!('x', { xmlns: 'jabber:x:data', type: 'submit' },
            xmlRef.current!('field', { var: 'FORM_TYPE', type: 'hidden' },
              xmlRef.current!('value', {}, 'urn:xmpp:mam:2')
            ),
            xmlRef.current!('field', { var: 'with' },
              xmlRef.current!('value', {}, jid)
            )
          ),
          xmlRef.current!('set', { xmlns: 'http://jabber.org/protocol/rsm' },
            xmlRef.current!('max', {}, '50')
          )
        )
      );
      
      clientRef.current.send(query).catch(error => {
        mamQueryRef.current.delete(queryId);
        reject(error);
      });
      
      // Timeout after 10 seconds
      setTimeout(() => {
        if (mamQueryRef.current.has(queryId)) {
          mamQueryRef.current.delete(queryId);
          reject(new Error('MAM query timeout'));
        }
      }, 10000);
    });
  }, [connectionState]);

  // Mark message as read
  const markMessageRead = useCallback((messageId: string, to: string) => {
    if (!clientRef.current || connectionState !== 'connected') return;
    
    const marker = xmlRef.current!(
      'message',
      { to },
      xmlRef.current!('displayed', { xmlns: 'urn:xmpp:chat-markers:0', id: messageId })
    );
    
    clientRef.current.send(marker).catch(console.error);
  }, [connectionState]);

  // Auto-connect if enabled and trigger connection when state changes to connecting
  useEffect(() => {
    if (settings.xmpp.autoConnect && connectionState === 'disconnected') {
      connect();
    }
  }, [settings.xmpp.autoConnect, connectionState, connect]);

  // Trigger connection when state is set to connecting externally
  useEffect(() => {
    if (connectionState === 'connecting' && !isConnecting) {
      connect();
    }
  }, [connectionState, isConnecting, connect]);

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
      const pingIq = xmlRef.current!(
        'iq',
        { type: 'get', to: settings.xmpp.domain, id: `ping_${Date.now()}` },
        xmlRef.current!('ping', { xmlns: 'urn:xmpp:ping' })
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
      ping,
      loadConversationHistory,
      markMessageRead
    }}>
      {children}
    </XmppContext.Provider>
  );
};