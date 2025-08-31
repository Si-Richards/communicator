import { useState, useEffect, useCallback, useRef } from 'react';
import { XmppMessage, TypingIndicator } from '../types/xmpp';
import { xmppStorage } from '../lib/xmpp/storage';
import { useXmppMessaging } from '../contexts/XmppMessagingProvider';

export const useThread = (jidOrRoomId: string) => {
  const [messages, setMessages] = useState<XmppMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const [typingUsers, setTypingUsers] = useState<TypingIndicator[]>([]);
  const { 
    sendMessage, 
    sendTyping, 
    markAsRead, 
    requestHistory, 
    updateEventHandlers 
  } = useXmppMessaging();
  
  const pageSize = 50;
  const typingTimeoutRef = useRef<NodeJS.Timeout>();
  const currentThreadId = useRef<string>('');

  // Generate thread ID
  useEffect(() => {
    // For groupchat, thread ID is the room JID
    // For chat, it's a combination of both JIDs
    if (jidOrRoomId.includes('@conference.') || jidOrRoomId.includes('@muc.')) {
      currentThreadId.current = jidOrRoomId;
    } else {
      // For direct chats, we'll need the current user's JID
      // This is a simplified version - in practice, you'd get this from the client
      currentThreadId.current = `${jidOrRoomId}|chat`;
    }
  }, [jidOrRoomId]);

  // Load initial messages
  useEffect(() => {
    const loadMessages = async () => {
      if (!currentThreadId.current) return;
      
      try {
        setLoading(true);
        const threadMessages = await xmppStorage.getMessages(currentThreadId.current, pageSize, 0);
        setMessages(threadMessages.reverse()); // Reverse to show newest at bottom
        setHasMore(threadMessages.length === pageSize);
      } catch (error) {
        console.error('Failed to load messages:', error);
      } finally {
        setLoading(false);
      }
    };

    loadMessages();
  }, [currentThreadId.current]);

  // Listen for new messages
  useEffect(() => {
    const handleMessage = (message: XmppMessage) => {
      if (message.threadId === currentThreadId.current) {
        setMessages(prev => {
          // Check if message already exists
          if (prev.some(m => m.id === message.id)) {
            return prev;
          }
          return [...prev, message];
        });
      }
    };

    const handleTyping = (indicator: TypingIndicator) => {
      if (indicator.threadId === currentThreadId.current) {
        setTypingUsers(prev => {
          const filtered = prev.filter(t => t.jid !== indicator.jid);
          if (indicator.isTyping) {
            return [...filtered, indicator];
          }
          return filtered;
        });

        // Clear typing indicator after 5 seconds
        if (indicator.isTyping) {
          clearTimeout(typingTimeoutRef.current);
          typingTimeoutRef.current = setTimeout(() => {
            setTypingUsers(prev => prev.filter(t => t.jid !== indicator.jid));
          }, 5000);
        }
      }
    };

    updateEventHandlers({ 
      onMessage: handleMessage,
      onTyping: handleTyping
    });

    return () => {
      clearTimeout(typingTimeoutRef.current);
    };
  }, [currentThreadId.current, updateEventHandlers]);

  const sendMessageToThread = useCallback(async (body: string) => {
    if (!body.trim()) return;
    
    const type = jidOrRoomId.includes('@conference.') || jidOrRoomId.includes('@muc.') 
      ? 'groupchat' 
      : 'chat';
    
    return await sendMessage(jidOrRoomId, body, type);
  }, [jidOrRoomId, sendMessage]);

  const sendFile = useCallback(async (file: File): Promise<string> => {
    // This would implement HTTP Upload (XEP-0363)
    // For now, we'll just send a message with file info
    const fileName = file.name;
    const fileSize = file.size;
    const fileType = file.type;
    
    // In a real implementation, you'd upload the file first and get a URL
    const fileUrl = `https://example.com/uploads/${fileName}`;
    
    const message = `📎 File: ${fileName} (${Math.round(fileSize / 1024)}KB)`;
    return await sendMessageToThread(message);
  }, [sendMessageToThread]);

  const editMessage = useCallback(async (messageId: string, newBody: string) => {
    // This would implement Message Correction (XEP-0308)
    // For now, we'll update the message locally
    await xmppStorage.updateMessage(messageId, { 
      body: newBody, 
      edited: true 
    });
    
    setMessages(prev => prev.map(m => 
      m.id === messageId 
        ? { ...m, body: newBody, edited: true }
        : m
    ));
  }, []);

  const retractMessage = useCallback(async (messageId: string) => {
    // This would implement Message Retraction (XEP-0424)
    // For now, we'll mark the message as retracted locally
    await xmppStorage.updateMessage(messageId, { 
      retracted: true,
      body: 'This message was retracted'
    });
    
    setMessages(prev => prev.map(m => 
      m.id === messageId 
        ? { ...m, retracted: true, body: 'This message was retracted' }
        : m
    ));
  }, []);

  const hideMessage = useCallback(async (messageId: string) => {
    await xmppStorage.setHiddenFlag(messageId, 'message');
    setMessages(prev => prev.filter(m => m.id !== messageId));
  }, []);

  const copyMessage = useCallback((messageId: string) => {
    const message = messages.find(m => m.id === messageId);
    if (message && navigator.clipboard) {
      navigator.clipboard.writeText(message.body);
    }
  }, [messages]);

  const loadMoreMessages = useCallback(async () => {
    if (!hasMore || loading) return;
    
    try {
      const offset = messages.length;
      const olderMessages = await xmppStorage.getMessages(currentThreadId.current, pageSize, offset);
      
      if (olderMessages.length === 0) {
        setHasMore(false);
        return;
      }
      
      setMessages(prev => [...olderMessages.reverse(), ...prev]);
      setHasMore(olderMessages.length === pageSize);
    } catch (error) {
      console.error('Failed to load more messages:', error);
    }
  }, [messages.length, hasMore, loading, currentThreadId.current]);

  const requestMoreHistory = useCallback(async () => {
    if (messages.length === 0) return;
    
    const oldestMessage = messages[0];
    await requestHistory(jidOrRoomId, oldestMessage.timestamp, pageSize);
  }, [messages, jidOrRoomId, requestHistory]);

  const startTyping = useCallback(() => {
    sendTyping(jidOrRoomId, true);
  }, [jidOrRoomId, sendTyping]);

  const stopTyping = useCallback(() => {
    sendTyping(jidOrRoomId, false);
  }, [jidOrRoomId, sendTyping]);

  const markThreadAsRead = useCallback(async () => {
    if (messages.length > 0) {
      const lastMessage = messages[messages.length - 1];
      await markAsRead(currentThreadId.current, lastMessage.id);
    }
  }, [messages, markAsRead, currentThreadId.current]);

  return {
    messages,
    loading,
    hasMore,
    typingUsers,
    sendMessage: sendMessageToThread,
    sendFile,
    editMessage,
    retractMessage,
    hideMessage,
    copyMessage,
    loadMoreMessages,
    requestMoreHistory,
    startTyping,
    stopTyping,
    markAsRead: markThreadAsRead
  };
};