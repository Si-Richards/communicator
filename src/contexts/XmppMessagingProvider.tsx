import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { XmppClient } from '../lib/xmpp/client';
import { xmppStorage } from '../lib/xmpp/storage';
import { useSettings } from './SettingsContext';
import { 
  XmppConfig, 
  XmppConnectionStatus, 
  XmppMessage, 
  XmppContact, 
  XmppThread,
  MessagingEventHandlers,
  XmppFeatureFlags 
} from '../types/xmpp';

interface XmppMessagingContextType {
  client: XmppClient | null;
  status: XmppConnectionStatus;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  sendMessage: (to: string, body: string, type?: 'chat' | 'groupchat') => Promise<string>;
  sendTyping: (to: string, isTyping: boolean) => Promise<void>;
  markAsRead: (threadId: string, messageId: string) => Promise<void>;
  joinRoom: (roomJid: string, nick?: string) => Promise<void>;
  leaveRoom: (roomJid: string) => Promise<void>;
  requestHistory: (jid: string, before?: Date, max?: number) => Promise<void>;
  updateEventHandlers: (handlers: Partial<MessagingEventHandlers>) => void;
}

const XmppMessagingContext = createContext<XmppMessagingContextType | undefined>(undefined);

export const useXmppMessaging = () => {
  const context = useContext(XmppMessagingContext);
  if (!context) {
    throw new Error('useXmppMessaging must be used within an XmppMessagingProvider');
  }
  return context;
};

interface XmppMessagingProviderProps {
  children: ReactNode;
  config?: XmppConfig;
}

export const XmppMessagingProvider: React.FC<XmppMessagingProviderProps> = ({ 
  children, 
  config = {} 
}) => {
  const { settings } = useSettings();
  const [client, setClient] = useState<XmppClient | null>(null);
  const [status, setStatus] = useState<XmppConnectionStatus>({
    status: 'disconnected',
    resumeSupported: false
  });

  // Initialize storage
  useEffect(() => {
    xmppStorage.init().catch(console.error);
  }, []);

  // Create client when configuration is available
  useEffect(() => {
    if (config.existingClient) {
      // Use existing client
      setClient(config.existingClient);
      return;
    }

    // Get configuration from props or settings
    const serviceUrl = config.serviceUrl || settings.xmpp.serviceUrl;
    const domain = config.domain || settings.xmpp.domain;
    const resource = config.resource || settings.xmpp.resource;

    if (!serviceUrl || !domain) {
      console.error('XMPP configuration missing: serviceUrl and domain are required');
      return;
    }

    const features: Partial<XmppFeatureFlags> = {
      enableStreamManagement: true,
      enableCarbons: true,
      enableMAM: true,
      enableMUC: true,
      enableHTTPUpload: true,
      enableVCard: true,
      enableBlocking: true,
      enableReceipts: true,
      enableMarkers: true,
      enableTyping: true,
      enableEdit: true,
      enableRetract: true,
      enableReactions: false,
      ...config.features
    };

    const eventHandlers: Partial<MessagingEventHandlers> = {
      onConnectionStatus: setStatus,
      ...config.onEvents
    };

    const newClient = new XmppClient(
      serviceUrl,
      domain,
      resource,
      features,
      eventHandlers,
      settings.xmpp.debugMode
    );

    setClient(newClient);
  }, [config, settings.xmpp]);

  const connect = useCallback(async () => {
    if (!client) {
      throw new Error('XMPP client not initialized');
    }

    let credentials;
    
    if (config.getCredentials) {
      credentials = await config.getCredentials();
    } else {
      const username = settings.xmpp.username;
      const password = settings.xmpp.password;
      
      if (!username || !password) {
        throw new Error('XMPP credentials not configured');
      }
      
      const domain = config.domain || settings.xmpp.domain;
      credentials = {
        jid: `${username}@${domain}`,
        password
      };
    }

    await client.connect(credentials.jid, credentials.password);
  }, [client, config, settings.xmpp]);

  const disconnect = useCallback(async () => {
    if (client) {
      await client.disconnect();
    }
  }, [client]);

  const sendMessage = useCallback(async (to: string, body: string, type: 'chat' | 'groupchat' = 'chat') => {
    if (!client) {
      throw new Error('XMPP client not connected');
    }
    return await client.sendMessage(to, body, type);
  }, [client]);

  const sendTyping = useCallback(async (to: string, isTyping: boolean) => {
    if (!client) return;
    await client.sendTyping(to, isTyping);
  }, [client]);

  const markAsRead = useCallback(async (threadId: string, messageId: string) => {
    if (!client) return;
    
    // Get thread to find the other JID
    const thread = await xmppStorage.getThread(threadId);
    if (!thread) return;

    await client.sendMarker(thread.jid, messageId, 'displayed');
  }, [client]);

  const joinRoom = useCallback(async (roomJid: string, nick?: string) => {
    if (!client) {
      throw new Error('XMPP client not connected');
    }
    await client.joinRoom(roomJid, nick);
  }, [client]);

  const leaveRoom = useCallback(async (roomJid: string) => {
    if (!client) {
      throw new Error('XMPP client not connected');
    }
    await client.leaveRoom(roomJid);
  }, [client]);

  const requestHistory = useCallback(async (jid: string, before?: Date, max = 50) => {
    if (!client) return;
    await client.requestHistory(jid, before, max);
  }, [client]);

  const updateEventHandlers = useCallback((handlers: Partial<MessagingEventHandlers>) => {
    if (!client) return;
    client.updateEventHandlers(handlers);
  }, [client]);

  // Auto-connect if enabled
  useEffect(() => {
    if (client && settings.xmpp.enabled && settings.xmpp.autoConnect && status.status === 'disconnected') {
      connect().catch(console.error);
    }
  }, [client, settings.xmpp.enabled, settings.xmpp.autoConnect, status.status, connect]);

  return (
    <XmppMessagingContext.Provider
      value={{
        client,
        status,
        connect,
        disconnect,
        sendMessage,
        sendTyping,
        markAsRead,
        joinRoom,
        leaveRoom,
        requestHistory,
        updateEventHandlers
      }}
    >
      {children}
    </XmppMessagingContext.Provider>
  );
};