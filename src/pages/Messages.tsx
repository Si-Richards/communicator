import { Send, Search, Mic, MicOff, Wifi, WifiOff, Users, UserPlus } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useState, useEffect } from 'react';
import { useSpeechRecognition } from '@/hooks/useSpeechRecognition';
import { useSettings } from '@/contexts/SettingsContext';
import { useXmpp } from '@/contexts/XmppContext';

const Messages = () => {
  const [selectedConversation, setSelectedConversation] = useState<string | null>(null);
  const [newMessage, setNewMessage] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [contactSearchTerm, setContactSearchTerm] = useState('');
  const [newJid, setNewJid] = useState('');
  const [isNewChatOpen, setIsNewChatOpen] = useState(false);
  const { settings } = useSettings();
  const { 
    connectionState, 
    conversations, 
    contacts, 
    connect, 
    disconnect, 
    sendMessage,
    startConversation 
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

  const filteredConversations = conversations.filter((conv) => {
    const name = conv.name || conv.jid.split('@')[0] || '';
    return name.toLowerCase().includes(searchTerm.toLowerCase()) ||
           conv.jid.includes(searchTerm);
  });

  const filteredContacts = contacts.filter((contact) => {
    const name = contact.name || contact.jid.split('@')[0] || '';
    return name.toLowerCase().includes(contactSearchTerm.toLowerCase()) ||
           contact.jid.includes(contactSearchTerm);
  });

  const selectedConv = conversations.find((conv) => conv.jid === selectedConversation);

  const handleSendMessage = async () => {
    if (!newMessage.trim() || !selectedConv) return;

    const success = await sendMessage(selectedConv.jid, newMessage.trim());
    if (success) {
      setNewMessage('');
      resetTranscript();
    }
  };

  const handleStartNewChat = (jid: string) => {
    startConversation(jid);
    setSelectedConversation(jid);
    setIsNewChatOpen(false);
    setNewJid('');
    setContactSearchTerm('');
  };

  const handleStartChatWithJid = () => {
    if (!newJid.trim()) return;
    const jid = newJid.includes('@') ? newJid : `${newJid}@${settings.xmpp.domain}`;
    handleStartNewChat(jid);
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
              <Dialog open={isNewChatOpen} onOpenChange={setIsNewChatOpen}>
                <DialogTrigger asChild>
                  <Button size="sm" variant="outline">
                    <UserPlus className="h-4 w-4 mr-1" />
                    New Chat
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-md">
                  <DialogHeader>
                    <DialogTitle>Start New Chat</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-4">
                    <div>
                      <label className="text-sm font-medium mb-2 block">Enter JID</label>
                      <div className="flex gap-2">
                        <Input
                          placeholder="username or user@domain.com"
                          value={newJid}
                          onChange={(e) => setNewJid(e.target.value)}
                          onKeyPress={(e) => e.key === 'Enter' && handleStartChatWithJid()}
                          className="flex-1"
                        />
                        <Button onClick={handleStartChatWithJid} disabled={!newJid.trim()}>
                          Start
                        </Button>
                      </div>
                    </div>
                    
                    {connectionState === 'connected' && contacts.length > 0 && (
                      <div>
                        <label className="text-sm font-medium mb-2 block">Or select from contacts</label>
                        <div className="relative mb-2">
                          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                          <Input
                            placeholder="Search contacts..."
                            value={contactSearchTerm}
                            onChange={(e) => setContactSearchTerm(e.target.value)}
                            className="pl-10"
                          />
                        </div>
                        <ScrollArea className="h-48">
                          {filteredContacts.map((contact) => (
                            <div
                              key={contact.jid}
                              onClick={() => handleStartNewChat(contact.jid)}
                              className="flex items-center gap-3 p-2 hover:bg-muted rounded cursor-pointer"
                            >
                              <Avatar className="h-8 w-8">
                                <AvatarFallback className="text-xs">
                                  {getInitials(contact.name)}
                                </AvatarFallback>
                              </Avatar>
                              <div className="flex-1 min-w-0">
                                <p className="font-medium text-sm truncate">{contact.name}</p>
                                <p className="text-xs text-muted-foreground truncate">{contact.jid}</p>
                              </div>
                              <Badge 
                                variant={contact.presence === 'available' ? 'default' : 'secondary'}
                                className="text-xs"
                              >
                                {contact.presence}
                              </Badge>
                            </div>
                          ))}
                          {filteredContacts.length === 0 && (
                            <p className="text-sm text-muted-foreground text-center py-4">
                              No contacts found
                            </p>
                          )}
                        </ScrollArea>
                      </div>
                    )}
                  </div>
                </DialogContent>
              </Dialog>
              
              {connectionState === 'connected' ? (
                <Badge variant="default" className="text-xs">
                  <Wifi className="h-3 w-3 mr-1" />
                  Connected
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
        
        <ScrollArea className="h-[calc(100vh-8rem)]">
          {connectionState !== 'connected' ? (
            <div className="p-8 text-center text-muted-foreground">
              <WifiOff className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p className="text-lg font-medium mb-2">Not Connected</p>
              <p className="text-sm mb-4">Connect to XMPP server in Settings to view messages</p>
            </div>
          ) : filteredConversations.length === 0 && searchTerm === '' ? (
            <div className="p-8 text-center text-muted-foreground">
              <Users className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p className="text-lg font-medium mb-2">No Conversations</p>
              <p className="text-sm mb-4">Start a new chat to begin messaging</p>
            </div>
          ) : filteredConversations.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">
              <Search className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p className="text-lg font-medium mb-2">No Results</p>
              <p className="text-sm">No conversations match your search</p>
            </div>
          ) : (
            filteredConversations.map((conversation) => {
              const lastMessage = conversation.messages.length > 0 
                ? conversation.messages[conversation.messages.length - 1].body
                : 'No messages';
              const timestamp = conversation.lastActivity.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
              
              return (
                <div
                  key={conversation.jid}
                  onClick={() => setSelectedConversation(conversation.jid)}
                  className={`p-4 border-b border-border cursor-pointer hover:bg-muted/50 ${
                    selectedConversation === conversation.jid ? 'bg-muted' : ''
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <Avatar className="h-10 w-10">
                      <AvatarFallback>{getInitials(conversation.name)}</AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <h3 className="font-medium truncate">{conversation.name}</h3>
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
            })
          )}
        </ScrollArea>
      </div>

      {/* Message View */}
      <div className="flex-1 flex flex-col">
        {selectedConv ? (
          <>
            {/* Header */}
            <div className="p-4 border-b border-border">
              <div className="flex items-center gap-3">
                <Avatar className="h-10 w-10">
                  <AvatarFallback>{getInitials(selectedConv.name)}</AvatarFallback>
                </Avatar>
                <div>
                  <h2 className="font-medium">{selectedConv.name}</h2>
                  <p className="text-sm text-muted-foreground">{selectedConv.jid}</p>
                </div>
              </div>
            </div>

            {/* Messages */}
            <ScrollArea className="flex-1 p-4">
              {selectedConv.messages.length === 0 ? (
                <div className="flex items-center justify-center h-full text-muted-foreground">
                  <div className="text-center">
                    <Users className="h-12 w-12 mx-auto mb-4 opacity-50" />
                    <p className="text-lg font-medium mb-2">Start a conversation</p>
                    <p className="text-sm">Send a message to begin chatting with {selectedConv.name}</p>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  {selectedConv.messages.map((message) => {
                    const messageTimestamp = message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    const isSent = message.from === `${settings.xmpp.username}@${settings.xmpp.domain}`;
                    
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
                          <p className="text-sm">{message.body}</p>
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
              )}
            </ScrollArea>

            {/* Message Input */}
            <div className="p-4 border-t border-border">
              <div className="flex gap-2">
                <Input
                  placeholder={connectionState !== 'connected' ? "Connect to XMPP to send messages" : isListening ? "Listening..." : "Type a message..."}
                  value={newMessage + (interimTranscript ? ` ${interimTranscript}` : '')}
                  onChange={(e) => setNewMessage(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && handleSendMessage()}
                  
                  className="flex-1"
                />
                {isSupported && settings.dictation.enabled && connectionState === 'connected' && (
                  <Button
                    onClick={toggleDictation}
                    size="icon"
                    variant={isListening ? "default" : "outline"}
                    className={isListening ? "bg-red-600 hover:bg-red-700" : ""}
                  >
                    {isListening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                  </Button>
                )}
                <Button onClick={handleSendMessage} size="icon" disabled={!newMessage.trim()}>
                  <Send className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center">
              <Users className="h-16 w-16 mx-auto mb-4 opacity-50" />
              <p className="text-xl font-medium mb-2">Welcome to Messages</p>
              <p className="text-sm mb-4">Select a conversation or start a new chat to begin messaging</p>
              {connectionState !== 'connected' && (
                <p className="text-xs text-red-500">Please connect to XMPP server in Settings first</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default Messages;