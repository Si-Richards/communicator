import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, UserPlus } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { XmppContact } from '@/types/xmpp';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';

interface RoomInviteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roomJid: string;
  roomName: string;
  contacts: XmppContact[];
  onInvite: (userJids: string[], reason?: string) => Promise<void>;
}

export const RoomInviteDialog = ({
  open,
  onOpenChange,
  roomJid,
  roomName,
  contacts,
  onInvite,
}: RoomInviteDialogProps) => {
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(false);
  const [selectedContacts, setSelectedContacts] = useState<Set<string>>(new Set());
  const [customJid, setCustomJid] = useState('');
  const [reason, setReason] = useState('');
  const [searchTerm, setSearchTerm] = useState('');

  const filteredContacts = contacts.filter((contact) =>
    contact.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    contact.jid.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const toggleContact = (jid: string) => {
    const newSelected = new Set(selectedContacts);
    if (newSelected.has(jid)) {
      newSelected.delete(jid);
    } else {
      newSelected.add(jid);
    }
    setSelectedContacts(newSelected);
  };

  const handleInvite = async () => {
    const inviteJids = Array.from(selectedContacts);
    
    // Add custom JID if provided
    if (customJid.trim()) {
      inviteJids.push(customJid.trim());
    }

    if (inviteJids.length === 0) {
      toast({
        title: 'No Users Selected',
        description: 'Please select at least one user to invite',
        variant: 'destructive',
      });
      return;
    }

    setIsLoading(true);
    try {
      await onInvite(inviteJids, reason || undefined);
      toast({
        title: 'Invitations Sent',
        description: `Invited ${inviteJids.length} user${inviteJids.length !== 1 ? 's' : ''} to ${roomName}`,
      });
      onOpenChange(false);
      setSelectedContacts(new Set());
      setCustomJid('');
      setReason('');
    } catch (error: any) {
      toast({
        title: 'Failed to Send Invitations',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Invite Users to Room</DialogTitle>
          <DialogDescription>
            Select contacts or enter a JID to invite to {roomName}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label htmlFor="search">Search Contacts</Label>
            <Input
              id="search"
              placeholder="Search by name or JID..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>

          <div>
            <Label>Select Contacts ({selectedContacts.size} selected)</Label>
            <ScrollArea className="h-[200px] border rounded-lg mt-2">
              <div className="p-4 space-y-2">
                {filteredContacts.length === 0 ? (
                  <div className="text-center text-muted-foreground py-4">
                    No contacts found
                  </div>
                ) : (
                  filteredContacts.map((contact) => (
                    <div
                      key={contact.jid}
                      className="flex items-center space-x-2 p-2 rounded hover:bg-muted/50 cursor-pointer"
                      onClick={() => toggleContact(contact.jid)}
                    >
                      <Checkbox
                        checked={selectedContacts.has(contact.jid)}
                        onCheckedChange={() => toggleContact(contact.jid)}
                      />
                      <div className="flex-1">
                        <div className="font-medium">{contact.name}</div>
                        <div className="text-xs text-muted-foreground">{contact.jid}</div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </ScrollArea>
          </div>

          <div>
            <Label htmlFor="customJid">Or Enter JID Manually</Label>
            <Input
              id="customJid"
              placeholder="user@domain.com"
              value={customJid}
              onChange={(e) => setCustomJid(e.target.value)}
            />
          </div>

          <div>
            <Label htmlFor="reason">Invitation Message (Optional)</Label>
            <Textarea
              id="reason"
              placeholder="Join us for a chat..."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={handleInvite} disabled={isLoading}>
              {isLoading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <UserPlus className="mr-2 h-4 w-4" />
              )}
              Send Invitations
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
