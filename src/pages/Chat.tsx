import { User, Users } from 'lucide-react';
import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { DirectChatView } from '@/components/chat/DirectChatView';
import { RoomChatView } from '@/components/chat/RoomChatView';

const Chat = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState(() => {
    const tab = searchParams.get('tab');
    return tab === 'rooms' ? 'rooms' : 'direct';
  });

  useEffect(() => {
    // Update URL when tab changes
    if (activeTab === 'rooms') {
      setSearchParams({ tab: 'rooms' });
    } else {
      setSearchParams({});
    }
  }, [activeTab, setSearchParams]);

  return (
    <div className="h-full min-h-screen flex flex-col overflow-hidden">
      {/* Header with toggle */}
      <div className="flex-shrink-0 p-4 border-b border-border">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold">Chat</h1>
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-auto">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="direct" className="flex items-center gap-2">
                <User className="h-4 w-4" />
                Direct
              </TabsTrigger>
              <TabsTrigger value="rooms" className="flex items-center gap-2">
                <Users className="h-4 w-4" />
                Rooms
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </div>

      {/* Content area */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="h-full">
          <TabsContent value="direct" className="h-full m-0">
            <DirectChatView />
          </TabsContent>
          <TabsContent value="rooms" className="h-full m-0">
            <RoomChatView />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
};

export default Chat;