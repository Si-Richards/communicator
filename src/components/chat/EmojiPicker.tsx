/**
 * Emoji picker component for chat message composition
 * Fallback implementation until packages are properly loaded
 */

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Smile } from 'lucide-react';
import { useState } from 'react';

interface EmojiPickerProps {
  onEmojiSelect: (emoji: string) => void;
  disabled?: boolean;
}

export const EmojiPicker: React.FC<EmojiPickerProps> = ({ 
  onEmojiSelect, 
  disabled = false 
}) => {
  const [isOpen, setIsOpen] = useState(false);

  // Common emojis for quick access
  const commonEmojis = [
    '😀', '😂', '😍', '🥰', '😊', '😎', '🤔', '😢',
    '😴', '😜', '🙄', '😤', '👍', '👎', '👌', '🤝',
    '❤️', '💙', '💚', '💛', '🔥', '⭐', '✨', '🎉',
    '🎊', '💯', '💪', '🙏', '👏', '🤗', '🤷', '🤦'
  ];

  const handleEmojiSelect = (emoji: string) => {
    onEmojiSelect(emoji);
    setIsOpen(false);
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          className="h-8 w-8 p-0 hover:bg-muted"
        >
          <Smile className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent 
        className="w-80 p-2" 
        align="end"
        side="top"
      >
        <div className="grid grid-cols-8 gap-1">
          {commonEmojis.map((emoji, index) => (
            <Button
              key={index}
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 text-lg hover:bg-muted"
              onClick={() => handleEmojiSelect(emoji)}
            >
              {emoji}
            </Button>
          ))}
        </div>
        <div className="text-xs text-muted-foreground text-center mt-2 pt-2 border-t">
          Basic emoji picker - Enhanced version coming soon
        </div>
      </PopoverContent>
    </Popover>
  );
};