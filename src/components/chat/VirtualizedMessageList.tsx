/**
 * Virtualized Message List Component
 * High-performance message rendering with virtualization
 */

import React, { memo, useMemo, useCallback, useRef, useEffect } from 'react';
import { FixedSizeList as List } from 'react-window';
import { XmppMessage } from '@/types/xmpp';
import { MessageBodyRenderer } from './MessageBodyRenderer';
import { DateSeparator } from './DateSeparator';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { formatDistanceToNow } from 'date-fns';
import { cn } from '@/lib/utils';

interface VirtualizedMessageListProps {
  messages: XmppMessage[];
  height: number;
  currentUserJid: string;
  onLoadMore?: () => void;
  isLoading?: boolean;
}

interface MessageItem {
  type: 'message' | 'date-separator';
  id: string;
  data: XmppMessage | Date;
  index: number;
}

const VirtualizedMessageList = memo(({
  messages,
  height,
  currentUserJid,
  onLoadMore,
  isLoading = false,
}: VirtualizedMessageListProps) => {
  const listRef = useRef<List>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Memoized message items with date separators
  const messageItems = useMemo(() => {
    const items: MessageItem[] = [];
    let lastDate: Date | null = null;

    messages.forEach((message, index) => {
      const messageDate = new Date(message.timestamp);
      const messageDateStr = messageDate.toDateString();

      // Add date separator if date changed
      if (!lastDate || lastDate.toDateString() !== messageDateStr) {
        items.push({
          type: 'date-separator',
          id: `date-${messageDateStr}`,
          data: messageDate,
          index: items.length,
        });
        lastDate = messageDate;
      }

      // Add message
      items.push({
        type: 'message',
        id: message.id || `msg-${index}`,
        data: message,
        index: items.length,
      });
    });

    return items;
  }, [messages]);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (listRef.current && messageItems.length > 0) {
      listRef.current.scrollToItem(messageItems.length - 1, 'end');
    }
  }, [messageItems.length]);

  // Load more handler for infinite scroll
  const handleScroll = useCallback(({
    scrollDirection,
    scrollOffset,
  }: {
    scrollDirection: 'forward' | 'backward';
    scrollOffset: number;
  }) => {
    if (scrollDirection === 'backward' && scrollOffset < 100 && onLoadMore && !isLoading) {
      onLoadMore();
    }
  }, [onLoadMore, isLoading]);

  // Memoized row renderer
  const Row = memo(({ index, style }: { index: number; style: React.CSSProperties }) => {
    const item = messageItems[index];
    
    if (!item) return null;

    return (
      <div style={style}>
        {item.type === 'date-separator' ? (
          <DateSeparator date={item.data as Date} />
        ) : (
          <MessageRow
            message={item.data as XmppMessage}
            currentUserJid={currentUserJid}
          />
        )}
      </div>
    );
  });

  const getItemSize = useCallback((index: number) => {
    const item = messageItems[index];
    if (item?.type === 'date-separator') return 40;
    
    // Estimate message height based on content
    const message = item?.data as XmppMessage;
    if (!message) return 60;
    
    const baseHeight = 60;
    const lineHeight = 20;
    const estimatedLines = Math.ceil((message.body?.length || 0) / 50);
    
    return baseHeight + (estimatedLines * lineHeight);
  }, [messageItems]);

  if (messageItems.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <p>No messages yet. Start the conversation!</p>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex-1 overflow-hidden">
      {isLoading && (
        <div className="absolute top-0 left-0 right-0 z-10 bg-background/80 p-2 text-center text-sm text-muted-foreground">
          Loading more messages...
        </div>
      )}
      <List
        ref={listRef}
        height={height}
        width="100%"
        itemCount={messageItems.length}
        itemSize={60}
        onScroll={handleScroll}
        className="scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent"
      >
        {Row}
      </List>
    </div>
  );
});

// Memoized message row component
const MessageRow = memo(({
  message,
  currentUserJid,
}: {
  message: XmppMessage;
  currentUserJid: string;
}) => {
  const isFromSelf = message.from === currentUserJid || message.from?.includes(currentUserJid);
  
  const senderName = useMemo(() => {
    if (isFromSelf) return 'You';
    return message.from?.split('@')[0] || 'Unknown';
  }, [isFromSelf, message.from]);

  const timeDisplay = useMemo(() => {
    return formatDistanceToNow(message.timestamp, { addSuffix: true });
  }, [message.timestamp]);

  return (
    <div
      className={cn(
        "flex gap-3 p-4 hover:bg-muted/50 transition-colors",
        isFromSelf && "flex-row-reverse"
      )}
    >
      <Avatar className="h-8 w-8 shrink-0">
        <AvatarFallback className="text-xs">
          {senderName.slice(0, 2).toUpperCase()}
        </AvatarFallback>
      </Avatar>

      <div className={cn("flex-1 min-w-0", isFromSelf && "text-right")}>
        <div className={cn(
          "flex items-baseline gap-2 mb-1",
          isFromSelf && "flex-row-reverse"
        )}>
          <span className="font-medium text-sm text-foreground">
            {senderName}
          </span>
          <span className="text-xs text-muted-foreground">
            {timeDisplay}
          </span>
        </div>

        <div className={cn(
          "inline-block max-w-[80%] rounded-lg px-3 py-2",
          isFromSelf
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-foreground"
        )}>
          <MessageBodyRenderer
            body={message.body || ''}
            className="text-sm"
          />
        </div>

        {message.status && message.status !== 'sent' && (
          <div className={cn(
            "text-xs text-muted-foreground mt-1",
            isFromSelf && "text-right"
          )}>
            {message.status === 'delivered' && '✓✓'}
            {message.status === 'read' && '✓✓'}
            {message.status === 'error' && '❌'}
          </div>
        )}
      </div>
    </div>
  );
});

VirtualizedMessageList.displayName = 'VirtualizedMessageList';
MessageRow.displayName = 'MessageRow';

export { VirtualizedMessageList };