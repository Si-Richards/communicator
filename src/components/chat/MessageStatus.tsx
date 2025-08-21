/**
 * Enhanced message status indicator with tooltips
 */

import { Check, CheckCheck, Eye, Clock, AlertCircle } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { MessageStatus as MessageStatusType } from '@/types/xmpp';

interface MessageStatusProps {
  status?: MessageStatusType;
  timestamp: Date;
  className?: string;
}

export const MessageStatus: React.FC<MessageStatusProps> = ({ 
  status, 
  timestamp,
  className = '' 
}) => {
  const getStatusDetails = (status?: MessageStatusType) => {
    switch (status) {
      case 'sending':
        return {
          icon: <Clock className="h-3 w-3 text-muted-foreground" />,
          tooltip: 'Sending...',
          color: 'text-muted-foreground'
        };
      case 'sent':
        return {
          icon: <Check className="h-3 w-3 text-muted-foreground" />,
          tooltip: 'Sent',
          color: 'text-muted-foreground'
        };
      case 'delivered':
        return {
          icon: <CheckCheck className="h-3 w-3 text-muted-foreground" />,
          tooltip: 'Delivered',
          color: 'text-muted-foreground'
        };
      case 'read':
        return {
          icon: <Eye className="h-3 w-3 text-primary" />,
          tooltip: 'Read',
          color: 'text-primary'
        };
      case 'error':
        return {
          icon: <AlertCircle className="h-3 w-3 text-destructive" />,
          tooltip: 'Failed to send',
          color: 'text-destructive'
        };
      default:
        return null;
    }
  };

  const statusDetails = getStatusDetails(status);
  
  if (!statusDetails) {
    return null;
  }

  const timeString = timestamp.toLocaleTimeString([], { 
    hour: '2-digit', 
    minute: '2-digit' 
  });

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className={`flex items-center gap-1 ${className}`}>
            <span className="text-xs opacity-80">{timeString}</span>
            {statusDetails.icon}
          </div>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p>{statusDetails.tooltip}</p>
          <p className="text-xs opacity-80">
            {timestamp.toLocaleString()}
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};