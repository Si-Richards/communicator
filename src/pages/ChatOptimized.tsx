/**
 * Optimized Chat Page
 * Entry point for the new optimized chat system
 */

import React, { useEffect } from 'react';
import { OptimizedChatView } from '@/components/chat/OptimizedChatView';
import Layout from '@/components/Layout';
import { useChatCore } from '@/hooks/useChatCore';

export default function ChatOptimized() {
  const { selectItem } = useChatCore();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const jidParam = params.get('jid');
    
    if (jidParam) {
      // Start conversation with this JID
      selectItem(decodeURIComponent(jidParam));
      
      // Clean up URL parameter
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [selectItem]);

  return (
    <Layout>
      <div className="flex-1 flex flex-col h-full">
        <OptimizedChatView />
      </div>
    </Layout>
  );
}