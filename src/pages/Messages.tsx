// Messages Page - XMPP Chat Interface
import React from 'react';
import Layout from '@/components/Layout';
import { OptimizedChatView } from '@/components/chat/OptimizedChatView';

export default function Messages() {
  return (
    <Layout>
      <div className="flex-1 flex flex-col h-full">
        <OptimizedChatView />
      </div>
    </Layout>
  );
}