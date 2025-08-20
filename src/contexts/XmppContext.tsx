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
  hasHistoryLoaded: boolean;
  hasMoreHistory: boolean;
  isLoadingHistory: boolean;
  lastMamQueryId?: string;
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
  fetchHistory: (jid: string) => Promise<void>;
  loadMoreHistory: (jid: string) => Promise<boolean>;
  syncOfflineMessages: () => Promise<void>;
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
  const [manualDisconnect, setManualDisconnect] = useState(false);
  const [clientGeneration, setClientGeneration] = useState(0);
  const clientRef = useRef<any>(null);
  const clientGenerationRef = useRef(0);
  const connectInFlightRef = useRef<Promise<boolean> | null>(null);
  const outboxRef = useRef<Array<{id: string, to: string, body: string}>>([]);
  const processedMessageIds = useRef<Set<string>>(new Set());
  const mamQueryIds = useRef<Map<string, string>>(new Map());

  // Save conversations to localStorage
  const saveConversationsToStorage = useCallback((convs: XmppConversation[]) => {
    try {
      const storageKey = `xmpp_conversations_${settings.xmpp.username}@${settings.xmpp.domain}`;
      localStorage.setItem(storageKey, JSON.stringify(convs.map(conv => ({
        ...conv,
        lastActivity: conv.lastActivity.toISOString(),
        messages: conv.messages.map(msg => ({
          ...msg,
          timestamp: msg.timestamp.toISOString()
        }))
      }))));
    } catch (error) {
      console.warn('Failed to save conversations to storage:', error);
    }
  }, [settings.xmpp.username, settings.xmpp.domain]);

  // Load conversations from localStorage
  const loadConversationsFromStorage = useCallback((): XmppConversation[] => {
    try {
      const storageKey = `xmpp_conversations_${settings.xmpp.username}@${settings.xmpp.domain}`;
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const parsed = JSON.parse(stored);
        return parsed.map((conv: any) => ({
          ...conv,
          lastActivity: new Date(conv.lastActivity),
          messages: conv.messages.map((msg: any) => ({
            ...msg,
            timestamp: new Date(msg.timestamp)
          })),
          hasHistoryLoaded: conv.hasHistoryLoaded || false,
          hasMoreHistory: conv.hasMoreHistory !== false,
          isLoadingHistory: false
        }));
      }
    } catch (error) {
      console.warn('Failed to load conversations from storage:', error);
    }
    return [];
  }, [settings.xmpp.username, settings.xmpp.domain]);

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
        const stanza = xml(
          'message',
          { type: 'chat', to: normalizedTo },
          xml('body', {}, msg.body)
        );

        await clientRef.current.send(stanza);
        
        // Add to local conversation on successful send
        const sentMessage: XmppMessage = {
          id: `${Date.now()}-${Math.random()}`,
          from: effectiveJid,
          to: normalizedTo,
          body: msg.body,
          timestamp: new Date(),
          type: 'chat'
        };
        
        addMessageToConversation(sentMessage);

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

  // Handle message stanzas (live messages, carbons, MAM forwarded)
  const handleMessageStanza = useCallback((stanza: any) => {
    // Handle message carbons (sent/received copies)
    const sent = stanza.getChild('sent', 'urn:xmpp:carbons:2');
    const received = stanza.getChild('received', 'urn:xmpp:carbons:2');
    
    if (sent || received) {
      const forwarded = (sent || received)?.getChild('forwarded', 'urn:xmpp:forward:0');
      const innerMessage = forwarded?.getChild('message');
      if (innerMessage) {
        const body = innerMessage.getChildText('body');
        if (body) {
          const from = innerMessage.attrs.from?.split('/')[0];
          const to = innerMessage.attrs.to?.split('/')[0];
          const messageId = innerMessage.attrs.id || `carbon-${Date.now()}-${Math.random()}`;
          
          // Skip if already processed
          if (processedMessageIds.current.has(messageId)) return;
          processedMessageIds.current.add(messageId);
          
          const message: XmppMessage = {
            id: messageId,
            from,
            to,
            body,
            timestamp: new Date(),
            type: 'chat'
          };
          
          addMessageToConversation(message);
        }
      }
      return;
    }
    
    // Handle MAM forwarded messages
    const result = stanza.getChild('result', 'urn:xmpp:mam:2');
    if (result) {
      const forwarded = result.getChild('forwarded', 'urn:xmpp:forward:0');
      const innerMessage = forwarded?.getChild('message');
      const delay = forwarded?.getChild('delay', 'urn:xmpp:delay');
      
      if (innerMessage) {
        const body = innerMessage.getChildText('body');
        if (body) {
          const from = innerMessage.attrs.from?.split('/')[0];
          const to = innerMessage.attrs.to?.split('/')[0];
          const messageId = innerMessage.attrs.id || result.attrs.id || `mam-${Date.now()}-${Math.random()}`;
          const timestamp = delay?.attrs.stamp ? new Date(delay.attrs.stamp) : new Date();
          
          // Skip if already processed
          if (processedMessageIds.current.has(messageId)) return;
          processedMessageIds.current.add(messageId);
          
          const message: XmppMessage = {
            id: messageId,
            from,
            to,
            body,
            timestamp,
            type: 'chat'
          };
          
          addHistoryMessageToConversation(message);
        }
      }
      return;
    }
    
    // Handle regular live messages
    if (stanza.attrs.type === 'chat' || stanza.attrs.type === 'normal' || !stanza.attrs.type) {
      const from = stanza.attrs.from;
      const body = stanza.getChildText('body');
      
      if (body) {
        const messageId = stanza.attrs.id || `live-${Date.now()}-${Math.random()}`;
        
        // Skip if already processed
        if (processedMessageIds.current.has(messageId)) return;
        processedMessageIds.current.add(messageId);
        
        const message: XmppMessage = {
          id: messageId,
          from: from.split('/')[0],
          to: stanza.attrs.to,
          body,
          timestamp: new Date(),
          type: 'chat'
        };
        
        addMessageToConversation(message);
      }
    }
  }, []);

  const addMessageToConversation = useCallback((message: XmppMessage) => {
    setConversations(prev => {
      const contactJid = message.from === effectiveJid ? message.to : message.from;
      const existingConv = prev.find(conv => conv.jid === contactJid);
      
      if (existingConv) {
        const updatedConvs = prev.map(conv => {
          if (conv.jid === contactJid) {
            return {
              ...conv,
              messages: [...conv.messages, message],
              lastActivity: message.timestamp,
              unreadCount: message.from !== effectiveJid ? conv.unreadCount + 1 : conv.unreadCount
            };
          }
          return conv;
        }).sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());
        
        saveConversationsToStorage(updatedConvs);
        return updatedConvs;
      } else {
        // Create new conversation
        const newConv: XmppConversation = {
          jid: contactJid,
          name: contactJid.split('@')[0], // Use local part as name initially
          messages: [message],
          unreadCount: message.from !== effectiveJid ? 1 : 0,
          lastActivity: message.timestamp,
          hasHistoryLoaded: false,
          hasMoreHistory: true,
          isLoadingHistory: false
        };
        const updatedConvs = [newConv, ...prev];
        saveConversationsToStorage(updatedConvs);
        return updatedConvs;
      }
    });
  }, [effectiveJid, saveConversationsToStorage]);

  const addHistoryMessageToConversation = useCallback((message: XmppMessage) => {
    setConversations(prev => {
      const contactJid = message.from === effectiveJid ? message.to : message.from;
      const existingConv = prev.find(conv => conv.jid === contactJid);
      
      if (existingConv) {
        const updatedConvs = prev.map(conv => {
          if (conv.jid === contactJid) {
            // Insert history message in chronological order
            const newMessages = [...conv.messages, message].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
            return {
              ...conv,
              messages: newMessages,
              lastActivity: new Date(Math.max(conv.lastActivity.getTime(), message.timestamp.getTime()))
            };
          }
          return conv;
        });
        
        saveConversationsToStorage(updatedConvs);
        return updatedConvs;
      } else {
        const newConv: XmppConversation = {
          jid: contactJid,
          name: contactJid.split('@')[0],
          messages: [message],
          unreadCount: 0,
          lastActivity: message.timestamp,
          hasHistoryLoaded: true,
          hasMoreHistory: true,
          isLoadingHistory: false
        };
        const updatedConvs = [newConv, ...prev].sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());
        saveConversationsToStorage(updatedConvs);
        return updatedConvs;
      }
    });
  }, [effectiveJid, saveConversationsToStorage]);

  // MAM query handling
  const handleMamResult = useCallback((stanza: any) => {
    const queryId = stanza.attrs.id;
    const fin = stanza.getChild('fin', 'urn:xmpp:mam:2');
    
    if (fin && queryId) {
      const jid = mamQueryIds.current.get(queryId);
      if (jid) {
        const complete = fin.attrs.complete === 'true';
        
        setConversations(prev => prev.map(conv => {
          if (conv.jid === jid) {
            return {
              ...conv,
              isLoadingHistory: false,
              hasMoreHistory: !complete,
              hasHistoryLoaded: true,
              lastMamQueryId: queryId
            };
          }
          return conv;
        }));
        
        mamQueryIds.current.delete(queryId);
        console.log(`XMPP MAM query ${queryId} completed for ${jid}, complete: ${complete}`);
      }
    }
  }, []);

  // Fetch initial history for a conversation
  const fetchHistory = useCallback(async (jid: string): Promise<void> => {
    if (!clientRef.current || connectionState !== 'connected') {
      console.warn('XMPP cannot fetch history - not connected');
      return;
    }

    const conv = conversations.find(c => c.jid === jid);
    if (conv?.hasHistoryLoaded || conv?.isLoadingHistory) {
      console.log(`XMPP history already loaded/loading for ${jid}`);
      return;
    }

    const queryId = `mam-${jid.replace(/[@.]/g, '-')}-${Date.now()}`;
    mamQueryIds.current.set(queryId, jid);

    setConversations(prev => prev.map(conv => {
      if (conv.jid === jid) {
        return { ...conv, isLoadingHistory: true };
      }
      return conv;
    }));

    try {
      await clientRef.current.send(
        xml('iq', { type: 'set', id: queryId },
          xml('query', { xmlns: 'urn:xmpp:mam:2' },
            xml('x', { xmlns: 'jabber:x:data', type: 'submit' },
              xml('field', { var: 'FORM_TYPE', type: 'hidden' },
                xml('value', {}, 'urn:xmpp:mam:2')
              ),
              xml('field', { var: 'with' },
                xml('value', {}, jid)
              )
            ),
            xml('set', { xmlns: 'http://jabber.org/protocol/rsm' },
              xml('max', {}, '50')
            )
          )
        )
      );
      
      console.log(`XMPP initiated MAM query ${queryId} for ${jid}`);
    } catch (error) {
      console.error(`XMPP failed to fetch history for ${jid}:`, error);
      setConversations(prev => prev.map(conv => {
        if (conv.jid === jid) {
          return { ...conv, isLoadingHistory: false };
        }
        return conv;
      }));
      mamQueryIds.current.delete(queryId);
    }
  }, [clientRef, connectionState, conversations]);

  // Load more history for a conversation
  const loadMoreHistory = useCallback(async (jid: string): Promise<boolean> => {
    if (!clientRef.current || connectionState !== 'connected') {
      console.warn('XMPP cannot load more history - not connected');
      return false;
    }

    const conv = conversations.find(c => c.jid === jid);
    if (!conv?.hasMoreHistory || conv.isLoadingHistory) {
      console.log(`XMPP no more history available for ${jid}`);
      return false;
    }

    const queryId = `mam-more-${jid.replace(/[@.]/g, '-')}-${Date.now()}`;
    mamQueryIds.current.set(queryId, jid);

    setConversations(prev => prev.map(c => {
      if (c.jid === jid) {
        return { ...c, isLoadingHistory: true };
      }
      return c;
    }));

    try {
      const oldestMessage = conv.messages[0];
      
      await clientRef.current.send(
        xml('iq', { type: 'set', id: queryId },
          xml('query', { xmlns: 'urn:xmpp:mam:2' },
            xml('x', { xmlns: 'jabber:x:data', type: 'submit' },
              xml('field', { var: 'FORM_TYPE', type: 'hidden' },
                xml('value', {}, 'urn:xmpp:mam:2')
              ),
              xml('field', { var: 'with' },
                xml('value', {}, jid)
              ),
              ...(oldestMessage ? [
                xml('field', { var: 'end' },
                  xml('value', {}, oldestMessage.timestamp.toISOString())
                )
              ] : [])
            ),
            xml('set', { xmlns: 'http://jabber.org/protocol/rsm' },
              xml('max', {}, '50')
            )
          )
        )
      );
      
      console.log(`XMPP initiated MAM load-more query ${queryId} for ${jid}`);
      return true;
    } catch (error) {
      console.error(`XMPP failed to load more history for ${jid}:`, error);
      setConversations(prev => prev.map(c => {
        if (c.jid === jid) {
          return { ...c, isLoadingHistory: false };
        }
        return c;
      }));
      mamQueryIds.current.delete(queryId);
      return false;
    }
  }, [clientRef, connectionState, conversations]);

  // Sync offline messages using MAM
  const syncOfflineMessages = useCallback(async (): Promise<void> => {
    if (!clientRef.current || connectionState !== 'connected') {
      console.warn('XMPP cannot sync offline messages - not connected');
      return;
    }

    try {
      // Get last sync timestamp from storage
      const storageKey = `xmpp_last_sync_${settings.xmpp.username}@${settings.xmpp.domain}`;
      const lastSync = localStorage.getItem(storageKey);
      const since = lastSync ? new Date(lastSync) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7 days ago
      
      const queryId = `mam-offline-sync-${Date.now()}`;
      
      await clientRef.current.send(
        xml('iq', { type: 'set', id: queryId },
          xml('query', { xmlns: 'urn:xmpp:mam:2' },
            xml('x', { xmlns: 'jabber:x:data', type: 'submit' },
              xml('field', { var: 'FORM_TYPE', type: 'hidden' },
                xml('value', {}, 'urn:xmpp:mam:2')
              ),
              xml('field', { var: 'start' },
                xml('value', {}, since.toISOString())
              )
            ),
            xml('set', { xmlns: 'http://jabber.org/protocol/rsm' },
              xml('max', {}, '100')
            )
          )
        )
      );
      
      // Update last sync timestamp
      localStorage.setItem(storageKey, new Date().toISOString());
      
      console.log(`XMPP initiated offline message sync since ${since.toISOString()}`);
    } catch (error) {
      console.error('XMPP failed to sync offline messages:', error);
    }
  }, [clientRef, connectionState, settings.xmpp.username, settings.xmpp.domain]);

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
      
      const newClient = client({
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
        newClient.send(xml('presence')).catch(console.error);
        
        // Request roster
        newClient.send(
          xml('iq', { type: 'get', id: 'roster' },
            xml('query', { xmlns: 'jabber:iq:roster' })
          )
        ).catch(console.error);
        
        // Enable message carbons for message synchronization
        newClient.send(
          xml('iq', { type: 'set', id: 'enable-carbons' },
            xml('enable', { xmlns: 'urn:xmpp:carbons:2' })
          )
        ).catch(console.error);
        
        // Flush any queued messages after successful connection
        setTimeout(() => flushOutbox(), 100);
        
        // Sync offline messages
        setTimeout(() => syncOfflineMessages(), 500);
        
        resolve(true);
      });

      // Enhanced message handling - live messages, carbons, and MAM results
      newClient.on('stanza', (stanza: any) => {
        if (stanza.is('message')) {
          handleMessageStanza(stanza);
        } else if (stanza.is('presence')) {
          handlePresenceUpdate(stanza);
        } else if (stanza.is('iq')) {
          if (stanza.attrs.id === 'roster') {
            handleRosterUpdate(stanza);
          } else if (stanza.attrs.id?.startsWith('mam-')) {
            handleMamResult(stanza);
          }
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
  }, [settings.xmpp, toast, isConnecting, connectionState, reconnectTimeout, flushOutbox, syncOfflineMessages, handleMessageStanza, handleMamResult]);

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
    
    // If connected, try immediate send
    if (connectionState === 'connected' && clientRef.current) {
      try {
        const message = xml(
          'message',
          { type: 'chat', to: normalizedTo },
          xml('body', {}, body)
        );

        await clientRef.current.send(message);
        
        // Add to local conversation on successful send
        const sentMessage: XmppMessage = {
          id: `${Date.now()}-${Math.random()}`,
          from: effectiveJid,
          to: normalizedTo,
          body,
          timestamp: new Date(),
          type: 'chat'
        };
        
        addMessageToConversation(sentMessage);
        console.log('XMPP message sent immediately');
        return true;
        
      } catch (error) {
        console.error('XMPP immediate send failed:', error);
        
        // If it's a connectivity error, queue and trigger connect
        if (error instanceof TypeError && error.message.includes("Cannot read properties of null") ||
            (error instanceof Error && (error.message.includes('ECONNERROR') || error.message.includes('WebSocket')))) {
          console.log('XMPP connectivity error - queueing message and triggering connect');
          queueMessage(normalizedTo, body);
          
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
    
    // Not connected - queue message and trigger connect
    console.log('XMPP not connected - queueing message and triggering connect');
    queueMessage(normalizedTo, body);
    
    // Trigger connect by setting connection state
    if (connectionState === 'disconnected' || connectionState === 'error') {
      setConnectionState('connecting');
      setLastError(null);
    }
    
    return true; // Message queued, delivery deferred
  }, [connectionState, settings.xmpp.domain, effectiveJid, queueMessage, toast, addMessageToConversation]);

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
        lastActivity: new Date(),
        hasHistoryLoaded: false,
        hasMoreHistory: true,
        isLoadingHistory: false
      };
      const updatedConvs = [newConv, ...prev];
      saveConversationsToStorage(updatedConvs);
      return updatedConvs;
    });
  }, [saveConversationsToStorage]);

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

  // Load conversations from storage on mount
  useEffect(() => {
    if (settings.xmpp.username && settings.xmpp.domain) {
      const storedConversations = loadConversationsFromStorage();
      if (storedConversations.length > 0) {
        setConversations(storedConversations);
        console.log(`XMPP loaded ${storedConversations.length} conversations from storage`);
      }
    }
  }, [settings.xmpp.username, settings.xmpp.domain, loadConversationsFromStorage]);

  // Auto-connect if enabled
  useEffect(() => {
    if (settings.xmpp.autoConnect && !isConnecting && connectionState === 'disconnected') {
      console.log('XMPP auto-connecting on mount...');
      connect();
    }
  }, [settings.xmpp.autoConnect, connect, isConnecting, connectionState]);

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
      fetchHistory,
      loadMoreHistory,
      syncOfflineMessages,
      runWebSocketDiagnostics,
      ping
    }}>
      {children}
    </XmppContext.Provider>
  );
};
