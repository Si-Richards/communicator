/**
 * Hook for managing XMPP data persistence
 */

import { useEffect, useCallback } from 'react';
import { XmppConversation, MucRoom } from '@/types/xmpp';
import { xmppStorage } from '@/lib/xmppStorage';

interface UseXmppPersistenceProps {
  currentAccount: string | null;
  conversations: XmppConversation[];
  rooms: MucRoom[];
  connectionState: string;
  onHydrateConversations: (conversations: XmppConversation[]) => void;
  onHydrateRooms: (rooms: MucRoom[]) => void;
  onRejoinRooms: (roomJids: string[]) => void;
  onLoadRecentHistory: (conversationJids: string[]) => void;
}

export const useXmppPersistence = ({
  currentAccount,
  conversations,
  rooms,
  connectionState,
  onHydrateConversations,
  onHydrateRooms,
  onRejoinRooms,
  onLoadRecentHistory,
}: UseXmppPersistenceProps) => {
  
  // Set current account in storage when it changes
  useEffect(() => {
    if (currentAccount) {
      xmppStorage.setAccount(currentAccount);
    }
  }, [currentAccount]);

  // Hydrate data from storage when account changes
  useEffect(() => {
    if (!currentAccount) return;
    
    const storedConversations = xmppStorage.loadConversations();
    const storedRooms = xmppStorage.loadRooms();
    
    if (storedConversations.length > 0) {
      onHydrateConversations(storedConversations);
    }
    
    if (storedRooms.length > 0) {
      onHydrateRooms(storedRooms);
    }
  }, [currentAccount, onHydrateConversations, onHydrateRooms]);

  // Handle post-connection tasks
  useEffect(() => {
    if (connectionState !== 'connected' || !currentAccount) return;
    
    // Rejoin previously joined rooms
    const joinedRooms = xmppStorage.getJoinedRooms();
    if (joinedRooms.length > 0) {
      onRejoinRooms(joinedRooms);
    }
    
    // Load recent conversation history
    const recentConversations = xmppStorage.getRecentConversations();
    if (recentConversations.length > 0) {
      onLoadRecentHistory(recentConversations);
    }
  }, [connectionState, currentAccount, onRejoinRooms, onLoadRecentHistory]);

  // Save conversations when they change
  useEffect(() => {
    if (conversations.length > 0) {
      xmppStorage.saveConversations(conversations);
    }
  }, [conversations]);

  // Save rooms when they change
  useEffect(() => {
    if (rooms.length > 0) {
      xmppStorage.saveRooms(rooms);
    }
  }, [rooms]);

  // Clear storage function
  const clearStorage = useCallback(() => {
    if (currentAccount) {
      xmppStorage.clearAccount(currentAccount);
    }
  }, [currentAccount]);

  return {
    clearStorage,
  };
};