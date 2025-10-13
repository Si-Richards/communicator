// Messages Page - XMPP Chat Interface
import React, { useEffect } from 'react';
import Layout from '@/components/Layout';
import { OptimizedChatView } from '@/components/chat/OptimizedChatView';
import { useChatCore } from '@/hooks/useChatCore';

export default function Messages() {
  const { selectItem } = useChatCore();

  // Handle ?jid=... URL parameter for direct chat navigation
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const jidParam = params.get('jid');
    
    if (jidParam) {
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