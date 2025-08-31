import { useState } from 'react';
import { RosterPanel } from '@/components/xmpp/RosterPanel';
import { ChatWindow } from '@/components/xmpp/ChatWindow';
import { useXmppConnection } from '@/hooks/useXmppConnection';
import { Card } from '@/components/ui/card';

const Messages = () => {
  const [selectedJid, setSelectedJid] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const { isConnected } = useXmppConnection();

  const handleContactClick = (jid: string) => {
    setSelectedJid(jid);
  };

  const handleCloseChat = () => {
    setSelectedJid(null);
  };

  if (!isConnected) {
    return (
      <div className="min-h-full flex items-center justify-center">
        <Card className="p-6 text-center">
          <h2 className="text-xl font-semibold mb-2">XMPP Not Connected</h2>
          <p className="text-muted-foreground">
            Please configure and connect to XMPP in Settings to use messaging features.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-full flex">
      {/* Roster Panel */}
      <div className="w-1/3 border-r border-border">
        <RosterPanel
          onContactClick={handleContactClick}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
        />
      </div>

      {/* Chat Window */}
      <div className="flex-1">
        {selectedJid ? (
          <ChatWindow 
            jid={selectedJid} 
            onClose={handleCloseChat}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <p>Select a contact to start messaging</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default Messages;