import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

interface CreateRoomDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreateRoom: (config: RoomConfig) => Promise<void>;
}

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

export const CreateRoomDialog = ({ open, onOpenChange, onCreateRoom }: CreateRoomDialogProps) => {
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(false);
  const [formData, setFormData] = useState<RoomConfig>({
    roomJid: '',
    name: '',
    description: '',
    persistent: true,
    public: true,
    membersOnly: false,
    moderated: false,
    passwordProtected: false,
    password: '',
    maxUsers: 100,
    allowInvites: true,
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!formData.roomJid || !formData.name) {
      toast({
        title: 'Validation Error',
        description: 'Please provide room JID and name',
        variant: 'destructive',
      });
      return;
    }

    setIsLoading(true);
    try {
      await onCreateRoom(formData);
      toast({
        title: 'Room Created',
        description: `Successfully created room: ${formData.name}`,
      });
      onOpenChange(false);
      setFormData({
        roomJid: '',
        name: '',
        description: '',
        persistent: true,
        public: true,
        membersOnly: false,
        moderated: false,
        passwordProtected: false,
        password: '',
        maxUsers: 100,
        allowInvites: true,
      });
    } catch (error: any) {
      toast({
        title: 'Failed to Create Room',
        description: error.message || 'An error occurred',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create New Room</DialogTitle>
          <DialogDescription>
            Configure your new chat room settings
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-4">
            <div>
              <Label htmlFor="roomJid">Room JID *</Label>
              <Input
                id="roomJid"
                placeholder="myroom@conference.server.com"
                value={formData.roomJid}
                onChange={(e) => setFormData({ ...formData, roomJid: e.target.value })}
                required
              />
            </div>

            <div>
              <Label htmlFor="name">Room Name *</Label>
              <Input
                id="name"
                placeholder="My Chat Room"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                required
              />
            </div>

            <div>
              <Label htmlFor="description">Description</Label>
              <Input
                id="description"
                placeholder="Room description..."
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              />
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label htmlFor="persistent">Persistent Room</Label>
                <Switch
                  id="persistent"
                  checked={formData.persistent}
                  onCheckedChange={(checked) => setFormData({ ...formData, persistent: checked })}
                />
              </div>

              <div className="flex items-center justify-between">
                <Label htmlFor="public">Public Room</Label>
                <Switch
                  id="public"
                  checked={formData.public}
                  onCheckedChange={(checked) => setFormData({ ...formData, public: checked })}
                />
              </div>

              <div className="flex items-center justify-between">
                <Label htmlFor="membersOnly">Members Only</Label>
                <Switch
                  id="membersOnly"
                  checked={formData.membersOnly}
                  onCheckedChange={(checked) => setFormData({ ...formData, membersOnly: checked })}
                />
              </div>

              <div className="flex items-center justify-between">
                <Label htmlFor="moderated">Moderated</Label>
                <Switch
                  id="moderated"
                  checked={formData.moderated}
                  onCheckedChange={(checked) => setFormData({ ...formData, moderated: checked })}
                />
              </div>

              <div className="flex items-center justify-between">
                <Label htmlFor="passwordProtected">Password Protected</Label>
                <Switch
                  id="passwordProtected"
                  checked={formData.passwordProtected}
                  onCheckedChange={(checked) => setFormData({ ...formData, passwordProtected: checked })}
                />
              </div>

              {formData.passwordProtected && (
                <div>
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    placeholder="Room password"
                    value={formData.password}
                    onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  />
                </div>
              )}

              <div>
                <Label htmlFor="maxUsers">Max Users</Label>
                <Input
                  id="maxUsers"
                  type="number"
                  min="2"
                  max="1000"
                  value={formData.maxUsers}
                  onChange={(e) => setFormData({ ...formData, maxUsers: parseInt(e.target.value) || 100 })}
                />
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading}>
              {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create Room
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};
