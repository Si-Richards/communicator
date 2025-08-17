import { Send, Plus, User, Mic, MicOff } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { useState, useEffect } from 'react';
import { useSpeechRecognition } from '@/hooks/useSpeechRecognition';
import { useSettings } from '@/contexts/SettingsContext';

// Mock SMS data
const mockSMS = [
  {
    id: '1',
    to: '07880498653',
    contact: 'John Smith',
    message: 'Hey, can you call me back?',
    timestamp: '14:30',
    status: 'delivered'
  },
  {
    id: '2',
    to: '07890123456',
    contact: 'Sarah Johnson',
    message: 'Meeting confirmed for tomorrow at 3 PM',
    timestamp: '11:15',
    status: 'delivered'
  },
  {
    id: '3',
    to: '07700900123',
    contact: 'Unknown',
    message: 'Thank you for your response',
    timestamp: 'Yesterday',
    status: 'sent'
  }
];

const SMS = () => {
  const [recipient, setRecipient] = useState('');
  const [message, setMessage] = useState('');
  const [isComposing, setIsComposing] = useState(false);
  const { settings } = useSettings();
  
  const {
    isListening,
    transcript,
    interimTranscript,
    isSupported,
    start: startDictation,
    stop: stopDictation,
    reset: resetTranscript
  } = useSpeechRecognition({
    language: settings.dictation.language,
    continuous: settings.dictation.continuous,
    interimResults: settings.dictation.interimResults
  });

  const handleSendSMS = () => {
    if (recipient.trim() && message.trim()) {
      console.log('Sending SMS to:', recipient, 'Message:', message);
      setRecipient('');
      setMessage('');
      setIsComposing(false);
      resetTranscript();
    }
  };

  const toggleDictation = () => {
    if (!settings.dictation.enabled) return;
    
    if (isListening) {
      stopDictation();
    } else {
      resetTranscript();
      startDictation();
    }
  };

  // Update message when transcript changes
  useEffect(() => {
    if (transcript) {
      setMessage(prev => {
        const newText = prev + (prev ? ' ' : '') + transcript;
        resetTranscript();
        return newText;
      });
    }
  }, [transcript, resetTranscript]);

  const getContactName = (number: string) => {
    const sms = mockSMS.find(s => s.to === number);
    return sms?.contact || number;
  };

  const getStatusBadgeVariant = (status: string) => {
    switch (status) {
      case 'delivered':
        return 'default';
      case 'sent':
        return 'secondary';
      case 'failed':
        return 'destructive';
      default:
        return 'outline';
    }
  };

  return (
    <div className="min-h-full p-4">
      <div className="max-w-4xl mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">SMS</h1>
          <Button onClick={() => setIsComposing(true)} className="flex items-center gap-2">
            <Plus className="h-4 w-4" />
            New SMS
          </Button>
        </div>

        {/* Compose SMS */}
        {isComposing && (
          <Card>
            <CardHeader>
              <CardTitle>Compose SMS</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="recipient">Recipient</Label>
                <Input
                  id="recipient"
                  placeholder="Enter phone number"
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                />
              </div>
              
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="message">Message</Label>
                  {isSupported && settings.dictation.enabled && (
                    <Button
                      onClick={toggleDictation}
                      size="sm"
                      variant={isListening ? "default" : "outline"}
                      className={isListening ? "bg-red-600 hover:bg-red-700" : ""}
                    >
                      {isListening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                      {isListening ? "Stop" : "Dictate"}
                    </Button>
                  )}
                </div>
                <Textarea
                  id="message"
                  placeholder={isListening ? "Listening..." : "Type your message..."}
                  value={message + (interimTranscript ? ` ${interimTranscript}` : '')}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={4}
                />
                <div className="text-sm text-muted-foreground text-right">
                  {(message + (interimTranscript ? ` ${interimTranscript}` : '')).length}/160 characters
                </div>
              </div>
              
              <div className="flex gap-2">
                <Button onClick={handleSendSMS} className="flex items-center gap-2">
                  <Send className="h-4 w-4" />
                  Send SMS
                </Button>
                <Button variant="outline" onClick={() => setIsComposing(false)}>
                  Cancel
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* SMS History */}
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">Recent SMS</h2>
          
          {mockSMS.map((sms) => (
            <Card key={sms.id}>
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  <Avatar className="h-10 w-10">
                    <AvatarFallback>
                      {sms.contact === 'Unknown' ? (
                        <User className="h-5 w-5" />
                      ) : (
                        sms.contact.split(' ').map(n => n[0]).join('')
                      )}
                    </AvatarFallback>
                  </Avatar>
                  
                  <div className="flex-1 space-y-2">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="font-medium">{sms.contact}</h3>
                        <p className="text-sm text-muted-foreground">{sms.to}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm text-muted-foreground">{sms.timestamp}</p>
                        <Badge variant={getStatusBadgeVariant(sms.status)} className="text-xs mt-1">
                          {sms.status}
                        </Badge>
                      </div>
                    </div>
                    
                    <div className="bg-muted/50 p-3 rounded-lg">
                      <p className="text-sm">{sms.message}</p>
                    </div>
                    
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setRecipient(sms.to);
                          setIsComposing(true);
                        }}
                      >
                        Reply
                      </Button>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
};

export default SMS;