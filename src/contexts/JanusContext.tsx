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
  status: 'disconnected' | 'connecting' | 'connected' | 'calling' | 'incall' | 'incoming' | 'ringing' | 'error' | 'busy' | 'failed' | 'timeout'
  registered: boolean
  sipStatus: string
  doNotDisturb: boolean
  isOnHold: boolean
  localStream?: MediaStream
  remoteStream?: MediaStream
  incomingCallerId?: string
  incomingCallId?: string
  remoteJsep?: any
  direction?: 'incoming' | 'outgoing'
  callerId?: string
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
  registerNow: () => void
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
  const { getContactByPhoneNumber } = useContacts()
  const { addCallRecord } = useCallHistory()
  const [callState, setCallState] = useState<CallState>({
    status: 'disconnected',
    registered: false,
    sipStatus: 'Not connected',
    doNotDisturb: false,
    isOnHold: false
  })
  
  // Track call timing for history
  const callStartTimeRef = useRef<Date | null>(null)
  
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

  // Direct action functions that access current call state dynamically
  const directAcceptCall = useCallback(async () => {
    console.log("Direct accept call - accessing current state")
    
    // Get current state dynamically
    setCallState(currentState => {
      console.log("Current call state for accept:", currentState)
      
      if (!sipPluginRef.current) {
        console.log("Cannot accept call - No SIP plugin")
        toast({
          title: "Call Failed",
          description: "SIP plugin not available",
          variant: "destructive"
        })
        return currentState
      }

      if (!currentState.remoteJsep) {
        console.log("Cannot accept call - Missing remote JSEP in current state")
        toast({
          title: "Call Failed",
          description: "Missing remote session description", 
          variant: "destructive"
        })
        return currentState
      }

      // Proceed with call acceptance using current state
      (async () => {

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
            jsep: currentState.remoteJsep,
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
      })()
      
      return currentState
    })
  }, [])

  const directRejectCall = useCallback(() => {
    console.log("Direct reject call - accessing current state")
    
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
    
    // Stop ringtones
    ringtoneManager.stopRinging()
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
      
      // Dismiss any existing incoming call toast before creating new one
      if (incomingCallToastRef.current) {
        console.log("Dismissing existing incoming call toast")
        incomingCallToastRef.current.dismiss()
        incomingCallToastRef.current = null
      }
      
      callStartTimeRef.current = new Date()
      setCallState(prev => ({ 
        ...prev, 
        status: 'incoming', 
        sipStatus: `Incoming call from ${phoneNumber}`,
        incomingCallerId: callerId,
        incomingCallId: msg.call_id || msg.result?.call_id,
        remoteJsep: jsep,
        direction: 'incoming',
        callerId: phoneNumber
      }))
      
      // Play incoming ringtone if enabled
      if (settings.ringtones.enabled) {
        ringtoneManager.playIncomingRing()
      }
      
      console.log("Creating new incoming call toast for:", phoneNumber)
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
      console.log("Toast created with ref:", incomingCallToastRef.current)
    } else if (event === "calling") {
      if (!callStartTimeRef.current) {
        callStartTimeRef.current = new Date()
      }
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
      // Handle SIP response codes for call failures
      const sipCode = msg.result?.code || msg.code
      const sipReason = msg.result?.reason || msg.reason || "Call ended"
      
      // Stop any ringing sounds first
      ringtoneManager.stopRinging()
      
      // Dismiss incoming call toast if still showing
      if (incomingCallToastRef.current) {
        incomingCallToastRef.current.dismiss()
        incomingCallToastRef.current = null
      }
      
      // Log call to history when call ends
      if (callState.callerId && callStartTimeRef.current) {
        const endTime = new Date()
        const duration = Math.floor((endTime.getTime() - callStartTimeRef.current.getTime()) / 1000)
        const contact = getContactByPhoneNumber(callState.callerId)
        
        addCallRecord({
          phoneNumber: callState.callerId,
          contactName: contact?.name,
          duration: duration,
          timestamp: callStartTimeRef.current,
          type: callState.direction === 'outgoing' ? 'outgoing' : 'incoming',
          answered: callState.status === 'incall'
        })
      }
      
      callStartTimeRef.current = null
      
      // Handle specific SIP error codes
      if (sipCode) {
        logger.info(`SIP hangup with code: ${sipCode} - ${sipReason}`, undefined, 'JanusContext')
        
        if (sipCode === 486) {
          // Busy Here - line is engaged
          setCallState(prev => ({ 
            ...prev, 
            status: 'busy', 
            sipStatus: 'Line busy',
            localStream: undefined,
            remoteStream: undefined,
            incomingCallerId: undefined,
            incomingCallId: undefined,
            remoteJsep: undefined
          }))
          
          // Play busy tone
          if (settings.ringtones.enabled) {
            ringtoneManager.playBusyTone()
          }
          
          toast({
            title: "Line Busy",
            description: "The line you called is busy",
            variant: "destructive"
          })
          
          // Auto-return to connected state after 4 seconds
          setTimeout(() => {
            setCallState(prev => ({ 
              ...prev, 
              status: 'connected', 
              sipStatus: prev.registered ? 'Online' : 'Offline'
            }))
          }, 4000)
          
        } else if (sipCode === 404) {
          // Not Found
          setCallState(prev => ({ 
            ...prev, 
            status: 'failed', 
            sipStatus: 'Number not found',
            localStream: undefined,
            remoteStream: undefined,
            incomingCallerId: undefined,
            incomingCallId: undefined,
            remoteJsep: undefined
          }))
          
          toast({
            title: "Number Not Found",
            description: "The number you dialed does not exist",
            variant: "destructive"
          })
          
          // Auto-return to connected state after 3 seconds
          setTimeout(() => {
            setCallState(prev => ({ 
              ...prev, 
              status: 'connected', 
              sipStatus: prev.registered ? 'Online' : 'Offline'
            }))
          }, 3000)
          
        } else if (sipCode === 408) {
          // Request Timeout
          setCallState(prev => ({ 
            ...prev, 
            status: 'timeout', 
            sipStatus: 'Call timeout',
            localStream: undefined,
            remoteStream: undefined,
            incomingCallerId: undefined,
            incomingCallId: undefined,
            remoteJsep: undefined
          }))
          
          toast({
            title: "Call Timeout",
            description: "The call could not be completed - no response",
            variant: "destructive"
          })
          
          // Auto-return to connected state after 3 seconds
          setTimeout(() => {
            setCallState(prev => ({ 
              ...prev, 
              status: 'connected', 
              sipStatus: prev.registered ? 'Online' : 'Offline'
            }))
          }, 3000)
          
        } else if (sipCode === 480) {
          // Temporarily Unavailable
          setCallState(prev => ({ 
            ...prev, 
            status: 'failed', 
            sipStatus: 'Temporarily unavailable',
            localStream: undefined,
            remoteStream: undefined,
            incomingCallerId: undefined,
            incomingCallId: undefined,
            remoteJsep: undefined
          }))
          
          toast({
            title: "Temporarily Unavailable",
            description: "The person you're calling is temporarily unavailable",
            variant: "destructive"
          })
          
          // Auto-return to connected state after 3 seconds
          setTimeout(() => {
            setCallState(prev => ({ 
              ...prev, 
              status: 'connected', 
              sipStatus: prev.registered ? 'Online' : 'Offline'
            }))
          }, 3000)
          
        } else if (sipCode === 487) {
          // Request Terminated - call was cancelled
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
            title: "Call Cancelled",
            description: "The call was cancelled",
          })
          
        } else if (sipCode >= 400 && sipCode < 600) {
          // Other 4xx/5xx errors
          setCallState(prev => ({ 
            ...prev, 
            status: 'failed', 
            sipStatus: `Call failed (${sipCode})`,
            localStream: undefined,
            remoteStream: undefined,
            incomingCallerId: undefined,
            incomingCallId: undefined,
            remoteJsep: undefined
          }))
          
          toast({
            title: "Call Failed",
            description: `${sipReason} (SIP ${sipCode})`,
            variant: "destructive"
          })
          
          // Auto-return to connected state after 3 seconds
          setTimeout(() => {
            setCallState(prev => ({ 
              ...prev, 
              status: 'connected', 
              sipStatus: prev.registered ? 'Online' : 'Offline'
            }))
          }, 3000)
          
        } else {
          // Normal hangup without error code
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
        }
      } else {
        // Normal hangup without SIP code
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
      }
    } else if (event === "missed") {
      // Stop any ringing sounds
      ringtoneManager.stopRinging()
      
      // Dismiss incoming call toast if still showing
      if (incomingCallToastRef.current) {
        incomingCallToastRef.current.dismiss()
        incomingCallToastRef.current = null
      }
      
      // Log missed call for incoming calls
      if (callState.direction === 'incoming' && callState.callerId && callStartTimeRef.current) {
        const contact = getContactByPhoneNumber(callState.callerId)
        
        addCallRecord({
          phoneNumber: callState.callerId,
          contactName: contact?.name,
          duration: 0,
          timestamp: callStartTimeRef.current,
          type: 'missed',
          answered: false
        })
      }
      
      callStartTimeRef.current = null
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
  }, [callState.registered, callState.doNotDisturb, extractPhoneNumber, handleToastAcceptCall, handleToastRejectCall, settings])

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
  }, [retryCount])

  // Create a stable message handler ref that always uses current functions
  const messageHandlerRef = useRef<((msg: any, jsep?: any) => void) | null>(null)
  
  // Update the message handler ref whenever handleSipMessage changes
  useEffect(() => {
    messageHandlerRef.current = (msg: any, jsep?: any) => {
      console.log("SIP message received:", msg)
      handleSipMessage(msg, jsep)
    }
  }, [handleSipMessage])

  const attachSipPlugin = useCallback(() => {
    if (!janusRef.current) return;
    
    janusRef.current.attach({
      plugin: "janus.plugin.sip",
      success: (pluginHandle: any) => {
        console.log("SIP plugin attached successfully")
        sipPluginRef.current = pluginHandle
        setCallState(prev => ({ ...prev, sipStatus: 'SIP plugin ready' }))
        // Only auto-register if credentials are available
        if (settings.sip.username && settings.sip.password) {
          registerSipAccount()
        } else {
          setCallState(prev => ({ ...prev, sipStatus: 'SIP not configured' }))
        }
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
        // Use the stable ref to always call the current handler
        if (messageHandlerRef.current) {
          messageHandlerRef.current(msg, jsep)
        }
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
        console.log("SIP plugin cleanup - call ended")
        setCallState(prev => ({ 
          ...prev, 
          // Keep registration status unchanged during call cleanup
          sipStatus: prev.registered ? 'Online' : prev.sipStatus,
          localStream: undefined,
          remoteStream: undefined
        }))
      }
    })
  }, [handleSipMessage])

  const registerSipAccount = useCallback(() => {
    if (!sipPluginRef.current) return

    // Check if SIP credentials are configured
    if (!settings.sip.username || !settings.sip.password) {
      setCallState(prev => ({ 
        ...prev, 
        registered: false,
        sipStatus: 'SIP not configured' 
      }))
      return
    }

    const register = {
      request: "register",
      username: `sip:${settings.sip.username}@hpbx.sipconvergence.co.uk`,
      secret: settings.sip.password,
      host: "hpbx.sipconvergence.co.uk:5060",
      send_register: true
    }

    setCallState(prev => ({ ...prev, sipStatus: 'Registering SIP account...' }))
    sipPluginRef.current.send({ message: register })
  }, [settings.sip.username, settings.sip.password])

  const registerNow = useCallback(() => {
    if (!settings.sip.username || !settings.sip.password) {
      toast({
        title: "Cannot Register",
        description: "Please configure your SIP credentials first",
        variant: "destructive"
      })
      return
    }
    
    if (!sipPluginRef.current) {
      toast({
        title: "Cannot Register",
        description: "SIP plugin not available",
        variant: "destructive"
      })
      return
    }

    registerSipAccount()
  }, [settings.sip.username, settings.sip.password, registerSipAccount])

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
    
    // Log rejected call for incoming calls
    if (callState.direction === 'incoming' && callState.callerId && callStartTimeRef.current) {
      const contact = getContactByPhoneNumber(callState.callerId)
      
      addCallRecord({
        phoneNumber: callState.callerId,
        contactName: contact?.name,
        duration: 0,
        timestamp: callStartTimeRef.current,
        type: 'missed',
        answered: false
      })
    }
    
    callStartTimeRef.current = null
    setCallState(prev => ({ 
      ...prev, 
      status: 'connected', 
      sipStatus: callState.registered ? 'Online' : 'Offline',
      incomingCallerId: undefined,
      incomingCallId: undefined,
      remoteJsep: undefined
    }))
  }, [callState.status, callState.registered])

  // Utility function to preprocess phone numbers for SIP extensions
  const preprocessPhoneNumber = useCallback((phoneNumber: string): string => {
    // Remove any non-digit characters for processing
    const cleanNumber = phoneNumber.replace(/[^0-9]/g, '')
    
    // Check if it's a numeric extension between 200 and 99899
    const numericValue = parseInt(cleanNumber, 10)
    if (!isNaN(numericValue) && numericValue >= 200 && numericValue <= 99899) {
      logger.info(`Preprocessing extension ${phoneNumber} -> 16331*${phoneNumber}`, undefined, 'JanusContext')
      return `16331*${phoneNumber}`
    }
    
    // Return original number for external numbers
    logger.info(`Using original number: ${phoneNumber}`, undefined, 'JanusContext')
    return phoneNumber
  }, [])

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
      // Preprocess phone number for extensions
      const processedNumber = preprocessPhoneNumber(phoneNumber)
      logger.info(`Making call: ${phoneNumber} -> ${processedNumber}`, undefined, 'JanusContext')

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
        uri: `sip:${processedNumber}@hpbx.sipconvergence.co.uk`
      }
      
      logger.info(`SIP URI: ${call.uri}`, undefined, 'JanusContext')

      sipPluginRef.current.createOffer({
        tracks: [{ type: "audio", capture: true, recv: true }],
        success: (jsep: any) => {
          callStartTimeRef.current = new Date()
          setCallState(prev => ({ 
            ...prev, 
            direction: 'outgoing',
            callerId: processedNumber 
          }))
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
  }, [callState.registered, preprocessPhoneNumber, settings])

  const setDoNotDisturb = useCallback((enabled: boolean) => {
    setCallState(prev => ({ ...prev, doNotDisturb: enabled }))
    // Persist DND setting in localStorage
    localStorage.setItem('doNotDisturb', enabled.toString())
  }, [])

  const hangupCall = useCallback(() => {
    if (!sipPluginRef.current) return

    // Log call to history before hanging up
    if (callState.callerId && callStartTimeRef.current) {
      const endTime = new Date()
      const duration = Math.floor((endTime.getTime() - callStartTimeRef.current.getTime()) / 1000)
      const contact = getContactByPhoneNumber(callState.callerId)
      
      addCallRecord({
        phoneNumber: callState.callerId,
        contactName: contact?.name,
        duration: duration,
        timestamp: callStartTimeRef.current,
        type: callState.direction === 'outgoing' ? 'outgoing' : 'incoming',
        answered: callState.status === 'incall'
      })
    }

    const hangup = { request: "hangup" }
    sipPluginRef.current.send({ message: hangup })
    
    callStartTimeRef.current = null
    setCallState(prev => ({ 
      ...prev, 
      status: 'connected',
      isOnHold: false
    }))
  }, [callState, getContactByPhoneNumber, addCallRecord])

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
    setDoNotDisturb,
    registerNow
  }

  return (
    <JanusContext.Provider value={value}>
      {children}
    </JanusContext.Provider>
  )
}
