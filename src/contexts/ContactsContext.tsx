import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';

export interface Contact {
  id: string;
  name: string;
  phoneNumbers: string[];
  email?: string;
  xmppJid?: string;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

interface ContactsContextType {
  contacts: Contact[];
  addContact: (contact: Omit<Contact, 'id' | 'createdAt' | 'updatedAt'>) => void;
  updateContact: (id: string, contact: Partial<Omit<Contact, 'id' | 'createdAt'>>) => void;
  deleteContact: (id: string) => void;
  getContactByPhoneNumber: (phoneNumber: string) => Contact | undefined;
  getContactByXmppJid: (xmppJid: string) => Contact | undefined;
  addPhoneNumber: (contactId: string, phoneNumber: string) => void;
  removePhoneNumber: (contactId: string, phoneNumber: string) => void;
  searchContacts: (query: string) => Contact[];
  exportContacts: () => string;
  importContacts: (data: string) => boolean;
  clearContacts: () => void;
}

const ContactsContext = createContext<ContactsContextType | undefined>(undefined);

const STORAGE_KEY = 'app-contacts';

export const ContactsProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [contacts, setContacts] = useState<Contact[]>([]);

  // Load contacts from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        // Convert date strings back to Date objects and migrate old format
        const contactsWithDates = parsed.map((contact: any) => ({
          ...contact,
          // Migrate from old phoneNumber format to new phoneNumbers array format
          phoneNumbers: contact.phoneNumbers || (contact.phoneNumber ? [contact.phoneNumber] : []),
          xmppJid: contact.xmppJid || undefined,
          createdAt: new Date(contact.createdAt),
          updatedAt: new Date(contact.updatedAt),
        }));
        setContacts(contactsWithDates);
      }
    } catch (error) {
      console.error('Failed to load contacts from localStorage:', error);
    }
  }, []);

  // Save contacts to localStorage whenever contacts change
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(contacts));
    } catch (error) {
      console.error('Failed to save contacts to localStorage:', error);
    }
  }, [contacts]);

  const addContact = (contactData: Omit<Contact, 'id' | 'createdAt' | 'updatedAt'>) => {
    const newContact: Contact = {
      ...contactData,
      id: crypto.randomUUID(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    setContacts(prev => [...prev, newContact]);
  };

  const updateContact = (id: string, updates: Partial<Omit<Contact, 'id' | 'createdAt'>>) => {
    setContacts(prev => prev.map(contact => 
      contact.id === id 
        ? { ...contact, ...updates, updatedAt: new Date() }
        : contact
    ));
  };

  const deleteContact = (id: string) => {
    setContacts(prev => prev.filter(contact => contact.id !== id));
  };

  const getContactByPhoneNumber = (phoneNumber: string): Contact | undefined => {
    // Clean phone number for comparison (remove spaces, dashes, etc.)
    const cleanPhoneNumber = phoneNumber.replace(/\D/g, '');
    return contacts.find(contact => {
      return contact.phoneNumbers.some(contactNumber => {
        const cleanContactNumber = contactNumber.replace(/\D/g, '');
        return cleanContactNumber === cleanPhoneNumber;
      });
    });
  };

  const getContactByXmppJid = (xmppJid: string): Contact | undefined => {
    if (!xmppJid) return undefined;
    
    // Normalize JID to bare JID (remove resource)
    const bareJid = xmppJid.split('/')[0].toLowerCase();
    
    return contacts.find(contact => {
      if (!contact.xmppJid) return false;
      const contactBareJid = contact.xmppJid.split('/')[0].toLowerCase();
      return contactBareJid === bareJid;
    });
  };

  const addPhoneNumber = (contactId: string, phoneNumber: string) => {
    setContacts(prev => prev.map(contact => 
      contact.id === contactId 
        ? { ...contact, phoneNumbers: [...contact.phoneNumbers, phoneNumber], updatedAt: new Date() }
        : contact
    ));
  };

  const removePhoneNumber = (contactId: string, phoneNumber: string) => {
    setContacts(prev => prev.map(contact => 
      contact.id === contactId 
        ? { ...contact, phoneNumbers: contact.phoneNumbers.filter(num => num !== phoneNumber), updatedAt: new Date() }
        : contact
    ));
  };

  const searchContacts = (query: string): Contact[] => {
    if (!query.trim()) return contacts;
    
    const lowercaseQuery = query.toLowerCase();
    return contacts.filter(contact =>
      contact.name.toLowerCase().includes(lowercaseQuery) ||
      contact.phoneNumbers.some(phone => phone.includes(query)) ||
      contact.email?.toLowerCase().includes(lowercaseQuery) ||
      contact.xmppJid?.toLowerCase().includes(lowercaseQuery) ||
      contact.notes?.toLowerCase().includes(lowercaseQuery)
    );
  };

  const exportContacts = (): string => {
    return JSON.stringify(contacts, null, 2);
  };

  const importContacts = (data: string): boolean => {
    try {
      const importedContacts = JSON.parse(data);
      if (!Array.isArray(importedContacts)) {
        throw new Error('Invalid data format');
      }
      
      // Validate and convert imported contacts
      const validContacts = importedContacts.map((contact: any) => ({
        id: contact.id || crypto.randomUUID(),
        name: contact.name || '',
        phoneNumbers: contact.phoneNumbers || (contact.phoneNumber ? [contact.phoneNumber] : []),
        email: contact.email || undefined,
        xmppJid: contact.xmppJid || undefined,
        notes: contact.notes || undefined,
        createdAt: contact.createdAt ? new Date(contact.createdAt) : new Date(),
        updatedAt: contact.updatedAt ? new Date(contact.updatedAt) : new Date(),
      }));
      
      setContacts(validContacts);
      return true;
    } catch (error) {
      console.error('Failed to import contacts:', error);
      return false;
    }
  };

  const clearContacts = () => {
    setContacts([]);
  };

  const value: ContactsContextType = {
    contacts,
    addContact,
    updateContact,
    deleteContact,
    getContactByPhoneNumber,
    getContactByXmppJid,
    searchContacts,
    exportContacts,
    importContacts,
    clearContacts,
    addPhoneNumber,
    removePhoneNumber,
  };

  return <ContactsContext.Provider value={value}>{children}</ContactsContext.Provider>;
};

export const useContacts = () => {
  const context = useContext(ContactsContext);
  if (context === undefined) {
    throw new Error('useContacts must be used within a ContactsProvider');
  }
  return context;
};