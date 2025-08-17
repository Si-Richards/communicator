export interface VideoDevice {
  deviceId: string;
  label: string;
  kind: 'videoinput';
  groupId: string;
}

export interface VideoDeviceTestResult {
  success: boolean;
  error?: string;
}

class VideoDeviceManager {
  private static instance: VideoDeviceManager;
  private devices: VideoDevice[] = [];
  private onDeviceChangeCallbacks: (() => void)[] = [];

  private constructor() {
    // Listen for device changes
    navigator.mediaDevices?.addEventListener?.('devicechange', this.handleDeviceChange);
  }

  static getInstance(): VideoDeviceManager {
    if (!VideoDeviceManager.instance) {
      VideoDeviceManager.instance = new VideoDeviceManager();
    }
    return VideoDeviceManager.instance;
  }

  private handleDeviceChange = async () => {
    await this.refreshDevices();
    this.onDeviceChangeCallbacks.forEach(callback => callback());
  };

  async enumerateDevices(): Promise<VideoDevice[]> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      this.devices = devices
        .filter(device => device.kind === 'videoinput')
        .map(device => ({
          deviceId: device.deviceId,
          label: device.label || `Camera (${device.deviceId.slice(0, 8)})`,
          kind: device.kind as 'videoinput',
          groupId: device.groupId,
        }));

      return this.devices;
    } catch (error) {
      console.error('Failed to enumerate video devices:', error);
      return [];
    }
  }

  private async refreshDevices(): Promise<void> {
    await this.enumerateDevices();
  }

  getVideoDevices(): VideoDevice[] {
    return this.devices;
  }

  async testVideoDevice(deviceId: string): Promise<VideoDeviceTestResult> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: deviceId } },
        audio: false,
      });

      // Test by creating a video element and checking if it can play
      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      
      return new Promise((resolve) => {
        video.onloadedmetadata = () => {
          // Clean up
          stream.getTracks().forEach(track => track.stop());
          resolve({ success: true });
        };

        video.onerror = () => {
          stream.getTracks().forEach(track => track.stop());
          resolve({
            success: false,
            error: 'Failed to load video stream',
          });
        };

        // Timeout after 5 seconds
        setTimeout(() => {
          stream.getTracks().forEach(track => track.stop());
          resolve({
            success: false,
            error: 'Device test timeout',
          });
        }, 5000);
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
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      stream.getTracks().forEach(track => track.stop());
      await this.enumerateDevices();
      return true;
    } catch (error) {
      console.error('Failed to request camera permissions:', error);
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

  async getOptimalVideoConstraints(videoDeviceId?: string, resolution: string = '720p'): Promise<MediaStreamConstraints> {
    const videoConstraints: MediaTrackConstraints = {
      deviceId: videoDeviceId ? { exact: videoDeviceId } : undefined,
    };

    // Set resolution based on preference
    switch (resolution) {
      case '480p':
        videoConstraints.width = { ideal: 640 };
        videoConstraints.height = { ideal: 480 };
        break;
      case '720p':
        videoConstraints.width = { ideal: 1280 };
        videoConstraints.height = { ideal: 720 };
        break;
      case '1080p':
        videoConstraints.width = { ideal: 1920 };
        videoConstraints.height = { ideal: 1080 };
        break;
      default:
        videoConstraints.width = { ideal: 1280 };
        videoConstraints.height = { ideal: 720 };
    }

    return {
      video: videoConstraints,
      audio: false,
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

export const videoDeviceManager = VideoDeviceManager.getInstance();