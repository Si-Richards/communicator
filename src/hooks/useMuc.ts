// useMuc Hook - Multi-User Chat (XEP-0045) management
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { xml, jid } from '@xmpp/client';
import { useXmppMessaging } from '@/contexts/XmppMessagingProvider';
import { xmppStorage } from '@/lib/xmpp/storage';
import { MucRoom, RoomOccupant } from '@/lib/xmpp/types';
import { useState, useEffect } from 'react';

export interface UseMucReturn {
  // Room management
  joinedRooms: MucRoom[];
  availableRooms: Array<{ jid: string; name: string; description?: string }>;
  isLoading: boolean;
  error: string | null;
  
  // Actions
  createRoom: (jid: string, name: string, config?: RoomConfig) => Promise<void>;
  joinRoom: (jid: string, nick: string, password?: string) => Promise<void>;
  leaveRoom: (jid: string) => Promise<void>;
  destroyRoom: (jid: string, reason?: string) => Promise<void>;
  
  // Room configuration
  configureRoom: (jid: string, config: RoomConfig) => Promise<void>;
  changeSubject: (jid: string, subject: string) => Promise<void>;
  
  // Occupant management
  inviteUser: (roomJid: string, userJid: string, reason?: string) => Promise<void>;
  kickUser: (roomJid: string, nick: string, reason?: string) => Promise<void>;
  banUser: (roomJid: string, jid: string, reason?: string) => Promise<void>;
  grantModerator: (roomJid: string, nick: string) => Promise<void>;
  revokeModerator: (roomJid: string, nick: string) => Promise<void>;
  
  // Bookmarks
  bookmarks: Array<{ jid: string; name: string; autoJoin: boolean }>;
  addBookmark: (jid: string, name: string, autoJoin?: boolean) => Promise<void>;
  removeBookmark: (jid: string) => Promise<void>;
  
  // Discovery
  discoverRooms: (mucService?: string) => Promise<void>;
  
  // Room utilities
  getRoom: (jid: string) => MucRoom | undefined;
  isOwner: (roomJid: string) => boolean;
  isModerator: (roomJid: string) => boolean;
  canInvite: (roomJid: string) => boolean;
}

interface RoomConfig {
  title?: string;
  description?: string;
  persistent?: boolean;
  public?: boolean;
  membersOnly?: boolean;
  moderated?: boolean;
  passwordProtected?: boolean;
  password?: string;
  maxUsers?: number;
  allowInvites?: boolean;
  enableLogging?: boolean;
  changeSubject?: boolean;
}

const MUC_ROOMS_QUERY_KEY = ['xmpp', 'muc', 'rooms'];
const MUC_DISCOVERY_QUERY_KEY = ['xmpp', 'muc', 'discovery'];
const MUC_BOOKMARKS_QUERY_KEY = ['xmpp', 'muc', 'bookmarks'];

export const useMuc = (): UseMucReturn => {
  const { client, myJid, status, features } = useXmppMessaging();
  const queryClient = useQueryClient();
  const [joinedRooms, setJoinedRooms] = useState<MucRoom[]>([]);

  // Load bookmarks
  const { data: bookmarks = [] } = useQuery({
    queryKey: MUC_BOOKMARKS_QUERY_KEY,
    queryFn: () => xmppStorage.getBookmarks(),
    staleTime: 60000, // 1 minute
  });

  // Discover available rooms
  const { 
    data: availableRooms = [], 
    isLoading, 
    error,
    refetch: discoverRooms 
  } = useQuery({
    queryKey: MUC_DISCOVERY_QUERY_KEY,
    queryFn: async () => {
      if (!client || !myJid) return [];

      try {
        const domain = jid(myJid).domain;
        const mucService = `conference.${domain}`;
        
        const discoStanza = xml('iq', {
          type: 'get',
          to: mucService,
          id: client.generateId(),
        }, xml('query', { xmlns: 'http://jabber.org/protocol/disco#items' }));

        const response = await client.client?.iqCaller.request(discoStanza);
        const query = response?.getChild('query', 'http://jabber.org/protocol/disco#items');
        
        if (!query) return [];

        const items = query.getChildren('item');
        const rooms = items.map(item => ({
          jid: item.attrs.jid,
          name: item.attrs.name || jid(item.attrs.jid).local,
          description: item.attrs.description,
        }));

        return rooms;
      } catch (error) {
        console.error('Failed to discover rooms:', error);
        return [];
      }
    },
    enabled: !!client && !!myJid && status === 'connected' && features.muc,
    staleTime: 300000, // 5 minutes
  });

  // Create room mutation
  const createRoomMutation = useMutation({
    mutationFn: async ({ jid: roomJid, name, config = {} }: { jid: string; name: string; config?: RoomConfig }) => {
      if (!client || !myJid) throw new Error('Not connected');

      const nick = jid(myJid).local;
      
      // Join room to create it
      const joinStanza = xml('presence', {
        to: `${roomJid}/${nick}`,
      }, xml('x', { xmlns: 'http://jabber.org/protocol/muc' }));

      await client.send(joinStanza);
      
      // Configure room if owner
      if (Object.keys(config).length > 0) {
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for owner status
        await configureRoomMutation.mutateAsync({ jid: roomJid, config });
      }
      
      // Add to bookmarks
      await xmppStorage.saveBookmark(roomJid, name, false);
      
      return roomJid;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: MUC_DISCOVERY_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: MUC_BOOKMARKS_QUERY_KEY });
    },
  });

  // Join room mutation
  const joinRoomMutation = useMutation({
    mutationFn: async ({ jid: roomJid, nick, password }: { jid: string; nick: string; password?: string }) => {
      if (!client) throw new Error('Not connected');

      const joinStanza = xml('presence', {
        to: `${roomJid}/${nick}`,
      }, xml('x', { xmlns: 'http://jabber.org/protocol/muc' },
          password && xml('password', {}, password)
        )
      );

      await client.send(joinStanza);
      return roomJid;
    },
  });

  // Leave room mutation
  const leaveRoomMutation = useMutation({
    mutationFn: async (roomJid: string) => {
      if (!client) throw new Error('Not connected');

      const room = joinedRooms.find(r => r.jid === roomJid);
      if (!room) return;

      const leaveStanza = xml('presence', {
        to: `${roomJid}/${room.nick}`,
        type: 'unavailable',
      });

      await client.send(leaveStanza);
      
      // Remove from joined rooms
      setJoinedRooms(prev => prev.filter(r => r.jid !== roomJid));
      
      return roomJid;
    },
  });

  // Configure room mutation
  const configureRoomMutation = useMutation({
    mutationFn: async ({ jid: roomJid, config }: { jid: string; config: RoomConfig }) => {
      if (!client) throw new Error('Not connected');

      // First get the configuration form
      const getConfigStanza = xml('iq', {
        type: 'get',
        to: roomJid,
        id: client.generateId(),
      }, xml('query', { xmlns: 'http://jabber.org/protocol/muc#owner' }));

      const configResponse = await client.client?.iqCaller.request(getConfigStanza);
      const configForm = configResponse?.getChild('query', 'http://jabber.org/protocol/muc#owner')
        ?.getChild('x', 'jabber:x:data');

      if (!configForm) throw new Error('No configuration form received');

      // Create submit form with new configuration
      const submitForm = xml('x', { xmlns: 'jabber:x:data', type: 'submit' });
      
      // Add form type
      submitForm.append(xml('field', { var: 'FORM_TYPE', type: 'hidden' },
        xml('value', {}, 'http://jabber.org/protocol/muc#roomconfig')
      ));

      // Add configuration fields
      if (config.title !== undefined) {
        submitForm.append(xml('field', { var: 'muc#roomconfig_roomname' },
          xml('value', {}, config.title)
        ));
      }
      
      if (config.description !== undefined) {
        submitForm.append(xml('field', { var: 'muc#roomconfig_roomdesc' },
          xml('value', {}, config.description)
        ));
      }
      
      if (config.persistent !== undefined) {
        submitForm.append(xml('field', { var: 'muc#roomconfig_persistentroom' },
          xml('value', {}, config.persistent ? '1' : '0')
        ));
      }
      
      if (config.public !== undefined) {
        submitForm.append(xml('field', { var: 'muc#roomconfig_publicroom' },
          xml('value', {}, config.public ? '1' : '0')
        ));
      }
      
      if (config.membersOnly !== undefined) {
        submitForm.append(xml('field', { var: 'muc#roomconfig_membersonly' },
          xml('value', {}, config.membersOnly ? '1' : '0')
        ));
      }
      
      if (config.moderated !== undefined) {
        submitForm.append(xml('field', { var: 'muc#roomconfig_moderatedroom' },
          xml('value', {}, config.moderated ? '1' : '0')
        ));
      }
      
      if (config.passwordProtected !== undefined) {
        submitForm.append(xml('field', { var: 'muc#roomconfig_passwordprotectedroom' },
          xml('value', {}, config.passwordProtected ? '1' : '0')
        ));
      }
      
      if (config.password !== undefined) {
        submitForm.append(xml('field', { var: 'muc#roomconfig_roomsecret' },
          xml('value', {}, config.password)
        ));
      }
      
      if (config.maxUsers !== undefined) {
        submitForm.append(xml('field', { var: 'muc#roomconfig_maxusers' },
          xml('value', {}, config.maxUsers.toString())
        ));
      }

      // Submit configuration
      const setConfigStanza = xml('iq', {
        type: 'set',
        to: roomJid,
        id: client.generateId(),
      }, xml('query', { xmlns: 'http://jabber.org/protocol/muc#owner' },
          submitForm
        )
      );

      await client.client?.iqCaller.request(setConfigStanza);
      return roomJid;
    },
  });

  // Destroy room mutation
  const destroyRoomMutation = useMutation({
    mutationFn: async ({ jid: roomJid, reason }: { jid: string; reason?: string }) => {
      if (!client) throw new Error('Not connected');

      const destroyStanza = xml('iq', {
        type: 'set',
        to: roomJid,
        id: client.generateId(),
      }, xml('query', { xmlns: 'http://jabber.org/protocol/muc#owner' },
          xml('destroy', { jid: roomJid },
            reason && xml('reason', {}, reason)
          )
        )
      );

      await client.client?.iqCaller.request(destroyStanza);
      
      // Remove from joined rooms and bookmarks
      setJoinedRooms(prev => prev.filter(r => r.jid !== roomJid));
      // Note: Bookmark removal would be handled separately
      
      return roomJid;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: MUC_DISCOVERY_QUERY_KEY });
    },
  });

  // Room administration mutations
  const kickUserMutation = useMutation({
    mutationFn: async ({ roomJid, nick, reason }: { roomJid: string; nick: string; reason?: string }) => {
      if (!client) throw new Error('Not connected');

      const kickStanza = xml('iq', {
        type: 'set',
        to: roomJid,
        id: client.generateId(),
      }, xml('query', { xmlns: 'http://jabber.org/protocol/muc#admin' },
          xml('item', { nick, role: 'none' },
            reason && xml('reason', {}, reason)
          )
        )
      );

      await client.client?.iqCaller.request(kickStanza);
    },
  });

  const banUserMutation = useMutation({
    mutationFn: async ({ roomJid, jid: userJid, reason }: { roomJid: string; jid: string; reason?: string }) => {
      if (!client) throw new Error('Not connected');

      const banStanza = xml('iq', {
        type: 'set',
        to: roomJid,
        id: client.generateId(),
      }, xml('query', { xmlns: 'http://jabber.org/protocol/muc#admin' },
          xml('item', { jid: userJid, affiliation: 'outcast' },
            reason && xml('reason', {}, reason)
          )
        )
      );

      await client.client?.iqCaller.request(banStanza);
    },
  });

  // Bookmark mutations
  const bookmarkMutation = useMutation({
    mutationFn: async ({ jid: roomJid, name, autoJoin = false, remove = false }: 
      { jid: string; name: string; autoJoin?: boolean; remove?: boolean }) => {
      if (remove) {
        // Remove bookmark logic would go here
        // For now, we'll just update local storage
        return roomJid;
      } else {
        await xmppStorage.saveBookmark(roomJid, name, autoJoin);
        return roomJid;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: MUC_BOOKMARKS_QUERY_KEY });
    },
  });

  // Listen for MUC presence and messages
  useEffect(() => {
    if (!client) return;

    const handleStanza = (stanza: any) => {
      if (stanza.name === 'presence') {
        const from = stanza.attrs.from;
        const type = stanza.attrs.type;
        
        if (from?.includes('/')) { // Room presence
          const [roomJid, nick] = from.split('/');
          const mucUser = stanza.getChild('x', 'http://jabber.org/protocol/muc#user');
          
          if (mucUser) {
            const item = mucUser.getChild('item');
            const status = mucUser.getChildren('status');
            
            // Handle self-presence (joining/leaving rooms)
            const isSelfPresence = status.some(s => ['110', '201'].includes(s.attrs.code));
            
            if (isSelfPresence && type !== 'unavailable') {
              // We joined a room
              const room: MucRoom = {
                jid: roomJid,
                name: roomJid.split('@')[0],
                type: 'groupchat',
                nick,
                joined: true,
                subject: '',
                messages: [],
                occupants: [],
                unreadCount: 0,
                lastActivity: new Date(),
                isOwner: status.some(s => s.attrs.code === '201'), // Room created
                isModerator: item?.attrs.role === 'moderator',
                canInvite: true,
                canChangeSubject: true,
                pinned: false,
                muted: false,
                hidden: false,
                archived: false,
                hasMoreHistory: true,
                isTyping: false,
                typingUsers: [],
              };
              
              setJoinedRooms(prev => {
                const exists = prev.find(r => r.jid === roomJid);
                if (exists) return prev;
                return [...prev, room];
              });
            } else if (isSelfPresence && type === 'unavailable') {
              // We left a room
              setJoinedRooms(prev => prev.filter(r => r.jid !== roomJid));
            }
            
            // Update occupant list
            if (item) {
              setJoinedRooms(prev => prev.map(room => {
                if (room.jid === roomJid) {
                  const occupant: RoomOccupant = {
                    nick,
                    jid: item.attrs.jid,
                    affiliation: item.attrs.affiliation || 'none',
                    role: item.attrs.role || 'none',
                    presence: type === 'unavailable' ? 'unavailable' : 'available',
                    status: stanza.getChildText('status'),
                  };
                  
                  const occupants = room.occupants.filter(o => o.nick !== nick);
                  if (type !== 'unavailable') {
                    occupants.push(occupant);
                  }
                  
                  return { ...room, occupants };
                }
                return room;
              }));
            }
          }
        }
      }
    };

    client.on('stanza', handleStanza);

    return () => {
      client.off('stanza', handleStanza);
    };
  }, [client]);

  // Auto-join bookmarked rooms on connect
  useEffect(() => {
    if (status === 'connected' && bookmarks.length > 0) {
      const autoJoinRooms = bookmarks.filter(b => b.autoJoin);
      
      for (const bookmark of autoJoinRooms) {
        const nick = myJid ? jid(myJid).local : 'user';
        joinRoomMutation.mutate({ jid: bookmark.jid, nick });
      }
    }
  }, [status, bookmarks, myJid]);

  // Helper functions
  const getRoom = (roomJid: string) => {
    return joinedRooms.find(room => room.jid === roomJid);
  };

  const isOwner = (roomJid: string) => {
    const room = getRoom(roomJid);
    return room?.isOwner || false;
  };

  const isModerator = (roomJid: string) => {
    const room = getRoom(roomJid);
    return room?.isModerator || false;
  };

  const canInvite = (roomJid: string) => {
    const room = getRoom(roomJid);
    return room?.canInvite || false;
  };

  return {
    joinedRooms,
    availableRooms,
    isLoading,
    error: error ? String(error) : null,
    createRoom: (jid, name, config) => createRoomMutation.mutateAsync({ jid, name, config }),
    joinRoom: (jid, nick, password) => joinRoomMutation.mutateAsync({ jid, nick, password }),
    leaveRoom: (jid) => leaveRoomMutation.mutateAsync(jid),
    destroyRoom: (jid, reason) => destroyRoomMutation.mutateAsync({ jid, reason }),
    configureRoom: (jid, config) => configureRoomMutation.mutateAsync({ jid, config }),
    changeSubject: async (roomJid: string, subject: string) => {
      if (!client) throw new Error('Not connected');
      
      const subjectStanza = xml('message', {
        to: roomJid,
        type: 'groupchat',
      }, xml('subject', {}, subject));
      
      await client.send(subjectStanza);
    },
    inviteUser: async (roomJid: string, userJid: string, reason?: string) => {
      if (!client) throw new Error('Not connected');
      
      const inviteStanza = xml('message', {
        to: roomJid,
      }, xml('x', { xmlns: 'http://jabber.org/protocol/muc#user' },
          xml('invite', { to: userJid },
            reason && xml('reason', {}, reason)
          )
        )
      );
      
      await client.send(inviteStanza);
    },
    kickUser: (roomJid, nick, reason) => kickUserMutation.mutateAsync({ roomJid, nick, reason }),
    banUser: (roomJid, jid, reason) => banUserMutation.mutateAsync({ roomJid, jid, reason }),
    grantModerator: async (roomJid: string, nick: string) => {
      if (!client) throw new Error('Not connected');
      
      const moderatorStanza = xml('iq', {
        type: 'set',
        to: roomJid,
        id: client.generateId(),
      }, xml('query', { xmlns: 'http://jabber.org/protocol/muc#admin' },
          xml('item', { nick, role: 'moderator' })
        )
      );
      
      await client.client?.iqCaller.request(moderatorStanza);
    },
    revokeModerator: async (roomJid: string, nick: string) => {
      if (!client) throw new Error('Not connected');
      
      const revokeStanza = xml('iq', {
        type: 'set',
        to: roomJid,
        id: client.generateId(),
      }, xml('query', { xmlns: 'http://jabber.org/protocol/muc#admin' },
          xml('item', { nick, role: 'participant' })
        )
      );
      
      await client.client?.iqCaller.request(revokeStanza);
    },
    bookmarks,
    addBookmark: (jid, name, autoJoin) => bookmarkMutation.mutateAsync({ jid, name, autoJoin }),
    removeBookmark: (jid) => bookmarkMutation.mutateAsync({ jid, name: '', remove: true }),
    discoverRooms: () => discoverRooms(),
    getRoom,
    isOwner,
    isModerator,
    canInvite,
  };
};