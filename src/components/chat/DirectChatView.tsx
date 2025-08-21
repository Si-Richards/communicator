import { Search, Users, UserPlus, ArrowUpDown, Send, Mic, MicOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useState, useEffect } from 'react';
import { useSpeechRecognition } from '@/hooks/useSpeechRecognition';
import { useSettings } from '@/contexts/SettingsContext';
import { useXmpp } from '@/contexts/XmppContext';
import { MessageComposer } from './MessageComposer';
import { MessageBodyRenderer } from './MessageBodyRenderer';
import { MessageStatus } from './MessageStatus';
import { DateSeparator } from './DateSeparator';
import { PresencePicker } from './PresencePicker';
import { insertDateSeparators, formatFullDateTime } from '@/lib/dateUtils';

export const DirectChatView = () => {
  const [selectedConversation, setSelectedConversation] = useState<string | null>(null);
  const [newMessage, setNewMessage] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [contactSearchTerm, setContactSearchTerm] = useState('');
  const [newJid, setNewJid] = useState('');
  const [isNewChatOpen, setIsNewChatOpen] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<'newest' | 'a-z' | 'z-a'>('newest');
  const { settings } = useSettings();
  const { 
    connectionState, 
    conversations, 
    contacts, 
    userPresence,
    connect, 
    disconnect, 
    sendMessage,
    startConversation,
    loadConversationHistory,
    markMessageRead,
    markConversationRead,
    setPresence
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

  // Mark conversation as read when selected
  useEffect(() => {    
    if (selectedConversation) {
      const conversation = conversations.find(conv => conv.jid === selectedConversation);
      if (conversation && conversation.unreadCount > 0) {
        markConversationRead(selectedConversation);
      }
    }
  }, [selectedConversation, conversations, markConversationRead]);

  const filteredConversations = conversations.filter((conv) => {
    const name = conv.name || conv.jid.split('@')[0] || '';
    return name.toLowerCase().includes(searchTerm.toLowerCase()) ||
           conv.jid.includes(searchTerm);
  });

  const sortedConversations = [...filteredConversations].sort((a, b) => {
    switch (sortMode) {
      case 'newest':
        return b.lastActivity.getTime() - a.lastActivity.getTime();
      case 'a-z':
        return a.name.localeCompare(b.name);
      case 'z-a':
        return b.name.localeCompare(a.name);
      default:
        return 0;
    }
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

  const handleLoadHistory = async (jid: string) => {
    if (loadingHistory === jid) return;
    
    setLoadingHistory(jid);
    try {
      await loadConversationHistory(jid);
    } catch (error) {
      console.error('Failed to load conversation history:', error);
    } finally {
      setLoadingHistory(null);
    }
  };


  return (
    <div className="h-full flex overflow-hidden">
      {/* Conversations List */}
      <div className="w-1/3 border-r border-border flex flex-col min-h-0">
        <div className="p-4 border-b border-border flex-shrink-0">
          
          <div className="flex items-center justify-between mb-4">
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
                               <div className="flex items-center">
                                <div className={`w-2 h-2 rounded-full mr-2 ${
                                  contact.presence === 'available' ? 'bg-status-connected' :
                                  contact.presence === 'away' ? 'bg-status-connecting' :
                                  contact.presence === 'dnd' ? 'bg-status-error' :
                                  'bg-status-disconnected'
                                }`} />
                                <span className="text-xs text-muted-foreground capitalize">
                                  {contact.presence}
                                </span>
                              </div>
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
            </div>
            <Select value={sortMode} onValueChange={(value: 'newest' | 'a-z' | 'z-a') => setSortMode(value)}>
              <SelectTrigger className="w-28">
                <ArrowUpDown className="h-4 w-4 mr-1" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="newest">Newest</SelectItem>
                <SelectItem value="a-z">A–Z</SelectItem>
                <SelectItem value="z-a">Z–A</SelectItem>
              </SelectContent>
            </Select>
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
        
        <ScrollArea className="flex-1 min-h-0">
          {sortedConversations.length === 0 && searchTerm === '' ? (
            <div className="p-8 text-center text-muted-foreground">
              <Users className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p className="text-lg font-medium mb-2">No Conversations</p>
              <p className="text-sm mb-4">
                {connectionState === 'connected' 
                  ? 'Start a new chat to begin messaging'
                  : 'Conversations will appear here when connected'
                }
              </p>
            </div>
          ) : sortedConversations.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">
              <Search className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p className="text-lg font-medium mb-2">No Results</p>
              <p className="text-sm">No conversations match your search</p>
            </div>
          ) : (
            sortedConversations.map((conversation) => {
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
      <div className="flex-1 flex flex-col min-h-0">
        {selectedConv ? (
          <>
            {/* Header */}
            <div className="flex-shrink-0 p-4 border-b border-border">
              <div className="flex items-center gap-3">
                <Avatar className="h-10 w-10">
                  <AvatarFallback>{getInitials(selectedConv.name)}</AvatarFallback>
                </Avatar>
                <div className="flex-1">
                  <h2 className="font-medium">{selectedConv.name}</h2>
                  <div className="flex items-center gap-2">
                    <p className="text-sm text-muted-foreground">{selectedConv.jid}</p>
                    {/* Contact presence indicator */}
                    {(() => {
                      const contact = contacts.find(c => c.jid === selectedConv.jid);
                      if (contact) {
                        return (
                          <div className="flex items-center gap-1">
                            <div className={`w-2 h-2 rounded-full ${
                              contact.presence === 'available' ? 'bg-status-connected' :
                              contact.presence === 'away' ? 'bg-status-connecting' :
                              contact.presence === 'dnd' ? 'bg-status-error' :
                              'bg-status-disconnected'
                            }`} />
                            <span className="text-xs text-muted-foreground capitalize">
                              {contact.presence}
                            </span>
                          </div>
                        );
                      }
                      return null;
                    })()}
                  </div>
                </div>
              </div>
            </div>

            {/* Messages - Scrollable Area */}
            <div className="flex-1 min-h-0 overflow-hidden">
              <ScrollArea className="h-full">
                <div className="p-4 pb-6">
                  {selectedConv.messages.length === 0 ? (
                    <div className="flex items-center justify-center h-full text-muted-foreground min-h-[400px]">
                      <div className="text-center">
                        <Users className="h-12 w-12 mx-auto mb-4 opacity-50" />
                        <p className="text-lg font-medium mb-2">Start a conversation</p>
                        <p className="text-sm mb-4">Send a message to begin chatting with {selectedConv.name}</p>
                        {connectionState === 'connected' && selectedConv.hasMoreHistory !== false && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleLoadHistory(selectedConv.jid)}
                            disabled={loadingHistory === selectedConv.jid}
                            className="mb-4"
                          >
                            {loadingHistory === selectedConv.jid ? 'Loading...' : 'Load message history'}
                          </Button>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {connectionState === 'connected' && selectedConv.hasMoreHistory !== false && (
                        <div className="text-center">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleLoadHistory(selectedConv.jid)}
                            disabled={loadingHistory === selectedConv.jid}
                          >
                            {loadingHistory === selectedConv.jid ? 'Loading...' : 'Load earlier messages'}
                          </Button>
                        </div>
                      )}
                      
                      {insertDateSeparators(selectedConv.messages).map((item) => {
                        if ('type' in item && item.type === 'date-separator') {
                          return <DateSeparator key={item.id} date={item.date} />;
                        }

                        const message = item as any; // Type assertion for message properties
                        const myBareJid = `${settings.xmpp.username}@${settings.xmpp.domain}`;
                        const isSent = message.from.split('/')[0] === myBareJid;
                        
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
                              title={formatFullDateTime(message.timestamp)}
                            >
                              <MessageBodyRenderer 
                                body={message.body}
                                className={isSent ? 'text-primary-foreground' : 'text-foreground'}
                              />
                              <div className={`flex items-center justify-end gap-1 mt-1 ${
                                isSent ? 'text-primary-foreground/70' : 'text-muted-foreground'
                              }`}>
                                {isSent && settings.chat?.showDeliveryStatus ? (
                                  <MessageStatus 
                                    status={message.status} 
                                    timestamp={message.timestamp}
                                    className={isSent ? 'text-primary-foreground/70' : 'text-muted-foreground'}
                                  />
                                ) : (
                                  <span className="text-xs">
                                    {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                  </span>
                                )}
                                {message.isFromArchive && (
                                  <span className="text-xs opacity-60">(archived)</span>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </ScrollArea>
            </div>

            {/* Message Composer */}
            <MessageComposer
              value={newMessage}
              onChange={setNewMessage}
              onSend={handleSendMessage}
              onDictationToggle={isSupported && settings.dictation.enabled ? toggleDictation : undefined}
              isListening={isListening}
              isDictationEnabled={isSupported && settings.dictation.enabled}
              disabled={connectionState !== 'connected'}
              interimTranscript={interimTranscript}
              placeholder="Type a message..."
            />
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center">
              <Users className="h-16 w-16 mx-auto mb-4 opacity-30" />
              <h2 className="text-xl font-medium mb-2">Select a conversation</h2>
              <p className="text-sm">Choose a conversation from the list to start messaging</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};