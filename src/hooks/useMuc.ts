import { useState, useEffect, useCallback } from 'react';
import { XmppRoom } from '../types/xmpp';
import { useXmppMessaging } from '../contexts/XmppMessagingProvider';
import { xmppStorage } from '../lib/xmpp/storage';

export const useMuc = () => {
  const [rooms, setRooms] = useState<XmppRoom[]>([]);
  const [joinedRooms, setJoinedRooms] = useState<Set<string>>(new Set());
  const { joinRoom, leaveRoom, updateEventHandlers } = useXmppMessaging();

  // Listen for room events
  useEffect(() => {
    const handleRoomEvent = (roomJid: string, event: string, data: any) => {
      switch (event) {
        case 'joined':
          setJoinedRooms(prev => new Set([...prev, roomJid]));
          break;
        case 'left':
          setJoinedRooms(prev => {
            const updated = new Set(prev);
            updated.delete(roomJid);
            return updated;
          });
          break;
        case 'occupant-joined':
        case 'occupant-left':
        case 'subject-changed':
          // Update room data
          setRooms(prev => prev.map(room => 
            room.jid === roomJid 
              ? { ...room, ...data }
              : room
          ));
          break;
      }
    };

    updateEventHandlers({ onRoomEvent: handleRoomEvent });
  }, [updateEventHandlers]);

  const createRoom = useCallback(async (roomName: string, config?: {
    subject?: string;
    description?: string;
    persistent?: boolean;
    public?: boolean;
    membersOnly?: boolean;
    moderated?: boolean;
    password?: string;
  }) => {
    // In a real implementation, this would create a room via service discovery
    // and configure it using XEP-0045 and XEP-0004
    const roomJid = `${roomName}@conference.${window.location.hostname}`;
    
    const room: XmppRoom = {
      jid: roomJid,
      name: roomName,
      subject: config?.subject,
      description: config?.description,
      occupants: [],
      config: {
        persistent: config?.persistent ?? true,
        public: config?.public ?? true,
        membersOnly: config?.membersOnly ?? false,
        moderated: config?.moderated ?? false,
        passwordProtected: !!config?.password
      }
    };

    setRooms(prev => [...prev, room]);
    await joinRoom(roomJid);
    
    return roomJid;
  }, [joinRoom]);

  const joinExistingRoom = useCallback(async (roomJid: string, nick?: string) => {
    await joinRoom(roomJid, nick);
  }, [joinRoom]);

  const leaveExistingRoom = useCallback(async (roomJid: string) => {
    await leaveRoom(roomJid);
  }, [leaveRoom]);

  const destroyRoom = useCallback(async (roomJid: string) => {
    // This would send a room destruction request if user is owner
    // For now, we'll just leave the room
    await leaveRoom(roomJid);
    setRooms(prev => prev.filter(room => room.jid !== roomJid));
  }, [leaveRoom]);

  const inviteToRoom = useCallback(async (roomJid: string, userJid: string, reason?: string) => {
    // This would send an invitation using XEP-0045
    // Implementation would depend on the specific XMPP client capabilities
    console.log(`Inviting ${userJid} to ${roomJid}`, reason);
  }, []);

  const kickUser = useCallback(async (roomJid: string, userJid: string, reason?: string) => {
    // This would send a kick command if user has appropriate permissions
    console.log(`Kicking ${userJid} from ${roomJid}`, reason);
  }, []);

  const banUser = useCallback(async (roomJid: string, userJid: string, reason?: string) => {
    // This would send a ban command if user has appropriate permissions
    console.log(`Banning ${userJid} from ${roomJid}`, reason);
  }, []);

  const changeSubject = useCallback(async (roomJid: string, subject: string) => {
    // This would send a subject change message
    console.log(`Changing subject of ${roomJid} to: ${subject}`);
  }, []);

  const setBookmark = useCallback(async (roomJid: string, autoJoin = false, nick?: string) => {
    // Save bookmark to IndexedDB
    const bookmark = {
      jid: roomJid,
      autoJoin,
      nick,
      timestamp: new Date()
    };

    // In a real implementation, this would also sync with server bookmarks
    // using XEP-0048 (Bookmark Storage) or XEP-0402 (PEP Native Bookmarks)
    const store = await xmppStorage.getPublicStore('bookmarks', 'readwrite');
    return new Promise<void>((resolve, reject) => {
      const request = store.put(bookmark);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }, []);

  const removeBookmark = useCallback(async (roomJid: string) => {
    const store = await xmppStorage.getPublicStore('bookmarks', 'readwrite');
    return new Promise<void>((resolve, reject) => {
      const request = store.delete(roomJid);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }, []);

  const getBookmarks = useCallback(async () => {
    const store = await xmppStorage.getPublicStore('bookmarks');
    return new Promise<any[]>((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }, []);

  return {
    rooms,
    joinedRooms: Array.from(joinedRooms),
    createRoom,
    joinRoom: joinExistingRoom,
    leaveRoom: leaveExistingRoom,
    destroyRoom,
    inviteToRoom,
    kickUser,
    banUser,
    changeSubject,
    setBookmark,
    removeBookmark,
    getBookmarks
  };
};