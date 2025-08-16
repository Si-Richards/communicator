import { createContext, useContext, useState, useCallback, ReactNode } from 'react'
import { useJanusContext } from './JanusContext'
import { Call, CallsState } from '@/types/call'

interface SimpleMultiCallContextType {
  callsState: CallsState
  makeCall: (phoneNumber: string) => Promise<void>
  acceptCall: (callId?: string) => Promise<void>
  rejectCall: (callId?: string) => void
  hangupCall: (callId?: string) => void
  holdCall: (callId: string) => void
  resumeCall: (callId: string) => void
  swapCalls: () => void
  acceptWaitingCall: () => Promise<void>
  declineWaitingCall: () => void
  endCurrentAndAcceptWaiting: () => Promise<void>
  disconnect: () => void
  reconnect: () => Promise<void>
  setDoNotDisturb: (enabled: boolean) => void
  registerSipAccount: () => void
  unregisterSipAccount: () => void
  registerNow: () => void
}

const SimpleMultiCallContext = createContext<SimpleMultiCallContextType | undefined>(undefined)

export const useSimpleMultiCallContext = () => {
  const context = useContext(SimpleMultiCallContext)
  if (!context) {
    throw new Error('useSimpleMultiCallContext must be used within a SimpleMultiCallProvider')
  }
  return context
}

export const SimpleMultiCallProvider = ({ children }: { children: ReactNode }) => {
  const janusContext = useJanusContext()
  
  // Convert single call state to multi-call state
  const [waitingCall, setWaitingCall] = useState<{ id: string; phoneNumber: string; callerId?: string; remoteJsep?: any } | undefined>()
  
  const callsState: CallsState = {
    calls: janusContext.callState.status !== 'disconnected' && janusContext.callState.status !== 'connected' ? [{
      id: 'main-call',
      handleId: 'main',
      status: janusContext.callState.status === 'incall' ? 'incall' : 
              janusContext.callState.status === 'calling' ? 'calling' : 
              janusContext.callState.status === 'incoming' ? 'incoming' : 'idle',
      direction: janusContext.callState.direction || 'outgoing',
      phoneNumber: janusContext.callState.callerId || janusContext.callState.incomingCallerId || '',
      isOnHold: janusContext.callState.isOnHold
    }] : [],
    activeCallId: janusContext.callState.status !== 'disconnected' && janusContext.callState.status !== 'connected' ? 'main-call' : undefined,
    waitingCall,
    registered: janusContext.callState.registered,
    sipStatus: janusContext.callState.sipStatus,
    doNotDisturb: janusContext.callState.doNotDisturb,
    status: janusContext.callState.status === 'disconnected' ? 'disconnected' : 
             janusContext.callState.status === 'connecting' ? 'connecting' : 
             janusContext.callState.status === 'error' ? 'error' : 'connected',
    multiCallSupported: false // Single call for now
  }

  const declineWaitingCall = useCallback(() => {
    setWaitingCall(undefined)
  }, [])

  const endCurrentAndAcceptWaiting = useCallback(async () => {
    if (waitingCall) {
      janusContext.hangupCall()
      setWaitingCall(undefined)
    }
  }, [waitingCall, janusContext])

  return (
    <SimpleMultiCallContext.Provider value={{
      callsState,
      makeCall: janusContext.makeCall,
      acceptCall: janusContext.acceptCall,
      rejectCall: janusContext.rejectCall,
      hangupCall: janusContext.hangupCall,
      holdCall: janusContext.holdCall,
      resumeCall: janusContext.resumeCall,
      swapCalls: () => {}, // Not supported in single call mode
      acceptWaitingCall: async () => {},
      declineWaitingCall,
      endCurrentAndAcceptWaiting,
      disconnect: janusContext.disconnect,
      reconnect: janusContext.reconnect,
      setDoNotDisturb: janusContext.setDoNotDisturb,
      registerSipAccount: janusContext.registerSipAccount,
      unregisterSipAccount: janusContext.unregisterSipAccount,
      registerNow: janusContext.registerNow
    }}>
      {children}
    </SimpleMultiCallContext.Provider>
  )
}