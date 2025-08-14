export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  id: string;
  timestamp: Date;
  level: LogLevel;
  message: string;
  data?: any;
  source?: string;
}

class Logger {
  private static instance: Logger;
  private logs: LogEntry[] = [];
  private maxHistory = 1000;
  private currentLevel: LogLevel = 'info';
  private listeners: Array<(log: LogEntry) => void> = [];

  private constructor() {
    // Override console methods to capture all logs
    this.interceptConsoleMethods();
  }

  static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  private interceptConsoleMethods() {
    const originalConsole = {
      debug: console.debug,
      info: console.info,
      warn: console.warn,
      error: console.error,
    };

    console.debug = (...args) => {
      this.log('debug', args.join(' '), args.length > 1 ? args.slice(1) : undefined);
      originalConsole.debug.apply(console, args);
    };

    console.info = (...args) => {
      this.log('info', args.join(' '), args.length > 1 ? args.slice(1) : undefined);
      originalConsole.info.apply(console, args);
    };

    console.warn = (...args) => {
      this.log('warn', args.join(' '), args.length > 1 ? args.slice(1) : undefined);
      originalConsole.warn.apply(console, args);
    };

    console.error = (...args) => {
      this.log('error', args.join(' '), args.length > 1 ? args.slice(1) : undefined);
      originalConsole.error.apply(console, args);
    };
  }

  private log(level: LogLevel, message: string, data?: any, source?: string) {
    const logEntry: LogEntry = {
      id: Math.random().toString(36).substr(2, 9),
      timestamp: new Date(),
      level,
      message,
      data,
      source,
    };

    this.logs.push(logEntry);

    // Maintain max history
    if (this.logs.length > this.maxHistory) {
      this.logs.shift();
    }

    // Notify listeners
    this.listeners.forEach(listener => listener(logEntry));
  }

  debug(message: string, data?: any, source?: string) {
    this.log('debug', message, data, source);
  }

  info(message: string, data?: any, source?: string) {
    this.log('info', message, data, source);
  }

  warn(message: string, data?: any, source?: string) {
    this.log('warn', message, data, source);
  }

  error(message: string, data?: any, source?: string) {
    this.log('error', message, data, source);
  }

  getLogs(): LogEntry[] {
    return [...this.logs];
  }

  getFilteredLogs(level?: LogLevel, search?: string): LogEntry[] {
    let filtered = this.logs;

    if (level) {
      const levelPriority = { debug: 0, info: 1, warn: 2, error: 3 };
      const minPriority = levelPriority[level];
      filtered = filtered.filter(log => levelPriority[log.level] >= minPriority);
    }

    if (search) {
      const searchLower = search.toLowerCase();
      filtered = filtered.filter(log => 
        log.message.toLowerCase().includes(searchLower) ||
        log.source?.toLowerCase().includes(searchLower)
      );
    }

    return filtered;
  }

  clearLogs() {
    this.logs = [];
    this.listeners.forEach(listener => listener({
      id: 'clear',
      timestamp: new Date(),
      level: 'info',
      message: 'Logs cleared',
      source: 'Logger',
    }));
  }

  setLevel(level: LogLevel) {
    this.currentLevel = level;
  }

  setMaxHistory(max: number) {
    this.maxHistory = max;
    if (this.logs.length > max) {
      this.logs = this.logs.slice(-max);
    }
  }

  exportLogs(format: 'json' | 'text' = 'json'): string {
    if (format === 'json') {
      return JSON.stringify(this.logs, null, 2);
    }

    return this.logs
      .map(log => {
        const timestamp = log.timestamp.toISOString();
        const level = log.level.toUpperCase().padEnd(5);
        const source = log.source ? `[${log.source}]` : '';
        return `${timestamp} ${level} ${source} ${log.message}`;
      })
      .join('\n');
  }

  subscribe(listener: (log: LogEntry) => void): () => void {
    this.listeners.push(listener);
    
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index > -1) {
        this.listeners.splice(index, 1);
      }
    };
  }

  getStats() {
    const stats = this.logs.reduce(
      (acc, log) => {
        acc[log.level] = (acc[log.level] || 0) + 1;
        return acc;
      },
      {} as Record<LogLevel, number>
    );

    return {
      total: this.logs.length,
      byLevel: stats,
      oldestLog: this.logs[0]?.timestamp,
      newestLog: this.logs[this.logs.length - 1]?.timestamp,
    };
  }
}

export const logger = Logger.getInstance();