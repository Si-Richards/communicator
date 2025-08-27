import { Search, Users, BookUser, ArrowUpDown, Crown, VolumeX, Archive, Trash2, MoreVertical, AlertTriangle, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { useState, useEffect, useMemo } from 'react';
import { useXmpp } from '@/contexts/XmppContext';
import { MessageComposer } from './MessageComposer';
import { MessageBodyRenderer } from './MessageBodyRenderer';
import { MessageStatus } from './MessageStatus';
import { DateSeparator } from './DateSeparator';
import { PhonebookDialog } from './PhonebookDialog';
import { insertDateSeparators } from '@/lib/dateUtils';
import { jid as xmppJid } from '@xmpp/client';

interface UnifiedItem {
  kind: 'direct' | 'room';
  jid: string;
  name: string;
  lastActivity: Date;
  unreadCount: number;
  lastMessage?: string;
  isOwner?: boolean;
  isMuted?: boolean;
  archived?: boolean;
}

export const UnifiedChatView = () => {
  const [selectedItem, setSelectedItem] = useState<{ kind: 'direct' | 'room'; jid: string } | null>(null);
  const [newMessage, setNewMessage] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [loadingHistory, setLoadingHistory] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<'newest' | 'a-z' | 'z-a'>('newest');
  const [isPhonebookOpen, setIsPhonebookOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const { 
    uiConnection,
    conversations, 
    rooms,
    contacts,
    sendMessage,
    sendRoomMessage,
    loadConversationHistory,
    loadRoomHistory,
    markConversationRead,
    markRoomRead,
    startConversation,
    archiveConversation,
    archiveRoom,
    removeConversation,
    removeRoom,
    joinRoom,
    nickname
  } = useXmpp();

  // Merge conversations and rooms into unified list
  const unifiedItems: UnifiedItem[] = useMemo(() => {
    const directItems: UnifiedItem[] = conversations.map(conv => ({
      kind: 'direct' as const,
      jid: conv.jid || '',
      name: conv.name || conv.jid?.split('@')[0] || 'Unknown',
      lastActivity: conv.lastActivity || new Date(0),
      unreadCount: conv.unreadCount || 0,
      lastMessage: conv.messages && conv.messages.length > 0 ? conv.messages[conv.messages.length - 1].body : 'No messages',
      archived: conv.archived || false
    }));

    const roomItems: UnifiedItem[] = rooms.map(room => ({
      kind: 'room' as const,
      jid: room.jid || '',
      name: room.name || room.jid?.split('@')[0] || 'Unknown Room',
      lastActivity: room.lastActivity || new Date(0),
      unreadCount: room.unreadCount || 0,
      lastMessage: room.messages && room.messages.length > 0 ? room.messages[room.messages.length - 1].body : 'No messages',
      isOwner: room.isOwner || false,
      isMuted: room.isMuted || false,
      archived: room.archived || false
    }));

    return [...directItems, ...roomItems];
  }, [conversations, rooms]);

  // Filter and sort unified items (including archive toggle)
  const filteredItems = unifiedItems.filter((item) => {
    const searchLower = searchTerm.toLowerCase();
    const itemName = item.name || '';
    const itemJid = item.jid || '';
    const matchesSearch = itemName.toLowerCase().includes(searchLower) ||
                         itemJid.toLowerCase().includes(searchLower);
    const archiveMatch = showArchived ? item.archived : !item.archived;
    return matchesSearch && archiveMatch;
  });

  const sortedItems = [...filteredItems].sort((a, b) => {
    switch (sortMode) {
      case 'newest':
        return (b.lastActivity?.getTime() || 0) - (a.lastActivity?.getTime() || 0);
      case 'a-z':
        return (a.name || '').localeCompare(b.name || '');
      case 'z-a':
        return (b.name || '').localeCompare(a.name || '');
      default:
        return 0;
    }
  });

  // Get selected item data
  const selectedConversation = selectedItem?.kind === 'direct' 
    ? conversations.find(conv => conv.jid === selectedItem.jid)
    : null;
  
  const selectedRoom = selectedItem?.kind === 'room'
    ? rooms.find(room => room.jid === selectedItem.jid)
    : null;

  // Mark as read when selecting an item
  useEffect(() => {
    if (selectedItem) {
      if (selectedItem.kind === 'direct' && selectedConversation?.unreadCount > 0) {
        markConversationRead(selectedItem.jid);
      } else if (selectedItem.kind === 'room' && selectedRoom?.unreadCount > 0) {
        markRoomRead(selectedItem.jid);
      }
    }
  }, [selectedItem, selectedConversation?.unreadCount, selectedRoom?.unreadCount, markConversationRead, markRoomRead]);

  const handleSendMessage = async () => {
    if (!newMessage.trim() || !selectedItem) return;

    // Check if trying to send a direct message to a MUC JID
    if (selectedItem.kind === 'direct') {
      const domain = selectedItem.jid.split('@')[1];
      const isMucDomain = domain && (domain.includes('conference.') || 
                                   domain.includes('muc.') || 
                                   domain.includes('rooms.'));
      
      if (isMucDomain) {
        // This is actually a MUC room - offer to join it instead
        if (confirm(`This appears to be a chat room. Would you like to join "${selectedItem.jid}" as a room instead?`)) {
          try {
            await joinRoom(selectedItem.jid, nickname.trim());
            setSelectedItem({ kind: 'room', jid: selectedItem.jid });
            return;
          } catch (error) {
            console.error('Failed to join room:', error);
            return;
          }
        }
        return;
      }
    }

    const success = selectedItem.kind === 'direct'
      ? await sendMessage(selectedItem.jid, newMessage.trim())
      : await sendRoomMessage(selectedItem.jid, newMessage.trim());

    if (success) {
      setNewMessage('');
    }
  };

  const handleLoadHistory = async (jid: string, kind: 'direct' | 'room') => {
    if (loadingHistory === jid) return;
    
    setLoadingHistory(jid);
    try {
      if (kind === 'direct') {
        await loadConversationHistory(jid);
      } else {
        await loadRoomHistory(jid);
      }
    } catch (error) {
      console.error('Failed to load history:', error);
    } finally {
      setLoadingHistory(null);
    }
  };

  const handleSelectFromPhonebook = (jid: string, kind: 'direct' | 'room') => {
    if (kind === 'direct') {
      startConversation(jid);
    }
    setSelectedItem({ kind, jid });
    setIsPhonebookOpen(false);
  };

  const handleArchiveItem = (item: UnifiedItem) => {
    if (item.kind === 'direct') {
      archiveConversation(item.jid);
    } else {
      archiveRoom(item.jid);
    }
    // If the archived item was selected, clear selection
    if (selectedItem?.jid === item.jid) {
      setSelectedItem(null);
    }
  };

  const handleDeleteItem = (item: UnifiedItem) => {
    if (item.kind === 'direct') {
      removeConversation(item.jid);
    } else {
      removeRoom(item.jid);
    }
    // If the deleted item was selected, clear selection
    if (selectedItem?.jid === item.jid) {
      setSelectedItem(null);
    }
  };

  const handleUnarchiveItem = (item: UnifiedItem) => {
    if (item.kind === 'direct') {
      archiveConversation(item.jid, false);
    } else {
      archiveRoom(item.jid, false);
    }
  };

  const getInitials = (name: string) => {
    const safeName = name || 'Unknown';
    return safeName.split(' ').map(n => n[0] || '').join('').toUpperCase() || 'U';
  };

  const renderMessageThread = () => {
    if (!selectedItem) {
      return (
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          <div className="text-center">
            <Users className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p className="text-lg font-medium mb-2">Welcome to Messages</p>
            <p className="text-sm mb-4">Select a conversation or room to start messaging</p>
            <Button
              variant="outline"
              onClick={() => setIsPhonebookOpen(true)}
              disabled={uiConnection !== 'connected'}
            >
              <BookUser className="h-4 w-4 mr-2" />
              Open Phonebook
            </Button>
          </div>
        </div>
      );
    }

    const isDirectChat = selectedItem.kind === 'direct';
    const data = isDirectChat ? selectedConversation : selectedRoom;
    
    if (!data) {
      return (
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          <div className="text-center">
            <p className="text-lg font-medium">Loading...</p>
          </div>
        </div>
      );
    }

    const contact = isDirectChat ? contacts.find(c => c.jid === data.jid) : null;

    return (
      <>
        {/* Header */}
        <div className="flex-shrink-0 p-4 border-b border-border">
          <div className="flex items-center gap-3">
            <Avatar className="h-10 w-10">
              <AvatarFallback>{getInitials(data.name)}</AvatarFallback>
            </Avatar>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <h2 className="font-medium">{data.name}</h2>
                {!isDirectChat && (
                  <>
                    <Users className="h-4 w-4 text-muted-foreground" />
                    {selectedRoom?.isOwner && <Crown className="h-3 w-3 text-yellow-500" />}
                    {selectedRoom?.isMuted && <VolumeX className="h-3 w-3 text-muted-foreground" />}
                  </>
                )}
              </div>
              <div className="flex items-center gap-2">
                <p className="text-sm text-muted-foreground">{data.jid}</p>
                {isDirectChat && contact && (
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
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 min-h-0 overflow-hidden">
          <ScrollArea className="h-full">
            <div className="p-4 pb-6">
              {!data.messages || data.messages.length === 0 ? (
                <div className="flex items-center justify-center h-full text-muted-foreground min-h-[400px]">
                  <div className="text-center">
                    <Users className="h-12 w-12 mx-auto mb-4 opacity-50" />
                    <p className="text-lg font-medium mb-2">
                      {isDirectChat ? 'Start a conversation' : 'Room is quiet'}
                    </p>
                    <p className="text-sm mb-4">
                      {isDirectChat 
                        ? `Send a message to begin chatting with ${data.name}`
                        : `Be the first to send a message in ${data.name}`
                      }
                    </p>
                    {uiConnection === 'connected' && data.hasMoreHistory !== false && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleLoadHistory(data.jid, selectedItem.kind)}
                        disabled={loadingHistory === data.jid}
                        className="mb-4"
                      >
                        {loadingHistory === data.jid ? 'Loading...' : 'Load message history'}
                      </Button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  {uiConnection === 'connected' && data.hasMoreHistory !== false && (
                    <div className="text-center">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleLoadHistory(data.jid, selectedItem.kind)}
                        disabled={loadingHistory === data.jid}
                      >
                        {loadingHistory === data.jid ? 'Loading...' : 'Load earlier messages'}
                      </Button>
                    </div>
                  )}
                  
                  {insertDateSeparators(data.messages || []).map((item, index) => {
                    if ('type' in item && item.type === 'date-separator') {
                      return <DateSeparator key={item.id} date={item.date} />;
                    }

                    // TypeScript assertion - we know this is a message after the date separator check
                    const message = item as any; // Using any to avoid complex type intersection issues
                    const isOwn = isDirectChat 
                      ? xmppJid(message.from).bare().toString() !== selectedConversation?.jid 
                      : message.from.includes(`/${selectedRoom?.nick}`);

                    return (
                      <div
                        key={message.id || `msg-${index}`}
                        className={`flex ${isOwn ? 'justify-start' : 'justify-end'}`}
                      >
                        <div className={`max-w-[70%] ${isOwn ? 'order-1' : 'order-2'}`}>
                          <div
                            className={`rounded-lg px-3 py-2 ${
                              isOwn
                                ? 'bg-muted text-foreground'
                                : 'bg-primary text-primary-foreground'
                            }`}
                          >
                            {!isDirectChat && isOwn && (
                              <p className="text-xs font-medium mb-1 opacity-70">
                                {message.from.split('/')[1] || 'Unknown'}
                              </p>
                            )}
                            <MessageBodyRenderer body={message.body} />
                          </div>
                          <div className={`flex items-center gap-1 mt-1 text-xs text-muted-foreground ${
                            isOwn ? 'justify-start' : 'justify-end'
                          }`}>
                            <span>{message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                            {isDirectChat && !isOwn && (
                              <MessageStatus status={message.status} timestamp={message.timestamp} />
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
        <div className="flex-shrink-0 p-4 border-t border-border">
          <MessageComposer
            value={newMessage}
            onChange={setNewMessage}
            onSend={handleSendMessage}
            disabled={uiConnection !== 'connected'}
            placeholder={isDirectChat ? `Message ${data.name}...` : `Message ${data.name}...`}
          />
        </div>
      </>
    );
  };

  return (
    <div className="h-full flex overflow-hidden">
      {/* Items List */}
      <div className="w-1/3 border-r border-border flex flex-col min-h-0">
        <div className="p-4 border-b border-border flex-shrink-0">
          <div className="flex items-center justify-between mb-4">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setIsPhonebookOpen(true)}
              disabled={uiConnection !== 'connected'}
            >
              <BookUser className="h-4 w-4 mr-1" />
              Phonebook
            </Button>
            
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant={showArchived ? "default" : "outline"}
                onClick={() => setShowArchived(!showArchived)}
              >
                <Archive className="h-4 w-4 mr-1" />
                {showArchived ? 'Hide' : 'Show'} Archived
              </Button>
              
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
          </div>
          
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search messages..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10"
            />
          </div>
        </div>
        
        <ScrollArea className="flex-1 min-h-0">
          {sortedItems.length === 0 && searchTerm === '' ? (
            <div className="p-8 text-center text-muted-foreground">
              <Users className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p className="text-lg font-medium mb-2">No Messages</p>
              <p className="text-sm mb-4">
                {uiConnection === 'connected' 
                  ? 'Use the Phonebook to start chatting'
                  : 'Messages will appear here when connected'
                }
              </p>
            </div>
          ) : sortedItems.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">
              <Search className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p className="text-lg font-medium mb-2">No Results</p>
              <p className="text-sm">No messages match your search</p>
            </div>
          ) : (
            sortedItems.map((item) => {
              const timestamp = item.lastActivity?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) || '';
              const isSelected = selectedItem?.jid === item.jid && selectedItem?.kind === item.kind;
              
              return (
                 <div
                  key={`${item.kind}-${item.jid}`}
                  className={`group relative p-4 border-b border-border cursor-pointer hover:bg-muted/50 ${
                    isSelected ? 'bg-muted' : ''
                  }`}
                >
                  <div 
                    className="flex items-center gap-3"
                    onClick={() => setSelectedItem({ kind: item.kind, jid: item.jid })}
                  >
                    <Avatar className="h-10 w-10">
                      <AvatarFallback>{getInitials(item.name)}</AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <h3 className="font-medium truncate">{item.name}</h3>
                          {item.kind === 'room' && <Users className="h-3 w-3 text-muted-foreground" />}
                          {item.isOwner && <Crown className="h-3 w-3 text-yellow-500" />}
                          {item.isMuted && <VolumeX className="h-3 w-3 text-muted-foreground" />}
                          {item.archived && <Archive className="h-3 w-3 text-muted-foreground" />}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground">{timestamp}</span>
                          {item.unreadCount > 0 && (
                            <Badge variant="default" className="text-xs">
                              {item.unreadCount}
                            </Badge>
                          )}
                        </div>
                      </div>
                      <p className="text-sm text-muted-foreground truncate">{item.lastMessage}</p>
                    </div>
                  </div>
                  
                  {/* Actions menu */}
                  <div className="absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="sm" variant="ghost" className="h-8 w-8 p-0">
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {item.archived ? (
                          <DropdownMenuItem onClick={() => handleUnarchiveItem(item)}>
                            <MessageSquare className="h-4 w-4 mr-2" />
                            Unarchive
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem onClick={() => handleArchiveItem(item)}>
                            <Archive className="h-4 w-4 mr-2" />
                            Archive
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                              <Trash2 className="h-4 w-4 mr-2" />
                              Delete
                            </DropdownMenuItem>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Delete {item.kind === 'direct' ? 'Conversation' : 'Room'}?</AlertDialogTitle>
                              <AlertDialogDescription>
                                This will permanently delete "{item.name}" and all its messages. This action cannot be undone.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction onClick={() => handleDeleteItem(item)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                                Delete
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              );
            })
          )}
        </ScrollArea>
      </div>

      {/* Message View */}
      <div className="flex-1 flex flex-col min-h-0">
        {renderMessageThread()}
      </div>

      <PhonebookDialog
        open={isPhonebookOpen}
        onOpenChange={setIsPhonebookOpen}
        onSelect={handleSelectFromPhonebook}
      />
    </div>
  );
};