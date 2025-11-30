import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';

export interface CallQualityMetrics {
  packetsLost: number;
  packetsReceived: number;
  jitter: number;
  roundTripTime: number;
  audioLevel: number;
  quality: 'excellent' | 'good' | 'fair' | 'poor';
}

export interface CallRecord {
  id: string;
  phoneNumber: string;
  contactName?: string;
  duration: number; // in seconds
  timestamp: Date;
  type: 'incoming' | 'outgoing' | 'missed';
  answered: boolean;
  qualityMetrics?: CallQualityMetrics;
}

interface CallHistoryContextType {
  callHistory: CallRecord[];
  addCallRecord: (record: Omit<CallRecord, 'id'>) => void;
  getCallHistory: (limit?: number) => CallRecord[];
  getCallsByType: (type: CallRecord['type']) => CallRecord[];
  getCallsByDateRange: (startDate: Date, endDate: Date) => CallRecord[];
  searchCallHistory: (query: string) => CallRecord[];
  clearHistory: () => void;
  exportHistory: () => string;
  importHistory: (data: string) => boolean;
  getCallStats: () => {
    totalCalls: number;
    totalDuration: number;
    missedCalls: number;
    answeredCalls: number;
    averageDuration: number;
  };
  getQualityStats: () => {
    averageQuality: number;
    qualityDistribution: Record<string, number>;
    averagePacketLoss: number;
    averageJitter: number;
    callsWithMetrics: number;
  };
}

const CallHistoryContext = createContext<CallHistoryContextType | undefined>(undefined);

const STORAGE_KEY = 'app-call-history';
const MAX_HISTORY_SIZE = 1000; // Limit to prevent localStorage from getting too large

export const CallHistoryProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [callHistory, setCallHistory] = useState<CallRecord[]>([]);

  // Load call history from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        // Convert date strings back to Date objects
        const historyWithDates = parsed.map((record: any) => ({
          ...record,
          timestamp: new Date(record.timestamp),
        }));
        setCallHistory(historyWithDates);
      }
    } catch (error) {
      console.error('Failed to load call history from localStorage:', error);
    }
  }, []);

  // Save call history to localStorage whenever it changes
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(callHistory));
    } catch (error) {
      console.error('Failed to save call history to localStorage:', error);
    }
  }, [callHistory]);

  const addCallRecord = (recordData: Omit<CallRecord, 'id'>) => {
    const newRecord: CallRecord = {
      ...recordData,
      id: crypto.randomUUID(),
    };
    
    setCallHistory(prev => {
      const updated = [newRecord, ...prev];
      // Keep only the most recent records to prevent unlimited growth
      return updated.slice(0, MAX_HISTORY_SIZE);
    });
  };

  const getCallHistory = (limit?: number): CallRecord[] => {
    const sorted = [...callHistory].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    return limit ? sorted.slice(0, limit) : sorted;
  };

  const getCallsByType = (type: CallRecord['type']): CallRecord[] => {
    return callHistory.filter(record => record.type === type);
  };

  const getCallsByDateRange = (startDate: Date, endDate: Date): CallRecord[] => {
    return callHistory.filter(record => 
      record.timestamp >= startDate && record.timestamp <= endDate
    );
  };

  const searchCallHistory = (query: string): CallRecord[] => {
    if (!query.trim()) return getCallHistory();
    
    const lowercaseQuery = query.toLowerCase();
    return callHistory.filter(record =>
      record.phoneNumber.includes(query) ||
      record.contactName?.toLowerCase().includes(lowercaseQuery)
    );
  };

  const clearHistory = () => {
    setCallHistory([]);
  };

  const exportHistory = (): string => {
    return JSON.stringify(callHistory, null, 2);
  };

  const importHistory = (data: string): boolean => {
    try {
      const importedHistory = JSON.parse(data);
      if (!Array.isArray(importedHistory)) {
        throw new Error('Invalid data format');
      }
      
      // Validate and convert imported history
      const validHistory = importedHistory.map((record: any) => ({
        id: record.id || crypto.randomUUID(),
        phoneNumber: record.phoneNumber || '',
        contactName: record.contactName || undefined,
        duration: record.duration || 0,
        timestamp: record.timestamp ? new Date(record.timestamp) : new Date(),
        type: record.type || 'missed',
        answered: Boolean(record.answered),
      }));
      
      setCallHistory(validHistory);
      return true;
    } catch (error) {
      console.error('Failed to import call history:', error);
      return false;
    }
  };

  const getCallStats = () => {
    const totalCalls = callHistory.length;
    const totalDuration = callHistory.reduce((sum, record) => sum + record.duration, 0);
    const missedCalls = callHistory.filter(record => !record.answered).length;
    const answeredCalls = callHistory.filter(record => record.answered).length;
    const averageDuration = answeredCalls > 0 ? totalDuration / answeredCalls : 0;

    return {
      totalCalls,
      totalDuration,
      missedCalls,
      answeredCalls,
      averageDuration,
    };
  };

  const getQualityStats = () => {
    const callsWithMetrics = callHistory.filter(record => record.qualityMetrics);
    const qualityMap: Record<string, number> = { excellent: 4, good: 3, fair: 2, poor: 1 };
    
    let totalQuality = 0;
    let totalPacketLoss = 0;
    let totalJitter = 0;
    const qualityDistribution: Record<string, number> = {
      excellent: 0,
      good: 0,
      fair: 0,
      poor: 0
    };

    callsWithMetrics.forEach(record => {
      if (record.qualityMetrics) {
        const quality = record.qualityMetrics.quality;
        totalQuality += qualityMap[quality] || 0;
        qualityDistribution[quality]++;
        
        const { packetsLost, packetsReceived, jitter } = record.qualityMetrics;
        if (packetsReceived > 0) {
          totalPacketLoss += (packetsLost / (packetsLost + packetsReceived)) * 100;
        }
        totalJitter += jitter;
      }
    });

    const count = callsWithMetrics.length;
    return {
      averageQuality: count > 0 ? totalQuality / count : 0,
      qualityDistribution,
      averagePacketLoss: count > 0 ? totalPacketLoss / count : 0,
      averageJitter: count > 0 ? totalJitter / count : 0,
      callsWithMetrics: count
    };
  };

  const value: CallHistoryContextType = {
    callHistory,
    addCallRecord,
    getCallHistory,
    getCallsByType,
    getCallsByDateRange,
    searchCallHistory,
    clearHistory,
    exportHistory,
    importHistory,
    getCallStats,
    getQualityStats,
  };

  return <CallHistoryContext.Provider value={value}>{children}</CallHistoryContext.Provider>;
};

export const useCallHistory = () => {
  const context = useContext(CallHistoryContext);
  if (context === undefined) {
    throw new Error('useCallHistory must be used within a CallHistoryProvider');
  }
  return context;
};
