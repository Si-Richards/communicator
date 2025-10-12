/**
 * Optimized Chat View Component
 * Replacement for UnifiedChatView with improved performance
 */

import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { 
  Search, ArrowUpDown, Archive, Trash2, MoreVertical, 
  Phone, Video, MessageSquare, Users, BookUser, Plus, Settings, LogOut, Crown
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDistanceToNow } from 'date-fns';
import { VirtualizedMessageList } from './VirtualizedMessageList';
import { MessageComposer } from './MessageComposer';
import { PhonebookDialog } from './PhonebookDialog';
import { CreateRoomDialog } from './CreateRoomDialog';
import { RoomSettingsDialog } from './RoomSettingsDialog';
import { MessageContextMenu } from './MessageContextMenu';
import { useChatCore } from '@/hooks/useChatCore';
import { useXmpp } from '@/contexts/XmppContext';
import { useChatMessages } from '@/hooks/useChatCore';
import { useMuc } from '@/hooks/useMuc';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export const OptimizedChatView = () => {
  // Chat core state
  const {
    filteredItems,
    selectedItem,
    searchTerm,
    sortBy,
    showArchived,
    selectItem,
    setSearchTerm,
    setSortBy,
    setShowArchived,
    archiveItem,
    unarchiveItem,
    deleteItem,
    markAsRead,
  } = useChatCore();

  // XMPP hooks
  const { sendMessage, sendRoomMessage, connectionState } = useXmpp();
  const { toast } = useToast();
  
  // MUC Management
  const {
    createRoom,
    joinRoom,
    leaveRoom,
    destroyRoom,
    configureRoom,
    changeSubject,
    getRoom,
    isOwner,
    isModerator,
  } = useMuc();

  // Local UI state
  const [isPhonebookOpen, setIsPhonebookOpen] = useState(false);
  const [showCreateRoomDialog, setShowCreateRoomDialog] = useState(false);
  const [showRoomSettingsDialog, setShowRoomSettingsDialog] = useState(false);
  const [selectedRoomForSettings, setSelectedRoomForSettings] = useState<any>(null);
  const [deleteDialog, setDeleteDialog] = useState<{ open: boolean; item: typeof filteredItems[0] | null }>({
    open: false,
    item: null
  });
  const [joinRoomDialog, setJoinRoomDialog] = useState<{ open: boolean; jid: string }>({
    open: false,
    jid: ''
  });

  const { addMessage, loadHistory } = useChatMessages();

  const handleSendMessage = useCallback(async (message: string) => {
    if (!selectedItem || !message.trim()) return;

    try {
      if (selectedItem.type === 'room') {
        await sendRoomMessage(selectedItem.jid, message);
      } else {
        await sendMessage(selectedItem.jid, message);
      }
    } catch (error) {
      console.error('Failed to send message:', error);
    }
  }, [selectedItem, sendMessage, sendRoomMessage]);

  // Room management handlers
  const handleCreateRoom = useCallback(async (config: any) => {
    try {
      await createRoom(config.roomJid, 'User', config);
      toast({
        title: 'Room Created',
        description: `Successfully created ${config.name}`,
      });
    } catch (error: any) {
      toast({
        title: 'Failed to Create Room',
        description: error.message,
        variant: 'destructive',
      });
      throw error;
    }
  }, [createRoom, toast]);

  const handleLeaveRoom = useCallback(async (jid: string) => {
    try {
      await leaveRoom(jid);
      if (selectedItem?.jid === jid) {
        selectItem(null);
      }
      toast({
        title: 'Left Room',
        description: 'You have left the room',
      });
    } catch (error: any) {
      toast({
        title: 'Failed to Leave Room',
        description: error.message,
        variant: 'destructive',
      });
    }
  }, [leaveRoom, selectedItem, selectItem, toast]);

  const handleDestroyRoom = useCallback(async (jid: string) => {
    try {
      await destroyRoom(jid);
      if (selectedItem?.jid === jid) {
        selectItem(null);
      }
      toast({
        title: 'Room Destroyed',
        description: 'The room has been permanently deleted',
      });
    } catch (error: any) {
      toast({
        title: 'Failed to Destroy Room',
        description: error.message,
        variant: 'destructive',
      });
    }
  }, [destroyRoom, selectedItem, selectItem, toast]);

  const handleRoomSettings = useCallback((jid: string) => {
    const room = getRoom(jid);
    setSelectedRoomForSettings({
      ...room,
      isOwner: isOwner(jid),
      isModerator: isModerator(jid),
    });
    setShowRoomSettingsDialog(true);
  }, [getRoom, isOwner, isModerator]);

  // Message action handlers
  const handleDeleteMessage = useCallback((messageId: string) => {
    // Local delete - hide from UI
    console.log('Delete message locally:', messageId);
    toast({
      title: 'Message Deleted',
      description: 'Message removed from your view',
    });
  }, [toast]);

  const handleRetractMessage = useCallback((messageId: string) => {
    // Retract for everyone (XEP-0424)
    console.log('Retract message:', messageId);
    toast({
      title: 'Message Retracted',
      description: 'Message deleted for everyone',
    });
  }, [toast]);

  const handleCopyMessage = useCallback((messageBody: string) => {
    navigator.clipboard.writeText(messageBody);
    toast({
      title: 'Copied',
      description: 'Message copied to clipboard',
    });
  }, [toast]);

  const handleLoadHistory = useCallback(async (jid: string) => {
    await loadHistory(jid);
  }, [loadHistory]);

  useEffect(() => {
    if (selectedItem && selectedItem.unreadCount > 0) {
      markAsRead(selectedItem.jid);
    }
  }, [selectedItem, markAsRead]);

  const memoizedItemList = useMemo(() => (
    <div className="flex-1 overflow-auto">
      {filteredItems.map((item) => (
        <div
          key={item.id}
          className={cn(
            "flex items-center gap-3 p-3 hover:bg-muted/50 cursor-pointer border-l-2 transition-colors",
            selectedItem?.id === item.id ? "bg-muted border-l-primary" : "border-l-transparent"
          )}
          onClick={() => selectItem(item.jid)}
        >
          <Avatar className="h-10 w-10">
            <AvatarFallback>
              {item.name.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>

          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between">
              <h4 className="font-medium truncate">{item.name}</h4>
              {item.lastActivity && (
                <span className="text-xs text-muted-foreground">
                  {formatDistanceToNow(item.lastActivity, { addSuffix: true })}
                </span>
              )}
            </div>

            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground truncate">
                {item.lastMessage?.body || 'No messages'}
              </p>
              <div className="flex items-center gap-2">
                {item.unreadCount > 0 && (
                  <Badge variant="secondary" className="px-2 py-0 text-xs">
                    {item.unreadCount}
                  </Badge>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                      <MoreVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {item.type === 'room' && (
                      <>
                        {(isOwner(item.jid) || isModerator(item.jid)) && (
                          <DropdownMenuItem onClick={() => handleRoomSettings(item.jid)}>
                            <Settings className="h-4 w-4 mr-2" />
                            Room Settings
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem onClick={() => handleLeaveRoom(item.jid)}>
                          <LogOut className="h-4 w-4 mr-2" />
                          Leave Room
                        </DropdownMenuItem>
                        {isOwner(item.jid) && (
                          <DropdownMenuItem 
                            onClick={() => handleDestroyRoom(item.jid)}
                            className="text-destructive"
                          >
                            <Trash2 className="h-4 w-4 mr-2" />
                            Destroy Room
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                      </>
                    )}
                    {item.isArchived ? (
                      <DropdownMenuItem onClick={() => unarchiveItem(item.jid)}>
                        <Archive className="h-4 w-4 mr-2" />
                        Unarchive
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem onClick={() => archiveItem(item.jid)}>
                        <Archive className="h-4 w-4 mr-2" />
                        Archive
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem 
                      onClick={() => setDeleteDialog({ open: true, item })}
                      className="text-destructive"
                    >
                      <Trash2 className="h-4 w-4 mr-2" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  ), [filteredItems, selectedItem, selectItem, archiveItem, unarchiveItem, isOwner, isModerator, handleRoomSettings, handleLeaveRoom, handleDestroyRoom]);

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <div className="w-80 border-r flex flex-col">
        {/* Header */}
        <div className="p-4 border-b space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">Chats</h2>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowCreateRoomDialog(true)}
              >
                <Users className="h-4 w-4 mr-2" />
                Create Room
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIsPhonebookOpen(true)}
              >
                <BookUser className="h-4 w-4 mr-2" />
                Contacts
              </Button>
            </div>
          </div>

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search conversations..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-9"
            />
          </div>

          {/* Controls */}
          <div className="flex items-center justify-between">
            <Select value={sortBy} onValueChange={setSortBy}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="newest">Newest</SelectItem>
                <SelectItem value="a-z">A-Z</SelectItem>
                <SelectItem value="z-a">Z-A</SelectItem>
              </SelectContent>
            </Select>

            <Button
              variant={showArchived ? "default" : "outline"}
              size="sm"
              onClick={() => setShowArchived(!showArchived)}
            >
              <Archive className="h-4 w-4 mr-2" />
              {showArchived ? "Hide" : "Show"} Archived
            </Button>
          </div>
        </div>

        {/* Chat List */}
        {memoizedItemList}
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {selectedItem ? (
          <>
            {/* Fixed Chat Header */}
            <div className="flex-shrink-0 p-4 border-b border-border bg-background">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Avatar className="h-10 w-10">
                    <AvatarFallback>
                      {selectedItem.name.charAt(0).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="font-semibold">{selectedItem.name}</h2>
                      {selectedItem.type === 'room' && (
                        <>
                          <Users className="h-4 w-4 text-muted-foreground" />
                          {isOwner(selectedItem.jid) && <Crown className="h-3 w-3 text-yellow-500" />}
                        </>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground">{selectedItem.jid}</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Scrollable Messages Area */}
            <div className="flex-1 overflow-y-auto overflow-x-hidden">
              <VirtualizedMessageList
                messages={selectedItem.messages || []}
                height={600}
                currentUserJid={''}
                onLoadMore={() => handleLoadHistory(selectedItem.jid)}
                onDeleteMessage={handleDeleteMessage}
                onRetractMessage={handleRetractMessage}
                onCopyMessage={handleCopyMessage}
              />
            </div>

            {/* Sticky Message Composer */}
            <div className="flex-shrink-0">
              <MessageComposer
                value=""
                onChange={() => {}}
                onSend={() => {}}
                placeholder={`Message ${selectedItem.name}...`}
                disabled={connectionState !== 'connected'}
              />
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center">
              <MessageSquare className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p className="text-lg font-medium mb-2">No chat selected</p>
              <p className="text-sm">Select a conversation to start messaging</p>
            </div>
          </div>
        )}
      </div>

      {/* Phonebook Dialog */}
      <PhonebookDialog 
        open={isPhonebookOpen}
        onOpenChange={setIsPhonebookOpen}
        onSelect={(jid) => {
          selectItem(jid);
          setIsPhonebookOpen(false);
        }}
      />

      {/* Create Room Dialog */}
      <CreateRoomDialog
        open={showCreateRoomDialog}
        onOpenChange={setShowCreateRoomDialog}
        onCreateRoom={handleCreateRoom}
      />

      {/* Room Settings Dialog */}
      {selectedRoomForSettings && (
        <RoomSettingsDialog
          open={showRoomSettingsDialog}
          onOpenChange={setShowRoomSettingsDialog}
          room={selectedRoomForSettings}
          onUpdateRoom={async (config) => {
            try {
              await configureRoom(selectedRoomForSettings?.jid, config);
              toast({ title: 'Room Updated', description: 'Settings saved successfully' });
            } catch (error: any) {
              toast({ title: 'Update Failed', description: error.message, variant: 'destructive' });
            }
          }}
          onDestroyRoom={async (reason) => {
            await handleDestroyRoom(selectedRoomForSettings?.jid);
          }}
          onKickUser={async (nick, reason) => {
            console.log('Kick user:', nick, reason);
          }}
          onBanUser={async (jid, reason) => {
            console.log('Ban user:', jid, reason);
          }}
          onChangeSubject={async (subject) => {
            try {
              await changeSubject(selectedRoomForSettings?.jid, subject);
              toast({ title: 'Subject Changed', description: 'Room subject updated' });
            } catch (error: any) {
              toast({ title: 'Failed', description: error.message, variant: 'destructive' });
            }
          }}
          isOwner={selectedRoomForSettings?.isOwner || false}
          isModerator={selectedRoomForSettings?.isModerator || false}
        />
      )}

      {/* Delete Dialog */}
      <AlertDialog open={deleteDialog.open} onOpenChange={(open) => setDeleteDialog({ open, item: null })}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Conversation</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this conversation? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => {
              if (deleteDialog.item) {
                deleteItem(deleteDialog.item.jid);
                setDeleteDialog({ open: false, item: null });
              }
            }}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Join Room Dialog */}
      <AlertDialog open={joinRoomDialog.open} onOpenChange={(open) => setJoinRoomDialog({ open, jid: '' })}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Join Room</AlertDialogTitle>
            <AlertDialogDescription>
              You need to join this room before you can send messages.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={async () => {
              if (joinRoomDialog.jid) {
                await joinRoom(joinRoomDialog.jid, 'User');
                setJoinRoomDialog({ open: false, jid: '' });
              }
            }}>Join Room</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
