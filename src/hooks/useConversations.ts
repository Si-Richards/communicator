import { useState, useEffect, useCallback } from 'react';
import { XmppThread } from '../types/xmpp';
import { xmppStorage } from '../lib/xmpp/storage';
import { useXmppMessaging } from '../contexts/XmppMessagingProvider';

export const useConversations = () => {
  const [threads, setThreads] = useState<XmppThread[]>([]);
  const [loading, setLoading] = useState(true);
  const { updateEventHandlers } = useXmppMessaging();

  // Load initial threads
  useEffect(() => {
    const loadThreads = async () => {
      try {
        const storedThreads = await xmppStorage.getThreads();
        // Filter out hidden threads
        const visibleThreads = [];
        
        for (const thread of storedThreads) {
          const isHidden = await xmppStorage.isHidden(thread.id);
          if (!isHidden && !thread.isHidden) {
            visibleThreads.push(thread);
          }
        }
        
        // Sort by last message timestamp
        visibleThreads.sort((a, b) => {
          const aTime = a.lastMessage?.timestamp?.getTime() || 0;
          const bTime = b.lastMessage?.timestamp?.getTime() || 0;
          return bTime - aTime;
        });
        
        setThreads(visibleThreads);
      } catch (error) {
        console.error('Failed to load threads:', error);
      } finally {
        setLoading(false);
      }
    };

    loadThreads();
  }, []);

  // Listen for new messages to update threads
  useEffect(() => {
    const handleMessage = async (message: any) => {
      const storedThreads = await xmppStorage.getThreads();
      const thread = storedThreads.find(t => t.id === message.threadId);
      
      if (thread && !thread.isHidden) {
        const isHidden = await xmppStorage.isHidden(thread.id);
        if (!isHidden) {
          setThreads(prev => {
            const updated = prev.filter(t => t.id !== thread.id);
            return [thread, ...updated];
          });
        }
      }
    };

    updateEventHandlers({ onMessage: handleMessage });
  }, [updateEventHandlers]);

  const pinThread = useCallback(async (threadId: string) => {
    const thread = await xmppStorage.getThread(threadId);
    if (thread) {
      thread.isPinned = !thread.isPinned;
      await xmppStorage.saveThread(thread);
      
      setThreads(prev => prev.map(t => 
        t.id === threadId ? { ...t, isPinned: thread.isPinned } : t
      ));
    }
  }, []);

  const muteThread = useCallback(async (threadId: string) => {
    const thread = await xmppStorage.getThread(threadId);
    if (thread) {
      thread.isMuted = !thread.isMuted;
      await xmppStorage.saveThread(thread);
      
      setThreads(prev => prev.map(t => 
        t.id === threadId ? { ...t, isMuted: thread.isMuted } : t
      ));
    }
  }, []);

  const hideThread = useCallback(async (threadId: string) => {
    await xmppStorage.setHiddenFlag(threadId, 'thread');
    setThreads(prev => prev.filter(t => t.id !== threadId));
  }, []);

  const deleteThread = useCallback(async (threadId: string) => {
    // Clear messages for this thread (local only)
    await xmppStorage.clearMessages(threadId);
    
    // Hide the thread
    await hideThread(threadId);
  }, [hideThread]);

  const markAsRead = useCallback(async (threadId: string) => {
    const thread = await xmppStorage.getThread(threadId);
    if (thread) {
      thread.unreadCount = 0;
      await xmppStorage.saveThread(thread);
      
      setThreads(prev => prev.map(t => 
        t.id === threadId ? { ...t, unreadCount: 0 } : t
      ));
    }
  }, []);

  // Separate pinned and regular threads
  const pinnedThreads = threads.filter(t => t.isPinned);
  const regularThreads = threads.filter(t => !t.isPinned);

  const totalUnreadCount = threads.reduce((sum, thread) => sum + (thread.unreadCount || 0), 0);

  return {
    threads,
    pinnedThreads,
    regularThreads,
    loading,
    totalUnreadCount,
    pinThread,
    muteThread,
    hideThread,
    deleteThread,
    markAsRead
  };
};