/**
 * Message body renderer with optional Markdown support
 * Handles text formatting, emojis, and GIF display
 */

import { useSettings } from '@/contexts/SettingsContext';

interface MessageBodyRendererProps {
  body: string;
  className?: string;
}

export const MessageBodyRenderer: React.FC<MessageBodyRendererProps> = ({ 
  body, 
  className = '' 
}) => {
  const { settings } = useSettings();
  
  // Check if message is a GIF URL
  const isGifMessage = (text: string): boolean => {
    return text.startsWith('https://media.tenor.com/') && text.endsWith('.gif');
  };

  // Render GIF message
  if (isGifMessage(body)) {
    return (
      <div className={`gif-message ${className}`}>
        <img 
          src={body} 
          alt="GIF" 
          className="max-w-full max-h-48 rounded-md"
          loading="lazy"
        />
      </div>
    );
  }

  // Basic markdown-like rendering for now (will be enhanced when packages load)
  if (settings.chat?.enableMarkdown) {
    // Simple markdown parsing for basic formatting
    let processedBody = body;
    
    // Bold text **text**
    processedBody = processedBody.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    
    // Italic text *text*
    processedBody = processedBody.replace(/\*(.*?)\*/g, '<em>$1</em>');
    
    // Code `code`
    processedBody = processedBody.replace(/`(.*?)`/g, '<code class="bg-muted px-1 py-0.5 rounded text-xs font-mono">$1</code>');
    
    // Links [text](url)
    processedBody = processedBody.replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="text-primary hover:underline">$1</a>');
    
    return (
      <div 
        className={`markdown-content text-sm leading-relaxed ${className}`}
        dangerouslySetInnerHTML={{ __html: processedBody }}
      />
    );
  }

  // Plain text with basic emoji support
  return (
    <p className={`text-sm whitespace-pre-wrap ${className}`}>
      {body}
    </p>
  );
};