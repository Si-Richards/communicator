import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { useCallHistory, CallRecord } from '@/contexts/CallHistoryContext';
import { useJanusContext } from '@/contexts/JanusContext';
import { Search, Phone, PhoneIncoming, PhoneOutgoing, PhoneMissed, Download, Trash2, BarChart3 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { format, isToday, isYesterday, subDays, startOfDay, endOfDay } from 'date-fns';

const History = () => {
  const { 
    callHistory, 
    getCallHistory, 
    getCallsByType, 
    getCallsByDateRange, 
    searchCallHistory, 
    clearHistory, 
    exportHistory,
    getCallStats 
  } = useCallHistory();
  const { makeCall } = useJanusContext();
  const { toast } = useToast();
  
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'incoming' | 'outgoing' | 'missed'>('all');
  const [dateFilter, setDateFilter] = useState<'all' | 'today' | 'yesterday' | 'week'>('all');
  const [showStats, setShowStats] = useState(false);

  const formatDuration = (seconds: number): string => {
    if (seconds === 0) return '0:00';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  };

  const formatDate = (date: Date): string => {
    if (isToday(date)) return 'Today';
    if (isYesterday(date)) return 'Yesterday';
    return format(date, 'MMM d, yyyy');
  };

  const getFilteredCalls = (): CallRecord[] => {
    let filtered = callHistory;

    // Apply search filter
    if (searchQuery) {
      filtered = searchCallHistory(searchQuery);
    }

    // Apply type filter
    if (filterType !== 'all') {
      filtered = filtered.filter(call => call.type === filterType);
    }

    // Apply date filter
    if (dateFilter !== 'all') {
      const now = new Date();
      let startDate: Date;
      let endDate: Date = endOfDay(now);

      switch (dateFilter) {
        case 'today':
          startDate = startOfDay(now);
          break;
        case 'yesterday':
          startDate = startOfDay(subDays(now, 1));
          endDate = endOfDay(subDays(now, 1));
          break;
        case 'week':
          startDate = startOfDay(subDays(now, 7));
          break;
        default:
          return filtered;
      }

      filtered = filtered.filter(call => 
        call.timestamp >= startDate && call.timestamp <= endDate
      );
    }

    return filtered.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  };

  const filteredCalls = getFilteredCalls();

  const getCallIcon = (call: CallRecord) => {
    if (call.type === 'missed') {
      return <PhoneMissed className="w-4 h-4 text-destructive" />;
    } else if (call.type === 'incoming') {
      return <PhoneIncoming className="w-4 h-4 text-green-600" />;
    } else {
      return <PhoneOutgoing className="w-4 h-4 text-blue-600" />;
    }
  };

  const handleCall = (phoneNumber: string) => {
    makeCall(phoneNumber);
  };

  const handleExport = () => {
    const data = exportHistory();
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `call-history-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    toast({
      title: "Call history exported",
      description: "Your call history has been downloaded as a JSON file.",
    });
  };

  const handleClearHistory = () => {
    clearHistory();
    toast({
      title: "Call history cleared",
      description: "All call history has been removed.",
    });
  };

  const stats = getCallStats();

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <h1 className="text-3xl font-bold">Call History</h1>
        <div className="flex flex-wrap gap-2">
          <Button 
            onClick={() => setShowStats(!showStats)} 
            variant="outline" 
            size="sm"
          >
            <BarChart3 className="w-4 h-4 mr-2" />
            {showStats ? 'Hide' : 'Show'} Stats
          </Button>
          <Button onClick={handleExport} variant="outline" size="sm">
            <Download className="w-4 h-4 mr-2" />
            Export
          </Button>
          {callHistory.length > 0 && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" size="sm">
                  <Trash2 className="w-4 h-4 mr-2" />
                  Clear All
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Clear call history?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This action cannot be undone. All your call history will be permanently deleted.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={handleClearHistory}>
                    Clear All
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>

      {showStats && (
        <Card>
          <CardHeader>
            <CardTitle>Call Statistics</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
              <div className="text-center">
                <div className="text-2xl font-bold">{stats.totalCalls}</div>
                <div className="text-sm text-muted-foreground">Total Calls</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold">{stats.answeredCalls}</div>
                <div className="text-sm text-muted-foreground">Answered</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold">{stats.missedCalls}</div>
                <div className="text-sm text-muted-foreground">Missed</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold">{formatDuration(stats.totalDuration)}</div>
                <div className="text-sm text-muted-foreground">Total Duration</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold">{formatDuration(Math.round(stats.averageDuration))}</div>
                <div className="text-sm text-muted-foreground">Avg Duration</div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground w-4 h-4" />
              <Input
                placeholder="Search call history..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10"
              />
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <Select value={filterType} onValueChange={(value: any) => setFilterType(value)}>
                <SelectTrigger className="w-full sm:w-[180px]">
                  <SelectValue placeholder="Filter by type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Calls</SelectItem>
                  <SelectItem value="incoming">Incoming</SelectItem>
                  <SelectItem value="outgoing">Outgoing</SelectItem>
                  <SelectItem value="missed">Missed</SelectItem>
                </SelectContent>
              </Select>
              <Select value={dateFilter} onValueChange={(value: any) => setDateFilter(value)}>
                <SelectTrigger className="w-full sm:w-[180px]">
                  <SelectValue placeholder="Filter by date" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Dates</SelectItem>
                  <SelectItem value="today">Today</SelectItem>
                  <SelectItem value="yesterday">Yesterday</SelectItem>
                  <SelectItem value="week">Last 7 Days</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {filteredCalls.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              {callHistory.length === 0 ? "No call history yet." : "No calls match your filters."}
            </div>
          ) : (
            <div className="space-y-2">
              {filteredCalls.map((call) => (
                <div
                  key={call.id}
                  className="flex items-center justify-between p-4 border rounded-lg hover:bg-muted/50 transition-colors"
                >
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    {getCallIcon(call)}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="font-semibold truncate">
                          {call.contactName || call.phoneNumber}
                        </h3>
                        {call.contactName && (
                          <span className="text-sm text-muted-foreground">
                            ({call.phoneNumber})
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <span>{formatDate(call.timestamp)}</span>
                        <span>•</span>
                        <span>{format(call.timestamp, 'HH:mm')}</span>
                        {call.answered && call.duration > 0 && (
                          <>
                            <span>•</span>
                            <span>{formatDuration(call.duration)}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleCall(call.phoneNumber)}
                    className="shrink-0"
                  >
                    <Phone className="w-4 h-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default History;