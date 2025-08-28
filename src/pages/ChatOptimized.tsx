/**
 * Optimized Chat Page
 * Entry point for the new optimized chat system
 */

import React from 'react';
import { OptimizedChatView } from '@/components/chat/OptimizedChatView';
import Layout from '@/components/Layout';

export default function ChatOptimized() {
  return (
    <Layout>
      <div className="flex-1 flex flex-col h-full">
        <OptimizedChatView />
      </div>
    </Layout>
  );
}