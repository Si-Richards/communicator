import { useState } from 'react';
import { Phone, PhoneOff, Mic, MicOff, PhoneIncoming, X, Pause, Play, PhoneForwarded } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { CallButton } from '@/components/ui/call-button';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialpad } from '@/components/ui/dialpad';
import { useJanusContext } from '@/contexts/JanusContext';
import { toast } from '@/hooks/use-toast';
import { useCallTimer } from '@/hooks/useCallTimer';
import { useNavigate } from 'react-router-dom';

export const CallInterface = () => {
  const {
    callState,
    makeCall,
    acceptCall,
    rejectCall,
    hangupCall,
    holdCall,
    resumeCall,
    declineWaitingCall,
    endCurrentAndAcceptWaiting
  } = useJanusContext();
  const navigate = useNavigate();
  const [phoneNumber, setPhoneNumber] = useState('');
  const [isMuted, setIsMuted] = useState(false);
  const callTimer = useCallTimer(callState.status === 'incall');
  const handleCall = () => {
    if (callState.status === 'incall' || callState.status === 'calling') {
      hangupCall();
    } else if (callState.status === 'incoming') {
      acceptCall();
    } else {
      makeCall(phoneNumber);
    }
  };
  const toggleMute = () => {
    setIsMuted(!isMuted);
    // In a real implementation, you would mute/unmute the audio track
    toast({
      title: isMuted ? "Microphone Enabled" : "Microphone Muted",
      description: isMuted ? "You can now speak" : "Your microphone is muted"
    });
  };

  const toggleHold = () => {
    if (callState.isOnHold) {
      resumeCall();
    } else {
      holdCall();
    }
  };
  const getCallButtonVariant = () => {
    if (callState.status === 'incall' || callState.status === 'calling') {
      return 'hangup';
    } else if (callState.status === 'incoming') {
      return 'call';
    }
    return 'call';
  };
  const isCallDisabled = () => {
    return !callState.registered || callState.status === 'connecting' || callState.status === 'error';
  };
  const handleDialpadDigit = (digit: string) => {
    if (callState.status !== 'calling' && callState.status !== 'incall') {
      setPhoneNumber(prev => prev + digit);
    }
  };
  const handleDialpadBackspace = () => {
    if (callState.status !== 'calling' && callState.status !== 'incall') {
      setPhoneNumber(prev => prev.slice(0, -1));
    }
  };
  return (
      <Card className="w-full max-w-md p-8 space-y-6 text-center mx-auto">
        {/* Call Waiting Banner */}
        {callState.waitingCall && (
          <div className="bg-amber-100 dark:bg-amber-900 border border-amber-300 dark:border-amber-700 rounded-lg p-4 space-y-3">
            <div className="text-amber-800 dark:text-amber-200">
              <h3 className="font-semibold">Call Waiting</h3>
              <p className="text-sm">Incoming call from {callState.waitingCall.phoneNumber}</p>
            </div>
            <div className="flex gap-2 justify-center">
              <Button
                variant="outline"
                size="sm"
                onClick={declineWaitingCall}
                className="border-red-300 text-red-700 hover:bg-red-50"
              >
                <PhoneOff className="h-4 w-4 mr-1" />
                Decline
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={endCurrentAndAcceptWaiting}
                className="border-green-300 text-green-700 hover:bg-green-50"
              >
                <Phone className="h-4 w-4 mr-1" />
                End & Accept
              </Button>
            </div>
          </div>
        )}

        {/* Call Status - Moved above dialpad */}
        {(callState.status === 'calling' || callState.status === 'incall' || callState.status === 'incoming') && <div className="space-y-2">
            <div className="text-lg font-medium text-foreground">
              {callState.status === 'calling' && 'Calling...'}
              {callState.status === 'incall' && (callState.isOnHold ? 'On Hold' : 'In Call')}
              {callState.status === 'incoming' && 'Incoming Call'}
            </div>
            <div className="text-sm text-muted-foreground">
              {callState.status === 'incoming' ? callState.incomingCallerId : phoneNumber}
            </div>
            
            {/* Call Timer */}
            {callState.status === 'incall' && (
              <div className="text-xl font-mono text-primary">
                {callTimer}
              </div>
            )}
          </div>}

        {/* Phone Number Input */}
        <div className="space-y-4">
          <div className="relative">
            <Input id="phone" type="tel" value={phoneNumber} onChange={e => setPhoneNumber(e.target.value)} placeholder="Enter phone number" className="text-center text-lg pr-10" disabled={callState.status === 'calling' || callState.status === 'incall'} />
            {phoneNumber && <Button variant="ghost" size="sm" onClick={() => setPhoneNumber('')} className="absolute right-2 top-1/2 transform -translate-y-1/2 h-6 w-6 p-0">
                <X className="h-4 w-4" />
              </Button>}
          </div>
          
          {/* Dialpad */}
          <div className="mt-4">
            <Dialpad onDigitPress={handleDialpadDigit} onBackspace={handleDialpadBackspace} />
          </div>
        </div>

        {/* Call Controls */}
        <div className="flex justify-center gap-4">
          {/* Incoming call controls */}
          {callState.status === 'incoming' && <>
              <CallButton variant="hangup" size="lg" onClick={rejectCall} className="relative">
                <PhoneOff className="h-6 w-6" />
              </CallButton>
              <CallButton variant="call" size="xl" onClick={acceptCall} className="relative animate-pulse">
                <PhoneIncoming className="h-8 w-8" />
              </CallButton>
            </>}

          {/* Regular call controls */}
          {callState.status !== 'incoming' && <>
              {/* Call control buttons - only show during call */}
              {callState.status === 'incall' && (
                <div className="flex gap-4">
                  {/* Mute Button */}
                  <CallButton variant="secondary" size="lg" onClick={toggleMute} className="relative">
                    {isMuted ? <MicOff className="h-6 w-6" /> : <Mic className="h-6 w-6" />}
                  </CallButton>

                  {/* Hold Button */}
                  <CallButton variant="secondary" size="lg" onClick={toggleHold} className="relative">
                    {callState.isOnHold ? <Play className="h-6 w-6" /> : <Pause className="h-6 w-6" />}
                  </CallButton>
                </div>
              )}

              {/* Main Call Button */}
              <CallButton variant={getCallButtonVariant()} size="xl" onClick={handleCall} disabled={isCallDisabled()} className="relative">
                {callState.status === 'incall' || callState.status === 'calling' ? <PhoneOff className="h-8 w-8" /> : <Phone className="h-8 w-8" />}
              </CallButton>
            </>}
        </div>

        {/* Multi-call Navigation */}
        {callState.status === 'connected' && callState.registered && (
          <div className="pt-4 border-t">
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate('/dial')}
              className="text-muted-foreground hover:text-foreground"
            >
              <PhoneForwarded className="h-4 w-4 mr-2" />
              Multi-call Dialer
            </Button>
          </div>
        )}

        {/* SIP Status */}
        <div className="text-xs text-muted-foreground">
          <Badge variant={callState.registered ? "default" : "secondary"}>
            {callState.sipStatus}
          </Badge>
        </div>

      </Card>
    );
};