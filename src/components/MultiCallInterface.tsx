import { useState } from 'react';
import { Phone, PhoneOff, Mic, MicOff, PhoneIncoming, X, Pause, Play, ArrowUpDown, Hash } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CallButton } from '@/components/ui/call-button';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Dialpad } from '@/components/ui/dialpad';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { useSimpleMultiCallContext } from '@/contexts/SimpleMultiCallContext';
import { toast } from '@/hooks/use-toast';
import { useCallTimer } from '@/hooks/useCallTimer';
import { Badge } from '@/components/ui/badge';

export const MultiCallInterface = () => {
  const {
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
    sendDtmf
  } = useSimpleMultiCallContext();
  
  const [phoneNumber, setPhoneNumber] = useState('');
  const [isMuted, setIsMuted] = useState(false);
  const [keypadOpen, setKeypadOpen] = useState(false);
  
  const activeCalls = callsState.calls.filter(call => 
    call.status === 'incall' || call.status === 'held' || call.status === 'calling' || call.status === 'incoming'
  );
  const activeCall = callsState.calls.find(call => call.id === callsState.activeCallId);
  const incomingCall = callsState.calls.find(call => call.status === 'incoming');
  const hasMultipleCalls = activeCalls.length > 1;
  
  const callTimer = useCallTimer(activeCall?.status === 'incall');

  const handleCall = () => {
    if (incomingCall) {
      acceptCall(incomingCall.id);
    } else if (activeCall && (activeCall.status === 'incall' || activeCall.status === 'calling')) {
      hangupCall(activeCall.id);
    } else {
      makeCall(phoneNumber);
    }
  };

  const toggleMute = () => {
    setIsMuted(!isMuted);
    toast({
      title: isMuted ? "Microphone Enabled" : "Microphone Muted",
      description: isMuted ? "You can now speak" : "Your microphone is muted"
    });
  };

  const toggleHold = (callId: string) => {
    const call = callsState.calls.find(c => c.id === callId);
    if (!call) return;

    if (call.isOnHold) {
      resumeCall(callId);
    } else {
      holdCall(callId);
    }
  };

  const getCallButtonVariant = () => {
    if (activeCall && (activeCall.status === 'incall' || activeCall.status === 'calling')) {
      return 'hangup';
    } else if (incomingCall) {
      return 'call';
    }
    return 'call';
  };

  const isCallDisabled = () => {
    return !callsState.registered || callsState.status === 'connecting' || callsState.status === 'error';
  };

  const handleDialpadDigit = (digit: string) => {
    if (!activeCall || activeCall.status === 'idle') {
      setPhoneNumber(prev => prev + digit);
    }
  };

  const handleDialpadBackspace = () => {
    if (!activeCall || activeCall.status === 'idle') {
      setPhoneNumber(prev => prev.slice(0, -1));
    }
  };

  return (
    <div className="w-full max-w-md space-y-4">
      {/* Call Waiting Banner */}
      {callsState.waitingCall && (
        <Card className="border-call-warning bg-call-warning/10">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium text-call-warning-foreground">
                  Call Waiting
                </div>
                <div className="text-sm text-muted-foreground">
                  {callsState.waitingCall.phoneNumber}
                </div>
              </div>
              <div className="flex gap-2">
                <Button 
                  size="sm" 
                  variant="outline"
                  onClick={declineWaitingCall}
                  className="border-call-danger text-call-danger hover:bg-call-danger hover:text-call-danger-foreground"
                >
                  Decline
                </Button>
                <Button 
                  size="sm"
                  onClick={endCurrentAndAcceptWaiting}
                  className="bg-call-success hover:bg-call-success/90 text-call-success-foreground"
                >
                  End & Accept
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Active Calls Display */}
      {activeCalls.length > 0 && (
        <div className="space-y-3">
          {activeCalls.map((call) => (
            <Card key={call.id} className={`${call.id === callsState.activeCallId ? 'border-primary' : 'border-muted'}`}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-medium">
                    {call.id === callsState.activeCallId ? 'Active Call' : 'Call'}
                  </CardTitle>
                  <div className="flex items-center gap-2">
                    <Badge variant={call.isOnHold ? 'secondary' : 'default'}>
                      {call.isOnHold ? 'On Hold' : call.status === 'incall' ? 'Connected' : call.status}
                    </Badge>
                    {call.direction === 'incoming' && (
                      <Badge variant="outline">Incoming</Badge>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="text-center">
                  <div className="text-lg font-medium">
                    {call.phoneNumber}
                  </div>
                  {call.status === 'incall' && !call.isOnHold && call.id === callsState.activeCallId && (
                    <div className="text-xl font-mono text-primary mt-1">
                      {callTimer}
                    </div>
                  )}
                </div>
                
                <div className="flex justify-center gap-2">
                  {call.status === 'incoming' ? (
                    <>
                      <CallButton 
                        variant="hangup" 
                        size="lg" 
                        onClick={() => rejectCall(call.id)}
                      >
                        <PhoneOff className="h-6 w-6" />
                      </CallButton>
                      <CallButton 
                        variant="call" 
                        size="xl" 
                        onClick={() => acceptCall(call.id)}
                        className="animate-pulse"
                      >
                        <PhoneIncoming className="h-8 w-8" />
                      </CallButton>
                    </>
                  ) : (
                    <>
                      {call.status === 'incall' && (
                        <>
                          <CallButton 
                            variant="secondary" 
                            size="lg" 
                            onClick={() => toggleHold(call.id)}
                          >
                            {call.isOnHold ? <Play className="h-6 w-6" /> : <Pause className="h-6 w-6" />}
                          </CallButton>
                          
                           {call.id === callsState.activeCallId && (
                            <>
                              <CallButton 
                                variant="secondary" 
                                size="lg" 
                                onClick={toggleMute}
                              >
                                {isMuted ? <MicOff className="h-6 w-6" /> : <Mic className="h-6 w-6" />}
                              </CallButton>
                              
                              <Dialog open={keypadOpen} onOpenChange={setKeypadOpen}>
                                <DialogTrigger asChild>
                                  <CallButton 
                                    variant="secondary" 
                                    size="lg"
                                  >
                                    <Hash className="h-6 w-6" />
                                  </CallButton>
                                </DialogTrigger>
                                <DialogContent className="sm:max-w-[350px] bg-background border shadow-lg z-[100]">
                                  <DialogHeader>
                                    <DialogTitle>Keypad</DialogTitle>
                                  </DialogHeader>
                                  <Dialpad
                                    onDigitPress={(digit) => {
                                      sendDtmf(digit);
                                      toast({
                                        title: `DTMF: ${digit}`,
                                        description: "Tone sent",
                                        duration: 1000
                                      });
                                    }}
                                    onBackspace={() => {}}
                                    className="py-4"
                                  />
                                </DialogContent>
                              </Dialog>
                            </>
                          )}
                        </>
                      )}
                      
                      <CallButton 
                        variant="hangup" 
                        size="lg" 
                        onClick={() => hangupCall(call.id)}
                      >
                        <PhoneOff className="h-6 w-6" />
                      </CallButton>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
          
          {/* Swap Calls Button */}
          {hasMultipleCalls && callsState.multiCallSupported && (
            <div className="flex justify-center">
              <Button 
                onClick={swapCalls}
                variant="outline"
                className="flex items-center gap-2"
              >
                <ArrowUpDown className="h-4 w-4" />
                Swap Calls
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Main Dialer Interface */}
      {activeCalls.length === 0 && (
        <Card className="p-8 space-y-6 text-center">
          {/* Phone Number Input */}
          <div className="space-y-4">
            <div className="relative">
              <Input 
                id="phone" 
                type="tel" 
                value={phoneNumber} 
                onChange={e => setPhoneNumber(e.target.value)} 
                placeholder="Enter phone number" 
                className="text-center text-lg pr-10" 
                disabled={isCallDisabled()}
              />
              {phoneNumber && (
                <Button 
                  variant="ghost" 
                  size="sm" 
                  onClick={() => setPhoneNumber('')} 
                  className="absolute right-2 top-1/2 transform -translate-y-1/2 h-6 w-6 p-0"
                >
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>
            
            {/* Dialpad */}
            <div className="mt-4">
              <Dialpad 
                onDigitPress={handleDialpadDigit} 
                onBackspace={handleDialpadBackspace} 
              />
            </div>
          </div>

          {/* Call Button */}
          <div className="flex justify-center">
            <CallButton 
              variant={getCallButtonVariant()} 
              size="xl" 
              onClick={handleCall} 
              disabled={isCallDisabled() || !phoneNumber.trim()}
            >
              <Phone className="h-8 w-8" />
            </CallButton>
          </div>
        </Card>
      )}

      {/* Status Display */}
      <div className="text-center text-sm text-muted-foreground">
        <div>{callsState.sipStatus}</div>
        {callsState.multiCallSupported && (
          <div className="text-call-success">Multi-call ready</div>
        )}
      </div>
    </div>
  );
};