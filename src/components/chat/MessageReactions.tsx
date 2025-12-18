/**
 * Display reactions on a message
 */

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { MessageReaction } from '@/types/xmpp';

interface GroupedReaction {
  emoji: string;
  count: number;
  users: string[];
  hasReacted: boolean;
}

interface MessageReactionsProps {
  reactions: MessageReaction[];
  currentUserJid: string;
  onReact: (emoji: string) => void;
  isOwn?: boolean;
}

export const MessageReactions: React.FC<MessageReactionsProps> = ({
  reactions,
  currentUserJid,
  onReact,
  isOwn = false
}) => {
  if (!reactions || reactions.length === 0) return null;

  // Group reactions by emoji
  const groupedReactions: GroupedReaction[] = Object.values(
    reactions.reduce((acc, reaction) => {
      const emoji = reaction.emoji;
      if (!acc[emoji]) {
        acc[emoji] = {
          emoji,
          count: 0,
          users: [],
          hasReacted: false
        };
      }
      acc[emoji].count++;
      const userName = reaction.from.includes('/') 
        ? reaction.from.split('/')[1] 
        : reaction.from.split('@')[0];
      acc[emoji].users.push(userName);
      
      // Check if current user has reacted with this emoji
      const reactionBareJid = reaction.from.includes('/') 
        ? reaction.from.split('/')[0] 
        : reaction.from.split('@')[0] + '@' + (reaction.from.split('@')[1] || '');
      if (reactionBareJid === currentUserJid || reaction.from.includes(currentUserJid)) {
        acc[emoji].hasReacted = true;
      }
      
      return acc;
    }, {} as Record<string, GroupedReaction>)
  );

  return (
    <div className={`flex flex-wrap gap-1 mt-1 ${isOwn ? 'justify-end' : 'justify-start'}`}>
      <TooltipProvider>
        {groupedReactions.map((reaction) => (
          <Tooltip key={reaction.emoji}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onReact(reaction.emoji)}
                className={`h-6 px-1.5 py-0 text-xs rounded-full border ${
                  reaction.hasReacted 
                    ? 'bg-primary/20 border-primary/50 hover:bg-primary/30' 
                    : 'bg-muted/50 border-border hover:bg-muted'
                }`}
              >
                <span className="mr-1">{reaction.emoji}</span>
                <span className="text-muted-foreground">{reaction.count}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              {reaction.users.slice(0, 5).join(', ')}
              {reaction.users.length > 5 && ` +${reaction.users.length - 5} more`}
            </TooltipContent>
          </Tooltip>
        ))}
      </TooltipProvider>
    </div>
  );
};
