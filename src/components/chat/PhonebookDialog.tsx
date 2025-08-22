import { Search, Users, User as UserIcon, BookUser } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useState, useEffect, useMemo } from 'react';
import { useXmpp } from '@/contexts/XmppContext';
import { useSettings } from '@/contexts/SettingsContext';

interface PhonebookDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (jid: string, kind: 'direct' | 'room') => void;
}

export const PhonebookDialog: React.FC<PhonebookDialogProps> = ({ 
  open, 
  onOpenChange, 
  onSelect 
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [availableServices, setAvailableServices] = useState<string[]>([]);
  const [selectedService, setSelectedService] = useState<string>('');
  const [availableRooms, setAvailableRooms] = useState<Array<{jid: string; name: string}>>([]);
  const [searchedUsers, setSearchedUsers] = useState<Array<{jid: string; name: string}>>([]);
  const [loadingServices, setLoadingServices] = useState(false);
  const [loadingRooms, setLoadingRooms] = useState(false);
  const [loadingUsers, setLoadingUsers] = useState(false);

  const { settings } = useSettings();
  const { 
    uiConnection,
    contacts,
    nickname,
    listMucServices,
    listRooms,
    searchUsers,
    joinRoom
  } = useXmpp();

  // Enhanced user search with debouncing
  useEffect(() => {
    if (!searchTerm.trim() || uiConnection !== 'connected') {
      setSearchedUsers([]);
      return;
    }

    const timeoutId = setTimeout(async () => {
      setLoadingUsers(true);
      try {
        const users = await searchUsers(searchTerm);
        setSearchedUsers(users);
      } catch (error) {
        console.error('Failed to search users:', error);
        setSearchedUsers([]);
      } finally {
        setLoadingUsers(false);
      }
    }, 500);

    return () => clearTimeout(timeoutId);
  }, [searchTerm, searchUsers, uiConnection]);

  // Load MUC services when dialog opens
  useEffect(() => {
    if (open && uiConnection === 'connected' && availableServices.length === 0) {
      handleLoadServices();
    }
  }, [open, uiConnection]);

  const handleLoadServices = async () => {
    setLoadingServices(true);
    try {
      const services = await listMucServices();
      setAvailableServices(services);
      if (services.length > 0) {
        setSelectedService(services[0]);
        await loadRoomsForService(services[0]);
      }
    } catch (error) {
      console.error('Failed to load MUC services:', error);
    } finally {
      setLoadingServices(false);
    }
  };

  const loadRoomsForService = async (serviceJid: string) => {
    if (!serviceJid || uiConnection !== 'connected') return;
    
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

  const handleUserSelect = (jid: string) => {
    onSelect(jid, 'direct');
  };

  const handleRoomJoin = async (roomJid: string) => {
    if (!nickname.trim()) return;
    
    try {
      const success = await joinRoom(roomJid, nickname.trim());
      if (success) {
        onSelect(roomJid, 'room');
      }
    } catch (error) {
      console.error('Failed to join room:', error);
    }
  };

  // Combine roster contacts with searched users, removing duplicates
  const allUsers = useMemo(() => {
    const contactSet = new Set(contacts.map(c => c.jid));
    const uniqueSearchedUsers = searchedUsers.filter(u => !contactSet.has(u.jid));
    
    return [
      ...contacts.map(c => ({ jid: c.jid, name: c.name, presence: c.presence })),
      ...uniqueSearchedUsers.map(u => ({ jid: u.jid, name: u.name, presence: 'unavailable' as const }))
    ];
  }, [contacts, searchedUsers]);

  const filteredContacts = allUsers.filter((contact) => {
    const name = contact.name || contact.jid.split('@')[0] || '';
    return name.toLowerCase().includes(searchTerm.toLowerCase()) ||
           contact.jid.toLowerCase().includes(searchTerm.toLowerCase());
  });

  const filteredRooms = availableRooms.filter((room) => {
    return room.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
           room.jid.toLowerCase().includes(searchTerm.toLowerCase());
  });

  const getInitials = (name: string) => {
    return name.split(' ').map(n => n[0]).join('').toUpperCase();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookUser className="h-5 w-5" />
            Phonebook
          </DialogTitle>
        </DialogHeader>
        
        <div className="space-y-4">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search users and rooms..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Users Section */}
            <div className="space-y-3">
              <h3 className="font-medium text-sm flex items-center gap-2">
                <UserIcon className="h-4 w-4" />
                Users ({filteredContacts.length}) {loadingUsers && '• Searching...'}
              </h3>
              
              <ScrollArea className="h-64 border rounded-md">
                {loadingUsers && searchTerm.trim() ? (
                  <div className="p-4 text-center text-muted-foreground">
                    <UserIcon className="h-8 w-8 mx-auto mb-2 opacity-50 animate-pulse" />
                    <p className="text-sm">Searching for users...</p>
                  </div>
                ) : filteredContacts.length === 0 ? (
                  <div className="p-4 text-center text-muted-foreground">
                    <UserIcon className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    <p className="text-sm">
                      {searchTerm ? 'No users match your search' : 'No contacts available'}
                    </p>
                    {searchTerm && <p className="text-xs mt-1">Try searching the user directory</p>}
                  </div>
                ) : (
                  <div className="p-2">
                    {filteredContacts.map((contact) => (
                      <div
                        key={contact.jid}
                        onClick={() => handleUserSelect(contact.jid)}
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
                  </div>
                )}
              </ScrollArea>
            </div>

            {/* Rooms Section */}
            <div className="space-y-3">
              <h3 className="font-medium text-sm flex items-center gap-2">
                <Users className="h-4 w-4" />
                Rooms ({filteredRooms.length})
              </h3>

              {/* Service Selector */}
              {availableServices.length > 1 && (
                <div>
                  <label className="text-xs font-medium mb-1 block">Conference Service</label>
                  <Select value={selectedService} onValueChange={handleServiceChange}>
                    <SelectTrigger className="text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {availableServices.map(service => (
                        <SelectItem key={service} value={service}>{service}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <ScrollArea className="h-64 border rounded-md">
                {loadingServices || loadingRooms ? (
                  <div className="p-4 text-center text-muted-foreground">
                    <Users className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    <p className="text-sm">Loading rooms...</p>
                  </div>
                ) : filteredRooms.length === 0 ? (
                  <div className="p-4 text-center text-muted-foreground">
                    <Users className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    <p className="text-sm">
                      {searchTerm ? 'No rooms match your search' : 'No rooms found'}
                    </p>
                  </div>
                ) : (
                  <div className="p-2">
                    {filteredRooms.map(room => (
                      <div 
                        key={room.jid}
                        className="p-2 border-b last:border-b-0 hover:bg-muted/50 flex justify-between items-center"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-sm truncate">{room.name}</div>
                          <div className="text-xs text-muted-foreground truncate">{room.jid}</div>
                        </div>
                        <Button 
                          size="sm" 
                          variant="outline"
                          onClick={() => handleRoomJoin(room.jid)}
                          disabled={!nickname.trim()}
                          className="ml-2 text-xs"
                        >
                          Join
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </ScrollArea>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};