import { createContext, useContext, useState, useCallback, useRef, useEffect, ReactNode } from 'react'
import { toast } from '@/hooks/use-toast'
import { ToastAction } from '@/components/ui/toast'
import { Phone, PhoneOff } from 'lucide-react'
import { loadJanus, getJanus } from '@/lib/janusLoader'

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
  disconnect: () => void
  reconnect: () => Promise<void>
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
  const [callState, setCallState] = useState<CallState>({
    status: 'disconnected',
    registered: false,
    sipStatus: 'Not connected'
  })
  
  const janusRef = useRef<any>(null)
  const sessionRef = useRef<JanusSession | null>(null)
  const sipPluginRef = useRef<any>(null)
  const localVideoRef = useRef<HTMLVideoElement | null>(null)
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null)

  // Initialize Janus
  const initJanus = useCallback(async () => {
    try {
      setCallState(prev => ({ ...prev, status: 'connecting', sipStatus: 'Initializing...' }))

      // Load Janus library first
      await loadJanus()
      const Janus = getJanus()

      // Initialize Janus library
      Janus.init({
        debug: "all",
        callback: () => {
          console.log("Janus initialized successfully")
          connectToJanus()
        }
      })
    } catch (error) {
      console.error("Failed to initialize Janus:", error)
      setCallState(prev => ({ ...prev, status: 'error', sipStatus: `Failed to initialize: ${error instanceof Error ? error.message : 'Unknown error'}` }))
      toast({
        title: "Connection Error",
        description: "Failed to initialize WebRTC library",
        variant: "destructive"
      })
    }
  }, [])

  const connectToJanus = useCallback(() => {
    // Create Janus session
    const Janus = getJanus()
    janusRef.current = new Janus({
      server: "wss://devrtc.voicehost.io:443",
      apisecret: "overlord",
      success: () => {
        console.log("Connected to Janus Gateway")
        setCallState(prev => ({ ...prev, status: 'connected', sipStatus: 'Connected to server' }))
        attachSipPlugin()
      },
      error: (error: any) => {
        console.error("Failed to connect to Janus:", error)
        setCallState(prev => ({ ...prev, status: 'error', sipStatus: 'Connection failed' }))
        toast({
          title: "Connection Error",
          description: "Failed to connect to Janus server",
          variant: "destructive"
        })
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
          
          // Play remote audio
          const audioElement = new Audio()
          audioElement.srcObject = stream
          audioElement.play().catch(console.error)
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
    if (!sipPluginRef.current || callState.status !== 'incoming') {
      toast({
        title: "Cannot Accept Call", 
        description: "No incoming call to accept",
        variant: "destructive"
      })
      return
    }

    if (!callState.remoteJsep) {
      toast({
        title: "Call Failed",
        description: "Missing remote session description", 
        variant: "destructive"
      })
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: true, 
        video: false 
      })

      const accept = { request: "accept" }

      sipPluginRef.current.createAnswer({
        jsep: callState.remoteJsep,
        tracks: [{ type: "audio", capture: true, recv: true }],
        success: (jsep: any) => {
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
    if (!sipPluginRef.current || callState.status !== 'incoming') return

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

  const handleSipMessage = useCallback((msg: any, jsep?: any) => {
    const event = msg.result?.event || msg.sip
    
    if (event === "registered") {
      console.log("SIP registration successful")
      setCallState(prev => ({ 
        ...prev, 
        registered: true, 
        sipStatus: 'Online'
      }))
      toast({
        title: "SIP Registered",
        description: "Ready to make calls",
      })
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
      
      setCallState(prev => ({ 
        ...prev, 
        status: 'incoming', 
        sipStatus: `Incoming call from ${phoneNumber}`,
        incomingCallerId: callerId,
        incomingCallId: msg.call_id || msg.result?.call_id,
        remoteJsep: jsep
      }))
      
      toast({
        title: phoneNumber,
        description: "Incoming call",
        action: (
          <div className="flex gap-2">
            <ToastAction 
              altText="Accept call"
              onClick={() => acceptCall()}
              className="bg-green-600 hover:bg-green-700 text-white"
            >
              <Phone className="h-4 w-4" />
            </ToastAction>
            <ToastAction 
              altText="Reject call"
              onClick={() => rejectCall()}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              <PhoneOff className="h-4 w-4" />
            </ToastAction>
          </div>
        ),
      })
    } else if (event === "calling") {
      setCallState(prev => ({ ...prev, status: 'calling', sipStatus: 'Calling...' }))
    } else if (event === "accepted") {
      setCallState(prev => ({ ...prev, status: 'incall', sipStatus: 'Call connected' }))
      toast({
        title: "Call Connected",
        description: "Call is now active",
      })
    } else if (event === "hangup") {
      setCallState(prev => ({ 
        ...prev, 
        status: 'connected', 
        sipStatus: callState.registered ? 'Online' : 'Offline',
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
      setCallState(prev => ({ 
        ...prev, 
        status: 'connected', 
        sipStatus: callState.registered ? 'Online' : 'Offline',
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
  }, [callState.registered, extractPhoneNumber, acceptCall, rejectCall])

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
      // Get microphone access
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: true, 
        video: false 
      })

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

  const hangupCall = useCallback(() => {
    if (!sipPluginRef.current) return

    const hangup = { request: "hangup" }
    sipPluginRef.current.send({ message: hangup })
  }, [])

  const disconnect = useCallback(() => {
    if (janusRef.current) {
      janusRef.current.destroy()
      janusRef.current = null
      sessionRef.current = null
      sipPluginRef.current = null
    }
  }, [])

  // Auto-connect on mount
  useEffect(() => {
    initJanus()
    return () => {
      disconnect()
    }
  }, [initJanus, disconnect])

  const value: JanusContextType = {
    callState,
    makeCall,
    acceptCall,
    rejectCall,
    hangupCall,
    disconnect,
    reconnect: initJanus
  }

  return (
    <JanusContext.Provider value={value}>
      {children}
    </JanusContext.Provider>
  )
}