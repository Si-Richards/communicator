// XMPP Messaging Provider - Main context provider
import React, { createContext, useContext, useState, useEffect, useRef, ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { XmppClient } from '@/lib/xmpp/client';
import { xmppStorage } from '@/lib/xmpp/storage';
import { 
  ConnectionStatus, 
  XmppMessage, 
  XmppContact, 
  XmppConversation, 
  MucRoom,
  ServerFeatures,
  FeatureFlags,
  MessagingEventHandlers 
} from '@/lib/xmpp/types';
import { useSettings } from '@/contexts/SettingsContext';

interface XmppMessagingConfig {
  serviceUrl?: string;
  domain?: string;
  resource?: string;
  getCredentials?: () => Promise<{ jid: string; password: string }>;
  existingClient?: ReturnType<typeof import('@xmpp/client').client>;
  features?: Partial<FeatureFlags>;
  onEvents?: Partial<MessagingEventHandlers>;
  getUploadAuthHeaders?: () => Promise<Record<string, string>>;
}

interface XmppMessagingContextType {
  // Connection
  status: ConnectionStatus;
  features: ServerFeatures;
  myJid: string | null;
  
  // Core client
  client: XmppClient | null;
  
  // Event handlers
  eventHandlers: Partial<MessagingEventHandlers>;
  
  // Feature flags
  featureFlags: FeatureFlags;
  
  // Methods
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  updateEventHandlers: (handlers: Partial<MessagingEventHandlers>) => void;
}

const defaultFeatureFlags: FeatureFlags = {
  enableStreamManagement: true,
  enableCarbons: true,
  enableMAM: true,
  enableFileUpload: true,
  enableTyping: true,
  enableReceipts: true,
  enableMarkers: true,
  enableRetraction: true,
  enableReactions: false, // Future feature
};

const XmppMessagingContext = createContext<XmppMessagingContextType | null>(null);

export const useXmppMessaging = () => {
  const context = useContext(XmppMessagingContext);
  if (!context) {
    throw new Error('useXmppMessaging must be used within XmppMessagingProvider');
  }
  return context;
};

// Create a separate query client for XMPP to avoid conflicts
const xmppQueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 3,
      staleTime: 5 * 60 * 1000, // 5 minutes
      gcTime: 10 * 60 * 1000, // 10 minutes
    },
  },
});

interface XmppMessagingProviderProps {
  children: ReactNode;
  config?: XmppMessagingConfig;
}

export const XmppMessagingProvider: React.FC<XmppMessagingProviderProps> = ({ 
  children, 
  config = {} 
}) => {
  const settings = useSettings();
  const clientRef = useRef<XmppClient | null>(null);
  
  // State
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [features, setFeatures] = useState<ServerFeatures>({
    streamManagement: false,
    messageDeliveryReceipts: false,
    chatMarkers: false,
    messageArchiveManagement: false,
    messageCarbons: false,
    messageRetraction: false,
    lastActivity: false,
    muc: false,
    httpFileUpload: false,
    ping: false,
    blocking: false,
    vcard: false,
  });
  const [myJid, setMyJid] = useState<string | null>(null);
  const [eventHandlers, setEventHandlers] = useState<Partial<MessagingEventHandlers>>(
    config.onEvents || {}
  );

  const featureFlags: FeatureFlags = {
    ...defaultFeatureFlags,
    ...config.features,
  };

  // Initialize storage and client
  useEffect(() => {
    const initializeStorage = async () => {
      try {
        await xmppStorage.initialize();
        console.log('XMPP storage initialized');
      } catch (error) {
        console.error('Failed to initialize XMPP storage:', error);
      }
    };

    initializeStorage();

    // Create client
    if (config.existingClient) {
      clientRef.current = new XmppClient(config.existingClient);
    } else {
      clientRef.current = new XmppClient();
    }

    const client = clientRef.current;

    // Set up event listeners
    client.on('statusChanged', ({ status: newStatus }) => {
      setStatus(newStatus);
      eventHandlers.onConnectionChange?.(newStatus);
    });

    client.on('connected', ({ jid }) => {
      setMyJid(jid);
      
      // Set account for storage
      const bareJid = jid.split('/')[0];
      xmppStorage.setAccount(bareJid);
    });

    client.on('featuresDiscovered', (discoveredFeatures: ServerFeatures) => {
      setFeatures(discoveredFeatures);
    });

    client.on('error', (error) => {
      console.error('XMPP error:', error);
      eventHandlers.onError?.(error);
    });

    return () => {
      if (clientRef.current) {
        clientRef.current.disconnect();
      }
    };
  }, []);

  // Update event handlers when config changes
  useEffect(() => {
    setEventHandlers(config.onEvents || {});
  }, [config.onEvents]);

  const getCredentials = async (): Promise<{ jid: string; password: string }> => {
    // Priority order: config callback, then settings
    if (config.getCredentials) {
      return config.getCredentials();
    }

    const xmppSettings = settings.settings.xmpp;
    if (!xmppSettings.username || !xmppSettings.password) {
      throw new Error('XMPP credentials not configured. Please set username and password in settings.');
    }

    const domain = config.domain || xmppSettings.domain;
    const jid = xmppSettings.username.includes('@') 
      ? xmppSettings.username 
      : `${xmppSettings.username}@${domain}`;

    return {
      jid,
      password: xmppSettings.password,
    };
  };

  const connect = async (): Promise<void> => {
    if (!clientRef.current) {
      throw new Error('XMPP client not initialized');
    }

    // Skip connection if using existing client
    if (config.existingClient) {
      console.log('Using existing XMPP client, skipping connection');
      return;
    }

    const xmppSettings = settings.settings.xmpp;
    
    const connectionConfig = {
      serviceUrl: config.serviceUrl || xmppSettings.websocketUrl,
      domain: config.domain || xmppSettings.domain,
      resource: config.resource || xmppSettings.resource || 'webclient',
      getCredentials,
    };

    // Validate required config
    if (!connectionConfig.serviceUrl || !connectionConfig.domain) {
      throw new Error('XMPP service URL and domain must be configured');
    }

    await clientRef.current.connect(connectionConfig);
  };

  const disconnect = async (): Promise<void> => {
    if (clientRef.current) {
      await clientRef.current.disconnect();
      setMyJid(null);
    }
  };

  const updateEventHandlers = (handlers: Partial<MessagingEventHandlers>): void => {
    setEventHandlers(prev => ({ ...prev, ...handlers }));
  };

  const contextValue: XmppMessagingContextType = {
    status,
    features,
    myJid,
    client: clientRef.current,
    eventHandlers,
    featureFlags,
    connect,
    disconnect,
    updateEventHandlers,
  };

  return (
    <QueryClientProvider client={xmppQueryClient}>
      <XmppMessagingContext.Provider value={contextValue}>
        {children}
        {import.meta.env.DEV && <ReactQueryDevtools initialIsOpen={false} />}
      </XmppMessagingContext.Provider>
    </QueryClientProvider>
  );
};