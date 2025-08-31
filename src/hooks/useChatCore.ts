/**
 * React hook for Chat Core integration
 * Provides optimized state management and event handling
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { chatCore, ChatItem, ChatState } from '@/lib/chatCore';

export const useChatCore = () => {
  const [state, setState] = useState<ChatState>(chatCore.getState());
  const [isLoading, setIsLoading] = useState(false);

  // Subscribe to chat core events
  useEffect(() => {
    const handleUpdate = () => {
      setState(chatCore.getState());
    };

    const handleItemsUpdated = (jids: string[]) => {
      setState(chatCore.getState());
    };

    chatCore.on('selectedItemChanged', handleUpdate);
    chatCore.on('searchChanged', handleUpdate);
    chatCore.on('sortChanged', handleUpdate);
    chatCore.on('archiveFilterChanged', handleUpdate);
    chatCore.on('itemsUpdated', handleItemsUpdated);
    chatCore.on('itemDeleted', handleUpdate);

    return () => {
      chatCore.off('selectedItemChanged', handleUpdate);
      chatCore.off('searchChanged', handleUpdate);
      chatCore.off('sortChanged', handleUpdate);
      chatCore.off('archiveFilterChanged', handleUpdate);
      chatCore.off('itemsUpdated', handleItemsUpdated);
      chatCore.off('itemDeleted', handleUpdate);
    };
  }, []);

  // Memoized filtered items
  const filteredItems = useMemo(() => {
    return chatCore.getFilteredItems();
  }, [state.items, state.searchTerm, state.sortBy, state.showArchived]);

  // Memoized selected item
  const selectedItem = useMemo(() => {
    return chatCore.getSelectedItem();
  }, [state.selectedItemId, state.items]);

  // Actions
  const selectItem = useCallback((jid: string | null) => {
    chatCore.setSelectedItem(jid);
    if (jid) {
      chatCore.markAsRead(jid);
    }
  }, []);

  const setSearchTerm = useCallback((term: string) => {
    chatCore.setSearchTerm(term);
  }, []);

  const setSortBy = useCallback((sortBy: 'newest' | 'a-z' | 'z-a') => {
    chatCore.setSortBy(sortBy);
  }, []);

  const setShowArchived = useCallback((show: boolean) => {
    chatCore.setShowArchived(show);
  }, []);

  const archiveItem = useCallback((jid: string) => {
    chatCore.archiveItem(jid);
  }, []);

  const unarchiveItem = useCallback((jid: string) => {
    chatCore.unarchiveItem(jid);
  }, []);

  const deleteItem = useCallback((jid: string) => {
    chatCore.deleteItem(jid);
  }, []);

  const markAsRead = useCallback((jid: string) => {
    chatCore.markAsRead(jid);
  }, []);

  return {
    // State
    filteredItems,
    selectedItem,
    searchTerm: state.searchTerm,
    sortBy: state.sortBy,
    showArchived: state.showArchived,
    isLoading,

    // Actions
    selectItem,
    setSearchTerm,
    setSortBy,
    setShowArchived,
    archiveItem,
    unarchiveItem,
    deleteItem,
    markAsRead,

    // Utilities
    getItem: useCallback((jid: string) => chatCore.getItem(jid), []),
  };
};

// Hook for message operations (separated for performance)
export const useChatMessages = () => {
  const addMessage = useCallback((jid: string, message: any) => {
    chatCore.addMessage(jid, message);
  }, []);

  const loadHistory = useCallback(async (jid: string) => {
    // This will be implemented with actual XMPP context integration
    console.log('Loading history for:', jid);
  }, []);

  return {
    addMessage,
    loadHistory,
  };
};