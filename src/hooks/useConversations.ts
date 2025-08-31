// useConversations Hook - Conversation list management
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useXmppMessaging } from '@/contexts/XmppMessagingProvider';
import { xmppStorage } from '@/lib/xmpp/storage';
import { XmppConversation } from '@/lib/xmpp/types';
import { useMemo } from 'react';

export interface UseConversationsReturn {
  conversations: XmppConversation[];
  isLoading: boolean;
  error: string | null;
  pinConversation: (jid: string) => Promise<void>;
  unpinConversation: (jid: string) => Promise<void>;
  muteConversation: (jid: string) => Promise<void>;
  unmuteConversation: (jid: string) => Promise<void>;
  hideConversation: (jid: string) => Promise<void>;
  unhideConversation: (jid: string) => Promise<void>;
  archiveConversation: (jid: string) => Promise<void>;
  unarchiveConversation: (jid: string) => Promise<void>;
  deleteConversation: (jid: string) => Promise<void>;
  markAsRead: (jid: string) => Promise<void>;
  getTotalUnreadCount: () => number;
  getConversation: (jid: string) => XmppConversation | undefined;
}

const CONVERSATIONS_QUERY_KEY = ['xmpp', 'conversations'];

export const useConversations = (): UseConversationsReturn => {
  const { client, myJid, status } = useXmppMessaging();
  const queryClient = useQueryClient();

  // Fetch conversations
  const { 
    data: conversations = [], 
    isLoading, 
    error 
  } = useQuery({
    queryKey: CONVERSATIONS_QUERY_KEY,
    queryFn: async (): Promise<XmppConversation[]> => {
      // Always load from storage first for instant UI
      const storedConversations = await xmppStorage.getConversations();
      
      // Add any missing default properties
      return storedConversations.map(conv => ({
        pinned: false,
        muted: false,
        hidden: false,
        archived: false,
        hasMoreHistory: true,
        isTyping: false,
        typingUsers: [],
        unreadCount: 0,
        messages: [],
        ...conv,
      }));
    },
    staleTime: 10000, // 10 seconds
  });

  // Update conversation preferences
  const updateConversationMutation = useMutation({
    mutationFn: async ({ jid, updates }: { jid: string; updates: Partial<XmppConversation> }) => {
      // Update in storage
      const existingConversations = await xmppStorage.getConversations();
      const conversationIndex = existingConversations.findIndex(c => c.jid === jid);
      
      if (conversationIndex >= 0) {
        const updatedConversation = {
          ...existingConversations[conversationIndex],
          ...updates,
        };
        await xmppStorage.saveConversation(updatedConversation);
      } else {
        // Create new conversation if it doesn't exist
        const newConversation: XmppConversation = {
          jid,
          name: jid?.split('@')[0] || jid || 'Unknown',
          type: 'chat',
          messages: [],
          unreadCount: 0,
          lastActivity: new Date(),
          pinned: false,
          muted: false,
          hidden: false,
          archived: false,
          hasMoreHistory: true,
          isTyping: false,
          typingUsers: [],
          ...updates,
        };
        await xmppStorage.saveConversation(newConversation);
      }
      
      return jid;
    },
    onSuccess: (jid) => {
      // Invalidate conversations query to trigger refetch
      queryClient.invalidateQueries({ queryKey: CONVERSATIONS_QUERY_KEY });
    },
  });

  // Delete conversation (local only)
  const deleteConversationMutation = useMutation({
    mutationFn: async (jid: string) => {
      // Get all messages for this conversation and delete them
      const messages = await xmppStorage.getMessages(jid, 1000);
      for (const message of messages) {
        await xmppStorage.deleteMessage(message.id);
      }
      
      // Remove conversation from storage by updating it as hidden/archived
      const conversations = await xmppStorage.getConversations();
      const conversation = conversations.find(c => c.jid === jid);
      if (conversation) {
        await xmppStorage.saveConversation({
          ...conversation,
          hidden: true,
          archived: true,
          messages: [],
          unreadCount: 0,
        });
      }
      
      return jid;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: CONVERSATIONS_QUERY_KEY });
    },
  });

  // Mark conversation as read
  const markAsReadMutation = useMutation({
    mutationFn: async (jid: string) => {
      const conversations = await xmppStorage.getConversations();
      const conversation = conversations.find(c => c.jid === jid);
      
      if (conversation && conversation.unreadCount > 0) {
        await xmppStorage.saveConversation({
          ...conversation,
          unreadCount: 0,
        });
      }
      
      return jid;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: CONVERSATIONS_QUERY_KEY });
    },
  });

  // Helper functions
  const pinConversation = async (jid: string) => {
    await updateConversationMutation.mutateAsync({ jid, updates: { pinned: true } });
  };

  const unpinConversation = async (jid: string) => {
    await updateConversationMutation.mutateAsync({ jid, updates: { pinned: false } });
  };

  const muteConversation = async (jid: string) => {
    await updateConversationMutation.mutateAsync({ jid, updates: { muted: true } });
  };

  const unmuteConversation = async (jid: string) => {
    await updateConversationMutation.mutateAsync({ jid, updates: { muted: false } });
  };

  const hideConversation = async (jid: string) => {
    await updateConversationMutation.mutateAsync({ jid, updates: { hidden: true } });
  };

  const unhideConversation = async (jid: string) => {
    await updateConversationMutation.mutateAsync({ jid, updates: { hidden: false } });
  };

  const archiveConversation = async (jid: string) => {
    await updateConversationMutation.mutateAsync({ jid, updates: { archived: true } });
  };

  const unarchiveConversation = async (jid: string) => {
    await updateConversationMutation.mutateAsync({ jid, updates: { archived: false } });
  };

  const deleteConversation = async (jid: string) => {
    await deleteConversationMutation.mutateAsync(jid);
  };

  const markAsRead = async (jid: string) => {
    await markAsReadMutation.mutateAsync(jid);
  };

  // Computed values
  const getTotalUnreadCount = () => {
    return conversations
      .filter(conv => !conv.muted && !conv.hidden && !conv.archived)
      .reduce((total, conv) => total + conv.unreadCount, 0);
  };

  const getConversation = (jid: string) => {
    return conversations.find(conv => conv.jid === jid);
  };

  // Sort conversations: pinned first, then by last activity
  const sortedConversations = useMemo(() => {
    return [...conversations]
      .filter(conv => !conv.hidden && !conv.archived)
      .sort((a, b) => {
        // Pinned conversations first
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        
        // Then by last activity
        return b.lastActivity.getTime() - a.lastActivity.getTime();
      });
  }, [conversations]);

  return {
    conversations: sortedConversations,
    isLoading,
    error: error ? String(error) : null,
    pinConversation,
    unpinConversation,
    muteConversation,
    unmuteConversation,
    hideConversation,
    unhideConversation,
    archiveConversation,
    unarchiveConversation,
    deleteConversation,
    markAsRead,
    getTotalUnreadCount,
    getConversation,
  };
};