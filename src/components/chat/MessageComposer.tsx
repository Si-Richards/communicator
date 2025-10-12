/**
 * Enhanced message composer with emoji picker, GIF support, and multi-line input
 */

import { useState, useRef, KeyboardEvent } from 'react';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Send, Mic, MicOff } from 'lucide-react';
import { EmojiPicker } from './EmojiPicker';
import { GifPicker } from './GifPicker';

interface MessageComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onDictationToggle?: () => void;
  isListening?: boolean;
  isDictationEnabled?: boolean;
  placeholder?: string;
  disabled?: boolean;
  interimTranscript?: string;
}

export const MessageComposer: React.FC<MessageComposerProps> = ({
  value,
  onChange,
  onSend,
  onDictationToggle,
  isListening = false,
  isDictationEnabled = false,
  placeholder = "Type a message...",
  disabled = false,
  interimTranscript = ''
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (value.trim()) {
        onSend();
      }
    }
  };

  const handleEmojiSelect = (emoji: string) => {
    const textarea = textareaRef.current;
    if (textarea) {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const newValue = value.substring(0, start) + emoji + value.substring(end);
      onChange(newValue);
      
      // Set cursor position after emoji
      setTimeout(() => {
        textarea.setSelectionRange(start + emoji.length, start + emoji.length);
        textarea.focus();
      }, 0);
    } else {
      onChange(value + emoji);
    }
  };

  const handleGifSelect = (gifUrl: string) => {
    onChange(gifUrl);
    // Auto-send GIF
    setTimeout(() => onSend(), 100);
  };

  const displayValue = value + (interimTranscript ? ` ${interimTranscript}` : '');

  return (
    <div className="bg-background border-t border-border">
      <div className="p-4">
        <div className="flex items-end gap-2">
          {/* Message Input */}
          <div className="flex-1 relative">
            <Textarea
              ref={textareaRef}
              value={displayValue}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              disabled={disabled}
              className="min-h-[44px] max-h-32 resize-none pr-20"
              rows={1}
            />
            
            {/* Control Bar - Positioned over textarea */}
            <div className="absolute right-2 bottom-2 flex items-center gap-1">
              <TooltipProvider>
                {/* Emoji Picker */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span>
                      <EmojiPicker onEmojiSelect={handleEmojiSelect} disabled={disabled} />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>Add emoji</TooltipContent>
                </Tooltip>

                {/* GIF Picker */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span>
                      <GifPicker onGifSelect={handleGifSelect} disabled={disabled} />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>Send GIF</TooltipContent>
                </Tooltip>

                {/* Dictation Button */}
                {isDictationEnabled && onDictationToggle && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={onDictationToggle}
                        disabled={disabled}
                        className={`h-8 w-8 p-0 hover:bg-muted ${
                          isListening ? 'text-primary bg-primary/10' : ''
                        }`}
                      >
                        {isListening ? (
                          <MicOff className="h-4 w-4" />
                        ) : (
                          <Mic className="h-4 w-4" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {isListening ? 'Stop dictation' : 'Start dictation'}
                    </TooltipContent>
                  </Tooltip>
                )}
              </TooltipProvider>
            </div>
          </div>

          {/* Send Button */}
          <Button
            onClick={onSend}
            disabled={!value.trim() || disabled}
            size="sm"
            className="h-11 px-4"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
};