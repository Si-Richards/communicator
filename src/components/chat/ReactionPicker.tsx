/**
 * Quick reaction picker for messages
 */

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { SmilePlus } from 'lucide-react';
import { useState } from 'react';

interface ReactionPickerProps {
  onReact: (emoji: string) => void;
  disabled?: boolean;
  className?: string;
}

// Quick reaction emojis
const quickReactions = ['👍', '❤️', '😂', '😮', '😢', '🔥'];

export const ReactionPicker: React.FC<ReactionPickerProps> = ({ 
  onReact, 
  disabled = false,
  className = ''
}) => {
  const [isOpen, setIsOpen] = useState(false);

  const handleReact = (emoji: string) => {
    onReact(emoji);
    setIsOpen(false);
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          className={`h-6 w-6 p-0 hover:bg-muted ${className}`}
        >
          <SmilePlus className="h-3 w-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent 
        className="w-auto p-1" 
        align="center"
        side="top"
      >
        <div className="flex gap-0.5">
          {quickReactions.map((emoji, index) => (
            <Button
              key={index}
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 text-lg hover:bg-muted hover:scale-125 transition-transform"
              onClick={() => handleReact(emoji)}
            >
              {emoji}
            </Button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
};
