// useRoster Hook - Contact management with shared roster support
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { xml, jid } from '@xmpp/client';
import { useXmppMessaging } from '@/contexts/XmppMessagingProvider';
import { xmppStorage } from '@/lib/xmpp/storage';
import { XmppContact } from '@/lib/xmpp/types';
import { useState, useEffect, useMemo } from 'react';

export interface UseRosterReturn {
  contacts: XmppContact[];
  allUsers: XmppContact[]; // Includes offline users from shared roster
  isLoading: boolean;
  error: string | null;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  filteredContacts: XmppContact[];
  addContact: (jid: string, name?: string) => Promise<void>;
  removeContact: (jid: string) => Promise<void>;
  blockContact: (jid: string) => Promise<void>;
  unblockContact: (jid: string) => Promise<void>;
  requestSubscription: (jid: string) => Promise<void>;
  acceptSubscription: (jid: string) => Promise<void>;
  refetch: () => void;
}

const ROSTER_QUERY_KEY = ['xmpp', 'roster'];
const SHARED_ROSTER_QUERY_KEY = ['xmpp', 'shared-roster'];

export const useRoster = (): UseRosterReturn => {
  const { client, myJid, status } = useXmppMessaging();
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState('');

  // Fetch roster (contacts with subscription)
  const { 
    data: contacts = [], 
    isLoading: rosterLoading, 
    error: rosterError,
    refetch: refetchRoster 
  } = useQuery({
    queryKey: ROSTER_QUERY_KEY,
    queryFn: async (): Promise<XmppContact[]> => {
      if (!client || status !== 'connected') {
        // Try to load from storage first
        return await xmppStorage.getContacts();
      }

      try {
        const rosterStanza = xml('iq', {
          type: 'get',
          id: client.generateId(),
        }, xml('query', { xmlns: 'jabber:iq:roster' }));

        const response = await client.iqRequest(rosterStanza);
        const query = response?.getChild('query', 'jabber:iq:roster');
        
        if (!query) return [];

        const items = query.getChildren('item');
        const rosterContacts: XmppContact[] = [];

        for (const item of items) {
          const contact: XmppContact = {
            jid: item.attrs.jid,
            name: item.attrs.name || jid(item.attrs.jid).local,
            subscription: item.attrs.subscription || 'none',
            presence: 'unavailable',
            ask: item.attrs.ask as 'subscribe' | undefined,
            groups: item.getChildren('group').map(g => g.getText()),
          };

          rosterContacts.push(contact);
          await xmppStorage.saveContact(contact);
        }

        return rosterContacts;
      } catch (error) {
        console.error('Failed to fetch roster:', error);
        // Fallback to storage
        return await xmppStorage.getContacts();
      }
    },
    enabled: !!client && status === 'connected',
    staleTime: 30000, // 30 seconds
  });

  // Fetch shared roster (all users including offline)
  const { 
    data: sharedRosterUsers = [], 
    isLoading: sharedLoading 
  } = useQuery({
    queryKey: SHARED_ROSTER_QUERY_KEY,
    queryFn: async (): Promise<XmppContact[]> => {
      if (!client || status !== 'connected') return [];

      try {
        // Query shared roster group "All Users"
        const discoStanza = xml('iq', {
          type: 'get',
          to: `groups.${client.getJid()?.split('@')[1]}`, // groups.domain
          id: client.generateId(),
        }, xml('query', { xmlns: 'http://jabber.org/protocol/disco#items' }));

        const response = await client.iqRequest(discoStanza);
        const query = response?.getChild('query', 'http://jabber.org/protocol/disco#items');
        
        if (!query) return [];

        const items = query.getChildren('item');
        const allUsers: XmppContact[] = [];

        for (const item of items) {
          const userJid = item.attrs.jid;
          if (userJid && userJid !== myJid) {
            const contact: XmppContact = {
              jid: userJid,
              name: item.attrs.name || jid(userJid).local,
              subscription: 'both', // Shared roster implies mutual subscription
              presence: 'unavailable',
              groups: ['All Users'],
            };
            
            allUsers.push(contact);
          }
        }

        return allUsers;
      } catch (error) {
        console.error('Failed to fetch shared roster:', error);
        return [];
      }
    },
    enabled: !!client && status === 'connected',
    staleTime: 60000, // 1 minute
  });

  // Merge contacts and shared roster users
  const allUsers = useMemo(() => {
    const contactMap = new Map(contacts.map(c => [c.jid, c]));
    const allUserMap = new Map<string, XmppContact>();

    // Add all contacts first
    contacts.forEach(contact => {
      allUserMap.set(contact.jid, contact);
    });

    // Add shared roster users, merging with existing contacts
    sharedRosterUsers.forEach(user => {
      const existing = contactMap.get(user.jid);
      if (existing) {
        // Merge data, preferring roster data over shared roster
        allUserMap.set(user.jid, {
          ...user,
          ...existing,
          groups: [...(existing.groups || []), ...(user.groups || [])],
        });
      } else {
        allUserMap.set(user.jid, user);
      }
    });

    return Array.from(allUserMap.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [contacts, sharedRosterUsers]);

  // Filter contacts based on search query
  const filteredContacts = useMemo(() => {
    if (!searchQuery.trim()) return allUsers;

    const query = searchQuery.toLowerCase();
    return allUsers.filter(contact => 
      contact.name.toLowerCase().includes(query) ||
      contact.jid.toLowerCase().includes(query)
    );
  }, [allUsers, searchQuery]);

  // Add contact mutation
  const addContactMutation = useMutation({
    mutationFn: async ({ jid: contactJid, name }: { jid: string; name?: string }) => {
      if (!client) throw new Error('Not connected');

      const addStanza = xml('iq', {
        type: 'set',
        id: client.generateId(),
      }, xml('query', { xmlns: 'jabber:iq:roster' },
        xml('item', { 
          jid: contactJid, 
          name: name || jid(contactJid).local 
        })
      ));

      await client.iqRequest(addStanza);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ROSTER_QUERY_KEY });
    },
  });

  // Remove contact mutation
  const removeContactMutation = useMutation({
    mutationFn: async (contactJid: string) => {
      if (!client) throw new Error('Not connected');

      const removeStanza = xml('iq', {
        type: 'set',
        id: client.generateId(),
      }, xml('query', { xmlns: 'jabber:iq:roster' },
        xml('item', { jid: contactJid, subscription: 'remove' })
      ));

      await client.iqRequest(removeStanza);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ROSTER_QUERY_KEY });
    },
  });

  // Subscription mutations
  const subscriptionMutation = useMutation({
    mutationFn: async ({ jid: contactJid, type }: { jid: string; type: 'subscribe' | 'subscribed' | 'unsubscribe' | 'unsubscribed' }) => {
      if (!client) throw new Error('Not connected');

      const presenceStanza = xml('presence', {
        to: contactJid,
        type,
      });

      await client.send(presenceStanza);
    },
  });

  // Blocking mutations (XEP-0191)
  const blockMutation = useMutation({
    mutationFn: async ({ jid: contactJid, block }: { jid: string; block: boolean }) => {
      if (!client) throw new Error('Not connected');

      const action = block ? 'block' : 'unblock';
      const blockStanza = xml('iq', {
        type: 'set',
        id: client.generateId(),
      }, xml(action, { xmlns: 'urn:xmpp:blocking' },
        xml('item', { jid: contactJid })
      ));

      await client.iqRequest(blockStanza);
    },
  });

  // Listen for presence updates
  useEffect(() => {
    if (!client) return;

    const handlePresence = (stanza: any) => {
      const from = stanza.attrs.from;
      const type = stanza.attrs.type;
      const show = stanza.getChildText('show');
      const status = stanza.getChildText('status');

      if (from) {
        const bareJid = jid(from).bare().toString();
        
        queryClient.setQueryData(ROSTER_QUERY_KEY, (oldContacts: XmppContact[] = []) => {
          return oldContacts.map(contact => {
            if (contact.jid === bareJid) {
              let presence: XmppContact['presence'] = 'available';
              
              if (type === 'unavailable') {
                presence = 'unavailable';
              } else if (show) {
                presence = show as XmppContact['presence'];
              }

              return {
                ...contact,
                presence,
                status,
                lastSeen: type === 'unavailable' ? new Date() : undefined,
              };
            }
            return contact;
          });
        });
      }
    };

    client.on('stanza', (stanza) => {
      if (stanza.name === 'presence') {
        handlePresence(stanza);
      }
    });

    return () => {
      client.off('stanza', handlePresence);
    };
  }, [client, queryClient]);

  const addContact = async (contactJid: string, name?: string) => {
    await addContactMutation.mutateAsync({ jid: contactJid, name });
  };

  const removeContact = async (contactJid: string) => {
    await removeContactMutation.mutateAsync(contactJid);
  };

  const blockContact = async (contactJid: string) => {
    await blockMutation.mutateAsync({ jid: contactJid, block: true });
  };

  const unblockContact = async (contactJid: string) => {
    await blockMutation.mutateAsync({ jid: contactJid, block: false });
  };

  const requestSubscription = async (contactJid: string) => {
    await subscriptionMutation.mutateAsync({ jid: contactJid, type: 'subscribe' });
  };

  const acceptSubscription = async (contactJid: string) => {
    await subscriptionMutation.mutateAsync({ jid: contactJid, type: 'subscribed' });
  };

  const refetch = () => {
    refetchRoster();
    queryClient.invalidateQueries({ queryKey: SHARED_ROSTER_QUERY_KEY });
  };

  return {
    contacts,
    allUsers,
    isLoading: rosterLoading || sharedLoading,
    error: rosterError ? String(rosterError) : null,
    searchQuery,
    setSearchQuery,
    filteredContacts,
    addContact,
    removeContact,
    blockContact,
    unblockContact,
    requestSubscription,
    acceptSubscription,
    refetch,
  };
};