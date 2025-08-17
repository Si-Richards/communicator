import { useState } from 'react';
import { 
  Phone, 
  PhoneOff, 
  Mic, 
  MicOff, 
  PhoneIncoming, 
  X, 
  Pause, 
  Play, 
  PhoneForwarded,
  Video,
  VideoOff,
  SwitchCamera,
  Monitor,
  MonitorOff
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { CallButton } from '@/components/ui/call-button';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialpad } from '@/components/ui/dialpad';
import { VideoSurface } from '@/components/VideoSurface';
import { useJanusContext } from '@/contexts/JanusContext';
import { useSettings } from '@/contexts/SettingsContext';
import { toast } from '@/hooks/use-toast';
import { useCallTimer } from '@/hooks/useCallTimer';
import { useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';

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
    endCurrentAndAcceptWaiting,
    toggleVideo,
    startVideo,
    stopVideo,
    switchCamera,
    startScreenShare,
    stopScreenShare
  } = useJanusContext();
  const { settings } = useSettings();
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
      makeCall(phoneNumber, settings.video.startWithVideo);
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

        {/* Video surfaces */}
        {(callState.videoEnabled || callState.localVideoStream || callState.remoteVideoStream) && (
          <div className="grid grid-cols-1 gap-4 mb-4">
            {callState.remoteVideoStream && (
              <VideoSurface 
                stream={callState.remoteVideoStream}
                className="aspect-video h-48"
                placeholder="Remote video"
              />
            )}
            {callState.localVideoStream && (
              <VideoSurface 
                stream={callState.localVideoStream}
                isLocal
                isMirrored={settings.video.mirrorLocal}
                className="aspect-video h-24"
                placeholder="Your video"
              />
            )}
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
                <div className="space-y-4">
                  {/* Primary controls */}
                  <div className="grid grid-cols-4 gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={toggleMute}
                      className={cn(
                        "h-12 p-0",
                        isMuted && "bg-red-100 hover:bg-red-200 text-red-600"
                      )}
                    >
                      {isMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                    </Button>
                    
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={toggleHold}
                      className={cn(
                        "h-12 p-0",
                        callState.isOnHold && "bg-yellow-100 hover:bg-yellow-200 text-yellow-600"
                      )}
                    >
                      {callState.isOnHold ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
                    </Button>

                    <Button
                      variant="outline"
                      size="sm"
                      onClick={toggleVideo}
                      className={cn(
                        "h-12 p-0",
                        callState.isVideoMuted && "bg-red-100 hover:bg-red-200 text-red-600"
                      )}
                    >
                      {callState.isVideoMuted ? <VideoOff className="h-4 w-4" /> : <Video className="h-4 w-4" />}
                    </Button>

                    <Button
                      variant="outline"
                      size="sm"
                      onClick={switchCamera}
                      className="h-12 p-0"
                      disabled={!callState.localVideoStream}
                    >
                      <SwitchCamera className="h-4 w-4" />
                    </Button>
                  </div>

                  {/* Secondary video controls */}
                  <div className="flex justify-center space-x-4">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={callState.isScreenSharing ? stopScreenShare : startScreenShare}
                      className={cn(
                        "h-10",
                        callState.isScreenSharing && "bg-blue-100 hover:bg-blue-200 text-blue-600"
                      )}
                      disabled={!settings.video.allowScreenShare}
                    >
                      {callState.isScreenSharing ? (
                        <>
                          <MonitorOff className="h-4 w-4 mr-2" />
                          Stop Sharing
                        </>
                      ) : (
                        <>
                          <Monitor className="h-4 w-4 mr-2" />
                          Share Screen
                        </>
                      )}
                    </Button>
                  </div>

                  {/* Start video for audio-only calls */}
                  {!callState.videoEnabled && !callState.localVideoStream && (
                    <div className="flex justify-center">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={startVideo}
                        className="h-10"
                      >
                        <Video className="h-4 w-4 mr-2" />
                        Start Video
                      </Button>
                    </div>
                  )}
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