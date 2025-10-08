// Centralized XMPP error handling with circuit breaker pattern
export class XmppErrorHandler {
  private failureCounts: Map<string, number> = new Map();
  private circuitBreakers: Map<string, { opened: boolean; resetAt: Date | null }> = new Map();
  private readonly failureThreshold = 3;
  private readonly circuitResetDelay = 60000; // 1 minute

  isCircuitOpen(operation: string): boolean {
    const breaker = this.circuitBreakers.get(operation);
    if (!breaker || !breaker.opened) return false;

    // Check if circuit should reset
    if (breaker.resetAt && new Date() > breaker.resetAt) {
      this.circuitBreakers.delete(operation);
      this.failureCounts.delete(operation);
      console.log(`Circuit breaker reset for: ${operation}`);
      return false;
    }

    return true;
  }

  recordFailure(operation: string): void {
    const count = (this.failureCounts.get(operation) || 0) + 1;
    this.failureCounts.set(operation, count);

    if (count >= this.failureThreshold) {
      console.warn(`Circuit breaker opened for: ${operation} (${count} failures)`);
      this.circuitBreakers.set(operation, {
        opened: true,
        resetAt: new Date(Date.now() + this.circuitResetDelay)
      });
    }
  }

  recordSuccess(operation: string): void {
    this.failureCounts.delete(operation);
    this.circuitBreakers.delete(operation);
  }

  getFailureCount(operation: string): number {
    return this.failureCounts.get(operation) || 0;
  }

  reset(): void {
    this.failureCounts.clear();
    this.circuitBreakers.clear();
  }
}

export const xmppErrorHandler = new XmppErrorHandler();

// Safe IQ request wrapper with timeout and retry
export async function safeIqRequest(
  xmpp: any,
  stanza: any,
  options: {
    operation: string;
    timeout?: number;
    retries?: number;
    critical?: boolean;
  }
): Promise<any> {
  const { operation, timeout = 30000, retries = 2, critical = false } = options;

  // Check circuit breaker (skip for critical operations)
  if (!critical && xmppErrorHandler.isCircuitOpen(operation)) {
    throw new Error(`Circuit breaker open for: ${operation}`);
  }

  // Check if client is available and connected
  if (!xmpp || !xmpp.iqCaller) {
    const error = new Error('XMPP client not available');
    error.name = 'ClientDisconnected';
    throw error;
  }

  // Store reference to avoid race conditions
  const clientRef = xmpp;
  const iqCallerRef = xmpp.iqCaller;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // Verify client is still connected before each attempt
      if (!clientRef || !iqCallerRef || clientRef.status !== 'online') {
        const error = new Error('Client disconnected');
        error.name = 'ClientDisconnected';
        throw error;
      }

      // Create timeout promise
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('TimeoutError')), timeout);
      });

      // Race between IQ request and timeout
      const response = await Promise.race([
        iqCallerRef.request(stanza),
        timeoutPromise
      ]);

      // Success - record it
      xmppErrorHandler.recordSuccess(operation);
      return response;

    } catch (error: any) {
      lastError = error;
      
      // Check if it's a connection error - don't retry
      if (
        error.name === 'ClientDisconnected' ||
        error.message?.includes('not available') || 
        error.message?.includes('null') ||
        error.message?.toLowerCase().includes('write')
      ) {
        console.error(`${operation}: Client disconnected`);
        throw error;
      }

      // Log attempt
      if (attempt < retries) {
        console.warn(`${operation}: Attempt ${attempt + 1} failed, retrying...`, error);
        // Wait before retry with exponential backoff
        await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
      }
    }
  }

  // All retries failed
  xmppErrorHandler.recordFailure(operation);
  console.error(`${operation}: All ${retries + 1} attempts failed`);
  throw lastError || new Error(`${operation} failed`);
}
