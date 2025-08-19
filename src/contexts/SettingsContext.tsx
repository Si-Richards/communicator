import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';

export interface AudioQualitySettings {
  sampleRate: 16000 | 32000 | 48000;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
  jitterBufferSize: 'small' | 'medium' | 'large';
  networkQuality: 'high' | 'medium' | 'low';
}

export interface AudioDeviceSettings {
  inputDeviceId: string | null;
  outputDeviceId: string | null;
  inputVolume: number;
  outputVolume: number;
}

export interface LogSettings {
  level: 'debug' | 'info' | 'warn' | 'error';
  maxHistory: number;
  autoScroll: boolean;
}

export interface RingtoneSettings {
  enabled: boolean;
  volume: number;
}

export interface SipSettings {
  username: string;
  password: string;
  server: string;
  realm: string;
}

export interface DictationSettings {
  enabled: boolean;
  language: string;
  continuous: boolean;
  interimResults: boolean;
}

export interface VideoSettings {
  startWithVideo: boolean;
  cameraDeviceId: string | null;
  resolution: '480p' | '720p' | '1080p';
  frameRate: number;
  mirrorLocal: boolean;
  allowScreenShare: boolean;
}

export interface NotificationSettings {
  enabled: boolean;
  askOnStartup: boolean;
  showPreviewText: boolean;
}

export interface AppSettings {
  audioQuality: AudioQualitySettings;
  audioDevices: AudioDeviceSettings;
  logs: LogSettings;
  ringtones: RingtoneSettings;
  sip: SipSettings;
  dictation: DictationSettings;
  video: VideoSettings;
  notifications: NotificationSettings;
  version: string;
}

interface SettingsContextType {
  settings: AppSettings;
  updateAudioQuality: (updates: Partial<AudioQualitySettings>) => void;
  updateAudioDevices: (updates: Partial<AudioDeviceSettings>) => void;
  updateLogSettings: (updates: Partial<LogSettings>) => void;
  updateRingtoneSettings: (updates: Partial<RingtoneSettings>) => void;
  updateSipSettings: (updates: Partial<SipSettings>) => void;
  updateDictationSettings: (updates: Partial<DictationSettings>) => void;
  updateVideoSettings: (updates: Partial<VideoSettings>) => void;
  updateNotificationSettings: (updates: Partial<NotificationSettings>) => void;
  resetToDefaults: () => void;
  exportSettings: () => string;
  importSettings: (jsonString: string) => boolean;
}

const defaultSettings: AppSettings = {
  audioQuality: {
    sampleRate: 48000,
    noiseSuppression: true,
    echoCancellation: true,
    autoGainControl: true,
    jitterBufferSize: 'medium',
    networkQuality: 'high',
  },
  audioDevices: {
    inputDeviceId: null,
    outputDeviceId: null,
    inputVolume: 80,
    outputVolume: 80,
  },
  logs: {
    level: 'info',
    maxHistory: 1000,
    autoScroll: true,
  },
  ringtones: {
    enabled: true,
    volume: 0.5,
  },
    sip: {
      username: '',
      password: '',
      server: 'wss://devrtc.voicehost.io:443',
      realm: 'hpbx.sipconvergence.co.uk',
    },
  dictation: {
    enabled: true,
    language: 'en-US',
    continuous: false,
    interimResults: true,
  },
  video: {
    startWithVideo: false,
    cameraDeviceId: null,
    resolution: '720p',
    frameRate: 30,
    mirrorLocal: true,
    allowScreenShare: true,
  },
  notifications: {
    enabled: true,
    askOnStartup: true,
    showPreviewText: true,
  },
  version: '1.0.0',
};

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

export const useSettings = () => {
  const context = useContext(SettingsContext);
  if (!context) {
    throw new Error('useSettings must be used within a SettingsProvider');
  }
  return context;
};

interface SettingsProviderProps {
  children: ReactNode;
}

// Deep merge utility function
const deepMerge = (target: any, source: any): any => {
  const result = { ...target };
  
  for (const key in source) {
    if (source.hasOwnProperty(key)) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        result[key] = deepMerge(target[key] || {}, source[key]);
      } else {
        result[key] = source[key];
      }
    }
  }
  
  return result;
};

export const SettingsProvider: React.FC<SettingsProviderProps> = ({ children }) => {
  const [settings, setSettings] = useState<AppSettings>(() => {
    try {
      const saved = localStorage.getItem('app-settings');
      if (saved) {
        const parsed = JSON.parse(saved);
        return deepMerge(defaultSettings, parsed);
      }
    } catch (error) {
      console.warn('Failed to load settings from localStorage:', error);
    }
    return defaultSettings;
  });

  useEffect(() => {
    try {
      localStorage.setItem('app-settings', JSON.stringify(settings));
    } catch (error) {
      console.warn('Failed to save settings to localStorage:', error);
    }
  }, [settings]);

  const updateAudioQuality = (updates: Partial<AudioQualitySettings>) => {
    setSettings(prev => ({
      ...prev,
      audioQuality: { ...prev.audioQuality, ...updates },
    }));
  };

  const updateAudioDevices = (updates: Partial<AudioDeviceSettings>) => {
    setSettings(prev => ({
      ...prev,
      audioDevices: { ...prev.audioDevices, ...updates },
    }));
  };

  const updateLogSettings = (updates: Partial<LogSettings>) => {
    setSettings(prev => ({
      ...prev,
      logs: { ...prev.logs, ...updates },
    }));
  };

  const updateRingtoneSettings = (updates: Partial<RingtoneSettings>) => {
    setSettings(prev => ({
      ...prev,
      ringtones: { ...prev.ringtones, ...updates },
    }));
  };

  const updateSipSettings = (updates: Partial<SipSettings>) => {
    setSettings(prev => ({
      ...prev,
      sip: { ...prev.sip, ...updates },
    }));
  };

  const updateDictationSettings = (updates: Partial<DictationSettings>) => {
    setSettings(prev => ({
      ...prev,
      dictation: { ...prev.dictation, ...updates },
    }));
  };

  const updateVideoSettings = (updates: Partial<VideoSettings>) => {
    setSettings(prev => ({
      ...prev,
      video: { ...prev.video, ...updates },
    }));
  };

  const updateNotificationSettings = (updates: Partial<NotificationSettings>) => {
    setSettings(prev => ({
      ...prev,
      notifications: { ...prev.notifications, ...updates },
    }));
  };

  const resetToDefaults = () => {
    setSettings(defaultSettings);
  };

  const exportSettings = () => {
    return JSON.stringify(settings, null, 2);
  };

  const importSettings = (jsonString: string): boolean => {
    try {
      const imported = JSON.parse(jsonString);
      if (imported && typeof imported === 'object') {
        setSettings(deepMerge(defaultSettings, imported));
        return true;
      }
    } catch (error) {
      console.error('Failed to import settings:', error);
    }
    return false;
  };

  return (
    <SettingsContext.Provider
      value={{
        settings,
        updateAudioQuality,
        updateAudioDevices,
        updateLogSettings,
        updateRingtoneSettings,
        updateSipSettings,
        updateDictationSettings,
        updateVideoSettings,
        updateNotificationSettings,
        resetToDefaults,
        exportSettings,
        importSettings,
      }}
    >
      {children}
    </SettingsContext.Provider>
  );
};