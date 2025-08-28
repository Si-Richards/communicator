/**
 * vCard Management (XEP-0054, XEP-0153)
 * Handles user profiles and avatars
 */

import { xml } from '@xmpp/client';
import { XmppClient } from '../core/client';
import { XmppEventBus } from '../core/eventBus';
import { XmppUtils } from '../core/utils';
import { JidUtils } from '../core/jid';
import { logger } from '@/lib/logger';

export interface VCard {
  jid: string;
  fullName?: string;
  givenName?: string;
  familyName?: string;
  nickname?: string;
  email?: string;
  url?: string;
  organization?: string;
  title?: string;
  phone?: string;
  description?: string;
  avatar?: {
    type: string;
    data: string; // base64
    hash?: string;
  };
}

export class VCardManager {
  private client: XmppClient;
  private eventBus: XmppEventBus;
  private vcards = new Map<string, VCard>();
  private avatarCache = new Map<string, string>(); // hash -> data URL
  private pendingQueries = new Map<string, (result: any) => void>();

  constructor(client: XmppClient, eventBus: XmppEventBus) {
    this.client = client;
    this.eventBus = eventBus;
    this.loadAvatarCache();
  }

  async fetchVCard(jid?: string): Promise<VCard | null> {
    const targetJid = jid ? JidUtils.toBare(jid) : undefined;
    
    try {
      const iq = XmppUtils.createIq('get', targetJid);
      const vCard = xml('vCard', { xmlns: 'vcard-temp' });
      iq.cnode(vCard);

      const result = await this.sendIqQuery(iq);
      const card = this.parseVCard(result, targetJid || this.getOwnJid());
      
      if (card) {
        this.vcards.set(card.jid, card);
        this.eventBus.emit('vcard:updated', { vcard: card });
        
        // Cache avatar if present
        if (card.avatar) {
          this.cacheAvatar(card.avatar.hash!, card.avatar.data);
        }
      }
      
      return card;
    } catch (error) {
      logger.error('Error fetching vCard:', error);
      return null;
    }
  }

  async updateVCard(vcard: Partial<VCard>): Promise<boolean> {
    try {
      const iq = XmppUtils.createIq('set');
      const vCardElement = xml('vCard', { xmlns: 'vcard-temp' });
      
      // Build vCard XML
      if (vcard.fullName) {
        vCardElement.c('FN').t(vcard.fullName);
      }
      
      if (vcard.givenName || vcard.familyName) {
        const n = vCardElement.c('N');
        if (vcard.familyName) n.c('FAMILY').t(vcard.familyName);
        if (vcard.givenName) n.c('GIVEN').t(vcard.givenName);
      }
      
      if (vcard.nickname) {
        vCardElement.c('NICKNAME').t(vcard.nickname);
      }
      
      if (vcard.email) {
        vCardElement.c('EMAIL').c('USERID').t(vcard.email);
      }
      
      if (vcard.url) {
        vCardElement.c('URL').t(vcard.url);
      }
      
      if (vcard.organization) {
        vCardElement.c('ORG').c('ORGNAME').t(vcard.organization);
      }
      
      if (vcard.title) {
        vCardElement.c('TITLE').t(vcard.title);
      }
      
      if (vcard.phone) {
        vCardElement.c('TEL').c('NUMBER').t(vcard.phone);
      }
      
      if (vcard.description) {
        vCardElement.c('DESC').t(vcard.description);
      }
      
      if (vcard.avatar) {
        const photo = vCardElement.c('PHOTO');
        photo.c('TYPE').t(vcard.avatar.type);
        photo.c('BINVAL').t(vcard.avatar.data);
      }
      
      iq.cnode(vCardElement);
      
      await this.client.send(iq);
      
      // Update local cache
      const ownJid = this.getOwnJid();
      const existingCard = this.vcards.get(ownJid) || { jid: ownJid };
      const updatedCard = { ...existingCard, ...vcard };
      this.vcards.set(ownJid, updatedCard);
      
      this.eventBus.emit('vcard:updated', { vcard: updatedCard });
      
      // Update presence with avatar hash if avatar was updated
      if (vcard.avatar) {
        await this.updatePresenceWithAvatar(vcard.avatar.hash!);
      }
      
      logger.info('vCard updated successfully');
      return true;
    } catch (error) {
      logger.error('Error updating vCard:', error);
      return false;
    }
  }

  async updateAvatar(file: File): Promise<boolean> {
    try {
      // Convert file to base64
      const base64 = await this.fileToBase64(file);
      const hash = await this.generateAvatarHash(base64);
      
      const avatar = {
        type: file.type,
        data: base64,
        hash
      };
      
      // Update vCard with new avatar
      const success = await this.updateVCard({ avatar });
      
      if (success) {
        // Cache the avatar
        this.cacheAvatar(hash, base64);
        this.eventBus.emit('avatar:updated', { hash, data: base64 });
      }
      
      return success;
    } catch (error) {
      logger.error('Error updating avatar:', error);
      return false;
    }
  }

  getVCard(jid: string): VCard | undefined {
    return this.vcards.get(JidUtils.toBare(jid));
  }

  getAvatar(hash: string): string | undefined {
    return this.avatarCache.get(hash);
  }

  async getAvatarDataUrl(hash: string): Promise<string | null> {
    const cached = this.avatarCache.get(hash);
    if (cached) {
      return cached;
    }
    
    // Could implement fetching from other sources here
    return null;
  }

  canHandle(stanza: any): boolean {
    const vcard = XmppUtils.findChild(stanza, 'vCard', 'vcard-temp');
    return !!vcard;
  }

  handleStanza(stanza: any): void {
    const id = stanza.attrs.id;
    const type = stanza.attrs.type;
    
    const resolver = this.pendingQueries.get(id);
    if (!resolver) return;
    
    this.pendingQueries.delete(id);

    if (type === 'error') {
      const error = XmppUtils.findChild(stanza, 'error');
      const errorText = error ? XmppUtils.getTextContent(error) : 'Unknown error';
      resolver({ error: errorText });
      return;
    }

    const vcard = XmppUtils.findChild(stanza, 'vCard', 'vcard-temp');
    if (vcard) {
      resolver({ vcard });
    }
  }

  cleanup(): void {
    this.pendingQueries.clear();
    this.saveAvatarCache();
  }

  private async sendIqQuery(iq: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const queryId = iq.attrs.id;
      
      this.pendingQueries.set(queryId, (result) => {
        if (result.error) {
          reject(new Error(result.error));
        } else {
          resolve(result);
        }
      });

      setTimeout(() => {
        if (this.pendingQueries.has(queryId)) {
          this.pendingQueries.delete(queryId);
          reject(new Error('vCard query timeout'));
        }
      }, 10000);

      this.client.send(iq).catch(reject);
    });
  }

  private parseVCard(result: any, jid: string): VCard | null {
    const vcard = result.vcard;
    if (!vcard) return null;

    const card: VCard = { jid };

    // Parse name fields
    const fn = XmppUtils.findChild(vcard, 'FN');
    if (fn) {
      card.fullName = XmppUtils.getTextContent(fn);
    }

    const n = XmppUtils.findChild(vcard, 'N');
    if (n) {
      const given = XmppUtils.findChild(n, 'GIVEN');
      const family = XmppUtils.findChild(n, 'FAMILY');
      if (given) card.givenName = XmppUtils.getTextContent(given);
      if (family) card.familyName = XmppUtils.getTextContent(family);
    }

    const nickname = XmppUtils.findChild(vcard, 'NICKNAME');
    if (nickname) {
      card.nickname = XmppUtils.getTextContent(nickname);
    }

    // Parse contact fields
    const email = XmppUtils.findChild(vcard, 'EMAIL');
    if (email) {
      const userid = XmppUtils.findChild(email, 'USERID');
      if (userid) card.email = XmppUtils.getTextContent(userid);
    }

    const url = XmppUtils.findChild(vcard, 'URL');
    if (url) {
      card.url = XmppUtils.getTextContent(url);
    }

    const org = XmppUtils.findChild(vcard, 'ORG');
    if (org) {
      const orgname = XmppUtils.findChild(org, 'ORGNAME');
      if (orgname) card.organization = XmppUtils.getTextContent(orgname);
    }

    const title = XmppUtils.findChild(vcard, 'TITLE');
    if (title) {
      card.title = XmppUtils.getTextContent(title);
    }

    const tel = XmppUtils.findChild(vcard, 'TEL');
    if (tel) {
      const number = XmppUtils.findChild(tel, 'NUMBER');
      if (number) card.phone = XmppUtils.getTextContent(number);
    }

    const desc = XmppUtils.findChild(vcard, 'DESC');
    if (desc) {
      card.description = XmppUtils.getTextContent(desc);
    }

    // Parse photo/avatar
    const photo = XmppUtils.findChild(vcard, 'PHOTO');
    if (photo) {
      const type = XmppUtils.findChild(photo, 'TYPE');
      const binval = XmppUtils.findChild(photo, 'BINVAL');
      
      if (type && binval) {
        const avatarType = XmppUtils.getTextContent(type);
        const avatarData = XmppUtils.getTextContent(binval);
        
        if (avatarType && avatarData) {
          card.avatar = {
            type: avatarType,
            data: avatarData,
            hash: this.generateAvatarHashSync(avatarData)
          };
        }
      }
    }

    return card;
  }

  private async updatePresenceWithAvatar(hash: string): Promise<void> {
    try {
      const presence = XmppUtils.createPresence();
      const x = xml('x', { xmlns: 'vcard-temp:x:update' });
      x.c('photo').t(hash);
      presence.cnode(x);

      await this.client.send(presence);
      logger.debug('Presence updated with avatar hash:', hash);
    } catch (error) {
      logger.error('Error updating presence with avatar:', error);
    }
  }

  private async fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // Remove data URL prefix
        const base64 = result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  private async generateAvatarHash(base64Data: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(base64Data);
    const hashBuffer = await crypto.subtle.digest('SHA-1', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  private generateAvatarHashSync(base64Data: string): string {
    // Simple hash for now - in production you'd want to use a proper crypto library
    let hash = 0;
    for (let i = 0; i < base64Data.length; i++) {
      const char = base64Data.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString(16);
  }

  private cacheAvatar(hash: string, data: string): void {
    const dataUrl = `data:image/jpeg;base64,${data}`;
    this.avatarCache.set(hash, dataUrl);
    this.saveAvatarCache();
  }

  private saveAvatarCache(): void {
    try {
      const cacheData = Object.fromEntries(this.avatarCache.entries());
      localStorage.setItem('xmpp_avatar_cache', JSON.stringify(cacheData));
    } catch (error) {
      logger.error('Error saving avatar cache:', error);
    }
  }

  private loadAvatarCache(): void {
    try {
      const stored = localStorage.getItem('xmpp_avatar_cache');
      if (stored) {
        const cacheData = JSON.parse(stored);
        this.avatarCache = new Map(Object.entries(cacheData));
      }
    } catch (error) {
      logger.error('Error loading avatar cache:', error);
    }
  }

  private getOwnJid(): string {
    const config = this.client.getConfig();
    return config ? `${config.username}@${config.domain}` : '';
  }
}