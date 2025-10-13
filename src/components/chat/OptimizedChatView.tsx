/**
 * Optimized Chat View Component
 * Replacement for UnifiedChatView with improved performance
 */

import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { Search, Archive, ArchiveRestore, Trash2, Phone, Users, Settings } from 'lucide-react';
import { useChatCore, useChatMessages } from '@/hooks/useChatCore';
import { useXmpp } from '@/contexts/XmppContext';
import { VirtualizedMessageList } from './VirtualizedMessageList';
import { MessageComposer } from './MessageComposer';
import { PhonebookDialog } from './PhonebookDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { formatDistanceToNow } from 'date-fns';

export const OptimizedChatView = () => {
  const [isPhonebookOpen, setIsPhonebookOpen] = useState(false);
  const [deleteDialog, setDeleteDialog] = useState<{ open: boolean; jid?: string }>({ open: false });
  const [joinRoomDialog, setJoinRoomDialog] = useState<{ open: boolean; jid?: string }>({ open: false });

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

  // XMPP context
  const {
    connectionState,
    sendMessage,
    loadConversationHistory,
    joinRoom,
    contacts,
  } = useXmpp();

  // Message operations
  const { addMessage, loadHistory } = useChatMessages();

  // Handle message sending
  const handleSendMessage = useCallback(async (body: string) => {
    if (!selectedItem) return;

    try {
      // For rooms, check if user needs to join first
      if (selectedItem.type === 'room' && !selectedItem.joined) {
        setJoinRoomDialog({ open: true, jid: selectedItem.jid });
        return;
      }

      await sendMessage(selectedItem.jid, body);
    } catch (error) {
      console.error('Failed to send message:', error);
    }
  }, [selectedItem, sendMessage]);

  // Handle history loading
  const handleLoadHistory = useCallback(async () => {
    if (!selectedItem) return;
    
    try {
      if (selectedItem.type === 'conversation') {
        await loadConversationHistory(selectedItem.jid, '20');
      }
    } catch (error) {
      console.error('Failed to load history:', error);
    }
  }, [selectedItem, loadConversationHistory]);

  // Handle room joining
  const handleJoinRoom = useCallback(async () => {
    if (!joinRoomDialog.jid) return;

    try {
      await joinRoom(joinRoomDialog.jid, 'user');
      setJoinRoomDialog({ open: false });
    } catch (error) {
      console.error('Failed to join room:', error);
    }
  }, [joinRoomDialog.jid, joinRoom]);

  // Handle item selection
  const handleSelectItem = useCallback((jid: string) => {
    selectItem(jid);
  }, [selectItem]);

  // Handle phonebook selection
  const handleSelectFromPhonebook = useCallback((contact: any) => {
    selectItem(contact.jid);
    setIsPhonebookOpen(false);
  }, [selectItem]);

  // Handle archive operations
  const handleArchiveItem = useCallback((jid: string) => {
    archiveItem(jid);
  }, [archiveItem]);

  const handleUnarchiveItem = useCallback((jid: string) => {
    unarchiveItem(jid);
  }, [unarchiveItem]);

  // Handle delete confirmation
  const handleDeleteItem = useCallback(() => {
    if (deleteDialog.jid) {
      deleteItem(deleteDialog.jid);
      setDeleteDialog({ open: false });
    }
  }, [deleteDialog.jid, deleteItem]);

  // Mark as read when item is selected
  useEffect(() => {
    if (selectedItem && selectedItem.unreadCount > 0) {
      markAsRead(selectedItem.jid);
    }
  }, [selectedItem, markAsRead]);

  // Memoized item list for performance
  const memoizedItemList = useMemo(() => (
    <div className="flex-1 overflow-auto">
      {filteredItems.map((item) => (
        <div
          key={item.id}
          className={cn(
            "flex items-center gap-3 p-3 hover:bg-muted/50 cursor-pointer border-l-2 transition-colors",
            selectedItem?.id === item.id ? "bg-muted border-l-primary" : "border-l-transparent"
          )}
          onClick={() => handleSelectItem(item.jid)}
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
                      <Settings className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {item.isArchived ? (
                      <DropdownMenuItem onClick={() => handleUnarchiveItem(item.jid)}>
                        <ArchiveRestore className="h-4 w-4 mr-2" />
                        Unarchive
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem onClick={() => handleArchiveItem(item.jid)}>
                        <Archive className="h-4 w-4 mr-2" />
                        Archive
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem 
                      onClick={() => setDeleteDialog({ open: true, jid: item.jid })}
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
  ), [filteredItems, selectedItem, handleSelectItem, handleArchiveItem, handleUnarchiveItem]);

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <div className="w-80 border-r flex flex-col">
        {/* Header */}
        <div className="p-4 border-b space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Chats</h2>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsPhonebookOpen(true)}
            >
              <Users className="h-4 w-4 mr-2" />
              Contacts
            </Button>
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
      <div className="flex-1 flex flex-col">
        {selectedItem ? (
          <>
            {/* Chat Header */}
            <div className="p-4 border-b flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Avatar className="h-8 w-8">
                  <AvatarFallback>
                    {selectedItem.name.slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div>
                  <h3 className="font-medium">{selectedItem.name}</h3>
                  <p className="text-sm text-muted-foreground">
                    {selectedItem.type === 'room' ? `${selectedItem.occupants?.length || 0} members` : 'Direct message'}
                  </p>
                </div>
              </div>
              
              {selectedItem.type === 'conversation' && (
                <Button variant="outline" size="sm">
                  <Phone className="h-4 w-4" />
                </Button>
              )}
            </div>

            {/* Messages */}
            <VirtualizedMessageList
              messages={selectedItem.messages}
              height={400} // This will be dynamic based on container
              currentUserJid={'user@example.com'}
              onLoadMore={handleLoadHistory}
            />

            {/* Message Composer */}
            <div className="p-4 border-t">
            <MessageComposer
              value=""
              onChange={() => {}}
              onSend={() => handleSendMessage("")}
              disabled={connectionState !== 'connected'}
              placeholder={selectedItem.type === 'room' && !selectedItem.joined 
                ? "Join the room to send messages" 
                : "Type a message..."
              }
            />
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center">
              <Users className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p className="text-lg">Select a conversation to start chatting</p>
            </div>
          </div>
        )}
      </div>

      {/* Dialogs */}
      <PhonebookDialog
        open={isPhonebookOpen}
        onOpenChange={setIsPhonebookOpen}
        onSelect={(jid) => handleSelectFromPhonebook({ jid })}
      />

      <AlertDialog open={deleteDialog.open} onOpenChange={(open) => setDeleteDialog({ open })}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Conversation</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this conversation? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteItem}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={joinRoomDialog.open} onOpenChange={(open) => setJoinRoomDialog({ open })}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Join Room</AlertDialogTitle>
            <AlertDialogDescription>
              You need to join this room before you can send messages.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleJoinRoom}>Join Room</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};