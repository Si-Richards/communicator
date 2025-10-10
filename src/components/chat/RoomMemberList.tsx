import { useState } from 'react';
import { MucRoom, RoomOccupant } from '@/types/xmpp';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MoreVertical, UserX, Ban, Search } from 'lucide-react';


interface RoomMemberListProps {
  room: MucRoom;
  onKickUser: (nick: string, reason?: string) => Promise<void>;
  onBanUser: (jid: string, reason?: string) => Promise<void>;
  canManage: boolean;
}

export const RoomMemberList = ({ room, onKickUser, onBanUser, canManage }: RoomMemberListProps) => {
  const [searchTerm, setSearchTerm] = useState('');

  const filteredOccupants = room.occupants.filter((occupant) =>
    occupant.nick.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const getRoleBadgeColor = (role: string) => {
    switch (role) {
      case 'moderator':
        return 'default';
      case 'participant':
        return 'secondary';
      case 'visitor':
        return 'outline';
      default:
        return 'outline';
    }
  };

  const getAffiliationBadgeColor = (affiliation: string) => {
    switch (affiliation) {
      case 'owner':
        return 'destructive';
      case 'admin':
        return 'default';
      case 'member':
        return 'secondary';
      default:
        return 'outline';
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search members..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-8"
          />
        </div>
        <div className="text-sm text-muted-foreground">
          {filteredOccupants.length} member{filteredOccupants.length !== 1 ? 's' : ''}
        </div>
      </div>

      <ScrollArea className="h-[400px] border rounded-lg">
        <div className="p-4 space-y-2">
          {filteredOccupants.length === 0 ? (
            <div className="text-center text-muted-foreground py-8">
              No members found
            </div>
          ) : (
            filteredOccupants.map((occupant) => (
              <div
                key={occupant.nick}
                className="flex items-center justify-between p-3 rounded-lg hover:bg-muted/50 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div className={`w-2 h-2 rounded-full ${occupant.presence === 'available' ? 'bg-green-500' : 'bg-gray-400'}`} />
                  <div>
                    <div className="font-medium">{occupant.nick}</div>
                    {occupant.jid && (
                      <div className="text-xs text-muted-foreground">{occupant.jid}</div>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Badge variant={getRoleBadgeColor(occupant.role)}>
                    {occupant.role}
                  </Badge>
                  <Badge variant={getAffiliationBadgeColor(occupant.affiliation)}>
                    {occupant.affiliation}
                  </Badge>

                  {canManage && occupant.nick !== room.nick && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="sm">
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={() => onKickUser(occupant.nick, 'Kicked by moderator')}
                        >
                          <UserX className="mr-2 h-4 w-4" />
                          Kick User
                        </DropdownMenuItem>
                        {occupant.jid && (
                          <DropdownMenuItem
                            onClick={() => onBanUser(occupant.jid!, 'Banned by moderator')}
                            className="text-destructive"
                          >
                            <Ban className="mr-2 h-4 w-4" />
                            Ban User
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
};
