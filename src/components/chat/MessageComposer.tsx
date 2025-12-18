/**
 * Enhanced message composer with emoji picker, GIF support, file attachments, reply preview, and multi-line input
 */

import { useState, useRef, KeyboardEvent, ChangeEvent } from 'react';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Progress } from '@/components/ui/progress';
import { Send, Mic, MicOff, Paperclip, X, Loader2 } from 'lucide-react';
import { EmojiPicker } from './EmojiPicker';
import { GifPicker } from './GifPicker';
import { ReplyPreview } from './ReplyPreview';

interface FileUploadProgress {
  loaded: number;
  total: number;
  percentage: number;
}

interface ReplyToMessage {
  id: string;
  from: string;
  body: string;
}

interface MessageComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onFileUpload?: (file: File, onProgress?: (progress: FileUploadProgress) => void) => Promise<string>;
  onDictationToggle?: () => void;
  isListening?: boolean;
  isDictationEnabled?: boolean;
  placeholder?: string;
  disabled?: boolean;
  interimTranscript?: string;
  replyTo?: ReplyToMessage | null;
  onCancelReply?: () => void;
}

export const MessageComposer: React.FC<MessageComposerProps> = ({
  value,
  onChange,
  onSend,
  onFileUpload,
  onDictationToggle,
  isListening = false,
  isDictationEnabled = false,
  placeholder = "Type a message...",
  disabled = false,
  interimTranscript = '',
  replyTo = null,
  onCancelReply
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);

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

  const handleFileSelect = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !onFileUpload) return;

    setIsUploading(true);
    setUploadProgress(0);

    try {
      const fileUrl = await onFileUpload(file, (progress) => {
        setUploadProgress(progress.percentage);
      });
      
      // Set the file URL as the message and auto-send
      onChange(fileUrl);
      setTimeout(() => onSend(), 100);
    } catch (error) {
      console.error('File upload failed:', error);
    } finally {
      setIsUploading(false);
      setUploadProgress(0);
      // Reset input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const displayValue = value + (interimTranscript ? ` ${interimTranscript}` : '');

  return (
    <div className="bg-background">
      {/* Reply Preview */}
      {replyTo && onCancelReply && (
        <ReplyPreview replyToMessage={replyTo} onCancel={onCancelReply} />
      )}

      {/* Upload Progress */}
      {isUploading && (
        <div className="px-4 py-2 border-t border-border">
          <div className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            <span className="text-sm text-muted-foreground">Uploading file...</span>
            <Progress value={uploadProgress} className="flex-1 h-2" />
            <span className="text-xs text-muted-foreground">{uploadProgress}%</span>
          </div>
        </div>
      )}

      <div className="p-4">
        <div className="flex items-end gap-2">
          {/* Hidden File Input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,video/*,.pdf,.doc,.docx,.txt"
            className="hidden"
            onChange={handleFileSelect}
          />

          {/* Message Input */}
          <div className="flex-1 relative">
            <Textarea
              ref={textareaRef}
              value={displayValue}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              disabled={disabled || isUploading}
              className="min-h-[44px] max-h-32 resize-none pr-24"
              rows={1}
            />
            
            {/* Control Bar - Positioned over textarea */}
            <div className="absolute right-2 bottom-2 flex items-center gap-1">
              <TooltipProvider>
                {/* File Attachment */}
                {onFileUpload && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={disabled || isUploading}
                        className="h-8 w-8 p-0 hover:bg-muted"
                      >
                        <Paperclip className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Attach file</TooltipContent>
                  </Tooltip>
                )}

                {/* Emoji Picker */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span>
                      <EmojiPicker onEmojiSelect={handleEmojiSelect} disabled={disabled || isUploading} />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>Add emoji</TooltipContent>
                </Tooltip>

                {/* GIF Picker */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span>
                      <GifPicker onGifSelect={handleGifSelect} disabled={disabled || isUploading} />
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
                        disabled={disabled || isUploading}
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
            disabled={!value.trim() || disabled || isUploading}
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