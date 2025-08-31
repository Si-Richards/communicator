import React, { useState, useRef, useEffect } from 'react';
import { useThread } from '../../hooks/useThread';
import { Card, CardHeader, CardTitle, CardContent } from '../ui/card';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Send, MoreVertical } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, DropdownMenuItem } from '../ui/dropdown-menu';

interface ChatWindowProps {
  jid: string;
  onClose?: () => void;
}

export const ChatWindow: React.FC<ChatWindowProps> = ({ jid, onClose }) => {
  const [messageText, setMessageText] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout>();
  
  const {
    messages,
    loading,
    typingUsers,
    sendMessage,
    editMessage,
    retractMessage,
    hideMessage,
    copyMessage,
    startTyping,
    stopTyping,
    markAsRead
  } = useThread(jid);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    markAsRead();
  }, [markAsRead]);

  const handleSendMessage = async () => {
    if (!messageText.trim()) return;
    
    await sendMessage(messageText);
    setMessageText('');
    stopTyping();
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setMessageText(e.target.value);
    
    if (!isTyping) {
      setIsTyping(true);
      startTyping();
    }
    
    clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      setIsTyping(false);
      stopTyping();
    }, 2000);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  return (
    <Card className="flex flex-col h-full">
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="text-lg">{jid}</CardTitle>
        <Button variant="ghost" size="sm" onClick={onClose}>×</Button>
      </CardHeader>
      
      <CardContent className="flex-1 flex flex-col p-0">
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {loading && <div className="text-center text-muted-foreground">Loading messages...</div>}
          
          {messages.map(message => (
            <div key={message.id} className="group relative">
              <div className={`flex ${message.from === jid ? 'justify-start' : 'justify-end'}`}>
                <div className={`max-w-xs lg:max-w-md px-3 py-2 rounded-lg ${
                  message.from === jid 
                    ? 'bg-muted text-foreground' 
                    : 'bg-primary text-primary-foreground'
                }`}>
                  {message.retracted ? (
                    <em className="text-muted-foreground">{message.body}</em>
                  ) : (
                    <>
                      <p className="text-sm">{message.body}</p>
                      {message.edited && <span className="text-xs opacity-70">(edited)</span>}
                    </>
                  )}
                  <div className="text-xs opacity-70 mt-1">
                    {message.timestamp.toLocaleTimeString()}
                  </div>
                </div>
                
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button 
                      variant="ghost" 
                      size="sm" 
                      className="opacity-0 group-hover:opacity-100 ml-2"
                    >
                      <MoreVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    <DropdownMenuItem onClick={() => copyMessage(message.id)}>
                      Copy
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => hideMessage(message.id)}>
                      Hide
                    </DropdownMenuItem>
                    {message.from !== jid && !message.retracted && (
                      <>
                        <DropdownMenuItem onClick={() => editMessage(message.id, prompt('Edit message:') || message.body)}>
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => retractMessage(message.id)}>
                          Retract
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          ))}
          
          {typingUsers.length > 0 && (
            <div className="text-sm text-muted-foreground italic">
              {typingUsers.map(u => u.jid).join(', ')} {typingUsers.length === 1 ? 'is' : 'are'} typing...
            </div>
          )}
          
          <div ref={messagesEndRef} />
        </div>
        
        <div className="p-4 border-t">
          <div className="flex gap-2">
            <Input
              value={messageText}
              onChange={handleInputChange}
              onKeyPress={handleKeyPress}
              placeholder="Type a message..."
              className="flex-1"
            />
            <Button onClick={handleSendMessage} disabled={!messageText.trim()}>
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};