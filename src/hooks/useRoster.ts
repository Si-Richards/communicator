import { useState, useEffect, useMemo } from 'react';
import { XmppContact } from '../types/xmpp';
import { xmppStorage } from '../lib/xmpp/storage';
import { useXmppMessaging } from '../contexts/XmppMessagingProvider';

export const useRoster = (searchQuery = '') => {
  const [contacts, setContacts] = useState<XmppContact[]>([]);
  const [loading, setLoading] = useState(true);
  const { updateEventHandlers } = useXmppMessaging();

  // Load initial roster
  useEffect(() => {
    const loadRoster = async () => {
      try {
        const rosterContacts = await xmppStorage.getRoster();
        setContacts(rosterContacts);
      } catch (error) {
        console.error('Failed to load roster:', error);
      } finally {
        setLoading(false);
      }
    };

    loadRoster();
  }, []);

  // Listen for presence updates
  useEffect(() => {
    const handlePresence = (contact: XmppContact) => {
      setContacts(prev => {
        const index = prev.findIndex(c => c.jid === contact.jid);
        if (index >= 0) {
          const updated = [...prev];
          updated[index] = contact;
          return updated;
        } else {
          return [...prev, contact];
        }
      });
    };

    updateEventHandlers({ onPresence: handlePresence });
  }, [updateEventHandlers]);

  // Filter contacts based on search query
  const filteredContacts = useMemo(() => {
    if (!searchQuery.trim()) return contacts;
    
    const query = searchQuery.toLowerCase();
    return contacts.filter(contact => 
      contact.name.toLowerCase().includes(query) ||
      contact.jid.toLowerCase().includes(query) ||
      contact.vCard?.fullName?.toLowerCase().includes(query) ||
      contact.vCard?.email?.toLowerCase().includes(query)
    );
  }, [contacts, searchQuery]);

  // Separate online and offline contacts
  const onlineContacts = useMemo(() => 
    filteredContacts.filter(c => c.presence !== 'unavailable')
      .sort((a, b) => a.name.localeCompare(b.name)),
    [filteredContacts]
  );

  const offlineContacts = useMemo(() => 
    filteredContacts.filter(c => c.presence === 'unavailable')
      .sort((a, b) => {
        // Sort by last seen, then by name
        if (a.lastSeen && b.lastSeen) {
          return b.lastSeen.getTime() - a.lastSeen.getTime();
        }
        if (a.lastSeen && !b.lastSeen) return -1;
        if (!a.lastSeen && b.lastSeen) return 1;
        return a.name.localeCompare(b.name);
      }),
    [filteredContacts]
  );

  const allContacts = [...onlineContacts, ...offlineContacts];

  return {
    contacts: allContacts,
    onlineContacts,
    offlineContacts,
    loading,
    totalCount: contacts.length,
    onlineCount: onlineContacts.length,
    offlineCount: offlineContacts.length
  };
};