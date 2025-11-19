import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Loader2, Trash2, UserPlus } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { MucRoom } from '@/types/xmpp';
import { RoomConfig } from './CreateRoomDialog';
import { RoomMemberList } from './RoomMemberList';
import { InviteUserDialog } from './InviteUserDialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface RoomSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  room: MucRoom | null;
  onUpdateRoom: (config: Partial<RoomConfig>) => Promise<void>;
  onDestroyRoom: (reason?: string) => Promise<void>;
  onKickUser: (nick: string, reason?: string) => Promise<void>;
  onBanUser: (jid: string, reason?: string) => Promise<void>;
  onInviteUser: (userJid: string, reason?: string) => Promise<void>;
  onChangeSubject: (subject: string) => Promise<void>;
  isOwner: boolean;
  isModerator: boolean;
}

export const RoomSettingsDialog = ({
  open,
  onOpenChange,
  room,
  onUpdateRoom,
  onDestroyRoom,
  onKickUser,
  onBanUser,
  onInviteUser,
  onChangeSubject,
  isOwner,
  isModerator,
}: RoomSettingsDialogProps) => {
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(false);
  const [showDestroyDialog, setShowDestroyDialog] = useState(false);
  const [showInviteDialog, setShowInviteDialog] = useState(false);
  const [subject, setSubject] = useState('');

  useEffect(() => {
    if (room) {
      setSubject(room.subject || '');
    }
  }, [room]);

  const handleUpdateSubject = async () => {
    if (!room) return;
    
    setIsLoading(true);
    try {
      await onChangeSubject(subject);
      toast({
        title: 'Subject Updated',
        description: 'Room subject has been updated',
      });
    } catch (error: any) {
      toast({
        title: 'Failed to Update Subject',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleDestroyRoom = async () => {
    if (!room) return;
    
    setIsLoading(true);
    try {
      await onDestroyRoom('Room destroyed by owner');
      toast({
        title: 'Room Destroyed',
        description: 'The room has been permanently deleted',
      });
      onOpenChange(false);
    } catch (error: any) {
      toast({
        title: 'Failed to Destroy Room',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
      setShowDestroyDialog(false);
    }
  };

  const handleInviteUser = async (userJid: string, reason?: string) => {
    if (!room) return;
    
    try {
      await onInviteUser(userJid, reason);
      toast({
        title: 'Invitation Sent',
        description: `Invited ${userJid} to the room`,
      });
    } catch (error: any) {
      toast({
        title: 'Failed to Send Invitation',
        description: error.message,
        variant: 'destructive',
      });
    }
  };

  if (!room) return null;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Room Settings: {room.name}</DialogTitle>
          </DialogHeader>

          <Tabs defaultValue="general" className="w-full">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="general">General</TabsTrigger>
              <TabsTrigger value="members">Members</TabsTrigger>
              <TabsTrigger value="advanced">Advanced</TabsTrigger>
            </TabsList>

            <TabsContent value="general" className="space-y-4">
              <div>
                <Label>Room JID</Label>
                <Input value={room.jid} disabled />
              </div>

              <div>
                <Label htmlFor="subject">Room Subject</Label>
                <div className="flex gap-2">
                  <Input
                    id="subject"
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    placeholder="Room subject..."
                    disabled={!isModerator && !isOwner}
                  />
                  <Button
                    onClick={handleUpdateSubject}
                    disabled={isLoading || (!isModerator && !isOwner) || subject === room.subject}
                  >
                    {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Update
                  </Button>
                </div>
              </div>

              <div className="pt-4 border-t">
                <h4 className="font-medium mb-2">Room Information</h4>
                <div className="space-y-2 text-sm text-muted-foreground">
                  <div>Members: {room.occupants.length}</div>
                  <div>Your Nickname: {room.nick || 'Not joined'}</div>
                  <div>Status: {room.joined ? 'Joined' : 'Not joined'}</div>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="members" className="space-y-4">
              <RoomMemberList
                room={room}
                onKickUser={onKickUser}
                onBanUser={onBanUser}
                canManage={isModerator || isOwner}
              />
            </TabsContent>

            <TabsContent value="advanced" className="space-y-4">
              {isOwner && (
                <div className="p-4 border border-destructive rounded-lg space-y-3">
                  <h4 className="font-medium text-destructive">Danger Zone</h4>
                  <p className="text-sm text-muted-foreground">
                    Destroying a room is permanent and cannot be undone.
                  </p>
                  <Button
                    variant="destructive"
                    onClick={() => setShowDestroyDialog(true)}
                    disabled={isLoading}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Destroy Room
                  </Button>
                </div>
              )}
              
              {!isOwner && (
                <p className="text-sm text-muted-foreground">
                  Only room owners can access advanced settings.
                </p>
              )}
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      <InviteUserDialog
        open={showInviteDialog}
        onOpenChange={setShowInviteDialog}
        onInvite={handleInviteUser}
      />

      <AlertDialog open={showDestroyDialog} onOpenChange={setShowDestroyDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the room "{room.name}" and remove all members.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDestroyRoom} className="bg-destructive text-destructive-foreground">
              {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Destroy Room
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
