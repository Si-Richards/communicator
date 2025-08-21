/**
 * Date separator component for chat messages
 */

import { getDateSeparatorText } from '@/lib/dateUtils';

interface DateSeparatorProps {
  date: Date;
}

export const DateSeparator: React.FC<DateSeparatorProps> = ({ date }) => {
  const text = getDateSeparatorText(date);
  
  return (
    <div className="flex items-center justify-center py-4">
      <div className="bg-muted px-3 py-1 rounded-full">
        <span className="text-xs font-medium text-muted-foreground">
          {text}
        </span>
      </div>
    </div>
  );
};