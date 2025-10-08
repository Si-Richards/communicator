import { Search, Users, User as UserIcon, BookUser } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useState, useEffect, useMemo, useRef } from 'react';
import { useXmpp } from '@/contexts/XmppContext';
import { useSettings } from '@/contexts/SettingsContext';
import { mucCache } from '@/lib/xmppMucCache';

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
  const [allRooms, setAllRooms] = useState<Array<{jid: string; name: string; service: string}>>([]);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const loadingInProgress = useRef(false);
  const loadTimeoutRef = useRef<NodeJS.Timeout>();

  const { settings } = useSettings();
  const { 
    uiConnection,
    connectionState,
    contacts,
    nickname,
    listMucServices,
    listRooms,
    searchUsers,
    joinRoom,
    connect,
    loadRoster
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

  // Load MUC services and roster when dialog opens with debouncing
  useEffect(() => {
    // Clear any pending timeout
    if (loadTimeoutRef.current) {
      clearTimeout(loadTimeoutRef.current);
    }

    if (!open) {
      setConnectionError(null);
      loadingInProgress.current = false;
      return;
    }

    if (uiConnection !== 'connected') {
      setConnectionError(uiConnection === 'offline' ? 'Not connected to server' : 
                        uiConnection === 'reconnecting' ? 'Reconnecting to server...' : 
                        'Connection error');
      return;
    }

    // Debounce the load by 500ms
    loadTimeoutRef.current = setTimeout(() => {
      if (!loadingInProgress.current) {
        console.log('PhonebookDialog: Loading services and roster');
        handleLoadServices();
        loadRoster();
      }
    }, 500);

    return () => {
      if (loadTimeoutRef.current) {
        clearTimeout(loadTimeoutRef.current);
      }
    };
  }, [open, uiConnection, connectionState, loadRoster]);

  const handleLoadServices = async () => {
    // Prevent duplicate calls
    if (loadingInProgress.current) {
      console.log('PhonebookDialog: Load already in progress, skipping');
      return;
    }

    // Verify connection
    if (uiConnection !== 'connected') {
      setConnectionError('Not connected to server');
      return;
    }

    loadingInProgress.current = true;
    setLoadingServices(true);
    setConnectionError(null);

    try {
      // Use deduplication wrapper
      const services = await mucCache.deduplicateRequest('muc-services', async () => {
        // Try cache first
        const cached = mucCache.getCachedServices();
        if (cached && cached.length > 0) {
          console.log('PhonebookDialog: Using cached services:', cached);
          return cached;
        }

        // Fresh fetch
        console.log('PhonebookDialog: Fetching MUC services');
        const freshServices = await listMucServices();
        
        if (freshServices.length > 0) {
          mucCache.setCachedServices(freshServices);
        }
        
        return freshServices;
      });

      console.log('PhonebookDialog: Found services:', services);
      setAvailableServices(services);
      
      if (services.length > 0) {
        setSelectedService("all");
        await loadAllRooms(services);
      } else {
        setConnectionError('No conference services found on this server');
      }
    } catch (error: any) {
      console.error('Failed to load MUC services:', error);
      
      // Provide specific error messages
      if (error.name === 'ClientDisconnected' || error.message?.includes('disconnected')) {
        setConnectionError('Connection lost while discovering services');
      } else if (error.message?.includes('Circuit breaker')) {
        setConnectionError('Service discovery temporarily unavailable');
      } else {
        setConnectionError('Failed to load conference services');
      }
    } finally {
      setLoadingServices(false);
      loadingInProgress.current = false;
    }
  };

  const loadAllRooms = async (services: string[]) => {
    // Verify connection before loading rooms
    if (uiConnection !== 'connected') {
      return;
    }

    setLoadingRooms(true);
    try {
      console.log('PhonebookDialog: Loading rooms from services:', services);
      const allRoomsData: Array<{jid: string; name: string; service: string}> = [];
      
      // Sequential loading with small delays to avoid overwhelming connection
      for (const service of services) {
        try {
          // Use cache with deduplication
          const rooms = await mucCache.deduplicateRequest(`rooms-${service}`, async () => {
            const cached = mucCache.getCachedRooms(service);
            if (cached) {
              console.log(`PhonebookDialog: Using cached rooms for ${service}`);
              return cached;
            }

            console.log(`PhonebookDialog: Fetching rooms from ${service}`);
            const freshRooms = await listRooms(service);
            
            if (freshRooms.length > 0) {
              mucCache.setCachedRooms(service, freshRooms);
            }
            
            return freshRooms;
          });

          console.log(`PhonebookDialog: Loaded ${rooms.length} rooms from ${service}`);
          allRoomsData.push(...rooms.map(room => ({...room, service})));

          // Small delay between services
          if (services.indexOf(service) < services.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 200));
          }
        } catch (error: any) {
          // Stop if client disconnected
          if (error.name === 'ClientDisconnected') {
            console.debug('Client disconnected during room loading');
            break;
          }
          console.error(`Failed to load rooms for ${service}:`, error);
        }
      }
      
      console.log(`PhonebookDialog: Total rooms loaded: ${allRoomsData.length}`);
      setAllRooms(allRoomsData);
      setAvailableRooms(allRoomsData);
      
      if (allRoomsData.length === 0) {
        setConnectionError('No public rooms found. This server may not have public rooms or they may be hidden.');
      }
    } catch (error: any) {
      if (error.name === 'ClientDisconnected' || error.message?.includes('disconnected')) {
        setConnectionError('Connection lost while loading rooms');
      } else {
        setConnectionError('Failed to load chat rooms');
      }
    } finally {
      setLoadingRooms(false);
    }
  };

  const handleServiceChange = (serviceJid: string) => {
    setSelectedService(serviceJid);
    // Filter allRooms by selected service, or show all if "all" is selected
    if (serviceJid === "all") {
      setAvailableRooms(allRooms);
    } else {
      const serviceRooms = allRooms.filter(room => room.service === serviceJid);
      setAvailableRooms(serviceRooms);
    }
  };

  const handleRetry = () => {
    if (uiConnection === 'connected' && !loadingInProgress.current) {
      // Clear cache to force fresh fetch
      mucCache.clearCache();
      loadingInProgress.current = false;
      handleLoadServices();
    }
  };

  const handleUserSelect = (jid: string) => {
    onSelect(jid, 'direct');
  };

  const handleRoomJoin = async (roomJid: string) => {
    if (!nickname.trim()) {
      console.warn('No nickname set, cannot join room');
      return;
    }
    
    try {
      console.log('Attempting to join room:', roomJid, 'with nickname:', nickname.trim());
      const success = await joinRoom(roomJid, nickname.trim());
      console.log('Join room result:', success);
      if (success) {
        onSelect(roomJid, 'room');
        onOpenChange(false); // Close dialog on successful join
      } else {
        console.error('Join room returned false');
      }
    } catch (error) {
      console.error('Failed to join room:', error);
    }
  };

  // Filter out MUC JIDs from user search and combine with contacts
  const allUsers = useMemo(() => {
    const contactSet = new Set(contacts.map(c => c.jid));
    
    // Filter out MUC JIDs from searched users (they should appear in rooms instead)
    const filteredSearchedUsers = searchedUsers.filter(u => {
      const domain = u.jid?.split('@')?.[1];
      const isMucDomain = domain && (domain.includes('conference.') || 
                                   domain.includes('muc.') || 
                                   domain.includes('rooms.'));
      return !contactSet.has(u.jid) && !isMucDomain;
    });
    
    return [
      ...contacts.map(c => ({ jid: c.jid, name: c.name, presence: c.presence })),
      ...filteredSearchedUsers.map(u => ({ jid: u.jid, name: u.name, presence: 'unavailable' as const }))
    ];
  }, [contacts, searchedUsers]);

  const filteredContacts = allUsers.filter((contact) => {
    const name = contact.name || contact.jid?.split('@')?.[0] || '';
    return name.toLowerCase().includes(searchTerm.toLowerCase()) ||
           contact.jid.toLowerCase().includes(searchTerm.toLowerCase());
  });

  const filteredRooms = availableRooms.filter((room) => {
    return room.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
           room.jid.toLowerCase().includes(searchTerm.toLowerCase());
  });

  // Detect if search term looks like a MUC JID for quick join
  const mucJidPattern = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  const isValidMucJid = searchTerm.trim() && mucJidPattern.test(searchTerm.trim()) && 
                       (searchTerm.includes('@conference.') || searchTerm.includes('@muc.') || searchTerm.includes('@rooms.'));

  const handleQuickRoomJoin = async () => {
    if (!isValidMucJid || !nickname.trim()) return;
    await handleRoomJoin(searchTerm.trim());
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && isValidMucJid && nickname.trim()) {
      handleQuickRoomJoin();
    }
  };

  const getInitials = (name: string) => {
    return name?.split(' ').map(n => n?.[0] || '').join('').toUpperCase() || '?';
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookUser className="h-5 w-5" />
            Phonebook
          </DialogTitle>
          <DialogDescription>
            Search for users and join chat rooms on the XMPP network.
          </DialogDescription>
        </DialogHeader>
        
        <div className="space-y-4">
          {/* Connection Status */}
          {connectionError && (
            <div className="p-3 bg-destructive/10 text-destructive rounded-md border border-destructive/20 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 bg-destructive rounded-full" />
                <span className="text-sm">{connectionError}</span>
              </div>
              {uiConnection === 'connected' ? (
                <Button size="sm" variant="outline" onClick={handleRetry}>
                  Retry
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={() => connect()}>
                  Connect
                </Button>
              )}
            </div>
          )}

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search users and rooms... (try full JID like room@conference.domain.com)"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onKeyPress={handleKeyPress}
              className="pl-10"
              disabled={uiConnection !== 'connected'}
            />
          </div>

          {/* Quick Join Room by JID */}
          {isValidMucJid && (
            <div className="p-3 bg-primary/10 border border-primary/20 rounded-md">
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <p className="text-sm font-medium text-primary">Join room by JID</p>
                  <p className="text-xs text-muted-foreground truncate">{searchTerm.trim()}</p>
                </div>
                <Button 
                  size="sm" 
                  onClick={handleQuickRoomJoin}
                  disabled={!nickname.trim()}
                  className="ml-2"
                >
                  Join
                </Button>
              </div>
              {!nickname.trim() && (
                <p className="text-xs text-muted-foreground mt-1">Set a nickname in settings to join rooms</p>
              )}
            </div>
          )}

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
                    {searchTerm ? 'No users found' : 'No contacts available'}
                    </p>
                    {searchTerm && uiConnection === 'connected' && <p className="text-xs mt-1">User directory search may not be available on this server</p>}
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
            <div className="flex items-center justify-between">
                <h3 className="font-medium text-sm flex items-center gap-2">
                  <Users className="h-4 w-4" />
                  Rooms ({filteredRooms.length})
                </h3>
                <Button 
                  size="sm" 
                  variant="outline" 
                  onClick={handleLoadServices}
                  disabled={loadingServices || loadingRooms || uiConnection !== 'connected'}
                  className="text-xs h-7"
                >
                  {loadingServices || loadingRooms ? 'Loading...' : 'Refresh'}
                </Button>
              </div>

              {/* Service Selector */}
              {availableServices.length > 0 && (
                <div>
                  <label className="text-xs font-medium mb-1 block">Conference Service</label>
                  <Select value={selectedService} onValueChange={handleServiceChange}>
                    <SelectTrigger className="text-sm">
                      <SelectValue placeholder="All services" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All services</SelectItem>
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