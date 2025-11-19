import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Loader2 } from 'lucide-react';

interface InviteUserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInvite: (userJid: string, reason?: string) => Promise<void>;
}

export const InviteUserDialog: React.FC<InviteUserDialogProps> = ({
  open,
  onOpenChange,
  onInvite,
}) => {
  const [userJid, setUserJid] = useState('');
  const [reason, setReason] = useState('');
  const [isInviting, setIsInviting] = useState(false);

  const handleInvite = async () => {
    if (!userJid.trim()) return;

    setIsInviting(true);
    try {
      await onInvite(userJid.trim(), reason.trim() || undefined);
      onOpenChange(false);
      setUserJid('');
      setReason('');
    } catch (error) {
      console.error('Failed to invite user:', error);
    } finally {
      setIsInviting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Invite User to Room</DialogTitle>
          <DialogDescription>
            Enter the JID of the user you want to invite
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="user-jid">User JID *</Label>
            <Input
              id="user-jid"
              value={userJid}
              onChange={(e) => setUserJid(e.target.value)}
              placeholder="user@domain.com"
              disabled={isInviting}
              autoComplete="off"
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="reason">Invitation Message (Optional)</Label>
            <Textarea
              id="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Join us in this room!"
              disabled={isInviting}
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isInviting}
          >
            Cancel
          </Button>
          <Button onClick={handleInvite} disabled={isInviting || !userJid.trim()}>
            {isInviting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Send Invitation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
