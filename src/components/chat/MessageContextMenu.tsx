import { MoreVertical, Copy, Trash2, RotateCcw, Edit } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface MessageContextMenuProps {
  messageId: string;
  messageBody: string;
  isOwnMessage: boolean;
  canRetract?: boolean;
  messageStatus?: string;
  onDelete: () => void;
  onRetract?: () => void;
  onCopy: () => void;
  onResend?: () => void;
}

export const MessageContextMenu = ({
  messageId,
  messageBody,
  isOwnMessage,
  canRetract = false,
  messageStatus,
  onDelete,
  onRetract,
  onCopy,
  onResend,
}: MessageContextMenuProps) => {
  const isFailed = messageStatus === 'error' || messageStatus === 'failed';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <MoreVertical className="h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onClick={onCopy}>
          <Copy className="h-4 w-4 mr-2" />
          Copy Text
        </DropdownMenuItem>
        
        {isOwnMessage && canRetract && onRetract && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onRetract} className="text-destructive">
              <Trash2 className="h-4 w-4 mr-2" />
              Delete for Everyone
            </DropdownMenuItem>
          </>
        )}
        
        <DropdownMenuItem onClick={onDelete}>
          <Trash2 className="h-4 w-4 mr-2" />
          Delete Locally
        </DropdownMenuItem>
        
        {isFailed && onResend && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onResend}>
              <RotateCcw className="h-4 w-4 mr-2" />
              Retry Send
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
