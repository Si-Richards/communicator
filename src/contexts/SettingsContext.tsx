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

export interface AppSettings {
  audioQuality: AudioQualitySettings;
  audioDevices: AudioDeviceSettings;
  logs: LogSettings;
  version: string;
}

interface SettingsContextType {
  settings: AppSettings;
  updateAudioQuality: (updates: Partial<AudioQualitySettings>) => void;
  updateAudioDevices: (updates: Partial<AudioDeviceSettings>) => void;
  updateLogSettings: (updates: Partial<LogSettings>) => void;
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

export const SettingsProvider: React.FC<SettingsProviderProps> = ({ children }) => {
  const [settings, setSettings] = useState<AppSettings>(() => {
    try {
      const saved = localStorage.getItem('app-settings');
      if (saved) {
        const parsed = JSON.parse(saved);
        return { ...defaultSettings, ...parsed };
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
        setSettings({ ...defaultSettings, ...imported });
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
        resetToDefaults,
        exportSettings,
        importSettings,
      }}
    >
      {children}
    </SettingsContext.Provider>
  );
};