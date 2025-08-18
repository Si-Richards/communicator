import React, { useState, useEffect, useRef } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { useSettings } from '@/contexts/SettingsContext';
import { useJanusContext } from '@/contexts/JanusContext';
import { notificationManager } from '@/lib/notificationManager';
import { audioDeviceManager, AudioDevice, DeviceTestResult } from '@/lib/audioDeviceManager';
import { videoDeviceManager, VideoDevice, VideoDeviceTestResult } from '@/lib/videoDeviceManager';
import { logger, LogEntry, LogLevel } from '@/lib/logger';
import { useToast } from '@/hooks/use-toast';
import { Download, Upload, RotateCcw, Play, Volume2, Mic, Search, Filter, Trash2, Settings, AudioLines, Database, Activity, Info, Phone, Eye, EyeOff, Bell, RefreshCw } from 'lucide-react';
const SettingsPage = () => {
  const {
    settings,
    updateAudioQuality,
    updateAudioDevices,
    updateLogSettings,
    updateRingtoneSettings,
    updateSipSettings,
    updateVideoSettings,
    updateNotificationSettings,
    resetToDefaults,
    exportSettings,
    importSettings
  } = useSettings();
  const { toast } = useToast();
  const { callState, registerNow, unregisterSipAccount } = useJanusContext();

  // Device management state
  const [inputDevices, setInputDevices] = useState<AudioDevice[]>([]);
  const [outputDevices, setOutputDevices] = useState<AudioDevice[]>([]);
  const [videoDevices, setVideoDevices] = useState<VideoDevice[]>([]);
  const [testingDevice, setTestingDevice] = useState<string | null>(null);
  
  // Video testing state
  const [testingVideoDevice, setTestingVideoDevice] = useState<string | null>(null);
  const [videoTestStream, setVideoTestStream] = useState<MediaStream | null>(null);
  const videoTestRef = useRef<HTMLVideoElement>(null);

  // Logs state
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logSearch, setLogSearch] = useState('');
  const [logLevelFilter, setLogLevelFilter] = useState<LogLevel | 'all'>('all');
  const logsEndRef = useRef<HTMLDivElement>(null);

  // SIP configuration state
  const [showPassword, setShowPassword] = useState(false);
  const [tempSipSettings, setTempSipSettings] = useState({
    username: settings.sip.username,
    password: settings.sip.password
  });

  // Sync temp settings when main settings change
  useEffect(() => {
    setTempSipSettings({
      username: settings.sip.username,
      password: settings.sip.password
    });
  }, [settings.sip.username, settings.sip.password]);
  useEffect(() => {
    // Load devices
    loadDevices();

    // Set up device change listener
    const unsubscribe = audioDeviceManager.onDeviceChange(() => {
      loadDevices();
    });

    // Set up log listener
    const unsubscribeLogs = logger.subscribe(log => {
      setLogs(prev => [...prev, log]);
    });

    // Load existing logs
    setLogs(logger.getLogs());
    return () => {
      unsubscribe();
      unsubscribeLogs();
    };
  }, []);
  useEffect(() => {
    if (settings.logs.autoScroll && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({
        behavior: 'smooth'
      });
    }
  }, [logs, settings.logs.autoScroll]);
  const loadDevices = async () => {
    await audioDeviceManager.requestPermissions();
    await videoDeviceManager.requestPermissions();
    const allDevices = await audioDeviceManager.enumerateDevices();
    const videoDevs = await videoDeviceManager.enumerateDevices();
    setInputDevices(audioDeviceManager.getInputDevices());
    setOutputDevices(audioDeviceManager.getOutputDevices());
    setVideoDevices(videoDevs);
  };

  const loadVideoDevices = async () => {
    console.log('loadVideoDevices called')
    await videoDeviceManager.requestPermissions();
    const videoDevs = await videoDeviceManager.enumerateDevices();
    setVideoDevices(videoDevs);
  };

  const testDevice = async (deviceId: string, kind: 'audioinput' | 'audiooutput') => {
    setTestingDevice(deviceId);
    try {
      let result: DeviceTestResult;
      if (kind === 'audioinput') {
        result = await audioDeviceManager.testInputDevice(deviceId);
      } else {
        result = await audioDeviceManager.testOutputDevice(deviceId);
      }
      if (result.success) {
        toast({
          title: 'Device Test Successful',
          description: kind === 'audioinput' ? `Microphone working. Volume: ${result.volume}%` : 'Speaker test completed successfully'
        });
      } else {
        toast({
          title: 'Device Test Failed',
          description: result.error,
          variant: 'destructive'
        });
      }
    } catch (error) {
      toast({
        title: 'Test Error',
        description: 'Failed to test device',
        variant: 'destructive'
      });
    } finally {
      setTestingDevice(null);
    }
  };

  const testVideoDevice = async (deviceId: string) => {
    try {
      setTestingVideoDevice(deviceId)
      
      // Use videoDeviceManager for consistent constraints
      const constraints = await videoDeviceManager.getOptimalVideoConstraints(
        deviceId === 'default' ? undefined : deviceId,
        settings.video.resolution
      )
      
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      
      setVideoTestStream(stream)
      if (videoTestRef.current) {
        videoTestRef.current.srcObject = stream
      }
      
      toast({
        title: "Camera Test",
        description: "Camera is working properly",
      })
    } catch (error) {
      console.error('Camera test failed:', error)
      toast({
        title: "Camera Test Failed", 
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: "destructive"
      })
    } finally {
      setTestingVideoDevice(null)
    }
  }

  const stopVideoTest = () => {
    if (videoTestStream) {
      videoTestStream.getTracks().forEach(track => track.stop());
      setVideoTestStream(null);
    }
    if (videoTestRef.current) {
      videoTestRef.current.srcObject = null;
    }
  };
  const handleExportSettings = () => {
    const data = exportSettings();
    const blob = new Blob([data], {
      type: 'application/json'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'webrtc-app-settings.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
  const handleImportSettings = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = e => {
        try {
          const data = e.target?.result as string;
          if (importSettings(data)) {
            toast({
              title: 'Settings Imported',
              description: 'Settings have been successfully imported'
            });
          } else {
            toast({
              title: 'Import Failed',
              description: 'Invalid settings file format',
              variant: 'destructive'
            });
          }
        } catch (error) {
          toast({
            title: 'Import Error',
            description: 'Failed to read settings file',
            variant: 'destructive'
          });
        }
      };
      reader.readAsText(file);
    }
  };
  const exportLogs = (format: 'json' | 'text') => {
    const data = logger.exportLogs(format);
    const blob = new Blob([data], {
      type: format === 'json' ? 'application/json' : 'text/plain'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `app-logs.${format}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
  const filteredLogs = logs.filter(log => {
    const matchesLevel = logLevelFilter === 'all' || log.level === logLevelFilter;
    const matchesSearch = !logSearch || log.message.toLowerCase().includes(logSearch.toLowerCase()) || log.source?.toLowerCase().includes(logSearch.toLowerCase());
    return matchesLevel && matchesSearch;
  });
  const getLevelColor = (level: LogLevel) => {
    switch (level) {
      case 'error':
        return 'text-call-danger';
      case 'warn':
        return 'text-call-warning';
      case 'info':
        return 'text-primary';
      case 'debug':
        return 'text-muted-foreground';
    }
  };
  return <div className="min-h-full p-6">
      <div className="max-w-4xl mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Settings</h1>
          <p className="text-muted-foreground">Customise your experience</p>
        </div>

        <Tabs defaultValue="audio-quality" className="w-full">
          <TabsList className="grid w-full grid-cols-8">
            <TabsTrigger value="audio-quality" className="flex items-center gap-2">
              <AudioLines className="h-4 w-4" />
              Audio Quality
            </TabsTrigger>
            <TabsTrigger value="devices" className="flex items-center gap-2">
              <Settings className="h-4 w-4" />
              Devices
            </TabsTrigger>
            <TabsTrigger value="video" className="flex items-center gap-2">
              <Eye className="h-4 w-4" />
              Video
            </TabsTrigger>
            <TabsTrigger value="sip" className="flex items-center gap-2">
              <Phone className="h-4 w-4" />
              SIP
            </TabsTrigger>
            <TabsTrigger value="notifications" className="flex items-center gap-2">
              <Bell className="h-4 w-4" />
              Notifications
            </TabsTrigger>
            <TabsTrigger value="advanced" className="flex items-center gap-2">
              <Database className="h-4 w-4" />
              Advanced
            </TabsTrigger>
            <TabsTrigger value="logs" className="flex items-center gap-2">
              <Activity className="h-4 w-4" />
              Logs
            </TabsTrigger>
            <TabsTrigger value="about" className="flex items-center gap-2">
              <Info className="h-4 w-4" />
              About
            </TabsTrigger>
          </TabsList>

          <TabsContent value="audio-quality" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Audio Quality Settings</CardTitle>
                <CardDescription>
                  Configure audio processing and network optimization
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <Label>Sample Rate</Label>
                    <Select value={settings.audioQuality.sampleRate.toString()} onValueChange={value => updateAudioQuality({
                    sampleRate: parseInt(value) as 16000 | 32000 | 48000
                  })}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="16000">16 kHz (Low bandwidth)</SelectItem>
                        <SelectItem value="32000">32 kHz (Medium quality)</SelectItem>
                        <SelectItem value="48000">48 kHz (High quality)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>Network Quality</Label>
                    <Select value={settings.audioQuality.networkQuality} onValueChange={value => updateAudioQuality({
                    networkQuality: value as 'high' | 'medium' | 'low'
                  })}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="high">High (Best quality)</SelectItem>
                        <SelectItem value="medium">Medium (Balanced)</SelectItem>
                        <SelectItem value="low">Low (Conserve bandwidth)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>Jitter Buffer Size</Label>
                    <Select value={settings.audioQuality.jitterBufferSize} onValueChange={value => updateAudioQuality({
                    jitterBufferSize: value as 'small' | 'medium' | 'large'
                  })}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="small">Small (Low latency)</SelectItem>
                        <SelectItem value="medium">Medium (Balanced)</SelectItem>
                        <SelectItem value="large">Large (Smooth audio)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <Separator />

                <div className="space-y-4">
                  <h4 className="text-sm font-medium">Audio Processing</h4>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="noise-suppression">Noise Suppression</Label>
                      <Switch id="noise-suppression" checked={settings.audioQuality.noiseSuppression} onCheckedChange={checked => updateAudioQuality({
                      noiseSuppression: checked
                    })} />
                    </div>
                    <div className="flex items-center justify-between">
                      <Label htmlFor="echo-cancellation">Echo Cancellation</Label>
                      <Switch id="echo-cancellation" checked={settings.audioQuality.echoCancellation} onCheckedChange={checked => updateAudioQuality({
                      echoCancellation: checked
                    })} />
                    </div>
                    <div className="flex items-center justify-between">
                      <Label htmlFor="auto-gain-control">Auto Gain Control</Label>
                      <Switch id="auto-gain-control" checked={settings.audioQuality.autoGainControl} onCheckedChange={checked => updateAudioQuality({
                      autoGainControl: checked
                    })} />
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="devices" className="space-y-4">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Mic className="h-5 w-5" />
                    Input Devices
                  </CardTitle>
                  <CardDescription>Select and test your microphone</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label>Microphone</Label>
                    <Select value={settings.audioDevices.inputDeviceId || 'default'} onValueChange={value => updateAudioDevices({
                    inputDeviceId: value === 'default' ? null : value
                  })}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="default">System Default</SelectItem>
                        {inputDevices.map(device => <SelectItem key={device.deviceId} value={device.deviceId}>
                            {device.label}
                          </SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>Input Volume: {settings.audioDevices.inputVolume}%</Label>
                    <Slider value={[settings.audioDevices.inputVolume]} onValueChange={([value]) => updateAudioDevices({
                    inputVolume: value
                  })} max={100} step={5} className="w-full" />
                  </div>

                  {settings.audioDevices.inputDeviceId && <Button onClick={() => testDevice(settings.audioDevices.inputDeviceId!, 'audioinput')} disabled={testingDevice === settings.audioDevices.inputDeviceId} variant="outline" size="sm" className="w-full">
                      {testingDevice === settings.audioDevices.inputDeviceId ? 'Testing...' : 'Test Microphone'}
                    </Button>}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Volume2 className="h-5 w-5" />
                    Output Devices
                  </CardTitle>
                  <CardDescription>Select and test your speakers</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label>Speakers</Label>
                    <Select value={settings.audioDevices.outputDeviceId || 'default'} onValueChange={value => updateAudioDevices({
                    outputDeviceId: value === 'default' ? null : value
                  })}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="default">System Default</SelectItem>
                        {outputDevices.map(device => <SelectItem key={device.deviceId} value={device.deviceId}>
                            {device.label}
                          </SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>Output Volume: {settings.audioDevices.outputVolume}%</Label>
                    <Slider value={[settings.audioDevices.outputVolume]} onValueChange={([value]) => updateAudioDevices({
                    outputVolume: value
                  })} max={100} step={5} className="w-full" />
                  </div>

                  {settings.audioDevices.outputDeviceId && <Button onClick={() => testDevice(settings.audioDevices.outputDeviceId!, 'audiooutput')} disabled={testingDevice === settings.audioDevices.outputDeviceId} variant="outline" size="sm" className="w-full">
                      {testingDevice === settings.audioDevices.outputDeviceId ? 'Testing...' : 'Test Speakers'}
                    </Button>}
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Volume2 className="h-5 w-5" />
                  Ringtone Settings
                </CardTitle>
                <CardDescription>Configure ringtone behavior and volume</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <Label htmlFor="ringtones-enabled">Enable Ringtones</Label>
                  <Switch id="ringtones-enabled" checked={settings.ringtones.enabled} onCheckedChange={checked => updateRingtoneSettings({
                  enabled: checked
                })} />
                </div>

                <div className="space-y-2">
                  <Label>Ringtone Volume: {Math.round(settings.ringtones.volume * 100)}%</Label>
                  <Slider value={[settings.ringtones.volume * 100]} onValueChange={([value]) => updateRingtoneSettings({
                  volume: value / 100
                })} max={100} step={5} className="w-full" disabled={!settings.ringtones.enabled} />
                </div>

                
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="video" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Video Settings</CardTitle>
                <CardDescription>
                  Configure video preferences and devices for video calls
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <Label>Camera Device</Label>
                    <Select 
                      value={settings.video.cameraDeviceId || 'default'} 
                      onValueChange={value => updateVideoSettings({
                        cameraDeviceId: value === 'default' ? null : value
                      })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="default">Default Camera</SelectItem>
                        {videoDevices.map(device => (
                          <SelectItem key={device.deviceId} value={device.deviceId}>
                            {device.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>Video Resolution</Label>
                    <Select 
                      value={settings.video.resolution} 
                      onValueChange={value => updateVideoSettings({
                        resolution: value as '480p' | '720p' | '1080p'
                      })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="480p">480p (Standard)</SelectItem>
                        <SelectItem value="720p">720p (HD)</SelectItem>
                        <SelectItem value="1080p">1080p (Full HD)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>Frame Rate: {settings.video.frameRate} FPS</Label>
                    <Slider 
                      value={[settings.video.frameRate]} 
                      onValueChange={([value]) => updateVideoSettings({
                        frameRate: value
                      })} 
                      min={15} 
                      max={60} 
                      step={5} 
                      className="w-full" 
                    />
                  </div>
                </div>

                <Separator />

                <div className="space-y-4">
                  <h4 className="text-sm font-medium">Video Preferences</h4>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="start-with-video">Start calls with video</Label>
                      <Switch 
                        id="start-with-video" 
                        checked={settings.video.startWithVideo} 
                        onCheckedChange={checked => updateVideoSettings({
                          startWithVideo: checked
                        })} 
                      />
                    </div>
                    <div className="flex items-center justify-between">
                      <Label htmlFor="mirror-local">Mirror self view</Label>
                      <Switch 
                        id="mirror-local" 
                        checked={settings.video.mirrorLocal} 
                        onCheckedChange={checked => updateVideoSettings({
                          mirrorLocal: checked
                        })} 
                      />
                    </div>
                    <div className="flex items-center justify-between">
                      <Label htmlFor="allow-screen-share">Allow screen sharing</Label>
                      <Switch 
                        id="allow-screen-share" 
                        checked={settings.video.allowScreenShare} 
                        onCheckedChange={checked => updateVideoSettings({
                          allowScreenShare: checked
                        })} 
                      />
                    </div>
                  </div>
                </div>

                <Separator />

                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-medium">Camera Testing</h4>
                    <Button
                      onClick={loadVideoDevices}
                      variant="ghost"
                      size="sm"
                      className="h-8 px-2 text-xs"
                    >
                      <RefreshCw className="h-3 w-3 mr-1" />
                      Refresh
                    </Button>
                  </div>
                  
                  <div className="space-y-4">
                    <Button 
                      onClick={() => testVideoDevice(settings.video.cameraDeviceId || 'default')} 
                      disabled={testingVideoDevice !== null} 
                      variant="outline" 
                      size="sm" 
                      className="w-full"
                    >
                      {testingVideoDevice ? 'Testing Camera...' : 'Test Camera'}
                    </Button>
                    
                    {videoTestStream ? (
                      <div className="relative">
                        <video
                          ref={videoTestRef}
                          autoPlay
                          playsInline
                          muted
                          className="w-full h-48 bg-muted rounded-lg object-cover"
                        />
                        <Button
                          onClick={stopVideoTest}
                          variant="destructive"
                          size="sm"
                          className="absolute top-2 right-2"
                        >
                          Stop Test
                        </Button>
                      </div>
                    ) : videoDevices.length === 0 ? (
                      <div className="p-4 bg-muted/50 rounded-lg text-center">
                        <p className="text-sm text-muted-foreground mb-2">
                          No cameras detected
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Click "Test Camera" to request camera permissions
                        </p>
                      </div>
                    ) : null}
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="sip" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Phone className="h-5 w-5" />
                  SIP Account Configuration
                </CardTitle>
                <CardDescription>
                  Configure your credentials
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <Label htmlFor="sip-username">SIP Username</Label>
                    <Input
                      id="sip-username"
                      type="text"
                      placeholder="e.g., 16331*201"
                      value={tempSipSettings.username}
                      onChange={(e) => setTempSipSettings(prev => ({ ...prev, username: e.target.value }))}
                    />
                    <p className="text-xs text-muted-foreground">
                      Enter your SIP username
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="sip-password">SIP Password</Label>
                    <div className="relative">
                      <Input
                        id="sip-password"
                        type={showPassword ? "text" : "password"}
                        placeholder="Enter your SIP password"
                        value={tempSipSettings.password}
                        onChange={(e) => setTempSipSettings(prev => ({ ...prev, password: e.target.value }))}
                        className="pr-10"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
                        onClick={() => setShowPassword(!showPassword)}
                      >
                        {showPassword ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Your SIP account password
                    </p>
                  </div>
                </div>


                <div className="flex gap-3">
                  <Button 
                    onClick={() => {
                      updateSipSettings(tempSipSettings);
                      toast({
                        title: "SIP Settings Saved",
                        description: "Your SIP credentials have been saved successfully"
                      });
                    }}
                    disabled={!tempSipSettings.username || !tempSipSettings.password}
                  >
                    Save Credentials
                  </Button>
                  
                  {callState.registered ? (
                    <Button 
                      variant="outline"
                      onClick={unregisterSipAccount}
                    >
                      Unregister
                    </Button>
                  ) : (
                    <Button 
                      variant="outline"
                      onClick={() => {
                        if (settings.sip.username && settings.sip.password) {
                          registerNow();
                        } else {
                          toast({
                            title: "No Credentials",
                            description: "Please save your SIP credentials first",
                            variant: "destructive"
                          });
                        }
                      }}
                      disabled={!settings.sip.username || !settings.sip.password || callState.sipStatus.includes('Registering')}
                    >
                      {callState.sipStatus.includes('Registering') ? 'Registering...' : 'Register Now'}
                    </Button>
                  )}
                </div>

                <Separator />

                <div className="space-y-2">
                  <Label className="text-sm font-medium">Connection Status</Label>
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${
                      callState.registered ? 'bg-green-500' : 'bg-red-500'
                    }`} />
                    <span className="text-sm text-muted-foreground">
                      {callState.sipStatus}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="notifications" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Bell className="h-5 w-5" />
                  Desktop Notifications
                </CardTitle>
                <CardDescription>
                  Configure desktop notifications for calls and app events
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="space-y-1">
                      <Label htmlFor="notifications-enabled">Enable Desktop Notifications</Label>
                      <p className="text-xs text-muted-foreground">
                        Show system notifications when the app is minimized or in background
                      </p>
                    </div>
                    <Switch 
                      id="notifications-enabled" 
                      checked={settings.notifications.enabled} 
                      onCheckedChange={checked => updateNotificationSettings({
                        enabled: checked
                      })} 
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="space-y-1">
                      <Label htmlFor="ask-on-startup">Ask for Permission on Startup</Label>
                      <p className="text-xs text-muted-foreground">
                        Request notification permission when the app starts (if not already granted)
                      </p>
                    </div>
                    <Switch 
                      id="ask-on-startup" 
                      checked={settings.notifications.askOnStartup} 
                      onCheckedChange={checked => updateNotificationSettings({
                        askOnStartup: checked
                      })} 
                      disabled={!settings.notifications.enabled}
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="space-y-1">
                      <Label htmlFor="show-preview">Show Caller Information</Label>
                      <p className="text-xs text-muted-foreground">
                        Display caller name/number in notification preview text
                      </p>
                    </div>
                    <Switch 
                      id="show-preview" 
                      checked={settings.notifications.showPreviewText} 
                      onCheckedChange={checked => updateNotificationSettings({
                        showPreviewText: checked
                      })} 
                      disabled={!settings.notifications.enabled}
                    />
                  </div>
                </div>

                <Separator />

                <div className="space-y-4">
                  <h4 className="text-sm font-medium">Notification Status</h4>
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <div className={`w-2 h-2 rounded-full ${
                        notificationManager.getPermission() === 'granted' ? 'bg-green-500' : 
                        notificationManager.getPermission() === 'denied' ? 'bg-red-500' : 'bg-yellow-500'
                      }`} />
                      <span className="text-sm text-muted-foreground">
                        Browser Permission: {notificationManager.getPermission()}
                      </span>
                    </div>
                    
                    {notificationManager.getPermission() === 'denied' && (
                      <p className="text-xs text-call-warning">
                        Notifications are blocked. Please enable them in your browser settings.
                      </p>
                    )}
                    
                    {notificationManager.getPermission() === 'default' && (
                      <Button 
                        onClick={async () => {
                          const permission = await notificationManager.requestPermission();
                          if (permission === 'granted') {
                            toast({
                              title: "Notifications Enabled",
                              description: "Desktop notifications are now allowed"
                            });
                          } else {
                            toast({
                              title: "Permission Denied",
                              description: "Desktop notifications were not allowed",
                              variant: "destructive"
                            });
                          }
                        }}
                        variant="outline"
                        size="sm"
                      >
                        Request Permission
                      </Button>
                    )}
                  </div>
                </div>

                <Separator />

                <div className="space-y-2">
                  <Label>Test Notifications</Label>
                  <Button 
                    onClick={() => {
                      const notification = notificationManager.showTest();
                      if (notification) {
                        toast({
                          title: "Test Notification Sent",
                          description: "Check your system notifications"
                        });
                      } else {
                        toast({
                          title: "Cannot Send Notification",
                          description: "Please enable notifications first",
                          variant: "destructive"
                        });
                      }
                    }}
                    variant="outline"
                    size="sm"
                    disabled={!settings.notifications.enabled || notificationManager.getPermission() !== 'granted'}
                  >
                    Send Test Notification
                  </Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="advanced" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Advanced Settings</CardTitle>
                <CardDescription>Import, export, and reset your settings</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  <Button onClick={handleExportSettings} variant="outline">
                    <Download className="h-4 w-4 mr-2" />
                    Export Settings
                  </Button>
                  
                  <Button asChild variant="outline">
                    <label>
                      <Upload className="h-4 w-4 mr-2" />
                      Import Settings
                      <input type="file" accept=".json" onChange={handleImportSettings} className="hidden" />
                    </label>
                  </Button>

                  <Button onClick={resetToDefaults} variant="outline" className="text-call-danger hover:text-call-danger-foreground hover:bg-call-danger">
                    <RotateCcw className="h-4 w-4 mr-2" />
                    Reset to Defaults
                  </Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="logs" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Application Logs</CardTitle>
                <CardDescription>View and manage application logs for debugging</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap gap-2 items-center">
                  <div className="flex items-center gap-2">
                    <Search className="h-4 w-4" />
                    <Input placeholder="Search logs..." value={logSearch} onChange={e => setLogSearch(e.target.value)} className="w-48" />
                  </div>

                  <Select value={logLevelFilter} onValueChange={value => setLogLevelFilter(value as LogLevel | 'all')}>
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Levels</SelectItem>
                      <SelectItem value="debug">Debug</SelectItem>
                      <SelectItem value="info">Info</SelectItem>
                      <SelectItem value="warn">Warning</SelectItem>
                      <SelectItem value="error">Error</SelectItem>
                    </SelectContent>
                  </Select>

                  <div className="flex items-center gap-2">
                    <Label htmlFor="auto-scroll">Auto-scroll</Label>
                    <Switch id="auto-scroll" checked={settings.logs.autoScroll} onCheckedChange={checked => updateLogSettings({
                    autoScroll: checked
                  })} />
                  </div>

                  <Button onClick={() => exportLogs('text')} variant="outline" size="sm">
                    Export Text
                  </Button>
                  
                  <Button onClick={() => exportLogs('json')} variant="outline" size="sm">
                    Export JSON
                  </Button>

                  <Button onClick={() => {
                  logger.clearLogs();
                  setLogs([]);
                }} variant="outline" size="sm" className="text-call-danger hover:text-call-danger-foreground hover:bg-call-danger">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>

                <ScrollArea className="h-96 w-full border rounded-md p-4">
                  <div className="space-y-2 font-mono text-sm">
                    {filteredLogs.map(log => <div key={log.id} className="flex items-start gap-2 py-1">
                        <Badge variant="outline" className={`text-xs ${getLevelColor(log.level)}`}>
                          {log.level.toUpperCase()}
                        </Badge>
                        <span className="text-muted-foreground text-xs">
                          {log.timestamp.toLocaleTimeString()}
                        </span>
                        {log.source && <Badge variant="secondary" className="text-xs">
                            {log.source}
                          </Badge>}
                        <span className="flex-1">{log.message}</span>
                      </div>)}
                    <div ref={logsEndRef} />
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="about" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>About VoiceHost Limited</CardTitle>
                <CardDescription>Application information and details</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-4">
                  <div>
                    <h4 className="text-sm font-medium text-foreground mb-2">Application Details</h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                      <div>
                        <span className="text-muted-foreground">Version:</span>
                        <span className="ml-2 font-mono">1.0.0</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Build:</span>
                        <span className="ml-2 font-mono">2024.01.15</span>
                      </div>
                    </div>
                  </div>

                  <Separator />

                  <div>
                    <h4 className="text-sm font-medium text-foreground mb-2">Support</h4>
                    <div className="text-sm text-muted-foreground space-y-2">
                      <p>For technical support and assistance, please contact our support team:</p>
                      <div className="space-y-1">
                        <div>
                          <span className="text-foreground">Email:</span>
                          <span className="ml-2">support@voicehost.co.uk</span>
                        </div>
                        <div>
                          <span className="text-foreground">Phone:</span>
                          <span className="ml-2">0800 2 545454</span>
                        </div>
                        <div>
                          <span className="text-foreground">Website:</span>
                          <span className="ml-2">www.voicehost.co.uk</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  <Separator />

                  <div>
                    <h4 className="text-sm font-medium text-foreground mb-2">Legal & Licenses</h4>
                    <div className="text-xs text-muted-foreground space-y-2">
                      <p>© 2024 VoiceHost Limited. All rights reserved.</p>
                      <p>This software is licensed under the MIT License.</p>
                      
                      <div className="pt-2">
                        <h5 className="text-xs font-medium text-foreground mb-1">Third Party Licenses:</h5>
                        <ul className="space-y-1 pl-2">
                          <li>• React (MIT License) - Meta Platforms, Inc.</li>
                          <li>• TypeScript (Apache 2.0) - Microsoft Corporation</li>
                          <li>• Tailwind CSS (MIT License) - Tailwind Labs Inc.</li>
                          <li>• Radix UI (MIT License) - WorkOS</li>
                          <li>• Lucide React (ISC License) - Lucide Contributors</li>
                          <li>• Vite (MIT License) - Evan You</li>
                          <li>• React Router (MIT License) - Remix Software Inc.</li>
                          <li>• Class Variance Authority (Apache 2.0) - Joe Bell</li>
                          <li>• Janus WebRTC Gateway (GPL v3/Commercial) - Meetecho</li>
                          <li>• WebRTC (BSD 3-Clause) - Google Inc.</li>
                        </ul>
                      </div>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>;
};
export default SettingsPage;
