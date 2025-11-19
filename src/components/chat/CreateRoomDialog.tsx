import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2 } from 'lucide-react';
import { useXmpp } from '@/contexts/XmppContext';
import { toast } from 'sonner';

interface CreateRoomDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Export RoomConfig for RoomSettingsDialog
export interface RoomConfig {
  roomJid: string;
  name: string;
  description?: string;
  persistent?: boolean;
  public?: boolean;
  membersOnly?: boolean;
  moderated?: boolean;
  passwordProtected?: boolean;
  password?: string;
  maxUsers?: number;
  allowInvites?: boolean;
}

export const CreateRoomDialog: React.FC<CreateRoomDialogProps> = ({ open, onOpenChange }) => {
  const [roomName, setRoomName] = useState('');
  const [password, setPassword] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const { joinRoom, nickname, effectiveJid } = useXmpp();

  const handleCreate = async () => {
    if (!roomName.trim()) {
      toast.error('Please enter a room name');
      return;
    }

    // Get domain from effective JID
    const domain = effectiveJid?.split('@')[1] || 'ejabberd.voicehost.io';
    const roomLocalPart = roomName.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const roomJid = `${roomLocalPart}@conference.${domain}`;

    setIsCreating(true);
    try {
      // Joining a room creates it if it doesn't exist
      const success = await joinRoom(roomJid, nickname || 'User', password || undefined);

      if (success) {
        toast.success('Room created successfully');
        onOpenChange(false);
        // Reset form
        setRoomName('');
        setPassword('');
      } else {
        toast.error('Failed to create room');
      }
    } catch (error) {
      console.error('Error creating room:', error);
      toast.error('Failed to create room');
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Create New Room</DialogTitle>
          <DialogDescription>
            Create a new chat room
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="room-name">Room Name *</Label>
            <Input
              id="room-name"
              value={roomName}
              onChange={(e) => setRoomName(e.target.value)}
              placeholder="My Awesome Room"
              disabled={isCreating}
            />
            <p className="text-xs text-muted-foreground">
              Room will be created automatically when you join
            </p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="room-password">Password (Optional)</Label>
            <Input
              id="room-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Leave empty for no password"
              disabled={isCreating}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isCreating}
          >
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={isCreating}>
            {isCreating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Create & Join Room
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
