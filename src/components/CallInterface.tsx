import { useState } from 'react'
import { Phone, PhoneOff, Settings, Mic, MicOff, PhoneIncoming, Grid3x3 } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { CallButton } from '@/components/ui/call-button'
import { StatusIndicator } from '@/components/ui/status-indicator'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Dialpad } from '@/components/ui/dialpad'
import { useJanus } from '@/hooks/useJanus'
import { toast } from '@/hooks/use-toast'

export const CallInterface = () => {
  const { callState, makeCall, acceptCall, rejectCall, hangupCall, reconnect } = useJanus()
  const [phoneNumber, setPhoneNumber] = useState('07880498653')
  const [isMuted, setIsMuted] = useState(false)
  const [showDialpad, setShowDialpad] = useState(false)

  const handleCall = () => {
    if (callState.status === 'incall' || callState.status === 'calling') {
      hangupCall()
    } else if (callState.status === 'incoming') {
      acceptCall()
    } else {
      makeCall(phoneNumber)
    }
  }

  const toggleMute = () => {
    setIsMuted(!isMuted)
    // In a real implementation, you would mute/unmute the audio track
    toast({
      title: isMuted ? "Microphone Enabled" : "Microphone Muted",
      description: isMuted ? "You can now speak" : "Your microphone is muted",
    })
  }

  const getStatusVariant = () => {
    switch (callState.status) {
      case 'connected':
        return callState.registered ? 'connected' : 'connecting'
      case 'connecting':
        return 'connecting'
      case 'calling':
      case 'incall':
      case 'incoming':
        return 'connected'
      case 'error':
        return 'error'
      default:
        return 'disconnected'
    }
  }

  const getCallButtonVariant = () => {
    if (callState.status === 'incall' || callState.status === 'calling') {
      return 'hangup'
    } else if (callState.status === 'incoming') {
      return 'call'
    }
    return 'call'
  }

  const isCallDisabled = () => {
    return !callState.registered || callState.status === 'connecting' || callState.status === 'error'
  }

  const handleDialpadDigit = (digit: string) => {
    if (callState.status !== 'calling' && callState.status !== 'incall') {
      setPhoneNumber(prev => prev + digit)
    }
  }

  const handleDialpadBackspace = () => {
    if (callState.status !== 'calling' && callState.status !== 'incall') {
      setPhoneNumber(prev => prev.slice(0, -1))
    }
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-md p-8 space-y-8 text-center">
        {/* Header */}
        <div className="space-y-2">
          <h1 className="text-2xl font-bold text-foreground">WebRTC Phone</h1>
          <p className="text-sm text-muted-foreground">Professional SIP Calling</p>
        </div>

        {/* Status Indicator */}
        <div className="flex justify-center">
          <StatusIndicator 
            variant={getStatusVariant()} 
            label={callState.sipStatus}
          />
        </div>

        {/* Phone Number Input */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label htmlFor="phone" className="text-sm font-medium text-foreground">
              Phone Number
            </label>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowDialpad(!showDialpad)}
              className="h-8 w-8 p-0"
            >
              <Grid3x3 className="h-4 w-4" />
            </Button>
          </div>
          <Input
            id="phone"
            type="tel"
            value={phoneNumber}
            onChange={(e) => setPhoneNumber(e.target.value)}
            placeholder="Enter phone number"
            className="text-center text-lg"
            disabled={callState.status === 'calling' || callState.status === 'incall'}
          />
          
          {/* Dialpad */}
          {showDialpad && (
            <div className="mt-4 animate-fade-in">
              <Dialpad
                onDigitPress={handleDialpadDigit}
                onBackspace={handleDialpadBackspace}
              />
            </div>
          )}
        </div>

        {/* Call Status */}
        {(callState.status === 'calling' || callState.status === 'incall' || callState.status === 'incoming') && (
          <div className="space-y-2">
            <div className="text-lg font-medium text-foreground">
              {callState.status === 'calling' && 'Calling...'}
              {callState.status === 'incall' && 'In Call'}
              {callState.status === 'incoming' && 'Incoming Call'}
            </div>
            <div className="text-sm text-muted-foreground">
              {callState.status === 'incoming' ? callState.incomingCallerId : phoneNumber}
            </div>
            
            {/* Call duration could be added here */}
          </div>
        )}

        {/* Call Controls */}
        <div className="flex justify-center gap-4">
          {/* Incoming call controls */}
          {callState.status === 'incoming' && (
            <>
              <CallButton
                variant="hangup"
                size="lg"
                onClick={rejectCall}
                className="relative"
              >
                <PhoneOff className="h-6 w-6" />
              </CallButton>
              <CallButton
                variant="call"
                size="xl"
                onClick={acceptCall}
                className="relative animate-pulse"
              >
                <PhoneIncoming className="h-8 w-8" />
              </CallButton>
            </>
          )}

          {/* Regular call controls */}
          {callState.status !== 'incoming' && (
            <>
              {/* Mute Button - only show during call */}
              {callState.status === 'incall' && (
                <CallButton
                  variant="secondary"
                  size="lg"
                  onClick={toggleMute}
                  className="relative"
                >
                  {isMuted ? <MicOff className="h-6 w-6" /> : <Mic className="h-6 w-6" />}
                </CallButton>
              )}

              {/* Main Call Button */}
              <CallButton
                variant={getCallButtonVariant()}
                size="xl"
                onClick={handleCall}
                disabled={isCallDisabled()}
                className="relative"
              >
                {callState.status === 'incall' || callState.status === 'calling' ? (
                  <PhoneOff className="h-8 w-8" />
                ) : (
                  <Phone className="h-8 w-8" />
                )}
              </CallButton>
            </>
          )}
        </div>

        {/* Action Buttons */}
        <div className="flex gap-2 justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={reconnect}
            disabled={callState.status === 'connecting'}
          >
            <Settings className="h-4 w-4 mr-2" />
            Reconnect
          </Button>
        </div>

        {/* Connection Info */}
        <div className="text-xs text-muted-foreground space-y-1">
          <div>Server: devrtc.voicehost.io</div>
          <div>SIP: hpbx.sipconvergence.co.uk</div>
          <div>Account: 16331*201</div>
        </div>
      </Card>
    </div>
  )
}