// useXmppConnection Hook - Connection management
import { useState, useEffect, useCallback } from 'react';
import { useXmppMessaging } from '@/contexts/XmppMessagingProvider';
import { ConnectionStatus } from '@/lib/xmpp/types';

export interface UseXmppConnectionReturn {
  status: ConnectionStatus;
  myJid: string | null;
  isConnected: boolean;
  isConnecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  resume: () => Promise<void>;
}

export const useXmppConnection = (): UseXmppConnectionReturn => {
  const { status, myJid, client, connect: contextConnect, disconnect: contextDisconnect } = useXmppMessaging();
  const [error, setError] = useState<string | null>(null);

  const isConnected = status === 'connected';
  const isConnecting = ['connecting', 'authenticating', 'resuming'].includes(status);

  useEffect(() => {
    if (status === 'error') {
      setError('Connection failed');
    } else if (status === 'connected') {
      setError(null);
    }
  }, [status]);

  const connect = useCallback(async () => {
    try {
      setError(null);
      await contextConnect();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown connection error';
      setError(errorMessage);
      throw err;
    }
  }, [contextConnect]);

  const disconnect = useCallback(async () => {
    try {
      setError(null);
      await contextDisconnect();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown disconnection error';
      setError(errorMessage);
      throw err;
    }
  }, [contextDisconnect]);

  const resume = useCallback(async () => {
    // For stream management resume, we can attempt to reconnect
    // The client will automatically try to resume if stream management is enabled
    if (client && status === 'disconnected') {
      await connect();
    }
  }, [client, status, connect]);

  return {
    status,
    myJid,
    isConnected,
    isConnecting,
    error,
    connect,
    disconnect,
    resume,
  };
};