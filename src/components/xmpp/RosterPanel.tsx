import React from 'react';
import { useRoster } from '../../hooks/useRoster';
import { Card, CardHeader, CardTitle, CardContent } from '../ui/card';
import { Badge } from '../ui/badge';
import { Input } from '../ui/input';
import { Search, User, Users } from 'lucide-react';

interface RosterPanelProps {
  onContactClick?: (jid: string) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
}

export const RosterPanel: React.FC<RosterPanelProps> = ({
  onContactClick,
  searchQuery,
  onSearchChange
}) => {
  const { onlineContacts, offlineContacts, loading, onlineCount, offlineCount } = useRoster(searchQuery);

  if (loading) {
    return <div className="p-4">Loading contacts...</div>;
  }

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="h-5 w-5" />
          Contacts
          <Badge variant="secondary">{onlineCount + offlineCount}</Badge>
        </CardTitle>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search contacts..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="pl-10"
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {onlineCount > 0 && (
          <div>
            <h3 className="text-sm font-medium text-muted-foreground mb-2">
              Online ({onlineCount})
            </h3>
            <div className="space-y-1">
              {onlineContacts.map(contact => (
                <div
                  key={contact.jid}
                  className="flex items-center gap-3 p-2 rounded-lg hover:bg-accent cursor-pointer"
                  onClick={() => onContactClick?.(contact.jid)}
                >
                  <div className="relative">
                    <User className="h-8 w-8" />
                    <div className="absolute -bottom-1 -right-1 w-3 h-3 bg-green-500 rounded-full border-2 border-background" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{contact.name}</p>
                    <p className="text-xs text-muted-foreground truncate">{contact.jid}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {offlineCount > 0 && (
          <div>
            <h3 className="text-sm font-medium text-muted-foreground mb-2">
              Offline ({offlineCount})
            </h3>
            <div className="space-y-1">
              {offlineContacts.map(contact => (
                <div
                  key={contact.jid}
                  className="flex items-center gap-3 p-2 rounded-lg hover:bg-accent cursor-pointer opacity-60"
                  onClick={() => onContactClick?.(contact.jid)}
                >
                  <User className="h-8 w-8" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{contact.name}</p>
                    <p className="text-xs text-muted-foreground truncate">{contact.jid}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
};