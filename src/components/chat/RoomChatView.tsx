import { Search, Users, UserPlus, Crown, Shield, User as UserIcon, Ban, UserMinus, Volume2, VolumeX, Trash2, WifiOff, Globe, ArrowUpDown, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useState, useEffect } from 'react';
import { useSettings } from '@/contexts/SettingsContext';
import { useXmpp } from '@/contexts/XmppContext';
import { MessageComposer } from './MessageComposer';
import { MessageBodyRenderer } from './MessageBodyRenderer';
import { DateSeparator } from './DateSeparator';
import { insertDateSeparators, formatFullDateTime } from '@/lib/dateUtils';

export const RoomChatView = () => {
  const [selectedRoom, setSelectedRoom] = useState<string | null>(null);
  const [newMessage, setNewMessage] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [newRoomName, setNewRoomName] = useState('');
  const [newRoomNick, setNewRoomNick] = useState('');
  const [joinRoomJid, setJoinRoomJid] = useState('');
  const [joinRoomNick, setJoinRoomNick] = useState('');
  const [isCreateRoomOpen, setIsCreateRoomOpen] = useState(false);
  const [isJoinRoomOpen, setIsJoinRoomOpen] = useState(false);
  const [isBrowseRoomsOpen, setIsBrowseRoomsOpen] = useState(false);
  const [isMembersOpen, setIsMembersOpen] = useState(false);
  const [availableServices, setAvailableServices] = useState<string[]>([]);
  const [selectedService, setSelectedService] = useState<string>('');
  const [availableRooms, setAvailableRooms] = useState<Array<{jid: string; name: string}>>([]);
  const [loadingServices, setLoadingServices] = useState(false);
  const [loadingRooms, setLoadingRooms] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<'newest' | 'a-z' | 'z-a'>('newest');
  
  const { settings } = useSettings();
  const { 
    connectionState, 
    rooms,
    createRoom,
    joinRoom,
    leaveRoom,
    destroyRoom,
    sendRoomMessage,
    inviteToRoom,
    kickFromRoom,
    banFromRoom,
    setRoomAffiliation,
    muteRoom,
    loadRoomHistory,
    markRoomRead,
    listMucServices,
    listRooms
  } = useXmpp();

  const handleLeaveRoom = (roomJid: string) => {
    leaveRoom(roomJid);
    setSelectedRoom(null); // Clear selection when leaving
  };

  const filteredRooms = rooms.filter((room) => {
    const name = room.name || room.jid.split('@')[0] || '';
    return name.toLowerCase().includes(searchTerm.toLowerCase()) ||
           room.jid.includes(searchTerm);
  });

  const sortedRooms = [...filteredRooms].sort((a, b) => {
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

  const selectedRoomData = rooms.find((room) => room.jid === selectedRoom);

  // Mark room as read when selected
  useEffect(() => {
    if (selectedRoom && selectedRoomData && selectedRoomData.unreadCount > 0) {
      markRoomRead(selectedRoom);
    }
  }, [selectedRoom, selectedRoomData?.unreadCount, markRoomRead]);

  const handleSendMessage = async () => {
    if (!newMessage.trim() || !selectedRoomData) return;

    const success = await sendRoomMessage(selectedRoomData.jid, newMessage.trim());
    if (success) {
      setNewMessage('');
    }
  };

  const handleCreateRoom = async () => {
    if (!newRoomName.trim() || !newRoomNick.trim()) return;
    
    const success = await createRoom(newRoomName.trim(), newRoomNick.trim());
    if (success) {
      setNewRoomName('');
      setNewRoomNick('');
      setIsCreateRoomOpen(false);
    }
  };

  const handleJoinRoom = async () => {
    if (!joinRoomJid.trim() || !joinRoomNick.trim()) return;
    
    const success = await joinRoom(joinRoomJid.trim(), joinRoomNick.trim());
    if (success) {
      setSelectedRoom(joinRoomJid.trim());
      setJoinRoomJid('');
      setJoinRoomNick('');
      setIsJoinRoomOpen(false);
    }
  };

  const handleLoadHistory = async (jid: string) => {
    if (loadingHistory === jid) return;
    
    setLoadingHistory(jid);
    try {
      await loadRoomHistory(jid);
    } catch (error) {
      console.error('Failed to load room history:', error);
    } finally {
      setLoadingHistory(null);
    }
  };

  const handleBrowseRooms = async () => {
    if (connectionState !== 'connected') return;
    
    setIsBrowseRoomsOpen(true);
    setLoadingServices(true);
    try {
      const services = await listMucServices();
      setAvailableServices(services);
      if (services.length > 0) {
        setSelectedService(services[0]);
        await loadRoomsForService(services[0]);
      }
    } catch (error) {
      console.error('Failed to browse rooms:', error);
    } finally {
      setLoadingServices(false);
    }
  };

  const loadRoomsForService = async (serviceJid: string) => {
    if (!serviceJid || connectionState !== 'connected') return;
    
    setLoadingRooms(true);
    try {
      const roomList = await listRooms(serviceJid);
      setAvailableRooms(roomList);
    } catch (error) {
      console.error('Failed to load rooms for service:', error);
      setAvailableRooms([]);
    } finally {
      setLoadingRooms(false);
    }
  };

  const handleServiceChange = (serviceJid: string) => {
    setSelectedService(serviceJid);
    loadRoomsForService(serviceJid);
  };

  const handleJoinFromBrowse = async (roomJid: string) => {
    if (!joinRoomNick.trim()) return;
    
    const success = await joinRoom(roomJid, joinRoomNick.trim());
    if (success) {
      setSelectedRoom(roomJid);
      setIsBrowseRoomsOpen(false);
      setJoinRoomNick('');
    }
  };

  const getInitials = (name: string) => {
    return name.split(' ').map(n => n[0]).join('').toUpperCase();
  };


  const getRoleIcon = (occupant: typeof selectedRoomData extends undefined ? never : typeof selectedRoomData['occupants'][0]) => {
    if (occupant.affiliation === 'owner') return <Crown className="h-3 w-3 text-yellow-500" />;
    if (occupant.affiliation === 'admin') return <Shield className="h-3 w-3 text-blue-500" />;
    if (occupant.role === 'moderator') return <Shield className="h-3 w-3 text-green-500" />;
    return <UserIcon className="h-3 w-3 text-muted-foreground" />;
  };

  return (
    <div className="h-full flex overflow-hidden">
      {/* Rooms List */}
      <div className="w-1/3 border-r border-border flex flex-col min-h-0">
        <div className="p-4 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2 mb-4">
            <Dialog open={isCreateRoomOpen} onOpenChange={setIsCreateRoomOpen}>
              <DialogTrigger asChild>
                <Button size="sm" variant="outline">
                  <UserPlus className="h-4 w-4 mr-1" />
                  Create
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-md">
                <DialogHeader>
                  <DialogTitle>Create Room</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                  <div>
                    <label className="text-sm font-medium mb-2 block">Room Name</label>
                    <Input
                      placeholder="My Room"
                      value={newRoomName}
                      onChange={(e) => setNewRoomName(e.target.value)}
                      onKeyPress={(e) => e.key === 'Enter' && handleCreateRoom()}
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium mb-2 block">Your Nickname</label>
                    <Input
                      placeholder="nickname"
                      value={newRoomNick}
                      onChange={(e) => setNewRoomNick(e.target.value)}
                      onKeyPress={(e) => e.key === 'Enter' && handleCreateRoom()}
                    />
                  </div>
                  <Button 
                    onClick={handleCreateRoom} 
                    disabled={!newRoomName.trim() || !newRoomNick.trim()}
                    className="w-full"
                  >
                    Create Room
                  </Button>
                </div>
              </DialogContent>
            </Dialog>

            <Dialog open={isJoinRoomOpen} onOpenChange={setIsJoinRoomOpen}>
              <DialogTrigger asChild>
                <Button size="sm" variant="outline">
                  <Users className="h-4 w-4 mr-1" />
                  Join
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-md">
                <DialogHeader>
                  <DialogTitle>Join Room</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                  <div>
                    <label className="text-sm font-medium mb-2 block">Room JID</label>
                    <Input
                      placeholder="room@conference.domain.com"
                      value={joinRoomJid}
                      onChange={(e) => setJoinRoomJid(e.target.value)}
                      onKeyPress={(e) => e.key === 'Enter' && handleJoinRoom()}
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium mb-2 block">Your Nickname</label>
                    <Input
                      placeholder="nickname"
                      value={joinRoomNick}
                      onChange={(e) => setJoinRoomNick(e.target.value)}
                      onKeyPress={(e) => e.key === 'Enter' && handleJoinRoom()}
                    />
                  </div>
                  <Button 
                    onClick={handleJoinRoom} 
                    disabled={!joinRoomJid.trim() || !joinRoomNick.trim()}
                    className="w-full"
                  >
                    Join Room
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
            
            <Dialog open={isBrowseRoomsOpen} onOpenChange={setIsBrowseRoomsOpen}>
              <DialogTrigger asChild>
                <Button 
                  variant="outline" 
                  size="sm"
                  onClick={handleBrowseRooms}
                  disabled={connectionState !== 'connected'}
                >
                  <Globe className="h-4 w-4 mr-2" />
                  Browse
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl">
                <DialogHeader>
                  <DialogTitle>Browse Rooms</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                  <div>
                    <label className="text-sm font-medium mb-2 block">Your Nickname</label>
                    <Input
                      placeholder="nickname"
                      value={joinRoomNick}
                      onChange={(e) => setJoinRoomNick(e.target.value)}
                    />
                  </div>
                  {availableServices.length > 1 && (
                    <div>
                      <label className="text-sm font-medium mb-2 block">Conference Service</label>
                      <select 
                        className="w-full p-2 border rounded-md"
                        value={selectedService}
                        onChange={(e) => handleServiceChange(e.target.value)}
                      >
                        {availableServices.map(service => (
                          <option key={service} value={service}>{service}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div>
                    <label className="text-sm font-medium mb-2 block">Available Rooms</label>
                    <div className="border rounded-md max-h-60 overflow-y-auto">
                      {loadingServices || loadingRooms ? (
                        <div className="p-4 text-center text-muted-foreground">
                          Loading rooms...
                        </div>
                      ) : availableRooms.length === 0 ? (
                        <div className="p-4 text-center text-muted-foreground">
                          No rooms found
                        </div>
                      ) : (
                        availableRooms.map(room => (
                          <div 
                            key={room.jid}
                            className="p-3 border-b last:border-b-0 hover:bg-muted/50 flex justify-between items-center"
                          >
                            <div>
                              <div className="font-medium">{room.name}</div>
                              <div className="text-sm text-muted-foreground">{room.jid}</div>
                            </div>
                            <Button 
                              size="sm" 
                              onClick={() => handleJoinFromBrowse(room.jid)}
                              disabled={!joinRoomNick.trim()}
                            >
                              Join
                            </Button>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          </div>
          <div className="flex items-center gap-2 mb-4">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search rooms..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10"
              />
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
        </div>
        
        <ScrollArea className="flex-1 min-h-0">
          {sortedRooms.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">
              <Users className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p className="text-lg font-medium mb-2">No Rooms</p>
              <p className="text-sm mb-4">
                {connectionState === 'connected' 
                  ? 'Create or join a room to start group chatting'
                  : 'Rooms will appear here when connected'
                }
              </p>
              {connectionState !== 'connected' && (
                <div className="flex items-center justify-center gap-2 mt-2">
                  <WifiOff className="h-4 w-4" />
                  <span className="text-xs">Offline</span>
                </div>
              )}
            </div>
          ) : (
            sortedRooms.map((room) => {
              const lastMessage = room.messages.length > 0 
                ? room.messages[room.messages.length - 1].body
                : 'No messages';
              const timestamp = room.lastActivity.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
              
              return (
                <div
                  key={room.jid}
                  onClick={() => setSelectedRoom(room.jid)}
                  className={`p-4 border-b border-border cursor-pointer hover:bg-muted/50 ${
                    selectedRoom === room.jid ? 'bg-muted' : ''
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <Avatar className="h-10 w-10">
                      <AvatarFallback>{getInitials(room.name)}</AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <h3 className="font-medium truncate">{room.name}</h3>
                          {room.isOwner && <Crown className="h-3 w-3 text-yellow-500" />}
                          {room.isMuted && <VolumeX className="h-3 w-3 text-muted-foreground" />}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground">{timestamp}</span>
                          {room.unreadCount > 0 && (
                            <Badge variant="default" className="text-xs">
                              {room.unreadCount}
                            </Badge>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center justify-between">
                        <p className="text-sm text-muted-foreground truncate">{lastMessage}</p>
                        <span className="text-xs text-muted-foreground">{room.occupants.length} members</span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </ScrollArea>
      </div>

      {/* Room View */}
      <div className="flex-1 flex overflow-hidden">
        {selectedRoomData ? (
          <>
            {/* Messages Area */}
            <div className="flex-1 flex flex-col min-h-0">
              {/* Header */}
              <div className="flex-shrink-0 p-4 border-b border-border">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Avatar className="h-10 w-10">
                      <AvatarFallback>{getInitials(selectedRoomData.name)}</AvatarFallback>
                    </Avatar>
                    <div>
                      <div className="flex items-center gap-2">
                        <h2 className="font-medium">{selectedRoomData.name}</h2>
                        {selectedRoomData.isOwner && <Crown className="h-4 w-4 text-yellow-500" />}
                      </div>
                      <p className="text-sm text-muted-foreground">{selectedRoomData.occupants.length} members</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setIsMembersOpen(true)}
                    >
                      <Users className="h-4 w-4 mr-1" />
                      Members
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => muteRoom(selectedRoomData.jid, !selectedRoomData.isMuted)}
                    >
                      {selectedRoomData.isMuted ? (
                        <Volume2 className="h-4 w-4" />
                      ) : (
                        <VolumeX className="h-4 w-4" />
                      )}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleLeaveRoom(selectedRoomData.jid)}
                    >
                      Leave
                    </Button>
                    {selectedRoomData.isOwner && (
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => destroyRoom(selectedRoomData.jid, 'Room deleted by owner')}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </div>
              </div>

              {/* Messages */}
              <div className="flex-1 min-h-0 overflow-hidden">
                <ScrollArea className="h-full">
                  <div className="p-4 pb-6">
                    {selectedRoomData.messages.length === 0 ? (
                      <div className="flex items-center justify-center h-full text-muted-foreground min-h-[400px]">
                        <div className="text-center">
                          <Users className="h-12 w-12 mx-auto mb-4 opacity-50" />
                          <p className="text-lg font-medium mb-2">Start the conversation</p>
                          <p className="text-sm mb-4">Send a message to begin chatting in {selectedRoomData.name}</p>
                          {connectionState === 'connected' && selectedRoomData.hasMoreHistory !== false && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleLoadHistory(selectedRoomData.jid)}
                              disabled={loadingHistory === selectedRoomData.jid}
                              className="mb-4"
                            >
                              {loadingHistory === selectedRoomData.jid ? 'Loading...' : 'Load message history'}
                            </Button>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-4">
                        {connectionState === 'connected' && selectedRoomData.hasMoreHistory !== false && (
                          <div className="text-center">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleLoadHistory(selectedRoomData.jid)}
                              disabled={loadingHistory === selectedRoomData.jid}
                            >
                              {loadingHistory === selectedRoomData.jid ? 'Loading...' : 'Load earlier messages'}
                            </Button>
                          </div>
                        )}
                        
                        {insertDateSeparators(selectedRoomData.messages).map((item) => {
                          if ('type' in item && item.type === 'date-separator') {
                            return <DateSeparator key={item.id} date={item.date} />;
                          }

                          const message = item as any; // Type assertion for message properties
                          const myNick = selectedRoomData.nick;
                          const senderNick = message.from.split('/')[1] || message.from;
                          const isSent = senderNick === myNick;
                          
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
                                {!isSent && (
                                  <p className="text-xs font-medium mb-1 opacity-70">{senderNick}</p>
                                )}
                                <MessageBodyRenderer 
                                  body={message.body}
                                  className={isSent ? 'text-primary-foreground' : 'text-foreground'}
                                />
                                <div className="flex items-center justify-end gap-1 mt-1">
                                  <span className={`text-xs opacity-80 ${
                                    isSent ? 'text-primary-foreground' : 'text-muted-foreground'
                                  }`}>
                                    {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                  </span>
                                  {message.isFromArchive && (
                                    <span className={`text-xs opacity-60 ${
                                      isSent ? 'text-primary-foreground' : 'text-muted-foreground'
                                    }`}>(archived)</span>
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
                disabled={connectionState !== 'connected' || !selectedRoomData.joined}
                placeholder="Type a message..."
              />
            </div>

            {/* Members Dialog */}
            <Dialog open={isMembersOpen} onOpenChange={setIsMembersOpen}>
              <DialogContent className="max-w-md">
                <DialogHeader>
                  <DialogTitle>Members ({selectedRoomData.occupants.length})</DialogTitle>
                </DialogHeader>
                <ScrollArea className="max-h-96">
                  <div className="space-y-2">
                    {selectedRoomData.occupants.map((occupant) => (
                      <div key={occupant.nick} className="flex items-center justify-between p-2 hover:bg-muted rounded">
                        <div className="flex items-center gap-3">
                          <Avatar className="h-8 w-8">
                            <AvatarFallback className="text-xs">
                              {getInitials(occupant.nick)}
                            </AvatarFallback>
                          </Avatar>
                          <div>
                            <div className="flex items-center gap-1">
                              <p className="font-medium text-sm">{occupant.nick}</p>
                              {getRoleIcon(occupant)}
                            </div>
                            <p className="text-xs text-muted-foreground">{occupant.affiliation || 'none'}</p>
                          </div>
                        </div>
                        {selectedRoomData.isOwner && occupant.nick !== selectedRoomData.nick && (
                          <div className="flex gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => kickFromRoom(selectedRoomData.jid, occupant.nick, 'Kicked by room owner')}
                              className="h-6 w-6 p-0"
                            >
                              <UserMinus className="h-3 w-3" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => occupant.jid && banFromRoom(selectedRoomData.jid, occupant.jid, 'Banned by room owner')}
                              className="h-6 w-6 p-0"
                              disabled={!occupant.jid}
                            >
                              <Ban className="h-3 w-3" />
                            </Button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </DialogContent>
            </Dialog>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center">
              <Users className="h-16 w-16 mx-auto mb-4 opacity-50" />
              <p className="text-lg font-medium mb-2">Select a room</p>
              <p className="text-sm">Choose a room from the list to start chatting</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};