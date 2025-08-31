// Messages Page - XMPP Chat Interface
import React from 'react';
import { XmppMessagingProvider } from '@/contexts/XmppMessagingProvider';

// Placeholder components that will be implemented
const RosterPanel = () => <div className="p-4">Roster Panel (Coming Soon)</div>;
const ChatWindow = () => <div className="p-4">Chat Window (Coming Soon)</div>;

export default function Messages() {
  return (
    <XmppMessagingProvider>
      <div className="flex h-full">
        <div className="w-1/3 border-r border-border">
          <RosterPanel />
        </div>
        <div className="flex-1">
          <ChatWindow />
        </div>
      </div>
    </XmppMessagingProvider>
  );
}