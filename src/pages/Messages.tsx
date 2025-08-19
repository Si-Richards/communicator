import { Send, Search, Mic, MicOff, Wifi, WifiOff, Users } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { useState, useEffect } from 'react';
import { useSpeechRecognition } from '@/hooks/useSpeechRecognition';
import { useSettings } from '@/contexts/SettingsContext';
import { useXmpp } from '@/contexts/XmppContext';

// Mock conversations data
const mockConversations = [
  {
    id: '1',
    name: 'John Smith',
    number: '07880498653',
    lastMessage: 'Thanks for the update!',
    timestamp: '14:30',
    unreadCount: 0,
    messages: [
      { id: '1', text: 'Hey, how are you?', sent: false, timestamp: '14:25' },
      { id: '2', text: 'I\'m good, thanks! How about you?', sent: true, timestamp: '14:27' },
      { id: '3', text: 'Great! Just wanted to give you an update on the project.', sent: false, timestamp: '14:28' },
      { id: '4', text: 'Thanks for the update!', sent: false, timestamp: '14:30' }
    ]
  },
  {
    id: '2',
    name: 'Sarah Johnson',
    number: '07890123456',
    lastMessage: 'See you tomorrow',
    timestamp: '11:15',
    unreadCount: 2,
    messages: [
      { id: '1', text: 'Meeting at 3 PM tomorrow?', sent: false, timestamp: '11:10' },
      { id: '2', text: 'Yes, that works for me', sent: true, timestamp: '11:12' },
      { id: '3', text: 'Perfect! I\'ll send the agenda', sent: false, timestamp: '11:14' },
      { id: '4', text: 'See you tomorrow', sent: false, timestamp: '11:15' }
    ]
  },
  {
    id: '3',
    name: 'Mike Wilson',
    number: '07700900123',
    lastMessage: 'Got it, thanks!',
    timestamp: 'Yesterday',
    unreadCount: 0,
    messages: [
      { id: '1', text: 'Can you send me the report?', sent: false, timestamp: 'Yesterday 16:30' },
      { id: '2', text: 'Sure, I\'ll email it to you shortly', sent: true, timestamp: 'Yesterday 16:32' },
      { id: '3', text: 'Got it, thanks!', sent: false, timestamp: 'Yesterday 16:45' }
    ]
  }
];

const Messages = () => {
  const [selectedConversation, setSelectedConversation] = useState<string | null>(null);
  const [newMessage, setNewMessage] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const { settings } = useSettings();
  const { 
    connectionState, 
    conversations, 
    contacts, 
    connect, 
    disconnect, 
    sendMessage 
  } = useXmpp();
  
  const {
    isListening,
    transcript,
    interimTranscript,
    isSupported,
    start: startDictation,
    stop: stopDictation,
    reset: resetTranscript
  } = useSpeechRecognition({
    language: settings.dictation.language,
    continuous: settings.dictation.continuous,
    interimResults: settings.dictation.interimResults
  });

  // Use XMPP conversations if connected, otherwise fallback to mock data
  const activeConversations = connectionState === 'connected' ? conversations : mockConversations;
  
  const filteredConversations = activeConversations.filter((conv: any) => {
    const name = 'name' in conv ? conv.name : conv.jid?.split('@')[0] || '';
    const identifier = 'number' in conv ? conv.number : conv.jid || '';
    return name.toLowerCase().includes(searchTerm.toLowerCase()) ||
           identifier.includes(searchTerm);
  });

  const selectedConv = activeConversations.find((conv: any) => {
    const id = 'id' in conv ? conv.id : conv.jid;
    return id === selectedConversation;
  });

  const handleSendMessage = async () => {
    if (!newMessage.trim() || !selectedConv) return;

    if (connectionState === 'connected') {
      const to = 'jid' in selectedConv ? selectedConv.jid : (selectedConv as any).number;
      const success = await sendMessage(to, newMessage.trim());
      if (success) {
        setNewMessage('');
        resetTranscript();
      }
    } else {
      // Mock mode - just log
      console.log('Sending message:', newMessage);
      setNewMessage('');
      resetTranscript();
    }
  };

  const toggleDictation = () => {
    if (!settings.dictation.enabled) return;
    
    if (isListening) {
      stopDictation();
    } else {
      resetTranscript();
      startDictation();
    }
  };

  // Update message when transcript changes
  useEffect(() => {
    if (transcript) {
      setNewMessage(prev => {
        const newText = prev + (prev ? ' ' : '') + transcript;
        resetTranscript();
        return newText;
      });
    }
  }, [transcript, resetTranscript]);

  const getInitials = (name: string) => {
    return name.split(' ').map(n => n[0]).join('').toUpperCase();
  };

  return (
    <div className="min-h-full flex">
      {/* Conversations List */}
      <div className="w-1/3 border-r border-border">
        <div className="p-4 border-b border-border">
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-xl font-bold">Messages</h1>
            <div className="flex items-center gap-2">
              {connectionState === 'connected' ? (
                <Badge variant="default" className="text-xs">
                  <Wifi className="h-3 w-3 mr-1" />
                  XMPP Connected
                </Badge>
              ) : connectionState === 'connecting' ? (
                <Badge variant="secondary" className="text-xs">
                  Connecting...
                </Badge>
              ) : (
                <Badge variant="destructive" className="text-xs">
                  <WifiOff className="h-3 w-3 mr-1" />
                  Offline
                </Badge>
              )}
            </div>
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search conversations..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10"
            />
          </div>
        </div>
        
        <div className="overflow-y-auto h-[calc(100vh-8rem)]">
          {filteredConversations.map((conversation: any) => {
            const conversationId = 'id' in conversation ? conversation.id : conversation.jid;
            const conversationName = 'name' in conversation ? conversation.name : conversation.jid?.split('@')[0] || 'Unknown';
            const lastMessage = 'lastMessage' in conversation 
              ? conversation.lastMessage 
              : conversation.messages.length > 0 
                ? conversation.messages[conversation.messages.length - 1].body
                : 'No messages';
            const timestamp = 'timestamp' in conversation 
              ? conversation.timestamp 
              : conversation.lastActivity.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            
            return (
              <div
                key={conversationId}
                onClick={() => setSelectedConversation(conversationId)}
                className={`p-4 border-b border-border cursor-pointer hover:bg-muted/50 ${
                  selectedConversation === conversationId ? 'bg-muted' : ''
                }`}
              >
                <div className="flex items-center gap-3">
                  <Avatar className="h-10 w-10">
                    <AvatarFallback>{getInitials(conversationName)}</AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <h3 className="font-medium truncate">{conversationName}</h3>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">{timestamp}</span>
                        {conversation.unreadCount > 0 && (
                          <Badge variant="default" className="text-xs">
                            {conversation.unreadCount}
                          </Badge>
                        )}
                      </div>
                    </div>
                    <p className="text-sm text-muted-foreground truncate">{lastMessage}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Message View */}
      <div className="flex-1 flex flex-col">
        {selectedConv ? (
          <>
            {/* Header */}
            <div className="p-4 border-b border-border">
              <div className="flex items-center gap-3">
                <Avatar className="h-10 w-10">
                  <AvatarFallback>{getInitials('name' in selectedConv ? selectedConv.name : (selectedConv as any).jid?.split('@')[0] || 'Unknown')}</AvatarFallback>
                </Avatar>
                <div>
                  <h2 className="font-medium">{'name' in selectedConv ? selectedConv.name : (selectedConv as any).jid?.split('@')[0] || 'Unknown'}</h2>
                  <p className="text-sm text-muted-foreground">{'number' in selectedConv ? (selectedConv as any).number : (selectedConv as any).jid || ''}</p>
                </div>
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {selectedConv.messages.map((message) => {
                const messageText = 'text' in message ? message.text : message.body;
                const messageTimestamp = 'timestamp' in message ? message.timestamp : message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                const isSent = 'sent' in message ? message.sent : message.from === `${settings.xmpp.username}@${settings.xmpp.domain}`;
                
                return (
                  <div
                    key={message.id}
                    className={`flex ${isSent ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-xs lg:max-w-md px-4 py-2 rounded-lg ${
                        isSent
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted'
                      }`}
                    >
                      <p className="text-sm">{messageText}</p>
                      <p className={`text-xs mt-1 ${
                        isSent ? 'text-primary-foreground/70' : 'text-muted-foreground'
                      }`}>
                        {messageTimestamp}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Message Input */}
            <div className="p-4 border-t border-border">
              <div className="flex gap-2">
                <Input
                  placeholder={isListening ? "Listening..." : "Type a message..."}
                  value={newMessage + (interimTranscript ? ` ${interimTranscript}` : '')}
                  onChange={(e) => setNewMessage(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && handleSendMessage()}
                  className="flex-1"
                />
                {isSupported && settings.dictation.enabled && (
                  <Button
                    onClick={toggleDictation}
                    size="icon"
                    variant={isListening ? "default" : "outline"}
                    className={isListening ? "bg-red-600 hover:bg-red-700" : ""}
                  >
                    {isListening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                  </Button>
                )}
                <Button onClick={handleSendMessage} size="icon">
                  <Send className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <p>Select a conversation to view messages</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default Messages;