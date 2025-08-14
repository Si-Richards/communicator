export interface AudioDevice {
  deviceId: string;
  label: string;
  kind: 'audioinput' | 'audiooutput';
  groupId: string;
}

export interface DeviceTestResult {
  success: boolean;
  error?: string;
  volume?: number;
}

class AudioDeviceManager {
  private static instance: AudioDeviceManager;
  private devices: AudioDevice[] = [];
  private onDeviceChangeCallbacks: (() => void)[] = [];

  private constructor() {
    // Listen for device changes
    navigator.mediaDevices?.addEventListener?.('devicechange', this.handleDeviceChange);
  }

  static getInstance(): AudioDeviceManager {
    if (!AudioDeviceManager.instance) {
      AudioDeviceManager.instance = new AudioDeviceManager();
    }
    return AudioDeviceManager.instance;
  }

  private handleDeviceChange = async () => {
    await this.refreshDevices();
    this.onDeviceChangeCallbacks.forEach(callback => callback());
  };

  async enumerateDevices(): Promise<AudioDevice[]> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      this.devices = devices
        .filter(device => device.kind === 'audioinput' || device.kind === 'audiooutput')
        .map(device => ({
          deviceId: device.deviceId,
          label: device.label || `${device.kind === 'audioinput' ? 'Microphone' : 'Speaker'} (${device.deviceId.slice(0, 8)})`,
          kind: device.kind as 'audioinput' | 'audiooutput',
          groupId: device.groupId,
        }));

      return this.devices;
    } catch (error) {
      console.error('Failed to enumerate devices:', error);
      return [];
    }
  }

  private async refreshDevices(): Promise<void> {
    await this.enumerateDevices();
  }

  getInputDevices(): AudioDevice[] {
    return this.devices.filter(device => device.kind === 'audioinput');
  }

  getOutputDevices(): AudioDevice[] {
    return this.devices.filter(device => device.kind === 'audiooutput');
  }

  async testInputDevice(deviceId: string): Promise<DeviceTestResult> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId } },
        video: false,
      });

      // Create audio context to analyze volume
      const audioContext = new AudioContext();
      const analyser = audioContext.createAnalyser();
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);

      analyser.fftSize = 256;
      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      // Test for 2 seconds to get average volume
      return new Promise((resolve) => {
        let samples = 0;
        let totalVolume = 0;

        const checkVolume = () => {
          analyser.getByteFrequencyData(dataArray);
          const volume = dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length;
          totalVolume += volume;
          samples++;

          if (samples >= 20) { // ~2 seconds at 10fps
            const averageVolume = Math.round((totalVolume / samples) * 100 / 255);
            
            // Clean up
            stream.getTracks().forEach(track => track.stop());
            audioContext.close();

            resolve({
              success: true,
              volume: averageVolume,
            });
          } else {
            setTimeout(checkVolume, 100);
          }
        };

        checkVolume();
      });
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async testOutputDevice(deviceId: string): Promise<DeviceTestResult> {
    try {
      // Create a test tone
      const audioContext = new AudioContext();
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);

      // Set up test tone (440Hz for 1 second)
      oscillator.frequency.value = 440;
      oscillator.type = 'sine';
      gainNode.gain.value = 0.1;

      // Try to set the output device (not all browsers support this)
      if ('setSinkId' in audioContext.destination) {
        try {
          await (audioContext.destination as any).setSinkId(deviceId);
        } catch (error) {
          console.warn('setSinkId not supported or failed:', error);
        }
      }

      oscillator.start();
      oscillator.stop(audioContext.currentTime + 1);

      return new Promise((resolve) => {
        oscillator.onended = () => {
          audioContext.close();
          resolve({ success: true });
        };
      });
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async requestPermissions(): Promise<boolean> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(track => track.stop());
      await this.enumerateDevices();
      return true;
    } catch (error) {
      console.error('Failed to request microphone permissions:', error);
      return false;
    }
  }

  onDeviceChange(callback: () => void): () => void {
    this.onDeviceChangeCallbacks.push(callback);
    
    // Return cleanup function
    return () => {
      const index = this.onDeviceChangeCallbacks.indexOf(callback);
      if (index > -1) {
        this.onDeviceChangeCallbacks.splice(index, 1);
      }
    };
  }

  async getOptimalAudioConstraints(inputDeviceId?: string): Promise<MediaStreamConstraints> {
    return {
      audio: {
        deviceId: inputDeviceId ? { exact: inputDeviceId } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: 48000,
        channelCount: 1,
      },
      video: false,
    };
  }

  isDeviceAvailable(deviceId: string): boolean {
    return this.devices.some(device => device.deviceId === deviceId);
  }

  destroy(): void {
    navigator.mediaDevices?.removeEventListener?.('devicechange', this.handleDeviceChange);
    this.onDeviceChangeCallbacks = [];
  }
}

export const audioDeviceManager = AudioDeviceManager.getInstance();