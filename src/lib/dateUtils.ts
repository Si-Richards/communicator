/**
 * Date utility functions for chat message timestamps and date separators
 */

import { format, isToday, isYesterday, isSameDay } from 'date-fns';

/**
 * Format message timestamp for display
 */
export const formatMessageTime = (date: Date): string => {
  return format(date, 'HH:mm');
};

/**
 * Format message timestamp with full date for tooltips
 */
export const formatFullDateTime = (date: Date): string => {
  return format(date, 'PPP p'); // Wednesday, February 14th, 2024 at 2:30 PM
};

/**
 * Get display date for date separators
 */
export const getDateSeparatorText = (date: Date): string => {
  if (isToday(date)) {
    return 'Today';
  }
  if (isYesterday(date)) {
    return 'Yesterday';
  }
  return format(date, 'EEEE, MMMM do'); // Wednesday, February 14th
};

/**
 * Check if two dates need a date separator between them
 */
export const needsDateSeparator = (currentDate: Date, previousDate?: Date): boolean => {
  if (!previousDate) return true;
  return !isSameDay(currentDate, previousDate);
};

/**
 * Create date separator object for message list
 */
export interface DateSeparator {
  type: 'date-separator';
  id: string;
  date: Date;
  text: string;
}

/**
 * Insert date separators into message list
 */
export const insertDateSeparators = <T extends { timestamp: Date; id: string }>(
  messages: T[]
): (T | DateSeparator)[] => {
  const result: (T | DateSeparator)[] = [];
  
  messages.forEach((message, index) => {
    const previousMessage = messages[index - 1];
    
    if (needsDateSeparator(message.timestamp, previousMessage?.timestamp)) {
      result.push({
        type: 'date-separator',
        id: `separator-${message.timestamp.toISOString()}`,
        date: message.timestamp,
        text: getDateSeparatorText(message.timestamp)
      });
    }
    
    result.push(message);
  });
  
  return result;
};