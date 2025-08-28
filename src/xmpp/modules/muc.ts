/**
 * Multi-User Chat (MUC) Management
 * Handles XEP-0045: Multi-User Chat
 */

import { xml } from '@xmpp/client';
import { XmppClient } from '../core/client';
import { XmppEventBus } from '../core/eventBus';
import { XmppUtils } from '../core/utils';
import { JidUtils } from '../core/jid';
import { logger } from '@/lib/logger';

export type RoomAffiliation = 'owner' | 'admin' | 'member' | 'outcast' | 'none';
export type RoomRole = 'moderator' | 'participant' | 'visitor' | 'none';

export interface RoomOccupant {
  nick: string;
  jid?: string;
  affiliation: RoomAffiliation;
  role: RoomRole;
  presence: 'available' | 'unavailable';
  status?: string;
}

export interface MucRoom {
  jid: string;
  name: string;
  nick: string;
  subject?: string;
  occupants: RoomOccupant[];
  joined: boolean;
  isOwner: boolean;
  isMuted: boolean;
  isBookmarked: boolean;
  password?: string;
  // Room configuration
  membersOnly?: boolean;
  moderated?: boolean;
  persistent?: boolean;
  public?: boolean;
}

export class MucManager {
  private client: XmppClient;
  private eventBus: XmppEventBus;
  private rooms = new Map<string, MucRoom>();
  private pendingQueries = new Map<string, (result: any) => void>();

  constructor(client: XmppClient, eventBus: XmppEventBus) {
    this.client = client;
    this.eventBus = eventBus;
  }

  async createRoom(roomJid: string, nick: string, config?: {
    name?: string;
    description?: string;
    password?: string;
    membersOnly?: boolean;
    moderated?: boolean;
    persistent?: boolean;
    public?: boolean;
  }): Promise<MucRoom> {
    // Join room to create it
    const room = await this.joinRoom(roomJid, nick);
    
    if (config) {
      try {
        // Configure room
        await this.configureRoom(roomJid, config);
        
        // Update room properties
        Object.assign(room, config);
        this.eventBus.emit('room:updated', { room });
      } catch (error) {
        logger.error('Error configuring room:', error);
      }
    }
    
    return room;
  }

  async joinRoom(roomJid: string, nick: string, password?: string): Promise<MucRoom> {
    const fullJid = `${roomJid}/${nick}`;
    
    const presence = XmppUtils.createPresence(undefined, fullJid);
    const x = xml('x', { xmlns: 'http://jabber.org/protocol/muc' });
    
    if (password) {
      x.c('password').t(password);
    }
    
    presence.cnode(x);
    
    await this.client.send(presence);
    
    // Create room object
    const room: MucRoom = {
      jid: roomJid,
      name: JidUtils.getLocal(roomJid) || roomJid,
      nick,
      occupants: [],
      joined: true,
      isOwner: false,
      isMuted: false,
      isBookmarked: false,
      password
    };
    
    this.rooms.set(roomJid, room);
    
    logger.info('Joined room:', roomJid, nick);
    this.eventBus.emit('room:joined', { room });
    
    return room;
  }

  async leaveRoom(roomJid: string): Promise<void> {
    const room = this.rooms.get(roomJid);
    if (!room) return;
    
    const fullJid = `${roomJid}/${room.nick}`;
    const presence = XmppUtils.createPresence('unavailable', fullJid);
    
    await this.client.send(presence);
    
    room.joined = false;
    this.eventBus.emit('room:left', { room });
    
    logger.info('Left room:', roomJid);
  }

  async destroyRoom(roomJid: string, reason?: string): Promise<void> {
    const iq = XmppUtils.createIq('set', roomJid);
    const query = xml('query', { xmlns: 'http://jabber.org/protocol/muc#owner' });
    const destroy = xml('destroy');
    
    if (reason) {
      destroy.c('reason').t(reason);
    }
    
    query.cnode(destroy);
    iq.cnode(query);
    
    await this.client.send(iq);
    
    this.rooms.delete(roomJid);
    this.eventBus.emit('room:destroyed', { roomJid, reason });
    
    logger.info('Destroyed room:', roomJid, reason);
  }

  async sendRoomMessage(roomJid: string, body: string): Promise<string> {
    const messageId = XmppUtils.generateId();
    const message = XmppUtils.createMessage('groupchat', roomJid);
    message.attrs.id = messageId;
    message.c('body').t(body);
    
    await this.client.send(message);
    
    logger.debug('Room message sent:', roomJid, messageId);
    return messageId;
  }

  async inviteToRoom(roomJid: string, userJid: string, reason?: string): Promise<void> {
    const message = XmppUtils.createMessage('normal', roomJid);
    const x = xml('x', { xmlns: 'http://jabber.org/protocol/muc#user' });
    const invite = xml('invite', { to: userJid });
    
    if (reason) {
      invite.c('reason').t(reason);
    }
    
    x.cnode(invite);
    message.cnode(x);
    
    await this.client.send(message);
    
    logger.info('Invitation sent:', roomJid, userJid, reason);
  }

  async kickFromRoom(roomJid: string, nick: string, reason?: string): Promise<void> {
    await this.setRole(roomJid, nick, 'none', reason);
  }

  async banFromRoom(roomJid: string, jid: string, reason?: string): Promise<void> {
    await this.setAffiliation(roomJid, jid, 'outcast', reason);
  }

  async setRoomSubject(roomJid: string, subject: string): Promise<void> {
    const message = XmppUtils.createMessage('groupchat', roomJid);
    message.c('subject').t(subject);
    
    await this.client.send(message);
    
    const room = this.rooms.get(roomJid);
    if (room) {
      room.subject = subject;
      this.eventBus.emit('room:updated', { room });
    }
    
    logger.info('Room subject changed:', roomJid, subject);
  }

  async bookmarkRoom(roomJid: string, name?: string, nick?: string): Promise<void> {
    const room = this.rooms.get(roomJid);
    if (room) {
      room.isBookmarked = true;
      this.eventBus.emit('room:bookmarked', { room });
      
      // Persist bookmark locally
      this.saveBookmark(roomJid, name || room.name, nick || room.nick);
    }
  }

  async removeBookmark(roomJid: string): Promise<void> {
    const room = this.rooms.get(roomJid);
    if (room) {
      room.isBookmarked = false;
      this.eventBus.emit('room:bookmarkRemoved', { room });
      
      // Remove bookmark locally
      this.removeBookmarkFromStorage(roomJid);
    }
  }

  canHandle(stanza: any): boolean {
    const from = stanza.attrs.from;
    if (!from) return false;
    
    // Check if it's a MUC-related stanza
    const x = XmppUtils.findChild(stanza, 'x', 'http://jabber.org/protocol/muc#user');
    if (x) return true;
    
    // Check if it's from a known room
    const bareFrom = JidUtils.toBare(from);
    return this.rooms.has(bareFrom);
  }

  handleStanza(stanza: any): void {
    const name = stanza.name;
    const from = stanza.attrs.from;
    
    if (!from) return;
    
    const bareFrom = JidUtils.toBare(from);
    const resource = JidUtils.getResource(from);
    
    switch (name) {
      case 'presence':
        this.handleRoomPresence(stanza, bareFrom, resource);
        break;
      case 'message':
        this.handleRoomMessage(stanza, bareFrom);
        break;
      case 'iq':
        this.handleRoomIq(stanza);
        break;
    }
  }

  getRooms(): MucRoom[] {
    return Array.from(this.rooms.values());
  }

  getRoom(roomJid: string): MucRoom | undefined {
    return this.rooms.get(roomJid);
  }

  cleanup(): void {
    // Leave all rooms
    for (const room of this.rooms.values()) {
      if (room.joined) {
        this.leaveRoom(room.jid).catch(console.error);
      }
    }
  }

  private async configureRoom(roomJid: string, config: any): Promise<void> {
    const iq = XmppUtils.createIq('set', roomJid);
    const query = xml('query', { xmlns: 'http://jabber.org/protocol/muc#owner' });
    const x = xml('x', { xmlns: 'jabber:x:data', type: 'submit' });
    
    // Add configuration fields
    if (config.name) {
      x.c('field', { var: 'muc#roomconfig_roomname' })
        .c('value').t(config.name);
    }
    
    if (config.description) {
      x.c('field', { var: 'muc#roomconfig_roomdesc' })
        .c('value').t(config.description);
    }
    
    if (config.password) {
      x.c('field', { var: 'muc#roomconfig_passwordprotectedroom' })
        .c('value').t('1');
      x.c('field', { var: 'muc#roomconfig_roomsecret' })
        .c('value').t(config.password);
    }
    
    if (config.membersOnly !== undefined) {
      x.c('field', { var: 'muc#roomconfig_membersonly' })
        .c('value').t(config.membersOnly ? '1' : '0');
    }
    
    if (config.moderated !== undefined) {
      x.c('field', { var: 'muc#roomconfig_moderatedroom' })
        .c('value').t(config.moderated ? '1' : '0');
    }
    
    if (config.persistent !== undefined) {
      x.c('field', { var: 'muc#roomconfig_persistentroom' })
        .c('value').t(config.persistent ? '1' : '0');
    }
    
    if (config.public !== undefined) {
      x.c('field', { var: 'muc#roomconfig_publicroom' })
        .c('value').t(config.public ? '1' : '0');
    }
    
    query.cnode(x);
    iq.cnode(query);
    
    await this.client.send(iq);
  }

  private async setRole(roomJid: string, nick: string, role: RoomRole, reason?: string): Promise<void> {
    const iq = XmppUtils.createIq('set', roomJid);
    const query = xml('query', { xmlns: 'http://jabber.org/protocol/muc#admin' });
    const item = xml('item', { nick, role });
    
    if (reason) {
      item.c('reason').t(reason);
    }
    
    query.cnode(item);
    iq.cnode(query);
    
    await this.client.send(iq);
  }

  private async setAffiliation(roomJid: string, jid: string, affiliation: RoomAffiliation, reason?: string): Promise<void> {
    const iq = XmppUtils.createIq('set', roomJid);
    const query = xml('query', { xmlns: 'http://jabber.org/protocol/muc#admin' });
    const item = xml('item', { jid, affiliation });
    
    if (reason) {
      item.c('reason').t(reason);
    }
    
    query.cnode(item);
    iq.cnode(query);
    
    await this.client.send(iq);
  }

  private handleRoomPresence(stanza: any, roomJid: string, nick: string): void {
    const type = stanza.attrs.type;
    const room = this.rooms.get(roomJid);
    
    if (!room) return;
    
    const x = XmppUtils.findChild(stanza, 'x', 'http://jabber.org/protocol/muc#user');
    if (!x) return;
    
    const item = XmppUtils.findChild(x, 'item');
    if (!item) return;
    
    const affiliation = XmppUtils.getAttribute(item, 'affiliation') as RoomAffiliation || 'none';
    const role = XmppUtils.getAttribute(item, 'role') as RoomRole || 'none';
    const jid = XmppUtils.getAttribute(item, 'jid');
    
    if (type === 'unavailable') {
      // Remove occupant
      room.occupants = room.occupants.filter(o => o.nick !== nick);
    } else {
      // Add or update occupant
      const existingIndex = room.occupants.findIndex(o => o.nick === nick);
      const occupant: RoomOccupant = {
        nick,
        jid,
        affiliation,
        role,
        presence: 'available'
      };
      
      if (existingIndex >= 0) {
        room.occupants[existingIndex] = occupant;
      } else {
        room.occupants.push(occupant);
      }
      
      // Check if we're the owner
      if (nick === room.nick && affiliation === 'owner') {
        room.isOwner = true;
      }
    }
    
    this.eventBus.emit('room:occupantsChanged', { room });
    logger.debug('Room occupant update:', roomJid, nick, type);
  }

  private handleRoomMessage(stanza: any, roomJid: string): void {
    const type = stanza.attrs.type;
    
    if (type === 'groupchat') {
      // Handle regular room message - will be processed by MessageManager
      return;
    }
    
    // Handle room subject
    const subject = XmppUtils.findChild(stanza, 'subject');
    if (subject) {
      const subjectText = XmppUtils.getTextContent(subject);
      const room = this.rooms.get(roomJid);
      
      if (room) {
        room.subject = subjectText;
        this.eventBus.emit('room:subjectChanged', { room, subject: subjectText });
        logger.info('Room subject changed:', roomJid, subjectText);
      }
    }
    
    // Handle invitations
    const x = XmppUtils.findChild(stanza, 'x', 'http://jabber.org/protocol/muc#user');
    if (x) {
      const invite = XmppUtils.findChild(x, 'invite');
      if (invite) {
        const from = XmppUtils.getAttribute(invite, 'from');
        const reason = XmppUtils.getTextContent(XmppUtils.findChild(invite, 'reason'));
        
        this.eventBus.emit('room:invitation', { 
          roomJid, 
          from, 
          reason 
        });
        
        logger.info('Room invitation received:', roomJid, from, reason);
      }
    }
  }

  private handleRoomIq(stanza: any): void {
    // Handle room-related IQ stanzas if needed
    // Most room operations use presence and message stanzas
  }

  private saveBookmark(roomJid: string, name: string, nick: string): void {
    try {
      const bookmarks = this.getBookmarks();
      bookmarks[roomJid] = { name, nick, timestamp: new Date().toISOString() };
      localStorage.setItem('xmpp_room_bookmarks', JSON.stringify(bookmarks));
    } catch (error) {
      logger.error('Error saving bookmark:', error);
    }
  }

  private removeBookmarkFromStorage(roomJid: string): void {
    try {
      const bookmarks = this.getBookmarks();
      delete bookmarks[roomJid];
      localStorage.setItem('xmpp_room_bookmarks', JSON.stringify(bookmarks));
    } catch (error) {
      logger.error('Error removing bookmark:', error);
    }
  }

  private getBookmarks(): any {
    try {
      const stored = localStorage.getItem('xmpp_room_bookmarks');
      return stored ? JSON.parse(stored) : {};
    } catch (error) {
      logger.error('Error loading bookmarks:', error);
      return {};
    }
  }
}