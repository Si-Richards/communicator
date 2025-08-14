import { createContext, useContext, useState, useCallback, useRef, useEffect, ReactNode } from 'react'
import { toast, useToast } from '@/hooks/use-toast'
import { ToastAction } from '@/components/ui/toast'
import { Phone, PhoneOff } from 'lucide-react'
import { loadJanus, getJanus } from '@/lib/janusLoader'
import { AudioQualityOptimizer, getOptimalAudioConstraints } from '@/lib/audioQualityOptimizer'
import { ringtoneManager } from '@/lib/ringtoneManager'
import { useSettings } from './SettingsContext'
import { audioDeviceManager } from '@/lib/audioDeviceManager'
import { logger } from '@/lib/logger'

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

interface CallState {
  status: 'disconnected' | 'connecting' | 'connected' | 'calling' | 'incall' | 'incoming' | 'ringing' | 'error'
  registered: boolean
  sipStatus: string
  doNotDisturb: boolean
  isOnHold: boolean
  localStream?: MediaStream
  remoteStream?: MediaStream
  incomingCallerId?: string
  incomingCallId?: string
  remoteJsep?: any
}

interface JanusContextType {
  callState: CallState
  makeCall: (phoneNumber: string) => Promise<void>
  acceptCall: () => Promise<void>
  rejectCall: () => void
  hangupCall: () => void
  holdCall: () => void
  resumeCall: () => void
  disconnect: () => void
  reconnect: () => Promise<void>
  setDoNotDisturb: (enabled: boolean) => void
}

const JanusContext = createContext<JanusContextType | undefined>(undefined)

export const useJanusContext = () => {
  const context = useContext(JanusContext)
  if (!context) {
    throw new Error('useJanusContext must be used within a JanusProvider')
  }
  return context
}

interface JanusProviderProps {
  children: ReactNode
}

export const JanusProvider = ({ children }: JanusProviderProps) => {
  const { settings } = useSettings()
  const [callState, setCallState] = useState<CallState>({
    status: 'disconnected',
    registered: false,
    sipStatus: 'Not connected',
    doNotDisturb: false,
    isOnHold: false
  })
  
  const { dismiss } = useToast()
  const janusRef = useRef<any>(null)
  const sessionRef = useRef<JanusSession | null>(null)
  const sipPluginRef = useRef<any>(null)
  const localVideoRef = useRef<HTMLVideoElement | null>(null)
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null)
  const incomingCallToastRef = useRef<any>(null)
  const audioOptimizerRef = useRef<AudioQualityOptimizer | null>(null)
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const [retryCount, setRetryCount] = useState(0)
  const [isRetrying, setIsRetrying] = useState(false)
  const maxRetries = 3
  const retryDelay = 3000

  // Initialize Janus
  const initJanus = useCallback(async () => {
    try {
      setCallState(prev => ({ ...prev, status: 'connecting', sipStatus: 'Initializing...' }))

      // Load Janus library first
      await loadJanus()
      const Janus = getJanus()

      // Initialize Janus library
      Janus.init({
        debug: settings.logs.level === 'debug' ? "all" : false,
        callback: () => {
          logger.info("Janus initialized successfully", undefined, 'JanusContext')
          connectToJanus()
        }
      })
    } catch (error) {
      logger.error("Failed to initialize Janus", error, 'JanusContext')
      setCallState(prev => ({ ...prev, status: 'error', sipStatus: `Failed to initialize: ${error instanceof Error ? error.message : 'Unknown error'}` }))
      toast({
        title: "Connection Error",
        description: "Failed to initialize WebRTC library",
        variant: "destructive"
      })
    }
  }, [])

  const connectToJanus = useCallback(() => {
    // Create Janus session with optimized settings for audio quality
    const Janus = getJanus()
    janusRef.current = new Janus({
      server: "wss://devrtc.voicehost.io:443",
      apisecret: "overlord",
      // ICE servers for better connectivity
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" }
      ],
      // Jitter buffer configuration for audio quality
      jitterBuffer: {
        minDelay: 20,
        maxDelay: 250,
        targetDelay: 50
      },
      // Network adaptation settings
      rtcConfiguration: {
        iceConnectionPolicy: "all",
        iceCandidatePoolSize: 10,
        bundlePolicy: "max-bundle",
        rtcpMuxPolicy: "require"
      },
      success: () => {
        console.log("Connected to Janus Gateway with optimized settings")
        // Reset retry state on successful connection
        setRetryCount(0)
        setIsRetrying(false)
        if (retryTimeoutRef.current) {
          clearTimeout(retryTimeoutRef.current)
          retryTimeoutRef.current = null
        }
        setCallState(prev => ({ ...prev, status: 'connected', sipStatus: 'Connected to server' }))
        attachSipPlugin()
      },
      error: (error: any) => {
        console.error("Failed to connect to Janus:", error)
        
        // Check if we can retry
        if (retryCount < maxRetries) {
          setIsRetrying(true)
          setRetryCount(prev => prev + 1)
          setCallState(prev => ({ 
            ...prev, 
            status: 'connecting', 
            sipStatus: `Retrying connection... (${retryCount + 1}/${maxRetries})` 
          }))
          
          // Retry after delay
          retryTimeoutRef.current = setTimeout(() => {
            console.log(`Retrying connection attempt ${retryCount + 1}/${maxRetries}`)
            connectToJanus()
          }, retryDelay)
        } else {
          // All retries exhausted
          setIsRetrying(false)
          setCallState(prev => ({ ...prev, status: 'error', sipStatus: 'Connection failed after retries' }))
          toast({
            title: "Connection Error",
            description: `Failed to connect to Janus server after ${maxRetries} attempts`,
            variant: "destructive"
          })
        }
      },
      destroyed: () => {
        console.log("Janus session destroyed")
        setCallState(prev => ({ ...prev, status: 'disconnected', sipStatus: 'Disconnected' }))
      }
    })
  }, [])

  const attachSipPlugin = useCallback(() => {
    if (!janusRef.current) return;
    
    janusRef.current.attach({
      plugin: "janus.plugin.sip",
      success: (pluginHandle: any) => {
        console.log("SIP plugin attached successfully")
        sipPluginRef.current = pluginHandle
        setCallState(prev => ({ ...prev, sipStatus: 'SIP plugin ready' }))
        registerSipAccount()
      },
      error: (error: any) => {
        console.error("Failed to attach SIP plugin:", error)
        setCallState(prev => ({ ...prev, status: 'error', sipStatus: 'SIP plugin failed' }))
        toast({
          title: "SIP Error",
          description: "Failed to attach SIP plugin",
          variant: "destructive"
        })
      },
      onmessage: (msg: any, jsep?: any) => {
        console.log("SIP message received:", msg)
        handleSipMessage(msg, jsep)
      },
      onlocaltrack: (track: MediaStreamTrack, on: boolean) => {
        console.log("Local track:", track, on)
        if (track.kind === 'audio' && on) {
          const stream = new MediaStream([track])
          setCallState(prev => ({ ...prev, localStream: stream }))
        }
      },
      onremotetrack: (track: MediaStreamTrack, mindex: number, on: boolean) => {
        console.log("Remote track:", track, mindex, on)
        if (track.kind === 'audio' && on) {
          const stream = new MediaStream([track])
          setCallState(prev => ({ ...prev, remoteStream: stream }))
          
          // Enhanced audio playback with optimized settings
          const audioElement = document.createElement('audio')
          audioElement.srcObject = stream
          audioElement.autoplay = true
          audioElement.controls = false
          audioElement.muted = false
          
          // Optimize for low latency and quality
          audioElement.setAttribute('playsinline', 'true')
          audioElement.setAttribute('webkit-playsinline', 'true')
          
          // Set audio context for better processing
          try {
            if ('audioTracks' in stream) {
              const audioTracks = stream.getAudioTracks()
              if (audioTracks.length > 0) {
                const audioTrack = audioTracks[0]
                const settings = audioTrack.getSettings()
                console.log("Remote audio track settings:", settings)
              }
            }
          } catch (error) {
            console.warn("Could not access audio track settings:", error)
          }
          
          audioElement.play().catch(error => {
            console.error("Failed to play remote audio:", error)
          })
        }
      },
      oncleanup: () => {
        console.log("SIP plugin cleanup")
        setCallState(prev => ({ 
          ...prev, 
          registered: false, 
          sipStatus: 'Disconnected',
          localStream: undefined,
          remoteStream: undefined
        }))
      }
    })
  }, [])

  const registerSipAccount = useCallback(() => {
    if (!sipPluginRef.current) return

    const register = {
      request: "register",
      username: "sip:16331*201@hpbx.sipconvergence.co.uk",
      secret: "am4tsQwM53YYT!cw",
      host: "hpbx.sipconvergence.co.uk:5060",
      send_register: true
    }

    setCallState(prev => ({ ...prev, sipStatus: 'Registering SIP account...' }))
    sipPluginRef.current.send({ message: register })
  }, [])

  // Utility function to extract phone number from SIP URI
  const extractPhoneNumber = useCallback((sipUri: string): string => {
    if (!sipUri) return "Unknown"
    
    // Extract number from SIP URI format like "sip:16331*201@hpbx.sipconvergence.co.uk"
    const match = sipUri.match(/^sip:([^@]+)@/)
    if (match && match[1]) {
      // Remove asterisk and other special characters, keep only digits
      return match[1].replace(/[^0-9]/g, '')
    }
    
    return sipUri
  }, [])

  const acceptCall = useCallback(async () => {
    console.log("AcceptCall called - Status:", callState.status, "SIP Plugin:", !!sipPluginRef.current)
    
    if (!sipPluginRef.current || callState.status !== 'incoming') {
      console.log("Cannot accept call - Invalid state")
      toast({
        title: "Cannot Accept Call", 
        description: "No incoming call to accept",
        variant: "destructive"
      })
      return
    }

    if (!callState.remoteJsep) {
      console.log("Cannot accept call - Missing remote JSEP")
      toast({
        title: "Call Failed",
        description: "Missing remote session description", 
        variant: "destructive"
      })
      return
    }

    try {
      console.log("Getting user media for accept call")
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

      sipPluginRef.current.createAnswer({
        jsep: callState.remoteJsep,
        tracks: [{ type: "audio", capture: true, recv: true }],
        success: (jsep: any) => {
          console.log("Accept call - create answer success")
          sipPluginRef.current.send({ message: accept, jsep })
          setCallState(prev => ({ ...prev, status: 'incall', sipStatus: 'Call connected' }))
        },
        error: (error: any) => {
          console.error("Create answer error:", error)
          toast({
            title: "Failed to Accept Call",
            description: error.message || "Could not create answer",
            variant: "destructive"
          })
        }
      })
    } catch (error) {
      console.error("Failed to get microphone access:", error)
      toast({
        title: "Microphone Error",
        description: "Cannot access microphone to accept call",
        variant: "destructive"
      })
    }
  }, [callState.status, callState.remoteJsep])

  const rejectCall = useCallback(() => {
    console.log("RejectCall called - Status:", callState.status, "SIP Plugin:", !!sipPluginRef.current)
    
    if (!sipPluginRef.current || callState.status !== 'incoming') {
      console.log("Cannot reject call - Invalid state")
      return
    }

    console.log("Sending decline message")
    const decline = { request: "decline" }
    sipPluginRef.current.send({ message: decline })
    
    setCallState(prev => ({ 
      ...prev, 
      status: 'connected', 
      sipStatus: callState.registered ? 'Online' : 'Offline',
      incomingCallerId: undefined,
      incomingCallId: undefined,
      remoteJsep: undefined
    }))
  }, [callState.status, callState.registered])

  // Direct action functions that bypass state validation for toast handlers
  const directAcceptCall = useCallback(async () => {
    console.log("Direct accept call - bypassing state validation")
    
    if (!sipPluginRef.current) {
      console.log("Cannot accept call - No SIP plugin")
      toast({
        title: "Call Failed",
        description: "SIP plugin not available",
        variant: "destructive"
      })
      return
    }

    if (!callState.remoteJsep) {
      console.log("Cannot accept call - Missing remote JSEP")
      toast({
        title: "Call Failed",
        description: "Missing remote session description", 
        variant: "destructive"
      })
      return
    }

    try {
      console.log("Getting user media for direct accept call")
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

      sipPluginRef.current.createAnswer({
        jsep: callState.remoteJsep,
        tracks: [{ type: "audio", capture: true, recv: true }],
        success: (jsep: any) => {
          console.log("Direct accept call - create answer success")
          sipPluginRef.current.send({ message: accept, jsep })
          setCallState(prev => ({ ...prev, status: 'incall', sipStatus: 'Call connected' }))
        },
        error: (error: any) => {
          console.error("Direct accept create answer error:", error)
          toast({
            title: "Failed to Accept Call",
            description: error.message || "Could not create answer",
            variant: "destructive"
          })
        }
      })
    } catch (error) {
      console.error("Direct accept failed to get microphone access:", error)
      toast({
        title: "Microphone Error",
        description: "Cannot access microphone to accept call",
        variant: "destructive"
      })
    }
  }, [callState.remoteJsep])

  const directRejectCall = useCallback(() => {
    console.log("Direct reject call - bypassing state validation")
    
    if (!sipPluginRef.current) {
      console.log("Cannot reject call - No SIP plugin")
      return
    }

    console.log("Sending decline message directly")
    const decline = { request: "decline" }
    sipPluginRef.current.send({ message: decline })
    
    setCallState(prev => ({ 
      ...prev, 
      status: 'connected', 
      sipStatus: prev.registered ? 'Online' : 'Offline',
      incomingCallerId: undefined,
      incomingCallId: undefined,
      remoteJsep: undefined
    }))
  }, [])

  // Toast action handlers that use direct functions
  const handleToastAcceptCall = useCallback(() => {
    console.log("Toast Accept button clicked")
    if (incomingCallToastRef.current) {
      incomingCallToastRef.current.dismiss()
      incomingCallToastRef.current = null
    }
    directAcceptCall()
  }, [directAcceptCall])

  const handleToastRejectCall = useCallback(() => {
    console.log("Toast Reject button clicked")
    if (incomingCallToastRef.current) {
      incomingCallToastRef.current.dismiss()
      incomingCallToastRef.current = null
    }
    directRejectCall()
  }, [directRejectCall])

  const handleSipMessage = useCallback((msg: any, jsep?: any) => {
    const event = msg.result?.event || msg.sip
    
    if (event === "registered") {
      console.log("SIP registration successful")
      setCallState(prev => ({ 
        ...prev, 
        registered: true, 
        sipStatus: 'Online'
      }))
      // Registration successful - no toast needed as status is visible in sidebar
    } else if (event === "registering") {
      setCallState(prev => ({ ...prev, sipStatus: 'Registering...' }))
    } else if (event === "registration_failed") {
      console.error("SIP registration failed:", msg.reason)
      setCallState(prev => ({ 
        ...prev, 
        registered: false, 
        status: 'error',
        sipStatus: `Registration failed: ${msg.reason}` 
      }))
      toast({
        title: "Registration Failed",
        description: msg.reason || "SIP registration failed",
        variant: "destructive"
      })
    } else if (event === "incomingcall") {
      console.log("Incoming call received:", msg, "JSEP:", jsep)
      const callerId = msg.username || msg.result?.username || "Unknown"
      const phoneNumber = extractPhoneNumber(callerId)
      
      // Check if Do Not Disturb is enabled
      if (callState.doNotDisturb) {
        console.log("Rejecting call due to Do Not Disturb mode")
        const decline = { request: "decline" }
        sipPluginRef.current.send({ message: decline })
        
        toast({
          title: "Call Blocked",
          description: `Incoming call from ${phoneNumber} blocked (Do Not Disturb)`,
          variant: "default"
        })
        return
      }
      
      setCallState(prev => ({ 
        ...prev, 
        status: 'incoming', 
        sipStatus: `Incoming call from ${phoneNumber}`,
        incomingCallerId: callerId,
        incomingCallId: msg.call_id || msg.result?.call_id,
        remoteJsep: jsep
      }))
      
      // Play incoming ringtone if enabled
      if (settings.ringtones.enabled) {
        ringtoneManager.playIncomingRing()
      }
      
      incomingCallToastRef.current = toast({
        title: phoneNumber,
        description: "Incoming call",
        action: (
          <div className="flex gap-2">
            <ToastAction 
              altText="Accept call"
              onClick={handleToastAcceptCall}
              className="bg-green-600 hover:bg-green-700 text-white"
            >
              <Phone className="h-4 w-4" />
            </ToastAction>
            <ToastAction 
              altText="Reject call"
              onClick={handleToastRejectCall}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              <PhoneOff className="h-4 w-4" />
            </ToastAction>
          </div>
        ),
      })
    } else if (event === "calling") {
      setCallState(prev => ({ ...prev, status: 'calling', sipStatus: 'Calling...' }))
      // Play outgoing ringtone if enabled
      if (settings.ringtones.enabled) {
        ringtoneManager.playOutgoingRing()
      }
    } else if (event === "accepted") {
      // Stop any ringing sounds
      ringtoneManager.stopRinging()
      
      setCallState(prev => ({ ...prev, status: 'incall', sipStatus: 'Call connected' }))
      toast({
        title: "Call Connected",
        description: "Call is now active",
      })
    } else if (event === "hangup") {
      // Stop any ringing sounds
      ringtoneManager.stopRinging()
      
      // Dismiss incoming call toast if still showing
      if (incomingCallToastRef.current) {
        incomingCallToastRef.current.dismiss()
        incomingCallToastRef.current = null
      }
      
      setCallState(prev => ({ 
        ...prev, 
        status: 'connected', 
        sipStatus: prev.registered ? 'Online' : 'Offline',
        localStream: undefined,
        remoteStream: undefined,
        incomingCallerId: undefined,
        incomingCallId: undefined,
        remoteJsep: undefined
      }))
      toast({
        title: "Call Ended",
        description: "Call has been terminated",
      })
    } else if (event === "missed") {
      // Stop any ringing sounds
      ringtoneManager.stopRinging()
      
      // Dismiss incoming call toast if still showing
      if (incomingCallToastRef.current) {
        incomingCallToastRef.current.dismiss()
        incomingCallToastRef.current = null
      }
      
      setCallState(prev => ({ 
        ...prev, 
        status: 'connected', 
        sipStatus: prev.registered ? 'Online' : 'Offline',
        incomingCallerId: undefined,
        incomingCallId: undefined,
        remoteJsep: undefined
      }))
      toast({
        title: "Missed Call",
        description: "You missed an incoming call",
        variant: "destructive"
      })
    }

    if (jsep) {
      sipPluginRef.current.handleRemoteJsep({ jsep })
    }
  }, [callState.registered, extractPhoneNumber, handleToastAcceptCall, handleToastRejectCall])

  const makeCall = useCallback(async (phoneNumber: string) => {
    if (!sipPluginRef.current || !callState.registered) {
      toast({
        title: "Cannot Make Call",
        description: "SIP account not registered",
        variant: "destructive"
      })
      return
    }

    try {
      // Get optimal audio constraints based on settings and selected device
      const deviceConstraints = await audioDeviceManager.getOptimalAudioConstraints(
        settings.audioDevices.inputDeviceId || undefined
      )
      
      // Override with user settings
      const audioConstraints: MediaStreamConstraints = {
        audio: {
          deviceId: settings.audioDevices.inputDeviceId ? { exact: settings.audioDevices.inputDeviceId } : undefined,
          sampleRate: settings.audioQuality.sampleRate,
          noiseSuppression: settings.audioQuality.noiseSuppression,
          echoCancellation: settings.audioQuality.echoCancellation,
          autoGainControl: settings.audioQuality.autoGainControl,
          channelCount: 1,
        },
        video: false,
      }
      
      const stream = await navigator.mediaDevices.getUserMedia(audioConstraints)

      // Apply audio optimization if available
      const optimizedStream = audioOptimizerRef.current 
        ? audioOptimizerRef.current.optimizeAudioStream(stream)
        : stream

      const call = {
        request: "call",
        uri: `sip:${phoneNumber}@hpbx.sipconvergence.co.uk`
      }

      sipPluginRef.current.createOffer({
        tracks: [{ type: "audio", capture: true, recv: true }],
        success: (jsep: any) => {
          sipPluginRef.current.send({ message: call, jsep })
        },
        error: (error: any) => {
          console.error("Create offer error:", error)
          toast({
            title: "Call Failed",
            description: "Failed to create call offer",
            variant: "destructive"
          })
        }
      })
    } catch (error) {
      console.error("Failed to get microphone access:", error)
      toast({
        title: "Microphone Error",
        description: "Cannot access microphone",
        variant: "destructive"
      })
    }
  }, [callState.registered])

  const setDoNotDisturb = useCallback((enabled: boolean) => {
    setCallState(prev => ({ ...prev, doNotDisturb: enabled }))
    // Persist DND setting in localStorage
    localStorage.setItem('doNotDisturb', enabled.toString())
  }, [])

  const hangupCall = useCallback(() => {
    if (!sipPluginRef.current) return

    const hangup = { request: "hangup" }
    sipPluginRef.current.send({ message: hangup })
    
    setCallState(prev => ({ 
      ...prev, 
      status: 'connected',
      isOnHold: false
    }))
  }, [])

  const holdCall = useCallback(() => {
    if (!sipPluginRef.current) return

    logger.info('Placing call on hold')
    
    const hold = {
      request: 'hold'
    }

    sipPluginRef.current.send({ message: hold })
    
    setCallState(prev => ({ 
      ...prev, 
      isOnHold: true
    }))
  }, [])

  const resumeCall = useCallback(() => {
    if (!sipPluginRef.current) return

    logger.info('Resuming call from hold')
    
    const unhold = {
      request: 'unhold'
    }

    sipPluginRef.current.send({ message: unhold })
    
    setCallState(prev => ({ 
      ...prev, 
      isOnHold: false
    }))
  }, [])

  const disconnect = useCallback(() => {
    // Clear any pending retry timeout
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current)
      retryTimeoutRef.current = null
    }
    
    if (janusRef.current) {
      janusRef.current.destroy()
      janusRef.current = null
      sessionRef.current = null
      sipPluginRef.current = null
    }
  }, [])

  // Load DND setting from localStorage on mount
  useEffect(() => {
    const savedDND = localStorage.getItem('doNotDisturb')
    if (savedDND === 'true') {
      setCallState(prev => ({ ...prev, doNotDisturb: true }))
    }
  }, [])

  // Auto-connect on mount
  useEffect(() => {
    // Initialize audio quality optimizer
    audioOptimizerRef.current = new AudioQualityOptimizer()
    
    // Apply ringtone settings
    ringtoneManager.setVolume(settings.ringtones.volume)
    
    initJanus()
    return () => {
      // Cleanup retry timeout
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current)
        retryTimeoutRef.current = null
      }
      // Cleanup audio optimizer
      if (audioOptimizerRef.current) {
        audioOptimizerRef.current.destroy()
        audioOptimizerRef.current = null
      }
      disconnect()
    }
  }, [initJanus, disconnect])

  // Reconnect function that resets retry state
  const reconnect = useCallback(async () => {
    // Reset retry state on manual reconnection
    setRetryCount(0)
    setIsRetrying(false)
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current)
      retryTimeoutRef.current = null
    }
    await initJanus()
  }, [initJanus])

  const value: JanusContextType = {
    callState,
    makeCall,
    acceptCall,
    rejectCall,
    hangupCall,
    holdCall,
    resumeCall,
    disconnect,
    reconnect,
    setDoNotDisturb
  }

  return (
    <JanusContext.Provider value={value}>
      {children}
    </JanusContext.Provider>
  )
}