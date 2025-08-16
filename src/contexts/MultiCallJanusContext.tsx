import { createContext, useContext, useState, useCallback, useRef, useEffect, ReactNode } from 'react'
import { toast, useToast } from '@/hooks/use-toast'
import { ToastAction } from '@/components/ui/toast'
import { Phone, PhoneOff } from 'lucide-react'
import { loadJanus, getJanus } from '@/lib/janusLoader'
import { AudioQualityOptimizer, getOptimalAudioConstraints } from '@/lib/audioQualityOptimizer'
import { ringtoneManager } from '@/lib/ringtoneManager'
import { useSettings } from './SettingsContext'
import { useContacts } from './ContactsContext'
import { useCallHistory } from './CallHistoryContext'
import { audioDeviceManager } from '@/lib/audioDeviceManager'
import { logger } from '@/lib/logger'
import { Call, CallsState, SipHandle } from '@/types/call'

// Janus WebRTC Gateway types
interface JanusConfig {
  server: string
  apiSecret?: string
}

interface JanusSession {
  id: number
  destroy: () => void
  attach: (pluginHandle: any) => void
}

interface JanusPlugin {
  plugin: string
  success: (pluginHandle: any) => void
  error: (error: any) => void
  onmessage: (msg: any, jsep?: any) => void
  onlocaltrack: (track: MediaStreamTrack, on: boolean) => void
  onremotetrack: (track: MediaStreamTrack, mindex: number, on: boolean) => void
  oncleanup: () => void
}

interface MultiCallJanusContextType {
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

const MultiCallJanusContext = createContext<MultiCallJanusContextType | undefined>(undefined)

export const useMultiCallJanusContext = () => {
  const context = useContext(MultiCallJanusContext)
  if (!context) {
    throw new Error('useMultiCallJanusContext must be used within a MultiCallJanusProvider')
  }
  return context
}

interface MultiCallJanusProviderProps {
  children: ReactNode
}

export const MultiCallJanusProvider = ({ children }: MultiCallJanusProviderProps) => {
  const { settings } = useSettings()
  const { getContactByPhoneNumber } = useContacts()
  const { addCallRecord } = useCallHistory()
  
  const [callsState, setCallsState] = useState<CallsState>({
    calls: [],
    registered: false,
    sipStatus: 'Not connected',
    doNotDisturb: false,
    status: 'disconnected',
    multiCallSupported: false
  })
  
  const { dismiss } = useToast()
  const janusRef = useRef<any>(null)
  const sessionRef = useRef<JanusSession | null>(null)
  const sipHandlesRef = useRef<SipHandle[]>([])
  const localVideoRef = useRef<HTMLVideoElement | null>(null)
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null)
  const isRegisteringRef = useRef<boolean>(false)
  const registrationCooldownRef = useRef<number>(0)
  const incomingCallToastRef = useRef<any>(null)
  const audioOptimizerRef = useRef<AudioQualityOptimizer | null>(null)
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const [retryCount, setRetryCount] = useState(0)
  const [isRetrying, setIsRetrying] = useState(false)
  const maxRetries = 3
  const retryDelay = 3000

  // Utility function to extract phone number from SIP URI
  const extractPhoneNumber = useCallback((sipUri: string): string => {
    if (!sipUri) return "Unknown"
    
    const match = sipUri.match(/^sip:([^@]+)@/)
    if (match && match[1]) {
      return match[1].replace(/[^0-9]/g, '')
    }
    
    return sipUri
  }, [])

  // Generate unique call ID
  const generateCallId = useCallback(() => {
    return `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }, [])

  // Find available SIP handle for new calls
  const getAvailableHandle = useCallback((): SipHandle | null => {
    // First check if we have any idle handles
    const activeCallIds = callsState.calls.map(call => call.handleId)
    const availableHandle = sipHandlesRef.current.find(handle => 
      !activeCallIds.includes(handle.id) && handle.registered
    )
    
    return availableHandle || null
  }, [callsState.calls])

  // Find handle by ID
  const getHandleById = useCallback((handleId: string): SipHandle | null => {
    return sipHandlesRef.current.find(handle => handle.id === handleId) || null
  }, [])

  // Handle SIP messages with handle-specific routing
  const createSipMessageHandler = useCallback((handleId: string) => {
    return (msg: any, jsep?: any) => {
      const event = msg.result?.event || msg.sip
      
      if (event === "registered") {
        logger.info(`SIP handle ${handleId} registration successful`)
        
        // Update handle registration status
        sipHandlesRef.current = sipHandlesRef.current.map(handle => 
          handle.id === handleId ? { ...handle, registered: true } : handle
        )
        
        // Check if this is our first registration
        const registeredHandles = sipHandlesRef.current.filter(h => h.registered)
        if (registeredHandles.length === 1) {
          setCallsState(prev => ({ 
            ...prev, 
            registered: true, 
            sipStatus: 'Online'
          }))
        } else if (registeredHandles.length === 2) {
          setCallsState(prev => ({ 
            ...prev, 
            multiCallSupported: true,
            sipStatus: 'Online (Multi-call ready)'
          }))
        }
        
      } else if (event === "registering") {
        setCallsState(prev => ({ ...prev, sipStatus: 'Registering...' }))
        
      } else if (event === "registration_failed") {
        const reason = msg.result?.reason || msg.reason || "Unknown error"
        const code = msg.result?.code || msg.code
        logger.error(`SIP handle ${handleId} registration failed:`, { reason, code, msg })
        
        // Update handle registration status
        sipHandlesRef.current = sipHandlesRef.current.map(handle => 
          handle.id === handleId ? { ...handle, registered: false } : handle
        )
        
        const registeredHandles = sipHandlesRef.current.filter(h => h.registered)
        if (registeredHandles.length === 0) {
          setCallsState(prev => ({ 
            ...prev, 
            registered: false, 
            status: 'error',
            sipStatus: `Registration failed: ${reason}` 
          }))
          
          toast({
            title: "Registration Failed",
            description: code ? `${reason} (${code})` : reason,
            variant: "destructive"
          })
        }
        
      } else if (event === "incomingcall") {
        logger.info(`Incoming call on handle ${handleId}:`, msg, "JSEP:", jsep)
        const callerId = msg.username || msg.result?.username || "Unknown"
        const phoneNumber = extractPhoneNumber(callerId)
        
        // Check if Do Not Disturb is enabled
        if (callsState.doNotDisturb) {
          logger.info("Rejecting call due to Do Not Disturb mode")
          const handle = getHandleById(handleId)
          if (handle?.plugin) {
            const decline = { request: "decline" }
            handle.plugin.send({ message: decline })
          }
          
          toast({
            title: "Call Blocked",
            description: `Incoming call from ${phoneNumber} blocked (Do Not Disturb)`,
            variant: "default"
          })
          return
        }
        
        // Check if we already have an active call
        const activeCalls = callsState.calls.filter(call => call.status === 'incall')
        
        if (activeCalls.length > 0) {
          // This is call waiting - store as waiting call
          setCallsState(prev => ({
            ...prev,
            waitingCall: {
              id: generateCallId(),
              phoneNumber,
              callerId,
              remoteJsep: jsep
            }
          }))
          
          // Play call waiting tone
          if (settings.ringtones.enabled) {
            ringtoneManager.playIncomingRing() // Could add specific call waiting tone
          }
          
          toast({
            title: "Call Waiting",
            description: `${phoneNumber} is calling`,
            action: (
              <div className="flex gap-2">
                <ToastAction 
                  altText="End current & accept"
                  onClick={() => endCurrentAndAcceptWaiting()}
                  className="bg-green-600 hover:bg-green-700 text-white"
                >
                  End & Accept
                </ToastAction>
                <ToastAction 
                  altText="Decline waiting call"
                  onClick={() => declineWaitingCall()}
                  className="bg-red-600 hover:bg-red-700 text-white"
                >
                  Decline
                </ToastAction>
              </div>
            ),
          })
          
        } else {
          // Regular incoming call
          const callId = generateCallId()
          const newCall: Call = {
            id: callId,
            handleId,
            status: 'incoming',
            direction: 'incoming',
            phoneNumber,
            callerId,
            remoteJsep: jsep,
            isOnHold: false,
            startTime: new Date()
          }
          
          setCallsState(prev => ({
            ...prev,
            calls: [...prev.calls, newCall],
            activeCallId: callId
          }))
          
          // Play incoming ringtone
          if (settings.ringtones.enabled) {
            ringtoneManager.playIncomingRing()
          }
          
          // Dismiss any existing toast
          if (incomingCallToastRef.current) {
            incomingCallToastRef.current.dismiss()
            incomingCallToastRef.current = null
          }
          
          incomingCallToastRef.current = toast({
            title: phoneNumber,
            description: "Incoming call",
            action: (
              <div className="flex gap-2">
                <ToastAction 
                  altText="Accept call"
                  onClick={() => acceptCall(callId)}
                  className="bg-green-600 hover:bg-green-700 text-white"
                >
                  <Phone className="h-4 w-4" />
                </ToastAction>
                <ToastAction 
                  altText="Reject call"
                  onClick={() => rejectCall(callId)}
                  className="bg-red-600 hover:bg-red-700 text-white"
                >
                  <PhoneOff className="h-4 w-4" />
                </ToastAction>
              </div>
            ),
          })
        }
        
      } else if (event === "calling") {
        // Update the call status for this handle
        setCallsState(prev => ({
          ...prev,
          calls: prev.calls.map(call => 
            call.handleId === handleId 
              ? { ...call, status: 'calling' as const }
              : call
          )
        }))
        
        // Play outgoing ringtone if enabled
        if (settings.ringtones.enabled) {
          ringtoneManager.playOutgoingRing()
        }
        
      } else if (event === "accepted") {
        // Stop any ringing sounds
        ringtoneManager.stopRinging()
        
        // Update call status to in-call
        setCallsState(prev => ({
          ...prev,
          calls: prev.calls.map(call => 
            call.handleId === handleId 
              ? { ...call, status: 'incall' as const }
              : call
          )
        }))
        
        toast({
          title: "Call Connected",
          description: "Call is now active",
        })
        
      } else if (event === "hangup") {
        const sipCode = msg.result?.code || msg.code
        const sipReason = msg.result?.reason || msg.reason || "Call ended"
        
        // Stop any ringing sounds
        ringtoneManager.stopRinging()
        
        // Dismiss incoming call toast if still showing
        if (incomingCallToastRef.current) {
          incomingCallToastRef.current.dismiss()
          incomingCallToastRef.current = null
        }
        
        // Find and remove the call for this handle
        const endedCall = callsState.calls.find(call => call.handleId === handleId)
        if (endedCall) {
          // Log call to history
          if (endedCall.phoneNumber && endedCall.startTime) {
            const endTime = new Date()
            const duration = Math.floor((endTime.getTime() - endedCall.startTime.getTime()) / 1000)
            const contact = getContactByPhoneNumber(endedCall.phoneNumber)
            
            addCallRecord({
              phoneNumber: endedCall.phoneNumber,
              contactName: contact?.name,
              duration: duration,
              timestamp: endedCall.startTime,
              type: endedCall.direction,
              answered: endedCall.status === 'incall'
            })
          }
          
          // Remove the call
          setCallsState(prev => {
            const remainingCalls = prev.calls.filter(call => call.id !== endedCall.id)
            const newActiveCallId = prev.activeCallId === endedCall.id 
              ? (remainingCalls.length > 0 ? remainingCalls[0].id : undefined)
              : prev.activeCallId
              
            return {
              ...prev,
              calls: remainingCalls,
              activeCallId: newActiveCallId
            }
          })
        }
        
        // Handle specific SIP error codes
        if (sipCode) {
          logger.info(`SIP hangup with code: ${sipCode} - ${sipReason}`)
          
          if (sipCode === 486) {
            ringtoneManager.playBusyTone()
            toast({
              title: "Line Busy",
              description: "The line you called is busy",
              variant: "destructive"
            })
          } else if (sipCode === 404) {
            toast({
              title: "Number Not Found",
              description: "The number you dialed does not exist",
              variant: "destructive"
            })
          } else if (sipCode === 408) {
            toast({
              title: "Call Timeout",
              description: "The call could not be completed - no response",
              variant: "destructive"
            })
          }
        }
      }
    }
  }, [callsState, settings, extractPhoneNumber, generateCallId, getHandleById, getContactByPhoneNumber, addCallRecord])

  // Initialize Janus and SIP plugin
  useEffect(() => {
    let destroyed = false

    const initializeJanus = async () => {
      if (destroyed) return

      setCallsState(prev => ({ ...prev, status: 'connecting', sipStatus: 'Connecting to server...' }))
      logger.info('Initializing Janus...')

      try {
        const janus = await loadJanus()
        janusRef.current = janus

        const janusServer = settings.janus.server
        const session = await createJanusSession(janusServer, settings.janus.apiSecret)
        sessionRef.current = session
        logger.info('Janus session created:', session.id)

        // Attach two SIP handles
        await attachSipHandle(session, 1)
        await attachSipHandle(session, 2)

        setCallsState(prev => ({ ...prev, status: 'connected', sipStatus: 'Registering SIP accounts...' }))
        registerSipAccounts()

      } catch (error: any) {
        logger.error('Failed to initialize Janus:', error)
        setCallsState(prev => ({ ...prev, status: 'error', sipStatus: 'Connection error' }))

        toast({
          title: "Connection Failed",
          description: error.message || "Could not connect to Janus",
          variant: "destructive"
        })

        // Retry connection with exponential backoff
        if (retryCount < maxRetries && !isRetrying) {
          setIsRetrying(true)
          const delay = retryDelay * Math.pow(2, retryCount)
          logger.warn(`Retrying Janus connection in ${delay / 1000} seconds (attempt ${retryCount + 1}/${maxRetries})`)

          retryTimeoutRef.current = setTimeout(() => {
            setIsRetrying(false)
            setRetryCount(prev => prev + 1)
            initializeJanus()
          }, delay)
        } else if (retryCount >= maxRetries) {
          logger.error('Max retries reached. Please check your settings and network connection.')
          toast({
            title: "Connection Failed",
            description: "Max connection retries reached. Please check your settings and network connection.",
            variant: "destructive"
          })
        }
      }
    }

    const createJanusSession = (server: string, apiSecret?: string): Promise<JanusSession> => {
      return new Promise((resolve, reject) => {
        const janus = janusRef.current

        janus({
          server: server,
          apisecret: apiSecret,
          success: (j: any) => {
            resolve({
              id: j.getSessionId(),
              destroy: () => j.destroy(),
              attach: (pluginHandle: any) => j.attach(pluginHandle)
            })
          },
          error: (error: any) => {
            logger.error('Error creating Janus session:', error)
            reject(new Error(error))
          },
          destroyed: () => {
            logger.warn('Janus session destroyed')
            janusRef.current = null
            sessionRef.current = null
            setCallsState(prev => ({ ...prev, status: 'disconnected', sipStatus: 'Disconnected' }))
          }
        })
      })
    }

    const attachSipHandle = (session: JanusSession, handleNumber: number): Promise<SipHandle> => {
      return new Promise((resolve, reject) => {
        const pluginOptions: JanusPlugin = {
          plugin: 'janus.plugin.sip',
          success: (pluginHandle: any) => {
            const handleId = `sipHandle_${handleNumber}`
            logger.info(`SIP plugin attached (handle ${handleNumber}):`, pluginHandle)

            const sipHandle: SipHandle = {
              id: handleId,
              plugin: pluginHandle,
              registered: false
            }

            sipHandlesRef.current.push(sipHandle)
            resolve(sipHandle)
          },
          error: (error: any) => {
            logger.error(`Error attaching SIP plugin (handle ${handleNumber}):`, error)
            reject(new Error(error))
          },
          onmessage: createSipMessageHandler(`sipHandle_${handleNumber}`),
          onlocaltrack: (track: MediaStreamTrack, on: boolean) => {
            logger.info(`Local track ${on ? 'added' : 'removed'}:`, track)
          },
          onremotetrack: (track: MediaStreamTrack, mindex: number, on: boolean) => {
            logger.info(`Remote track ${on ? 'added' : 'removed'} (index ${mindex}):`, track)
            // TODO: Handle remote video tracks
          },
          oncleanup: () => {
            logger.warn(`SIP plugin detached (handle ${handleNumber})`)
            // TODO: Handle plugin cleanup
          }
        }

        session.attach(pluginOptions)
      })
    }

    const registerSipAccounts = () => {
      if (isRegisteringRef.current) {
        logger.warn('SIP registration already in progress')
        return
      }

      if (!settings.sipAccount.username || !settings.sipAccount.authUsername || !settings.sipAccount.password) {
        logger.warn('SIP account details missing. Skipping registration.')
        setCallsState(prev => ({ ...prev, sipStatus: 'SIP account details missing' }))
        return
      }

      isRegisteringRef.current = true
      setCallsState(prev => ({ ...prev, sipStatus: 'Registering SIP accounts...' }))

      // Iterate through each SIP handle and register
      sipHandlesRef.current.forEach(async (handle, index) => {
        try {
          // Delay each registration attempt to avoid overwhelming the server
          await new Promise(resolve => setTimeout(resolve, index * 1000))

          const register = {
            request: "register",
            username: settings.sipAccount.username,
            authuser: settings.sipAccount.authUsername,
            secret: settings.sipAccount.password,
            proxy: settings.sipServer.host,
            reg_server: settings.sipServer.host,
          }

          logger.info(`Registering SIP account on handle ${handle.id}...`)
          handle.plugin.send({ message: register })

        } catch (error: any) {
          logger.error(`Failed to register SIP account on handle ${handle.id}:`, error)
          setCallsState(prev => ({ ...prev, sipStatus: `Registration failed: ${error.message}` }))
          toast({
            title: "Registration Failed",
            description: error.message || "Could not register SIP account",
            variant: "destructive"
          })
        } finally {
          isRegisteringRef.current = false
        }
      })
    }

    // Initialize audio quality optimizer
    if (settings.audio.opusMaxPlaybackRate) {
      audioOptimizerRef.current = new AudioQualityOptimizer(settings.audio.opusMaxPlaybackRate)
    }

    // Initial Janus initialization
    initializeJanus()

    // Cleanup on unmount
    return () => {
      destroyed = true

      // Clear retry timeout
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current)
      }

      // Destroy Janus session
      if (sessionRef.current) {
        logger.warn('Destroying Janus session...')
        sessionRef.current.destroy()
        sessionRef.current = null
      }

      // Detach SIP handles
      sipHandlesRef.current.forEach(handle => {
        if (handle.plugin) {
          logger.warn(`Detaching SIP plugin (handle ${handle.id})...`)
          handle.plugin.hangup()
        }
      })
      sipHandlesRef.current = []

      // Destroy Janus instance
      if (janusRef.current) {
        logger.warn('Destroying Janus instance...')
        janusRef.current.destroy()
        janusRef.current = null
      }
    }
  }, [settings, createSipMessageHandler, retryCount, isRetrying])
  
  // Call control functions
  const makeCall = useCallback(async (phoneNumber: string) => {
    const availableHandle = getAvailableHandle()
    if (!availableHandle) {
      toast({
        title: "No Available Line",
        description: "All lines are busy",
        variant: "destructive"
      })
      return
    }

    const callId = generateCallId()
    const newCall: Call = {
      id: callId,
      handleId: availableHandle.id,
      status: 'calling',
      direction: 'outgoing',
      phoneNumber,
      isOnHold: false,
      startTime: new Date()
    }

    setCallsState(prev => ({
      ...prev,
      calls: [...prev.calls, newCall],
      activeCallId: callId
    }))

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000,
          sampleSize: 16,
          channelCount: 1
        },
        video: false
      })

      const call = { request: "call", username: `sip:${phoneNumber}@${settings.sipServer?.domain || 'localhost'}` }

      availableHandle.plugin.createOffer({
        tracks: [{ type: "audio", capture: true, recv: true }],
        success: (jsep: any) => {
          availableHandle.plugin.send({ message: call, jsep })
        },
        error: (error: any) => {
          logger.error("Create offer error:", error)
          toast({
            title: "Call Failed",
            description: error.message || "Could not create offer",
            variant: "destructive"
          })
        }
      })
    } catch (error) {
      logger.error("Failed to get microphone access:", error)
      toast({
        title: "Microphone Error",
        description: "Cannot access microphone to make call",
        variant: "destructive"
      })
    }
  }, [getAvailableHandle, generateCallId, settings.sipServer.domain])

  const acceptCall = useCallback(async (callId?: string) => {
    const targetCallId = callId || callsState.activeCallId
    if (!targetCallId) return

    const call = callsState.calls.find(c => c.id === targetCallId)
    if (!call || !call.remoteJsep) return

    const handle = getHandleById(call.handleId)
    if (!handle?.plugin) return

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000,
          sampleSize: 16,
          channelCount: 1
        },
        video: false
      })

      const accept = { request: "accept" }

      handle.plugin.createAnswer({
        jsep: call.remoteJsep,
        tracks: [{ type: "audio", capture: true, recv: true }],
        success: (jsep: any) => {
          handle.plugin.send({ message: accept, jsep })
          setCallsState(prev => ({
            ...prev,
            calls: prev.calls.map(c => 
              c.id === targetCallId 
                ? { ...c, status: 'incall' as const }
                : c
            )
          }))
        },
        error: (error: any) => {
          logger.error("Create answer error:", error)
          toast({
            title: "Failed to Accept Call",
            description: error.message || "Could not create answer",
            variant: "destructive"
          })
        }
      })
    } catch (error) {
      logger.error("Failed to get microphone access:", error)
      toast({
        title: "Microphone Error",
        description: "Cannot access microphone to accept call",
        variant: "destructive"
      })
    }
  }, [callsState, getHandleById])

  const rejectCall = useCallback((callId?: string) => {
    const targetCallId = callId || callsState.activeCallId
    if (!targetCallId) return

    const call = callsState.calls.find(c => c.id === targetCallId)
    if (!call) return

    const handle = getHandleById(call.handleId)
    if (!handle?.plugin) return

    const decline = { request: "decline" }
    handle.plugin.send({ message: decline })
    
    setCallsState(prev => ({
      ...prev,
      calls: prev.calls.filter(c => c.id !== targetCallId),
      activeCallId: prev.activeCallId === targetCallId 
        ? (prev.calls.length > 1 ? prev.calls.find(c => c.id !== targetCallId)?.id : undefined)
        : prev.activeCallId
    }))

    ringtoneManager.stopRinging()
  }, [callsState, getHandleById])

  const hangupCall = useCallback((callId?: string) => {
    const targetCallId = callId || callsState.activeCallId
    if (!targetCallId) return

    const call = callsState.calls.find(c => c.id === targetCallId)
    if (!call) return

    const handle = getHandleById(call.handleId)
    if (!handle?.plugin) return

    const hangup = { request: "hangup" }
    handle.plugin.send({ message: hangup })
    handle.plugin.hangup()
  }, [callsState, getHandleById])

  const holdCall = useCallback((callId: string) => {
    const call = callsState.calls.find(c => c.id === callId)
    if (!call) return

    const handle = getHandleById(call.handleId)
    if (!handle?.plugin) return

    const hold = { request: "set", audio: false, video: false }
    handle.plugin.send({ message: hold })

    setCallsState(prev => ({
      ...prev,
      calls: prev.calls.map(c => 
        c.id === callId 
          ? { ...c, isOnHold: true, status: 'held' as const }
          : c
      )
    }))
  }, [callsState, getHandleById])

  const resumeCall = useCallback((callId: string) => {
    const call = callsState.calls.find(c => c.id === callId)
    if (!call) return

    const handle = getHandleById(call.handleId)
    if (!handle?.plugin) return

    const unhold = { request: "set", audio: true, video: false }
    handle.plugin.send({ message: unhold })

    setCallsState(prev => ({
      ...prev,
      calls: prev.calls.map(c => 
        c.id === callId 
          ? { ...c, isOnHold: false, status: 'incall' as const }
          : c
      ),
      activeCallId: callId
    }))
  }, [callsState, getHandleById])

  const swapCalls = useCallback(() => {
    const activeCalls = callsState.calls.filter(call => 
      call.status === 'incall' || call.status === 'held'
    )
    
    if (activeCalls.length !== 2) return

    const activeCall = activeCalls.find(call => !call.isOnHold)
    const heldCall = activeCalls.find(call => call.isOnHold)

    if (activeCall && heldCall) {
      holdCall(activeCall.id)
      resumeCall(heldCall.id)
    }
  }, [callsState, holdCall, resumeCall])

  const acceptWaitingCall = useCallback(async () => {
    if (!callsState.waitingCall) return

    // Put current call on hold if any
    const activeCall = callsState.calls.find(call => call.status === 'incall')
    if (activeCall) {
      holdCall(activeCall.id)
    }

    // Accept the waiting call on available handle
    const availableHandle = getAvailableHandle()
    if (!availableHandle) return

    // Create new call for waiting call
    const newCall: Call = {
      id: callsState.waitingCall.id,
      handleId: availableHandle.id,
      status: 'incoming',
      direction: 'incoming',
      phoneNumber: callsState.waitingCall.phoneNumber,
      callerId: callsState.waitingCall.callerId,
      remoteJsep: callsState.waitingCall.remoteJsep,
      isOnHold: false,
      startTime: new Date()
    }

    setCallsState(prev => ({
      ...prev,
      calls: [...prev.calls, newCall],
      activeCallId: newCall.id,
      waitingCall: undefined
    }))

    await acceptCall(newCall.id)
  }, [callsState, holdCall, getAvailableHandle, acceptCall])

  const declineWaitingCall = useCallback(() => {
    if (!callsState.waitingCall) return

    // Just clear the waiting call - no SIP action needed since we never accepted the INVITE
    setCallsState(prev => ({
      ...prev,
      waitingCall: undefined
    }))

    toast({
      title: "Call Declined",
      description: "Waiting call has been declined",
    })
  }, [callsState])

  const endCurrentAndAcceptWaiting = useCallback(async () => {
    if (!callsState.waitingCall) return

    // End current active call
    const activeCall = callsState.calls.find(call => call.status === 'incall')
    if (activeCall) {
      hangupCall(activeCall.id)
    }

    // Accept the waiting call
    await acceptWaitingCall()
  }, [callsState, hangupCall, acceptWaitingCall])

  // Keep existing functions for compatibility
  const setDoNotDisturb = useCallback((enabled: boolean) => {
    setCallsState(prev => ({ ...prev, doNotDisturb: enabled }))
  }, [])

  const disconnect = useCallback(() => {
    sipHandlesRef.current.forEach(handle => {
      if (handle.plugin) {
        handle.plugin.hangup()
      }
    })
    
    if (sessionRef.current) {
      sessionRef.current.destroy()
      sessionRef.current = null
    }
    
    setCallsState(prev => ({
      ...prev,
      calls: [],
      activeCallId: undefined,
      waitingCall: undefined,
      registered: false,
      status: 'disconnected',
      sipStatus: 'Disconnected'
    }))
  }, [])

  const reconnect = useCallback(async () => {
    disconnect()
    await initJanus()
  }, [disconnect, initJanus])

  const registerSipAccount = useCallback(() => {
    registerSipHandles()
  }, [registerSipHandles])

  const unregisterSipAccount = useCallback(() => {
    sipHandlesRef.current.forEach(handle => {
      if (handle.plugin) {
        const unregister = { request: "unregister" }
        handle.plugin.send({ message: unregister })
      }
    })
  }, [])

  const registerNow = useCallback(() => {
    registerSipHandles()
  }, [registerSipHandles])

  return (
    <MultiCallJanusContext.Provider value={{
      callsState,
      makeCall,
      acceptCall,
      rejectCall,
      hangupCall,
      holdCall,
      resumeCall,
      swapCalls,
      acceptWaitingCall,
      declineWaitingCall,
      endCurrentAndAcceptWaiting,
      disconnect,
      reconnect,
      setDoNotDisturb,
      registerSipAccount,
      unregisterSipAccount,
      registerNow
    }}>
      {children}
    </MultiCallJanusContext.Provider>
  )
}
