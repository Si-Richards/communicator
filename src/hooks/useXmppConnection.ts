import { useCallback } from 'react';
import { useXmppMessaging } from '../contexts/XmppMessagingProvider';
import { XmppConnectionStatus } from '../types/xmpp';

export const useXmppConnection = () => {
  const { client, status, connect, disconnect } = useXmppMessaging();

  const resume = useCallback(async () => {
    if (status.resumeSupported && client) {
      // Stream management resume would be handled automatically by the client
      await connect();
    }
  }, [status.resumeSupported, client, connect]);

  const isConnected = status.status === 'connected';
  const isConnecting = status.status === 'connecting' || status.status === 'resuming';

  return {
    status,
    isConnected,
    isConnecting,
    connect,
    disconnect,
    resume
  };
};