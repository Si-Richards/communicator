import { useEffect } from 'react';
import { UnifiedChatView } from '@/components/chat/UnifiedChatView';
import { useXmpp } from '@/contexts/XmppContext';
import { useSettings } from '@/contexts/SettingsContext';

const Chat = () => {
  const { connectionState, connect } = useXmpp();
  const { settings } = useSettings();

  // Safety net: auto-connect when visiting chat page
  useEffect(() => {
    if ((connectionState === 'disconnected' || connectionState === 'error') && settings?.xmpp) {
      const { websocketUrl, domain, username, password } = settings.xmpp;
      if (websocketUrl && domain && username && password) {
        connect().catch(console.error);
      }
    }
  }, [connectionState, settings?.xmpp, connect]);

  return (
    <div className="h-full min-h-screen flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 p-4 border-b border-border">
        <h1 className="text-xl font-bold">Messages</h1>
      </div>

      {/* Content area */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <UnifiedChatView />
      </div>
    </div>
  );
};

export default Chat;