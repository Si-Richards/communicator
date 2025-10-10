import React, { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useXmpp } from '@/contexts/XmppContext';
import { useContacts } from '@/contexts/ContactsContext';
import { ScrollArea } from '@/components/ui/scroll-area';
import { MessageSquare, UserPlus } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

interface ImportXmppContactsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const ImportXmppContactsDialog: React.FC<ImportXmppContactsDialogProps> = ({ open, onOpenChange }) => {
  const { contacts: xmppContacts } = useXmpp();
  const { contacts: phoneContacts, addContact, getContactByXmppJid } = useContacts();
  const [selectedJids, setSelectedJids] = useState<Set<string>>(new Set());
  const { toast } = useToast();

  // Filter XMPP contacts that aren't already in phone contacts
  const importableContacts = xmppContacts.filter(xc => !getContactByXmppJid(xc.jid));

  const handleToggle = (jid: string) => {
    setSelectedJids(prev => {
      const newSet = new Set(prev);
      if (newSet.has(jid)) {
        newSet.delete(jid);
      } else {
        newSet.add(jid);
      }
      return newSet;
    });
  };

  const handleImport = () => {
    let importedCount = 0;
    selectedJids.forEach(jid => {
      const xmppContact = xmppContacts.find(c => c.jid === jid);
      if (xmppContact) {
        addContact({
          name: xmppContact.name || jid.split('@')[0],
          phoneNumbers: [],
          xmppJid: xmppContact.jid,
          notes: `Imported from XMPP roster`
        });
        importedCount++;
      }
    });
    
    toast({
      title: "Contacts imported",
      description: `Successfully imported ${importedCount} contact${importedCount !== 1 ? 's' : ''} from chat.`,
    });
    
    setSelectedJids(new Set());
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Import XMPP Contacts</DialogTitle>
          <DialogDescription>
            Select XMPP contacts to add to your phone contacts
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[400px] pr-4">
          {importableContacts.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              All XMPP contacts are already in your phone contacts
            </p>
          ) : (
            <div className="space-y-2">
              {importableContacts.map(contact => (
                <div key={contact.jid} className="flex items-center gap-2 p-2 border rounded">
                  <Checkbox
                    checked={selectedJids.has(contact.jid)}
                    onCheckedChange={() => handleToggle(contact.jid)}
                  />
                  <div className="flex-1">
                    <p className="font-medium text-sm">{contact.name || contact.jid}</p>
                    <p className="text-xs text-muted-foreground">{contact.jid}</p>
                  </div>
                  <MessageSquare className="w-4 h-4 text-muted-foreground" />
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button 
            onClick={handleImport} 
            disabled={selectedJids.size === 0}
          >
            <UserPlus className="w-4 h-4 mr-2" />
            Import {selectedJids.size > 0 ? `(${selectedJids.size})` : ''}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
