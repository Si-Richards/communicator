import { Play, Pause, Trash2, Phone } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useState } from 'react';

// Mock voicemail data
const mockVoicemails = [
  {
    id: '1',
    from: 'John Smith',
    number: '07880498653',
    timestamp: '2024-01-15 14:30',
    duration: '1:23',
    isNew: true,
    transcription: 'Hey, this is John. Just calling to follow up on our meeting. Give me a call back when you get a chance.'
  },
  {
    id: '2',
    from: 'Sarah Johnson',
    number: '07890123456',
    timestamp: '2024-01-15 11:15',
    duration: '0:45',
    isNew: false,
    transcription: 'Hi, Sarah here. The documents are ready for review. Thanks!'
  },
  {
    id: '3',
    from: 'Unknown',
    number: '07700900123',
    timestamp: '2024-01-14 16:45',
    duration: '2:10',
    isNew: false,
    transcription: 'This is a reminder about your appointment tomorrow at 3 PM.'
  }
];

const Voicemail = () => {
  const [playingId, setPlayingId] = useState<string | null>(null);

  const handlePlay = (id: string) => {
    if (playingId === id) {
      setPlayingId(null);
    } else {
      setPlayingId(id);
    }
  };

  const handleCallBack = (number: string) => {
    console.log('Calling back:', number);
  };

  const handleDelete = (id: string) => {
    console.log('Deleting voicemail:', id);
  };

  return (
    <div className="min-h-full p-4">
      <div className="max-w-4xl mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Voicemail</h1>
          <Badge variant="secondary">{mockVoicemails.filter(v => v.isNew).length} New</Badge>
        </div>

        <div className="space-y-4">
          {mockVoicemails.map((voicemail) => (
            <Card key={voicemail.id} className={voicemail.isNew ? 'border-primary' : ''}>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <CardTitle className="text-lg">{voicemail.from}</CardTitle>
                    {voicemail.isNew && <Badge variant="default" className="text-xs">New</Badge>}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {voicemail.timestamp}
                  </div>
                </div>
                <div className="text-sm text-muted-foreground">
                  {voicemail.number} • {voicemail.duration}
                </div>
              </CardHeader>
              
              <CardContent className="space-y-4">
                <div className="bg-muted/50 p-3 rounded-lg">
                  <p className="text-sm italic">{voicemail.transcription}</p>
                </div>
                
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handlePlay(voicemail.id)}
                    className="flex items-center gap-2"
                  >
                    {playingId === voicemail.id ? (
                      <Pause className="h-4 w-4" />
                    ) : (
                      <Play className="h-4 w-4" />
                    )}
                    {playingId === voicemail.id ? 'Pause' : 'Play'}
                  </Button>
                  
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleCallBack(voicemail.number)}
                    className="flex items-center gap-2"
                  >
                    <Phone className="h-4 w-4" />
                    Call Back
                  </Button>
                  
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleDelete(voicemail.id)}
                    className="flex items-center gap-2 text-destructive hover:bg-destructive hover:text-destructive-foreground"
                  >
                    <Trash2 className="h-4 w-4" />
                    Delete
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
};

export default Voicemail;