import { Search, Users, BookUser, ArrowUpDown, Crown, VolumeX, Archive, Trash2, MoreVertical, AlertTriangle, MessageSquare, RefreshCw, Plus, Ban, ShieldOff, Reply } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useState, useEffect, useMemo, useCallback } from 'react';
import { useXmpp } from '@/contexts/XmppContext';
import { MessageComposer } from './MessageComposer';
import { MessageBodyRenderer } from './MessageBodyRenderer';
import { MessageStatus } from './MessageStatus';
import { DateSeparator } from './DateSeparator';
import { PhonebookDialog } from './PhonebookDialog';
import { CreateRoomDialog } from './CreateRoomDialog';
import { insertDateSeparators } from '@/lib/dateUtils';
import { jid as xmppJid } from '@xmpp/client';
import { JidUtils } from '@/xmpp/core/jid';
import { XmppMessage } from '@/types/xmpp';

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
  const [isCreateRoomOpen, setIsCreateRoomOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [showMucDialog, setShowMucDialog] = useState(false);
  const [pendingMucJid, setPendingMucJid] = useState('');
  const [isRefreshingRooms, setIsRefreshingRooms] = useState(false);
  const [replyTo, setReplyTo] = useState<{ id: string; from: string; body: string } | null>(null);

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
    nickname,
    refreshRooms,
    destroyRoom,
    leaveRoom,
    blockContact,
    unblockContact,
    isBlocked,
    uploadFile
  } = useXmpp();

  // Memoized computation for unified items
  const unifiedItems: UnifiedItem[] = useMemo(() => {
    const directItems: UnifiedItem[] = conversations.map(conv => ({
      kind: 'direct' as const,
      jid: conv.jid,
      name: conv.name,
      lastActivity: conv.lastActivity,
      unreadCount: conv.unreadCount,
      lastMessage: conv.messages.length > 0 ? conv.messages[conv.messages.length - 1].body : 'No messages',
      archived: conv.archived
    }));

    const roomItems: UnifiedItem[] = rooms.map(room => ({
      kind: 'room' as const,
      jid: room.jid,
      name: room.name,
      lastActivity: room.lastActivity,
      unreadCount: room.unreadCount,
      lastMessage: room.messages.length > 0 ? room.messages[room.messages.length - 1].body : 'No messages',
      isOwner: room.isOwner,
      isMuted: room.isMuted,
      archived: room.archived
    }));

    return [...directItems, ...roomItems];
  }, [conversations, rooms]);

  // Memoized filtering and sorting for performance
  const filteredItems = useMemo(() => {
    return unifiedItems.filter((item) => {
      const name = item.name || '';
      const jid = item.jid || '';
      const matchesSearch = name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                           jid.includes(searchTerm);
      const archiveMatch = showArchived ? item.archived : !item.archived;
      return matchesSearch && archiveMatch;
    });
  }, [unifiedItems, searchTerm, showArchived]);

  const sortedItems = useMemo(() => {
    return [...filteredItems].sort((a, b) => {
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
  }, [filteredItems, sortMode]);

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

  const handleSendMessage = useCallback(async () => {
    if (!newMessage.trim() || !selectedItem) return;

    // Check if trying to send a direct message to a MUC JID
    if (selectedItem.kind === 'direct' && selectedItem.jid && JidUtils.isMucJid(selectedItem.jid)) {
      // This is actually a MUC room - offer to join it instead
      setPendingMucJid(selectedItem.jid);
      setShowMucDialog(true);
      return;
    }

    const messageText = newMessage.trim();
    const replyData = replyTo ? { id: replyTo.id, to: replyTo.from } : undefined;
    
    setNewMessage(''); // Clear input immediately for better UX
    setReplyTo(null); // Clear reply

    const success = selectedItem.kind === 'direct'
      ? await sendMessage(selectedItem.jid, messageText, replyData)
      : await sendRoomMessage(selectedItem.jid, messageText, replyData);

    // Note: We don't revert the cleared message on failure for better UX
    // The message will appear in the chat with error status if it fails
  }, [newMessage, selectedItem, sendMessage, sendRoomMessage, replyTo]);

  const handleReply = useCallback((message: XmppMessage) => {
    setReplyTo({
      id: message.id,
      from: message.from,
      body: message.body
    });
  }, []);

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

  const handleDeleteItem = async (item: UnifiedItem) => {
    if (item.kind === 'direct') {
      removeConversation(item.jid);
    } else {
      // For rooms: destroy if owner, otherwise leave
      if (item.isOwner) {
        await destroyRoom(item.jid, 'Room deleted by owner');
      } else {
        leaveRoom(item.jid);
      }
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
    if (!name) return '?';
    return name.split(' ').map(n => n?.[0] || '').join('').toUpperCase() || '?';
  };

  const handleJoinRoom = async () => {
    if (!pendingMucJid) return;
    
    try {
      await joinRoom(pendingMucJid, nickname?.trim() || 'User');
      setSelectedItem({ kind: 'room', jid: pendingMucJid });
      setShowMucDialog(false);
      setPendingMucJid('');
    } catch (error) {
      console.error('Failed to join room:', error);
    }
  };

  const handleRefreshRooms = async () => {
    if (isRefreshingRooms || !refreshRooms) return;
    
    setIsRefreshingRooms(true);
    try {
      await refreshRooms();
    } catch (error) {
      console.error('Failed to refresh rooms:', error);
    } finally {
      setIsRefreshingRooms(false);
    }
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
    const contactBlocked = isDirectChat && isBlocked(data.jid);

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
                {contactBlocked && (
                  <Badge variant="destructive" className="text-xs">
                    <Ban className="h-3 w-3 mr-1" />
                    Blocked
                  </Badge>
                )}
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
                {isDirectChat && contact && !contactBlocked && (
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
            
            {/* Actions Menu */}
            {isDirectChat && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {contactBlocked ? (
                    <DropdownMenuItem onClick={() => unblockContact(data.jid)}>
                      <ShieldOff className="h-4 w-4 mr-2" />
                      Unblock Contact
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem 
                      onClick={() => blockContact(data.jid)}
                      className="text-destructive focus:text-destructive"
                    >
                      <Ban className="h-4 w-4 mr-2" />
                      Block Contact
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 min-h-0 overflow-hidden">
          <ScrollArea className="h-full">
            <div className="p-4 pb-6">
              {data.messages.length === 0 ? (
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
                  
                  {insertDateSeparators(data.messages).map((item, index) => {
                    if ('type' in item && item.type === 'date-separator') {
                      return <DateSeparator key={item.id} date={item.date} />;
                    }

                    // TypeScript assertion - we know this is a message after the date separator check
                    const message = item as XmppMessage;
                    
                    // Null safety for message.from
                    const messageFrom = message?.from || '';
                    const isOwn = isDirectChat 
                      ? messageFrom && xmppJid(messageFrom).bare().toString() !== selectedConversation?.jid 
                      : messageFrom && selectedRoom?.nick && messageFrom.includes(`/${selectedRoom.nick}`);

                    // Find the replied-to message if this is a reply
                    const repliedMessage = message.replyTo 
                      ? data.messages.find(m => m.id === message.replyTo?.id || m.originId === message.replyTo?.id)
                      : null;

                    return (
                      <div
                        key={message.id || `msg-${index}`}
                        className={`group flex ${isOwn ? 'justify-end' : 'justify-start'}`}
                      >
                        <div className="max-w-[70%]">
                          {/* Reply Preview */}
                          {repliedMessage && (
                            <div className={`text-xs mb-1 px-2 py-1 rounded border-l-2 border-primary/50 bg-muted/30 ${isOwn ? 'ml-auto' : ''}`}>
                              <span className="font-medium text-primary/70">
                                {repliedMessage.from.includes('/') 
                                  ? repliedMessage.from.split('/')[1] 
                                  : repliedMessage.from.split('@')[0]}
                              </span>
                              <p className="text-muted-foreground truncate max-w-[200px]">
                                {repliedMessage.body.length > 50 
                                  ? repliedMessage.body.substring(0, 50) + '...' 
                                  : repliedMessage.body}
                              </p>
                            </div>
                          )}
                          {message.replyTo && !repliedMessage && (
                            <div className={`text-xs mb-1 px-2 py-1 rounded border-l-2 border-muted bg-muted/20 ${isOwn ? 'ml-auto' : ''}`}>
                              <span className="text-muted-foreground italic">Reply to message</span>
                            </div>
                          )}
                          
                          <div className="flex items-start gap-1">
                            {/* Reply button - shown on hover for incoming messages */}
                            {!isOwn && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleReply(message)}
                                className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 mt-1"
                              >
                                <Reply className="h-3 w-3" />
                              </Button>
                            )}
                            
                            <div
                              className={`rounded-lg px-3 py-2 ${
                                isOwn
                                  ? 'bg-primary text-primary-foreground'
                                  : 'bg-muted text-foreground'
                              }`}
                            >
                              {!isDirectChat && !isOwn && messageFrom && (
                                <p className="text-xs font-medium mb-1 opacity-70">
                                  {messageFrom?.includes('/') ? messageFrom.split('/')[1] : 'Unknown'}
                                </p>
                              )}
                              <MessageBodyRenderer body={message.body || ''} />
                            </div>
                            
                            {/* Reply button - shown on hover for own messages */}
                            {isOwn && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleReply(message)}
                                className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 mt-1"
                              >
                                <Reply className="h-3 w-3" />
                              </Button>
                            )}
                          </div>
                          
                          <div className={`flex items-center gap-1 mt-1 text-xs text-muted-foreground ${
                            isOwn ? 'justify-end' : 'justify-start'
                          }`}>
                            <span>{message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                            {isDirectChat && isOwn && (
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

        {/* Typing Indicator */}
        {isDirectChat && selectedConversation?.isTyping && (
          <div className="flex-shrink-0 px-4 py-2 border-t border-border bg-muted/30">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="flex gap-0.5">
                <span className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </span>
              <span>{data.name} is typing...</span>
            </div>
          </div>
        )}

        {/* Message Composer */}
        <div className="flex-shrink-0 p-4 border-t border-border">
          {contactBlocked ? (
            <div className="text-center py-3 text-muted-foreground">
              <Ban className="h-5 w-5 mx-auto mb-2" />
              <p className="text-sm">You have blocked this contact</p>
              <Button variant="link" size="sm" onClick={() => unblockContact(data.jid)}>
                Unblock to send messages
              </Button>
            </div>
          ) : (
            <MessageComposer
              value={newMessage}
              onChange={setNewMessage}
              onSend={handleSendMessage}
              onFileUpload={uploadFile}
              disabled={uiConnection !== 'connected'}
              placeholder={isDirectChat ? `Message ${data.name}...` : `Message ${data.name}...`}
              replyTo={replyTo}
              onCancelReply={() => setReplyTo(null)}
            />
          )}
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
            <TooltipProvider>
              <div className="flex items-center gap-2">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setIsPhonebookOpen(true)}
                      disabled={uiConnection !== 'connected'}
                    >
                      <BookUser className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Phonebook</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setIsCreateRoomOpen(true)}
                      disabled={uiConnection !== 'connected'}
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Create Room</TooltipContent>
                </Tooltip>
              </div>
              
              <div className="flex items-center gap-2">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleRefreshRooms}
                      disabled={uiConnection !== 'connected' || isRefreshingRooms}
                    >
                      <RefreshCw className={`h-4 w-4 ${isRefreshingRooms ? 'animate-spin' : ''}`} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Refresh Rooms</TooltipContent>
                </Tooltip>
                
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      variant={showArchived ? "default" : "outline"}
                      onClick={() => setShowArchived(!showArchived)}
                    >
                      <Archive className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{showArchived ? 'Hide' : 'Show'} Archived</TooltipContent>
                </Tooltip>
              </div>
            </TooltipProvider>
            
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
              const timestamp = item.lastActivity.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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

      <CreateRoomDialog
        open={isCreateRoomOpen}
        onOpenChange={setIsCreateRoomOpen}
      />

      <AlertDialog open={showMucDialog} onOpenChange={setShowMucDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Join Chat Room</AlertDialogTitle>
            <AlertDialogDescription>
              This appears to be a chat room. Would you like to join "{pendingMucJid}" as a room instead?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingMucJid('')}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleJoinRoom}>
              Join Room
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};