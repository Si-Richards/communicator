import { createContext, useContext, useState, useCallback, useRef, useEffect, ReactNode } from 'react'
import { toast, useToast } from '@/hooks/use-toast'
import { ToastAction } from '@/components/ui/toast'
import { Phone, PhoneOff } from 'lucide-react'
import { loadJanus, getJanus } from '@/lib/janusLoader'
import { AudioQualityOptimizer, getOptimalAudioConstraints, getJitterBufferTargetMs } from '@/lib/audioQualityOptimizer'
import { ringtoneManager } from '@/lib/ringtoneManager'
import { notificationManager } from '@/lib/notificationManager'
import { useSettings } from './SettingsContext'
import { useContacts } from './ContactsContext'
import { useCallHistory } from './CallHistoryContext'
import { audioDeviceManager } from '@/lib/audioDeviceManager'
import { videoDeviceManager } from '@/lib/videoDeviceManager'
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
  localVideoStream?: MediaStream
  remoteVideoStream?: MediaStream
  videoEnabled: boolean
  isVideoMuted: boolean
  isScreenSharing: boolean
  incomingCallerId?: string
  incomingCallId?: string
  remoteJsep?: any
  direction?: 'incoming' | 'outgoing'
  callerId?: string
  waitingCall?: {
    id: string
    phoneNumber: string
    callerId?: string
    remoteJsep?: any
  }
  // Transfer state
  consultCall?: {
    id: string
    phoneNumber: string
    status: 'calling' | 'connected'
    handleId: string
  }
  dialogInfo?: {
    callId?: string
    fromTag?: string
    toTag?: string
    remoteUri?: string
  }
  // Audio quality metrics
  audioQuality?: 'excellent' | 'good' | 'fair' | 'poor'
}

interface JanusContextType {
  callState: CallState
  makeCall: (phoneNumber: string, withVideo?: boolean) => Promise<void>
  acceptCall: () => Promise<void>
  rejectCall: () => void
  hangupCall: () => void
  holdCall: () => void
  resumeCall: () => void
  acceptWaitingCall: () => Promise<void>
  declineWaitingCall: () => void
  endCurrentAndAcceptWaiting: () => Promise<void>
  toggleVideo: () => Promise<void>
  startVideo: () => Promise<void>
  stopVideo: () => void
  switchCamera: () => Promise<void>
  startScreenShare: () => Promise<void>
  stopScreenShare: () => void
  sendDtmf: (digit: string) => void
  disconnect: () => void
  reconnect: () => Promise<void>
  setDoNotDisturb: (enabled: boolean) => void
  registerSipAccount: () => void
  unregisterSipAccount: () => void
  registerNow: () => void
  // Transfer methods
  transferBlind: (destination: string) => Promise<void>
  startAttendedTransfer: (destination: string) => Promise<void>
  completeAttendedTransfer: () => Promise<void>
  cancelAttendedTransfer: () => void
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
    isOnHold: false,
    videoEnabled: false,
    isVideoMuted: false,
    isScreenSharing: false
  })
  
  // Track call timing for history
  const callStartTimeRef = useRef<Date | null>(null)
  
  const { dismiss } = useToast()
  const janusRef = useRef<any>(null)
  const sessionRef = useRef<JanusSession | null>(null)
  const sipPluginRef = useRef<any>(null)
  const consultSipPluginRef = useRef<any>(null)
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
    
    // Extract number from SIP URI format like "sip:16331*201@realm.com"
    const match = sipUri.match(/^sip:([^@]+)@/)
    if (match && match[1]) {
      // Remove asterisk and other special characters, keep only digits
      return match[1].replace(/[^0-9]/g, '')
    }
    
    return sipUri
  }, [])

  // Format phone number for display - show only extension for internal calls
  const formatPhoneNumberForDisplay = useCallback((phoneNumber: string): string => {
    // Check if it's an internal extension with the prefix
    const internalMatch = phoneNumber.match(/^16331\*?(\d{3,5})$/)
    if (internalMatch && internalMatch[1]) {
      // Return just the extension number
      return internalMatch[1]
    }
    
    // Return the original number for external calls
    return phoneNumber
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
    
    // Log rejected call BEFORE clearing state
    setCallState(prev => {
      // Log the call record using current state
      if (prev.direction === 'incoming' && prev.callerId && callStartTimeRef.current) {
        const contact = getContactByPhoneNumber(prev.callerId)
        
        addCallRecord({
          phoneNumber: formatPhoneNumberForDisplay(prev.callerId),
          contactName: contact?.name,
          duration: 0,
          timestamp: callStartTimeRef.current,
          type: 'missed',
          answered: false
        })
      }
      
      callStartTimeRef.current = null
      
      return { 
        ...prev, 
        status: 'connected', 
        sipStatus: prev.registered ? 'Online' : 'Offline',
        incomingCallerId: undefined,
        incomingCallId: undefined,
        remoteJsep: undefined
      }
    })
    
    // Stop ringtones
    ringtoneManager.stopRinging()
  }, [getContactByPhoneNumber, addCallRecord, formatPhoneNumberForDisplay])

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
      logger.info("SIP registration successful")
      isRegisteringRef.current = false // Clear registration flag on success
      registrationCooldownRef.current = 0 // Clear cooldown
      setCallState(prev => ({ 
        ...prev, 
        registered: true, 
        sipStatus: 'Online'
      }))
      // Registration successful - no toast needed as status is visible in sidebar
    } else if (event === "registering") {
      setCallState(prev => ({ ...prev, sipStatus: 'Registering...' }))
    } else if (event === "registration_failed") {
      const reason = msg.result?.reason || msg.reason || "Unknown error"
      const code = msg.result?.code || msg.code
      logger.error("SIP registration failed:", { reason, code, msg })
      
      // CRITICAL FIX: Clear the registration flag and cooldown on failure
      isRegisteringRef.current = false
      registrationCooldownRef.current = 0
      
      setCallState(prev => ({ 
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
    } else if (event === "incomingcall") {
      console.log("Incoming call received:", msg, "JSEP:", jsep)
      const callerId = msg.username || msg.result?.username || "Unknown"
      const phoneNumber = extractPhoneNumber(callerId)
      
      // Check if Do Not Disturb is enabled
      if (callState.doNotDisturb) {
        console.log("Rejecting call due to Do Not Disturb mode")
        const decline = { request: "decline" }
        sipPluginRef.current.send({ message: decline })
        
        // Log the missed call due to DND
        const contact = getContactByPhoneNumber(phoneNumber)
        addCallRecord({
          phoneNumber: formatPhoneNumberForDisplay(phoneNumber),
          contactName: contact?.name,
          duration: 0,
          timestamp: new Date(),
          type: 'missed',
          answered: false
        })
        
        toast({
          title: "Call Blocked",
          description: `Incoming call from ${phoneNumber} blocked (Do Not Disturb)`,
          variant: "default"
        })
        return
      }
      
      // Check if we're already in a call - handle call waiting
      // Use functional setState to access current state
      let storedAsWaiting = false
      setCallState(prev => {
        if (prev.status === 'incall' || prev.status === 'calling' || prev.status === 'incoming') {
          console.info("Call waiting: already in a call, storing waiting call from", phoneNumber)
          storedAsWaiting = true
          
          // Show call waiting toast with actions
          toast({
            title: "Call Waiting",
            description: `Incoming call from ${phoneNumber}`,
            action: (
              <div className="flex gap-2">
                <ToastAction 
                  altText="Decline waiting call"
                  onClick={() => {
                    console.info("Declining waiting call")
                    
                    // Get current waiting call data and log it
                    setCallState(current => {
                      if (current.waitingCall) {
                        // Log the declined call
                        const contact = getContactByPhoneNumber(current.waitingCall.phoneNumber)
                        addCallRecord({
                          phoneNumber: formatPhoneNumberForDisplay(current.waitingCall.phoneNumber),
                          contactName: contact?.name,
                          duration: 0,
                          timestamp: new Date(),
                          type: 'missed',
                          answered: false
                        })
                      }
                      
                      const decline = { request: "decline" }
                      sipPluginRef.current?.send({ message: decline })
                      
                      return { ...current, waitingCall: undefined }
                    })
                  }}
                  className="bg-red-600 hover:bg-red-700 text-white"
                >
                  <PhoneOff className="h-4 w-4" />
                </ToastAction>
                <ToastAction 
                  altText="End current and accept waiting"
                  onClick={async () => {
                    console.info("Ending current call and accepting waiting call")
                    // First hangup current call
                    const hangup = { request: "hangup" }
                    sipPluginRef.current?.send({ message: hangup })
                    
                    // Wait a moment then accept the waiting call
                    setTimeout(async () => {
                      const waitingCallData = callState.waitingCall
                      if (waitingCallData && waitingCallData.remoteJsep) {
                        try {
                          const stream = await navigator.mediaDevices.getUserMedia({ 
                            audio: true, 
                            video: false 
                          })

                          const accept = { request: "accept" }

                          sipPluginRef.current.createAnswer({
                            jsep: waitingCallData.remoteJsep,
                            tracks: [{ type: "audio", capture: true, recv: true }],
                            success: (jsep: any) => {
                              sipPluginRef.current.send({ message: accept, jsep })
                              setCallState(prev => ({ 
                                ...prev, 
                                status: 'incall', 
                                sipStatus: 'Call connected',
                                waitingCall: undefined,
                                callerId: waitingCallData.phoneNumber,
                                direction: 'incoming'
                              }))
                            },
                            error: (error: any) => {
                              console.error("Failed to accept waiting call:", error)
                              toast({
                                title: "Failed to Accept Call",
                                description: error.message || "Could not accept waiting call",
                                variant: "destructive"
                              })
                            }
                          })
                        } catch (error) {
                          console.error("Failed to get microphone access for waiting call:", error)
                          toast({
                            title: "Microphone Error",
                            description: "Cannot access microphone",
                            variant: "destructive"
                          })
                        }
                      }
                    }, 500)
                  }}
                  className="bg-green-600 hover:bg-green-700 text-white"
                >
                  <Phone className="h-4 w-4" />
                </ToastAction>
              </div>
            ),
          })
          
          return {
            ...prev,
            waitingCall: {
              id: msg.call_id || msg.result?.call_id || 'waiting-' + Date.now(),
              phoneNumber,
              callerId,
              remoteJsep: jsep
            }
          }
        }
        return prev
      })
      
      if (storedAsWaiting) {
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
      
      // Show desktop notification if enabled and app is hidden
      if (settings.notifications.enabled) {
        const contact = getContactByPhoneNumber(phoneNumber)
        const displayName = contact?.name || phoneNumber
        
        notificationManager.showWhenHidden({
          title: 'Incoming Call',
          body: settings.notifications.showPreviewText ? `Call from ${displayName}` : 'Incoming call',
          tag: 'incoming-call',
          requireInteraction: true,
        })
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
      
      // Capture dialog information for transfers
      const dialogInfo = {
        callId: msg.call_id || msg.result?.call_id,
        fromTag: msg.from_tag || msg.result?.from_tag,
        toTag: msg.to_tag || msg.result?.to_tag,
        remoteUri: msg.remote_uri || msg.result?.remote_uri
      }
      
      setCallState(prev => ({ 
        ...prev, 
        status: 'incall', 
        sipStatus: 'Call connected',
        dialogInfo 
      }))
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
        
        // Prepare quality metrics if available
        let qualityMetrics = undefined
        if (callState.audioQuality && audioOptimizerRef.current) {
          const metrics = audioOptimizerRef.current['qualityMetrics']
          if (metrics) {
            qualityMetrics = {
              packetsLost: metrics.packetsLost,
              packetsReceived: metrics.packetsReceived,
              jitter: metrics.jitter,
              roundTripTime: metrics.roundTripTime,
              audioLevel: metrics.audioLevel,
              quality: callState.audioQuality
            }
          }
        }
        
        addCallRecord({
          phoneNumber: callState.callerId,
          contactName: contact?.name,
          duration: duration,
          timestamp: callStartTimeRef.current,
          type: callState.direction === 'outgoing' ? 'outgoing' : 'incoming',
          answered: callState.status === 'incall',
          qualityMetrics
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
            remoteJsep: undefined,
            waitingCall: undefined
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
            remoteJsep: undefined,
            waitingCall: undefined
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
            remoteJsep: undefined,
            waitingCall: undefined
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
            remoteJsep: undefined,
            waitingCall: undefined
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
          remoteJsep: undefined,
          waitingCall: undefined
        }))
          
          toast({
            title: "Call Ended",
            description: "Call has been terminated",
          })
          
          // Show desktop notification for call end if enabled
          if (settings.notifications.enabled) {
            notificationManager.showWhenHidden({
              title: 'Call Ended',
              body: 'Your call has ended',
              tag: 'call-ended',
            })
          }
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
        remoteJsep: undefined,
        waitingCall: undefined
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
          phoneNumber: formatPhoneNumberForDisplay(callState.callerId),
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
  }, [callState.registered, callState.doNotDisturb, extractPhoneNumber, handleToastAcceptCall, handleToastRejectCall, settings, getContactByPhoneNumber, addCallRecord, formatPhoneNumberForDisplay])

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
  }, [settings.sip.server, settings.sip.realm])

  const connectToJanus = useCallback(() => {
    // Create Janus session with optimized settings for audio quality
    const Janus = getJanus()
    janusRef.current = new Janus({
      server: settings.sip.server || "wss://devrtc.voicehost.io:443",
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
        // Only auto-register if credentials are available and not already registering/registered
        if (settings.sip.username && settings.sip.password && !isRegisteringRef.current && !callState.registered) {
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
        console.log("Local track:", track.kind, on)
        if (track.kind === 'audio' && on) {
          const stream = new MediaStream([track])
          setCallState(prev => ({ ...prev, localStream: stream }))
        } else if (track.kind === 'video' && on) {
          const stream = new MediaStream([track])
          setCallState(prev => ({ 
            ...prev, 
            localVideoStream: stream,
            videoEnabled: true
          }))
        } else if (track.kind === 'video' && !on) {
          setCallState(prev => ({ 
            ...prev, 
            localVideoStream: undefined,
            videoEnabled: false
          }))
        }
      },
      onremotetrack: (track: MediaStreamTrack, mindex: number, on: boolean) => {
        console.log("Remote track:", track.kind, mindex, on)
        if (track.kind === 'audio' && on) {
          const stream = new MediaStream([track])
          
          // Apply jitter buffer settings to the receiver
          try {
            const pc = sipPluginRef.current?.webrtcStuff?.pc
            if (pc) {
              const receivers = pc.getReceivers()
              const audioReceiver = receivers.find((r: RTCRtpReceiver) => r.track?.kind === 'audio')
              
              if (audioReceiver && 'jitterBufferTarget' in audioReceiver) {
                const targetMs = getJitterBufferTargetMs(settings.audioQuality.jitterBufferSize)
                ;(audioReceiver as any).jitterBufferTarget = targetMs
                console.log(`Jitter buffer target set to ${targetMs}ms`)
              }
            }
          } catch (error) {
            console.warn("Could not configure jitter buffer:", error)
          }
          
          // Process remote audio with enhanced optimization
          const optimizedResult = audioOptimizerRef.current?.optimizeRemoteAudio(stream)
          
          if (optimizedResult) {
            setCallState(prev => ({ ...prev, remoteStream: stream }))
            console.log("Remote audio optimized with Web Audio API processing")
          } else {
            // Fallback to standard audio element if optimization fails
            setCallState(prev => ({ ...prev, remoteStream: stream }))
            
            const audioElement = document.createElement('audio')
            audioElement.srcObject = stream
            audioElement.autoplay = true
            audioElement.controls = false
            audioElement.muted = false
            audioElement.setAttribute('playsinline', 'true')
            audioElement.setAttribute('webkit-playsinline', 'true')
            
            audioElement.play().catch(error => {
              console.error("Failed to play remote audio:", error)
            })
          }
        } else if (track.kind === 'video' && on) {
          const stream = new MediaStream([track])
          setCallState(prev => ({ ...prev, remoteVideoStream: stream }))
        } else if (track.kind === 'video' && !on) {
          setCallState(prev => ({ ...prev, remoteVideoStream: undefined }))
        }
      },
      oncleanup: () => {
        console.log("SIP plugin cleanup - call ended")
        setCallState(prev => ({ 
          ...prev, 
          // Keep registration status unchanged during call cleanup
          sipStatus: prev.registered ? 'Online' : prev.sipStatus,
          localStream: undefined,
          remoteStream: undefined,
          localVideoStream: undefined,
          remoteVideoStream: undefined,
          videoEnabled: false,
          isVideoMuted: false,
          isScreenSharing: false
        }))
      }
    })
  }, [handleSipMessage])

  const registerSipAccount = useCallback(() => {
    // Validate SIP settings first
    if (!settings.sip.username?.trim()) {
      toast({
        title: "SIP Configuration Error",
        description: "Username is required for SIP registration",
        variant: "destructive"
      })
      return
    }

    if (!settings.sip.password?.trim()) {
      toast({
        title: "SIP Configuration Error", 
        description: "Password is required for SIP registration",
        variant: "destructive"
      })
      return
    }

    if (!settings.sip.server?.trim()) {
      toast({
        title: "SIP Configuration Error",
        description: "Janus server URL is required for SIP registration", 
        variant: "destructive"
      })
      return
    }

    if (!settings.sip.realm?.trim()) {
      toast({
        title: "SIP Configuration Error",
        description: "SIP realm is required for SIP registration",
        variant: "destructive"
      })
      return
    }

    if (!sipPluginRef.current) {
      toast({
        title: "Connection Error",
        description: "Not connected to Janus server",
        variant: "destructive"
      })
      return
    }

    // Prevent concurrent registrations
    if (isRegisteringRef.current) {
      logger.warn("Registration already in progress, skipping")
      return
    }

    // Check cooldown
    const now = Date.now()
    if (now < registrationCooldownRef.current) {
      const remaining = Math.ceil((registrationCooldownRef.current - now) / 1000)
      logger.warn(`Registration in cooldown for ${remaining} more seconds`)
      return
    }

    isRegisteringRef.current = true
    registrationCooldownRef.current = now + 10000 // 10 second cooldown

    // Normalize username (extract just the user part if it's a full SIP URI)
    const normalizeUsername = (username: string) => {
      if (username.startsWith('sip:')) {
        const match = username.match(/sip:([^@]+)@/)
        return match ? match[1] : username.replace('sip:', '').split('@')?.[0] || 'Unknown'
      }
      return username
    }

    const normalizedUsername = normalizeUsername(settings.sip.username)
    
    const register = {
      request: "register",
      username: `sip:${normalizedUsername}@${settings.sip.realm}`,
      secret: settings.sip.password,
      realm: settings.sip.realm,
      send_register: true
    }

    logger.info("Registering SIP account with:", { 
      username: register.username, 
      realm: register.realm,
      normalizedUsername
    })

    setCallState(prev => ({ ...prev, sipStatus: 'Registering SIP account...' }))
    sipPluginRef.current.send({ message: register })
    
    // Safety timeout: auto-clear registration flag after 30 seconds if no response
    setTimeout(() => {
      if (isRegisteringRef.current) {
        logger.warn("Registration timeout - clearing stuck registration flag")
        isRegisteringRef.current = false
      }
    }, 30000)
  }, [settings.sip.username, settings.sip.password, settings.sip.server, settings.sip.realm, toast])

  const unregisterSipAccount = useCallback(() => {
    if (!sipPluginRef.current) return

    const unregister = {
      request: "unregister"
    }

    console.log("Unregistering SIP account")
    setCallState(prev => ({ ...prev, sipStatus: 'Unregistering...' }))
    sipPluginRef.current.send({ message: unregister })
    
    // Reset registration state
    isRegisteringRef.current = false
    setCallState(prev => ({ 
      ...prev, 
      registered: false,
      sipStatus: 'Offline' 
    }))
  }, [])

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

    logger.info("Force registering SIP account (bypassing cooldown and clearing stuck state)")
    isRegisteringRef.current = false
    registrationCooldownRef.current = 0
    setCallState(prev => ({ ...prev, status: 'connecting', sipStatus: 'Initiating registration...' }))
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
      
      const accept = { request: "accept" }

      // Check if we should answer with video
      const answerWithVideo = settings.video.startWithVideo

      // Get video constraints if answering with video
      const mediaConstraints: MediaStreamConstraints = {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000,
          sampleSize: 16,
          channelCount: 1
        },
        video: answerWithVideo ? {
          deviceId: settings.video.cameraDeviceId ? { exact: settings.video.cameraDeviceId } : undefined,
          width: { ideal: parseInt(settings.video.resolution?.split('x')?.[0] || '640') },
          height: { ideal: parseInt(settings.video.resolution?.split('x')?.[1] || '480') },
          frameRate: { ideal: settings.video.frameRate }
        } : false
      }

      const mediaStream = await navigator.mediaDevices.getUserMedia(mediaConstraints)

      const tracks = [
        { type: "audio", capture: true, recv: true },
        { type: "video", capture: answerWithVideo, recv: true }
      ]

      sipPluginRef.current.createAnswer({
        jsep: callState.remoteJsep,
        tracks,
        success: (jsep: any) => {
          console.log("Accept call - create answer success")
          sipPluginRef.current.send({ message: accept, jsep })
          setCallState(prev => ({ 
            ...prev, 
            status: 'incall', 
            sipStatus: 'Call connected',
            videoEnabled: answerWithVideo,
            localVideoStream: answerWithVideo ? mediaStream : undefined
          }))
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

  const makeCall = useCallback(async (phoneNumber: string, withVideo?: boolean) => {
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
      logger.info(`Making call: ${phoneNumber} -> ${processedNumber} with video: ${withVideo}`, undefined, 'JanusContext')

      // Get optimal audio constraints based on settings and selected device
      const deviceConstraints = await audioDeviceManager.getOptimalAudioConstraints(
        settings.audioDevices.inputDeviceId || undefined
      )
      
      // Check if we should start with video
      const startWithVideo = withVideo || settings.video.startWithVideo
      
      // Override with user settings
      const mediaConstraints: MediaStreamConstraints = {
        audio: {
          deviceId: settings.audioDevices.inputDeviceId ? { exact: settings.audioDevices.inputDeviceId } : undefined,
          sampleRate: settings.audioQuality.sampleRate,
          noiseSuppression: settings.audioQuality.noiseSuppression,
          echoCancellation: settings.audioQuality.echoCancellation,
          autoGainControl: settings.audioQuality.autoGainControl,
          channelCount: 1,
        },
        video: startWithVideo ? {
          deviceId: settings.video.cameraDeviceId ? { exact: settings.video.cameraDeviceId } : undefined,
          width: { ideal: parseInt(settings.video.resolution?.split('x')?.[0] || '640') },
          height: { ideal: parseInt(settings.video.resolution?.split('x')?.[1] || '480') },
          frameRate: { ideal: settings.video.frameRate }
        } : false,
      }
      
      const stream = await navigator.mediaDevices.getUserMedia(mediaConstraints)

      // Apply audio optimization if available
      const optimizedStream = audioOptimizerRef.current 
        ? audioOptimizerRef.current.optimizeAudioStream(stream)
        : stream

      const call = {
        request: "call",
        uri: `sip:${processedNumber}@${settings.sip.realm}`
      }
      
      logger.info(`SIP URI: ${call.uri}`, undefined, 'JanusContext')

      // Prepare tracks for offer
      const tracks = [
        { type: "audio", capture: true, recv: true },
        { type: "video", capture: startWithVideo, recv: true }
      ]

      sipPluginRef.current.createOffer({
        tracks,
        success: (jsep: any) => {
          callStartTimeRef.current = new Date()
          setCallState(prev => ({ 
            ...prev, 
            direction: 'outgoing',
            callerId: processedNumber,
            videoEnabled: startWithVideo,
            localVideoStream: startWithVideo ? stream : undefined
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
      console.error("Failed to get media access:", error)
      toast({
        title: "Media Error",
        description: "Cannot access microphone or camera",
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
        phoneNumber: formatPhoneNumberForDisplay(callState.callerId),
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
  }, [callState, getContactByPhoneNumber, addCallRecord, formatPhoneNumberForDisplay])

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

  // Monitor audio quality during calls
  useEffect(() => {
    if (callState.status !== 'incall' || !sipPluginRef.current?.webrtcStuff?.pc) {
      return
    }

    const monitorQuality = async () => {
      if (!audioOptimizerRef.current || !sipPluginRef.current?.webrtcStuff?.pc) {
        return
      }

      try {
        const metrics = await audioOptimizerRef.current.monitorCallQuality(
          sipPluginRef.current.webrtcStuff.pc
        )
        const quality = audioOptimizerRef.current.getQualityAssessment()
        
        setCallState(prev => ({ ...prev, audioQuality: quality }))
        
        // Log quality issues
        if (quality === 'poor' || quality === 'fair') {
          const recommendations = audioOptimizerRef.current.getQualityRecommendations()
          console.warn('Audio quality issues detected:', quality, recommendations)
        }
      } catch (error) {
        console.warn('Failed to monitor call quality:', error)
      }
    }

    // Monitor every 2 seconds during call
    const intervalId = setInterval(monitorQuality, 2000)
    
    // Initial check
    monitorQuality()

    return () => clearInterval(intervalId)
  }, [callState.status])

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

  const acceptWaitingCall = useCallback(async () => {
    if (!callState.waitingCall) return
    
    console.log("Accepting waiting call:", callState.waitingCall.phoneNumber)
    
    // End current call first
    if (sipPluginRef.current && (callState.status === 'incall' || callState.status === 'calling')) {
      const hangup = { request: "hangup" }
      sipPluginRef.current.send({ message: hangup })
    }
    
    // Set the waiting call as the new incoming call
    setCallState(prev => ({
      ...prev,
      status: 'incoming',
      sipStatus: `Incoming call from ${prev.waitingCall?.phoneNumber}`,
      incomingCallerId: prev.waitingCall?.callerId,
      incomingCallId: prev.waitingCall?.id,
      remoteJsep: prev.waitingCall?.remoteJsep,
      direction: 'incoming',
      callerId: prev.waitingCall?.phoneNumber,
      waitingCall: undefined
    }))
    
    // Auto-accept the waiting call
    setTimeout(() => {
      directAcceptCall()
    }, 100)
  }, [callState.waitingCall, callState.status, directAcceptCall])

  const declineWaitingCall = useCallback(() => {
    if (!callState.waitingCall) return
    
    console.log("Declining waiting call:", callState.waitingCall.phoneNumber)
    
    // Log the declined waiting call BEFORE clearing
    const contact = getContactByPhoneNumber(callState.waitingCall.phoneNumber)
    addCallRecord({
      phoneNumber: formatPhoneNumberForDisplay(callState.waitingCall.phoneNumber),
      contactName: contact?.name,
      duration: 0,
      timestamp: new Date(),
      type: 'missed',
      answered: false
    })
    
    // Send decline for the waiting call if we have the call ID
    if (sipPluginRef.current && callState.waitingCall.id) {
      const decline = { request: "decline", call_id: callState.waitingCall.id }
      sipPluginRef.current.send({ message: decline })
    }
    
    setCallState(prev => ({
      ...prev,
      waitingCall: undefined
    }))
    
    toast({
      title: "Call Declined",
      description: `Declined call from ${callState.waitingCall.phoneNumber}`,
    })
  }, [callState.waitingCall, getContactByPhoneNumber, addCallRecord, formatPhoneNumberForDisplay])

  const endCurrentAndAcceptWaiting = useCallback(async () => {
    if (!callState.waitingCall) return
    
    console.log("Ending current call and accepting waiting call")
    
    // Store waiting call info before we clear it
    const waitingCallInfo = callState.waitingCall
    
    // End current call
    if (sipPluginRef.current && (callState.status === 'incall' || callState.status === 'calling')) {
      const hangup = { request: "hangup" }
      sipPluginRef.current.send({ message: hangup })
      
      // Log the ended call
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
    }
    
    // Set the waiting call as the new incoming call and accept it
    setCallState(prev => ({
      ...prev,
      status: 'incoming',
      sipStatus: `Incoming call from ${waitingCallInfo.phoneNumber}`,
      incomingCallerId: waitingCallInfo.callerId,
      incomingCallId: waitingCallInfo.id,
      remoteJsep: waitingCallInfo.remoteJsep,
      direction: 'incoming',
      callerId: waitingCallInfo.phoneNumber,
      waitingCall: undefined
    }))
    
    // Auto-accept the waiting call after a short delay
    setTimeout(() => {
      directAcceptCall()
    }, 500)
  }, [callState.waitingCall, callState.status, callState.callerId, callState.direction, directAcceptCall, getContactByPhoneNumber, addCallRecord])

  // Video functions
  const toggleVideo = useCallback(async () => {
    if (!sipPluginRef.current || callState.status !== 'incall') {
      toast({
        title: "Cannot Toggle Video",
        description: "Must be in an active call",
        variant: "destructive"
      })
      return
    }

    if (callState.videoEnabled) {
      stopVideo()
    } else {
      await startVideo()
    }
  }, [callState.status, callState.videoEnabled])

  const startVideo = useCallback(async () => {
    if (!sipPluginRef.current || callState.status !== 'incall') {
      toast({
        title: "Cannot Start Video",
        description: "Must be in an active call",
        variant: "destructive"
      })
      return
    }

    try {
      // Use videoDeviceManager for optimal constraints
      const constraints = await videoDeviceManager.getOptimalVideoConstraints(
        settings.video.cameraDeviceId || undefined,
        settings.video.resolution
      )

      const stream = await navigator.mediaDevices.getUserMedia(constraints)

      // Send a re-INVITE with video enabled
      sipPluginRef.current.createOffer({
        tracks: [
          { type: "audio", capture: true, recv: true },
          { type: "video", capture: true, recv: true }
        ],
        success: (jsep: any) => {
          const update = { request: "update" }
          sipPluginRef.current.send({ message: update, jsep })
          
          setCallState(prev => ({
            ...prev,
            videoEnabled: true,
            isVideoMuted: false,
            localVideoStream: stream
          }))

          toast({
            title: "Video Started",
            description: "Video is now enabled",
          })
        },
        error: (error: any) => {
          console.error("Failed to create video offer:", error)
          toast({
            title: "Video Failed",
            description: "Could not start video",
            variant: "destructive"
          })
        }
      })
    } catch (error) {
      console.error("Failed to get video access:", error)
      toast({
        title: "Camera Error",
        description: "Cannot access camera",
        variant: "destructive"
      })
    }
  }, [callState.status, settings.video])

  const stopVideo = useCallback(() => {
    if (!sipPluginRef.current || callState.status !== 'incall') {
      return
    }

    // Send a re-INVITE with video disabled
    sipPluginRef.current.createOffer({
      tracks: [
        { type: "audio", capture: true, recv: true },
        { type: "video", capture: false, recv: true }
      ],
      success: (jsep: any) => {
        const update = { request: "update" }
        sipPluginRef.current.send({ message: update, jsep })
        
        // Stop local video tracks
        if (callState.localVideoStream) {
          callState.localVideoStream.getVideoTracks().forEach(track => track.stop())
        }

        setCallState(prev => ({
          ...prev,
          videoEnabled: false,
          isVideoMuted: false,
          localVideoStream: undefined
        }))

        toast({
          title: "Video Stopped",
          description: "Video has been disabled",
        })
      },
      error: (error: any) => {
        console.error("Failed to stop video:", error)
      }
    })
  }, [callState.status, callState.localVideoStream])

  const switchCamera = useCallback(async () => {
    if (!callState.videoEnabled || !callState.localVideoStream) {
      toast({
        title: "Cannot Switch Camera",
        description: "Video must be enabled first",
        variant: "destructive"
      })
      return
    }

    try {
      // Get all video devices
      const devices = await navigator.mediaDevices.enumerateDevices()
      const videoDevices = devices.filter(device => device.kind === 'videoinput')
      
      if (videoDevices.length < 2) {
        toast({
          title: "Cannot Switch Camera",
          description: "Only one camera available",
          variant: "destructive"
        })
        return
      }

      // Find current device ID
      const currentTrack = callState.localVideoStream.getVideoTracks()[0]
      const currentSettings = currentTrack.getSettings()
      const currentDeviceId = currentSettings.deviceId

      // Find next device
      const currentIndex = videoDevices.findIndex(device => device.deviceId === currentDeviceId)
      const nextDevice = videoDevices[(currentIndex + 1) % videoDevices.length]

      // Get new stream with the next camera using videoDeviceManager
      const constraints = await videoDeviceManager.getOptimalVideoConstraints(
        nextDevice.deviceId,
        settings.video.resolution
      )
      const newStream = await navigator.mediaDevices.getUserMedia(constraints)

      // Stop old video track
      currentTrack.stop()

      // Update local video stream
      setCallState(prev => ({
        ...prev,
        localVideoStream: newStream
      }))

      toast({
        title: "Camera Switched",
        description: `Switched to ${nextDevice.label || 'Camera'}`,
      })
    } catch (error) {
      console.error("Failed to switch camera:", error)
      toast({
        title: "Camera Switch Failed",
        description: "Could not switch to another camera",
        variant: "destructive"
      })
    }
  }, [callState.videoEnabled, callState.localVideoStream, settings.video])

  const startScreenShare = useCallback(async () => {
    if (!sipPluginRef.current || callState.status !== 'incall') {
      toast({
        title: "Cannot Share Screen",
        description: "Must be in an active call",
        variant: "destructive"
      })
      return
    }

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false
      })

      // Send a re-INVITE with screen share
      sipPluginRef.current.createOffer({
        tracks: [
          { type: "audio", capture: true, recv: true },
          { type: "video", capture: true, recv: true }
        ],
        success: (jsep: any) => {
          const update = { request: "update" }
          sipPluginRef.current.send({ message: update, jsep })
          
          // Stop current video if any
          if (callState.localVideoStream) {
            callState.localVideoStream.getVideoTracks().forEach(track => track.stop())
          }

          setCallState(prev => ({
            ...prev,
            videoEnabled: true,
            isScreenSharing: true,
            localVideoStream: stream
          }))

          // Handle screen share end
          stream.getVideoTracks()[0].addEventListener('ended', () => {
            stopScreenShare()
          })

          toast({
            title: "Screen Share Started",
            description: "You are now sharing your screen",
          })
        },
        error: (error: any) => {
          console.error("Failed to start screen share:", error)
          toast({
            title: "Screen Share Failed",
            description: "Could not start screen sharing",
            variant: "destructive"
          })
        }
      })
    } catch (error) {
      console.error("Failed to get display media:", error)
      toast({
        title: "Screen Share Error",
        description: "Cannot access screen sharing",
        variant: "destructive"
      })
    }
  }, [callState.status, callState.localVideoStream])

  const stopScreenShare = useCallback(() => {
    if (!callState.isScreenSharing) return

    // Stop screen share tracks
    if (callState.localVideoStream) {
      callState.localVideoStream.getVideoTracks().forEach(track => track.stop())
    }

    setCallState(prev => ({
      ...prev,
      isScreenSharing: false,
      localVideoStream: undefined,
      videoEnabled: false
    }))

    toast({
      title: "Screen Share Stopped",
      description: "Screen sharing has ended",
    })
  }, [callState.isScreenSharing, callState.localVideoStream])

  const sendDtmf = useCallback((digit: string) => {
    if (!sipPluginRef.current || (callState.status !== 'incall' && callState.status !== 'calling')) {
      logger.warn('Cannot send DTMF: not in call or plugin not available')
      return
    }

    try {
      logger.info(`Sending DTMF digit: ${digit}`)
      sipPluginRef.current.dtmf({ dtmf: { tones: digit } })
    } catch (error) {
      logger.error('Error sending DTMF:', error)
      toast({
        title: "DTMF Error",
        description: "Failed to send keypad tone",
        variant: "destructive"
      })
    }
  }, [callState.status])

  // Transfer methods
  const transferBlind = useCallback(async (destination: string) => {
    if (!sipPluginRef.current || callState.status !== 'incall') {
      toast({
        title: "Transfer Failed",
        description: "Must be in an active call to transfer",
        variant: "destructive"
      })
      return
    }

    if (!callState.dialogInfo?.callId) {
      toast({
        title: "Transfer Failed", 
        description: "Missing call dialog information",
        variant: "destructive"
      })
      return
    }

    try {
      logger.info(`Starting blind transfer to: ${destination}`)
      
      const transferMessage = {
        request: "transfer",
        uri: `sip:${destination}@${settings.sip.realm}`,
        call_id: callState.dialogInfo.callId,
        from_tag: callState.dialogInfo.fromTag,
        to_tag: callState.dialogInfo.toTag
      }

      sipPluginRef.current.send({ message: transferMessage })
      
      toast({
        title: "Transfer Initiated",
        description: `Transferring call to ${destination}`,
      })
    } catch (error) {
      logger.error('Blind transfer failed:', error)
      toast({
        title: "Transfer Failed",
        description: "Could not initiate transfer",
        variant: "destructive"
      })
    }
  }, [callState.status, callState.dialogInfo, settings.sip.realm])

  const startAttendedTransfer = useCallback(async (destination: string) => {
    if (!sipPluginRef.current || callState.status !== 'incall') {
      toast({
        title: "Transfer Failed",
        description: "Must be in an active call to start consultation",
        variant: "destructive"
      })
      return
    }

    try {
      logger.info(`Starting attended transfer consultation to: ${destination}`)
      
      // First put current call on hold
      const hold = { request: "hold" }
      sipPluginRef.current.send({ message: hold })
      
      // Attach second SIP plugin for consultation call
      if (!sessionRef.current) {
        throw new Error("No Janus session available")
      }

      sessionRef.current.attach({
        plugin: "janus.plugin.sip",
        success: (plugin: any) => {
          logger.info("Consult SIP plugin attached successfully")
          consultSipPluginRef.current = plugin
          
          // Register consult handle
          const register = {
            request: "register",
            username: settings.sip.username,
            display_name: settings.sip.username,
            secret: settings.sip.password,
            proxy: `sip:${settings.sip.realm}`,
            user_agent: "Lovable WebRTC Phone"
          }
          
          plugin.send({ message: register })
          
          // Make consultation call after brief delay for registration
          setTimeout(() => {
            const call = {
              request: "call",
              uri: `sip:${destination}@${settings.sip.realm}`
            }
            
            plugin.createOffer({
              tracks: [{ type: "audio", capture: true, recv: true }],
              success: (jsep: any) => {
                plugin.send({ message: call, jsep })
                
                setCallState(prev => ({
                  ...prev,
                  consultCall: {
                    id: 'consult-' + Date.now(),
                    phoneNumber: destination,
                    status: 'calling',
                    handleId: plugin.getId()
                  }
                }))
                
                toast({
                  title: "Consultation Started",
                  description: `Calling ${destination} for consultation`,
                })
              },
              error: (error: any) => {
                logger.error('Failed to create consult offer:', error)
                toast({
                  title: "Consultation Failed",
                  description: "Could not start consultation call",
                  variant: "destructive"
                })
              }
            })
          }, 1000)
        },
        error: (error: any) => {
          logger.error('Failed to attach consult SIP plugin:', error)
          toast({
            title: "Transfer Failed",
            description: "Could not attach consultation handle",
            variant: "destructive"
          })
        },
        onmessage: (msg: any, jsep?: any) => {
          const event = msg.result?.event || msg.sip
          logger.info('Consult handle message:', { event, msg, jsep })
          
          if (event === "calling") {
            setCallState(prev => ({
              ...prev,
              consultCall: prev.consultCall ? { ...prev.consultCall, status: 'calling' } : undefined
            }))
          } else if (event === "accepted") {
            setCallState(prev => ({
              ...prev,
              consultCall: prev.consultCall ? { ...prev.consultCall, status: 'connected' } : undefined
            }))
            toast({
              title: "Consultation Connected",
              description: "You can now speak with the consultation party",
            })
          } else if (event === "hangup") {
            // Clean up consultation call
            setCallState(prev => ({ ...prev, consultCall: undefined }))
            if (consultSipPluginRef.current) {
              consultSipPluginRef.current.detach()
              consultSipPluginRef.current = null
            }
          }
        },
        onlocaltrack: () => {},
        onremotetrack: () => {},
        oncleanup: () => {
          logger.info('Consult plugin cleanup')
          consultSipPluginRef.current = null
        }
      })
    } catch (error) {
      logger.error('Failed to start attended transfer:', error)
      toast({
        title: "Transfer Failed",
        description: "Could not start consultation",
        variant: "destructive"
      })
    }
  }, [callState.status, settings.sip])

  const completeAttendedTransfer = useCallback(async () => {
    if (!sipPluginRef.current || !consultSipPluginRef.current) {
      toast({
        title: "Transfer Failed",
        description: "Missing call handles for transfer",
        variant: "destructive"
      })
      return
    }

    if (!callState.consultCall || callState.consultCall.status !== 'connected') {
      toast({
        title: "Transfer Failed",
        description: "Consultation call must be connected first",
        variant: "destructive"
      })
      return
    }

    try {
      logger.info('Completing attended transfer')
      
      const transferMessage = {
        request: "transfer",
        call_id: callState.dialogInfo?.callId,
        from_tag: callState.dialogInfo?.fromTag,
        to_tag: callState.dialogInfo?.toTag,
        refer_id: callState.consultCall.id
      }

      sipPluginRef.current.send({ message: transferMessage })
      
      toast({
        title: "Transfer Completed",
        description: "Calls have been connected",
      })
      
      // Clean up both handles
      setTimeout(() => {
        setCallState(prev => ({
          ...prev,
          status: 'connected',
          sipStatus: prev.registered ? 'Online' : 'Offline',
          consultCall: undefined,
          dialogInfo: undefined
        }))
        
        if (consultSipPluginRef.current) {
          consultSipPluginRef.current.detach()
          consultSipPluginRef.current = null
        }
      }, 1000)
    } catch (error) {
      logger.error('Failed to complete attended transfer:', error)
      toast({
        title: "Transfer Failed",
        description: "Could not complete transfer",
        variant: "destructive"
      })
    }
  }, [callState.consultCall, callState.dialogInfo])

  const cancelAttendedTransfer = useCallback(() => {
    if (consultSipPluginRef.current) {
      logger.info('Cancelling attended transfer')
      
      // Hangup consultation call
      const hangup = { request: "hangup" }
      consultSipPluginRef.current.send({ message: hangup })
      
      consultSipPluginRef.current.detach()
      consultSipPluginRef.current = null
    }
    
    // Resume main call
    if (sipPluginRef.current && callState.isOnHold) {
      const unhold = { request: "unhold" }
      sipPluginRef.current.send({ message: unhold })
    }
    
    setCallState(prev => ({
      ...prev,
      consultCall: undefined,
      isOnHold: false
    }))
    
    toast({
      title: "Transfer Cancelled",
      description: "Consultation call ended, main call resumed",
    })
  }, [callState.isOnHold])

  const value: JanusContextType = {
    callState,
    makeCall,
    acceptCall,
    rejectCall,
    hangupCall,
    holdCall,
    resumeCall,
    acceptWaitingCall,
    declineWaitingCall,
    endCurrentAndAcceptWaiting,
    toggleVideo,
    startVideo,
    stopVideo,
    switchCamera,
    startScreenShare,
    stopScreenShare,
    sendDtmf,
    disconnect,
    reconnect,
    setDoNotDisturb,
    registerSipAccount,
    unregisterSipAccount,
    registerNow,
    transferBlind,
    startAttendedTransfer,
    completeAttendedTransfer,
    cancelAttendedTransfer
  }

  return (
    <JanusContext.Provider value={value}>
      {children}
    </JanusContext.Provider>
  )
}
