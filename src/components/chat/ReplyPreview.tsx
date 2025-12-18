/**
 * ReplyPreview component - Shows the message being replied to
 */

import { X, Reply } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ReplyPreviewProps {
  replyToMessage: {
    id: string;
    from: string;
    body: string;
  };
  onCancel: () => void;
}

export const ReplyPreview: React.FC<ReplyPreviewProps> = ({ replyToMessage, onCancel }) => {
  // Extract sender name from JID or resource
  const senderName = replyToMessage.from.includes('/') 
    ? replyToMessage.from.split('/')[1] 
    : replyToMessage.from.split('@')[0];

  // Truncate body if too long
  const truncatedBody = replyToMessage.body.length > 100 
    ? replyToMessage.body.substring(0, 100) + '...' 
    : replyToMessage.body;

  return (
    <div className="flex items-center gap-2 px-4 py-2 bg-muted/50 border-l-2 border-primary">
      <Reply className="h-4 w-4 text-muted-foreground flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-primary truncate">{senderName}</p>
        <p className="text-sm text-muted-foreground truncate">{truncatedBody}</p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={onCancel}
        className="h-6 w-6 p-0 flex-shrink-0"
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
};
