import { useState } from 'react';
import { Phone, PhoneOff, Settings, Mic, MicOff, PhoneIncoming, X } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { CallButton } from '@/components/ui/call-button';
import { StatusIndicator } from '@/components/ui/status-indicator';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Dialpad } from '@/components/ui/dialpad';
import { useJanus } from '@/hooks/useJanus';
import { toast } from '@/hooks/use-toast';
export const CallInterface = () => {
  const {
    callState,
    makeCall,
    acceptCall,
    rejectCall,
    hangupCall,
    reconnect
  } = useJanus();
  const [phoneNumber, setPhoneNumber] = useState('07880498653');
  const [isMuted, setIsMuted] = useState(false);
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
  const getStatusVariant = () => {
    switch (callState.status) {
      case 'connected':
        return callState.registered ? 'connected' : 'connecting';
      case 'connecting':
        return 'connecting';
      case 'calling':
      case 'incall':
      case 'incoming':
        return 'connected';
      case 'error':
        return 'error';
      default:
        return 'disconnected';
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
  return <div className="min-h-screen bg-background flex items-center justify-center p-4">
      
    </div>;
};