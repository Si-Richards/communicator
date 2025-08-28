/**
 * JID (Jabber Identifier) utilities for safe JID handling
 */

export interface ParsedJid {
  local?: string;    // username part
  domain: string;    // domain part
  resource?: string; // resource part
  bare: string;      // local@domain
  full: string;      // local@domain/resource
}

export class JidUtils {
  /**
   * Parse a JID string into its components
   */
  static parse(jid: string | null | undefined): ParsedJid | null {
    if (!jid || typeof jid !== 'string') {
      return null;
    }

    try {
      // Split on / first to separate resource
      const [bareJid, resource] = jid.split('/', 2);
      
      // Split bare JID on @ to separate local and domain
      const atIndex = bareJid.lastIndexOf('@');
      
      let local: string | undefined;
      let domain: string;
      
      if (atIndex === -1) {
        // No @, so this is just a domain
        domain = bareJid;
      } else {
        local = bareJid.substring(0, atIndex);
        domain = bareJid.substring(atIndex + 1);
      }

      if (!domain) {
        return null;
      }

      const bare = local ? `${local}@${domain}` : domain;
      const full = resource ? `${bare}/${resource}` : bare;

      return {
        local,
        domain,
        resource,
        bare,
        full
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Get bare JID (without resource)
   */
  static toBare(jid: string | null | undefined): string {
    const parsed = this.parse(jid);
    return parsed?.bare || '';
  }

  /**
   * Get domain from JID
   */
  static getDomain(jid: string | null | undefined): string {
    const parsed = this.parse(jid);
    return parsed?.domain || '';
  }

  /**
   * Get local part from JID
   */
  static getLocal(jid: string | null | undefined): string {
    const parsed = this.parse(jid);
    return parsed?.local || '';
  }

  /**
   * Get resource from JID
   */
  static getResource(jid: string | null | undefined): string {
    const parsed = this.parse(jid);
    return parsed?.resource || '';
  }

  /**
   * Check if two JIDs are equal (bare comparison)
   */
  static areEqual(jid1: string | null | undefined, jid2: string | null | undefined): boolean {
    return this.toBare(jid1) === this.toBare(jid2);
  }

  /**
   * Check if JID is valid
   */
  static isValid(jid: string | null | undefined): boolean {
    return this.parse(jid) !== null;
  }

  /**
   * Escape JID for use in XML
   */
  static escape(jid: string | null | undefined): string {
    if (!jid) return '';
    return jid
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Create a display name from JID
   */
  static toDisplayName(jid: string | null | undefined, fallback = 'Unknown'): string {
    if (!jid) return fallback;
    
    const parsed = this.parse(jid);
    if (!parsed) return fallback;
    
    return parsed.local || parsed.domain || fallback;
  }

  /**
   * Get initials from JID for avatar
   */
  static getInitials(jid: string | null | undefined): string {
    const displayName = this.toDisplayName(jid);
    if (!displayName || displayName === 'Unknown') return '?';
    
    return displayName
      .split(/\s+/)
      .map(word => word.charAt(0).toUpperCase())
      .slice(0, 2)
      .join('');
  }

  /**
   * Check if JID is a MUC room (contains conference or muc in domain)
   */
  static isMucJid(jid: string | null | undefined): boolean {
    const domain = this.getDomain(jid);
    return domain.includes('conference') || domain.includes('muc') || domain.includes('rooms');
  }

  /**
   * Build a JID from components
   */
  static build(local?: string, domain?: string, resource?: string): string {
    if (!domain) return '';
    
    let jid = domain;
    if (local) {
      jid = `${local}@${domain}`;
    }
    if (resource) {
      jid = `${jid}/${resource}`;
    }
    
    return jid;
  }
}