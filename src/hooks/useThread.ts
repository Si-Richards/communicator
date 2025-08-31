// useThread Hook - Individual conversation/room message management
import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import { xml, jid } from '@xmpp/client';
import { useXmppMessaging } from '@/contexts/XmppMessagingProvider';
import { xmppStorage } from '@/lib/xmpp/storage';
import { XmppMessage, MamQuery, MamResult } from '@/lib/xmpp/types';
import { useState, useEffect, useCallback, useRef } from 'react';

export interface UseThreadReturn {
  messages: XmppMessage[];
  isLoading: boolean;
  isLoadingMore: boolean;
  hasMoreHistory: boolean;
  error: string | null;
  isTyping: boolean;
  typingUsers: string[];
  
  // Actions
  sendMessage: (body: string, options?: { type?: 'chat' | 'groupchat' }) => Promise<void>;
  sendFile: (file: File) => Promise<void>;
  editMessage: (messageId: string, newBody: string) => Promise<void>;
  retractMessage: (messageId: string) => Promise<void>;
  hideMessage: (messageId: string) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;
  markAsRead: () => Promise<void>;
  loadMoreHistory: () => Promise<void>;
  
  // Typing indicators
  sendTyping: (state: 'composing' | 'paused' | 'active') => void;
  
  // Utilities
  resendMessage: (messageId: string) => Promise<void>;
  copyMessage: (messageId: string) => void;
}

const MESSAGES_QUERY_KEY = (jid: string) => ['xmpp', 'messages', jid];
const TYPING_QUERY_KEY = (jid: string) => ['xmpp', 'typing', jid];

export const useThread = (conversationJid: string): UseThreadReturn => {
  const { client, myJid, status, features } = useXmppMessaging();
  const queryClient = useQueryClient();
  const [isTyping, setIsTyping] = useState(false);
  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  const typingTimeoutRef = useRef<NodeJS.Timeout>();

  // Load messages with infinite scroll support
  const {
    data,
    isLoading,
    isFetchingNextPage: isLoadingMore,
    hasNextPage: hasMoreHistory,
    fetchNextPage: loadMoreHistory,
    error,
  } = useInfiniteQuery({
    queryKey: MESSAGES_QUERY_KEY(conversationJid),
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => {
      // Load from storage first
      const messages = await xmppStorage.getMessages(conversationJid, 50, pageParam);
      
      // If connected and MAM is supported, try to fetch from server
      if (client && status === 'connected' && features.messageArchiveManagement && messages.length < 50) {
        try {
          const mamResult = await fetchMAMMessages({
            with: conversationJid,
            before: pageParam,
            max: 50,
          });
          
          // Save new messages to storage
          for (const message of mamResult.messages) {
            await xmppStorage.saveMessage(message, conversationJid);
          }
          
          return {
            messages: mamResult.messages,
            nextCursor: mamResult.first,
            hasMore: !mamResult.complete,
          };
        } catch (error) {
          console.error('Failed to fetch MAM messages:', error);
        }
      }
      
      return {
        messages,
        nextCursor: messages.length > 0 ? messages[0].id : undefined,
        hasMore: messages.length === 50,
      };
    },
    getNextPageParam: (lastPage) => lastPage.hasMore ? lastPage.nextCursor : undefined,
    staleTime: 30000, // 30 seconds
  });

  // Flatten messages from all pages
  const messages = data?.pages.flatMap(page => page.messages) ?? [];

  // Send message mutation
  const sendMessageMutation = useMutation({
    mutationFn: async ({ body, type = 'chat' }: { body: string; type?: 'chat' | 'groupchat' }) => {
      if (!client || !myJid) throw new Error('Not connected');

      const messageId = client.generateId();
      const timestamp = new Date();

      // Create message object
      const message: XmppMessage = {
        id: messageId,
        from: myJid,
        to: conversationJid,
        body,
        timestamp,
        type,
        status: 'sending',
        requestReceipt: features.messageDeliveryReceipts,
        markable: features.chatMarkers,
      };

      // Save to storage immediately for optimistic update
      await xmppStorage.saveMessage(message, conversationJid);

      // Create stanza
      const messageStanza = xml('message', {
        to: conversationJid,
        type,
        id: messageId,
      }, xml('body', {}, body));

      // Add delivery receipt request
      if (features.messageDeliveryReceipts) {
        messageStanza.append(xml('request', { xmlns: 'urn:xmpp:receipts' }));
      }

      // Add chat markers
      if (features.chatMarkers) {
        messageStanza.append(xml('markable', { xmlns: 'urn:xmpp:chat-markers:0' }));
      }

      // Add origin ID for message sync
      const originId = client.generateId();
      messageStanza.append(xml('origin-id', { 
        xmlns: 'urn:xmpp:sid:0', 
        id: originId 
      }));

      try {
        await client.send(messageStanza);
        
        // Update status to sent
        const sentMessage = { ...message, status: 'sent' as const };
        await xmppStorage.saveMessage(sentMessage, conversationJid);
        
        return sentMessage;
      } catch (error) {
        // Update status to error
        const errorMessage = { ...message, status: 'error' as const, error: String(error) };
        await xmppStorage.saveMessage(errorMessage, conversationJid);
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: MESSAGES_QUERY_KEY(conversationJid) });
      queryClient.invalidateQueries({ queryKey: ['xmpp', 'conversations'] });
    },
  });

  // Edit message mutation (XEP-0308)
  const editMessageMutation = useMutation({
    mutationFn: async ({ messageId, newBody }: { messageId: string; newBody: string }) => {
      if (!client || !features.messageRetraction) {
        throw new Error('Message editing not supported');
      }

      const editStanza = xml('message', {
        to: conversationJid,
        type: 'chat',
        id: client.generateId(),
      }, 
        xml('body', {}, newBody),
        xml('replace', {
          xmlns: 'urn:xmpp:message-correct:0',
          id: messageId,
        })
      );

      await client.send(editStanza);
      
      // Update local message
      const messages = await xmppStorage.getMessages(conversationJid, 1000);
      const messageIndex = messages.findIndex(m => m.id === messageId);
      
      if (messageIndex >= 0) {
        const updatedMessage = {
          ...messages[messageIndex],
          body: newBody,
          edited: true,
        };
        await xmppStorage.saveMessage(updatedMessage, conversationJid);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: MESSAGES_QUERY_KEY(conversationJid) });
    },
  });

  // Retract message mutation (XEP-0424)
  const retractMessageMutation = useMutation({
    mutationFn: async (messageId: string) => {
      if (!client || !features.messageRetraction) {
        throw new Error('Message retraction not supported');
      }

      const retractStanza = xml('message', {
        to: conversationJid,
        type: 'chat',
        id: client.generateId(),
      }, xml('apply-to', {
          xmlns: 'urn:xmpp:fasten:0',
          id: messageId,
        }, xml('retract', { xmlns: 'urn:xmpp:message-retract:0' })
      ));

      await client.send(retractStanza);
      
      // Update local message
      const messages = await xmppStorage.getMessages(conversationJid, 1000);
      const messageIndex = messages.findIndex(m => m.id === messageId);
      
      if (messageIndex >= 0) {
        const updatedMessage = {
          ...messages[messageIndex],
          retracted: true,
          retractedBy: myJid!,
          retractedAt: new Date(),
        };
        await xmppStorage.saveMessage(updatedMessage, conversationJid);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: MESSAGES_QUERY_KEY(conversationJid) });
    },
  });

  // File upload mutation (XEP-0363)
  const sendFileMutation = useMutation({
    mutationFn: async (file: File) => {
      if (!client || !features.httpFileUpload) {
        throw new Error('File upload not supported');
      }

      // First, request upload slot
      const requestStanza = xml('iq', {
        type: 'get',
        to: `upload.${jid(myJid!).domain}`,
        id: client.generateId(),
      }, xml('request', {
          xmlns: 'urn:xmpp:http:upload:0',
          filename: file.name,
          size: file.size.toString(),
          'content-type': file.type,
        })
      );

      const response = await client.client?.iqCaller.request(requestStanza);
      const slot = response?.getChild('slot', 'urn:xmpp:http:upload:0');
      
      if (!slot) throw new Error('No upload slot received');

      const putUrl = slot.getChild('put')?.attrs.url;
      const getUrl = slot.getChild('get')?.attrs.url;
      
      if (!putUrl || !getUrl) throw new Error('Invalid upload slot');

      // Upload file
      const uploadResponse = await fetch(putUrl, {
        method: 'PUT',
        body: file,
        headers: {
          'Content-Type': file.type,
        },
      });

      if (!uploadResponse.ok) {
        throw new Error('File upload failed');
      }

      // Send message with file URL
      const fileMessage = `📎 ${file.name}\n${getUrl}`;
      await sendMessageMutation.mutateAsync({ body: fileMessage });
      
      return getUrl;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: MESSAGES_QUERY_KEY(conversationJid) });
    },
  });

  // Typing indicators
  const sendTyping = useCallback((state: 'composing' | 'paused' | 'active') => {
    if (!client || !features.enableTyping) return;

    const typingStanza = xml('message', {
      to: conversationJid,
      type: 'chat',
    }, xml(state, { xmlns: 'http://jabber.org/protocol/chatstates' }));

    client.send(typingStanza).catch(console.error);

    // Auto-stop typing after 5 seconds
    if (state === 'composing') {
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
      typingTimeoutRef.current = setTimeout(() => {
        sendTyping('paused');
      }, 5000);
    }
  }, [client, conversationJid, features.enableTyping]);

  // Listen for incoming messages and typing notifications
  useEffect(() => {
    if (!client) return;

    const handleStanza = (stanza: any) => {
      if (stanza.name === 'message') {
        const from = stanza.attrs.from;
        const to = stanza.attrs.to;
        const bareFrom = jid(from).bare().toString();
        const bareTo = jid(to).bare().toString();
        
        // Only handle messages for this conversation
        if (bareFrom !== conversationJid && bareTo !== conversationJid) {
          return;
        }

        // Handle typing notifications
        const chatStates = ['composing', 'paused', 'active', 'inactive', 'gone'];
        for (const state of chatStates) {
          if (stanza.getChild(state, 'http://jabber.org/protocol/chatstates')) {
            if (state === 'composing') {
              setTypingUsers(prev => prev.includes(bareFrom) ? prev : [...prev, bareFrom]);
            } else {
              setTypingUsers(prev => prev.filter(user => user !== bareFrom));
            }
            return;
          }
        }

        // Handle regular messages
        const body = stanza.getChildText('body');
        if (body) {
          const message: XmppMessage = {
            id: stanza.attrs.id || client.generateId(),
            from,
            to,
            body,
            timestamp: new Date(),
            type: stanza.attrs.type || 'chat',
            status: 'received',
          };

          // Save to storage
          xmppStorage.saveMessage(message, conversationJid);
          
          // Invalidate queries to trigger refresh
          queryClient.invalidateQueries({ queryKey: MESSAGES_QUERY_KEY(conversationJid) });
        }
      }
    };

    client.on('stanza', handleStanza);

    return () => {
      client.off('stanza', handleStanza);
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
    };
  }, [client, conversationJid, queryClient]);

  // MAM query helper
  const fetchMAMMessages = async (query: MamQuery): Promise<MamResult> => {
    if (!client) throw new Error('Not connected');

    const queryId = client.generateId();
    const mamStanza = xml('iq', {
      type: 'set',
      id: client.generateId(),
    }, xml('query', {
        xmlns: 'urn:xmpp:mam:2',
        queryid: queryId,
      },
      xml('x', { xmlns: 'jabber:x:data', type: 'submit' },
        xml('field', { var: 'FORM_TYPE', type: 'hidden' },
          xml('value', {}, 'urn:xmpp:mam:2')
        ),
        query.with && xml('field', { var: 'with' },
          xml('value', {}, query.with)
        ),
        query.start && xml('field', { var: 'start' },
          xml('value', {}, query.start.toISOString())
        ),
        query.end && xml('field', { var: 'end' },
          xml('value', {}, query.end.toISOString())
        )
      ),
      xml('set', { xmlns: 'http://jabber.org/protocol/rsm' },
        query.max && xml('max', {}, query.max.toString()),
        query.before && xml('before', {}, query.before),
        query.after && xml('after', {}, query.after)
      )
    ));

    // This is a simplified MAM implementation
    // In a real implementation, you'd collect results from multiple result stanzas
    const response = await client.client?.iqCaller.request(mamStanza);
    
    return {
      messages: [], // Parse messages from MAM result
      complete: true,
      first: undefined,
      last: undefined,
      count: 0,
    };
  };

  // Helper functions
  const markAsRead = async () => {
    // Send read markers for unread messages
    const unreadMessages = messages.filter(m => 
      m.from !== myJid && 
      m.markable && 
      !m.displayed
    );

    for (const message of unreadMessages.slice(-5)) { // Only last 5 to avoid spam
      if (client && features.chatMarkers) {
        const markerStanza = xml('message', {
          to: conversationJid,
          type: 'chat',
        }, xml('displayed', {
            xmlns: 'urn:xmpp:chat-markers:0',
            id: message.id,
          })
        );

        await client.send(markerStanza);
      }
    }

    // Update conversation unread count
    queryClient.invalidateQueries({ queryKey: ['xmpp', 'conversations'] });
  };

  const hideMessage = async (messageId: string) => {
    await xmppStorage.hideMessage(messageId);
    queryClient.invalidateQueries({ queryKey: MESSAGES_QUERY_KEY(conversationJid) });
  };

  const deleteMessage = async (messageId: string) => {
    await xmppStorage.deleteMessage(messageId);
    queryClient.invalidateQueries({ queryKey: MESSAGES_QUERY_KEY(conversationJid) });
  };

  const resendMessage = async (messageId: string) => {
    const message = messages.find(m => m.id === messageId);
    if (message && message.status === 'error') {
      await sendMessageMutation.mutateAsync({ 
        body: message.body, 
        type: message.type 
      });
    }
  };

  const copyMessage = (messageId: string) => {
    const message = messages.find(m => m.id === messageId);
    if (message && navigator.clipboard) {
      navigator.clipboard.writeText(message.body);
    }
  };

  return {
    messages,
    isLoading,
    isLoadingMore,
    hasMoreHistory,
    error: error ? String(error) : null,
    isTyping,
    typingUsers,
    sendMessage: (body, options) => sendMessageMutation.mutateAsync({ body, ...options }),
    sendFile: (file) => sendFileMutation.mutateAsync(file),
    editMessage: (messageId, newBody) => editMessageMutation.mutateAsync({ messageId, newBody }),
    retractMessage: (messageId) => retractMessageMutation.mutateAsync(messageId),
    hideMessage,
    deleteMessage,
    markAsRead,
    loadMoreHistory,
    sendTyping,
    resendMessage,
    copyMessage,
  };
};