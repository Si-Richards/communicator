// Janus WebRTC Gateway TypeScript declarations
declare global {
  interface Window {
    Janus: JanusStatic;
  }
}

interface JanusStatic {
  init(options: JanusInitOptions): void;
  new (options: JanusOptions): JanusInstance;
  attachMediaStream(element: HTMLMediaElement, stream: MediaStream): void;
  listDevices(callback: (devices: MediaDeviceInfo[]) => void): void;
  isWebrtcSupported(): boolean;
  webRTCAdapter: any;
}

interface JanusInitOptions {
  debug?: string | boolean;
  callback?: () => void;
  dependencies?: string[];
}

interface JanusOptions {
  server: string;
  apisecret?: string;
  token?: string;
  success?: () => void;
  error?: (error: any) => void;
  destroyed?: () => void;
}

interface JanusInstance {
  attach(options: JanusPluginOptions): void;
  destroy(): void;
}

interface JanusPluginOptions {
  plugin: string;
  opaqueId?: string;
  success?: (pluginHandle: JanusPluginHandle) => void;
  error?: (error: any) => void;
  consentDialog?: (on: boolean) => void;
  iceState?: (state: string) => void;
  mediaState?: (medium: string, on: boolean) => void;
  webrtcState?: (on: boolean) => void;
  onmessage?: (msg: any, jsep?: any) => void;
  onlocaltrack?: (track: MediaStreamTrack, on: boolean) => void;
  onremotetrack?: (track: MediaStreamTrack, mindex: number, on: boolean) => void;
  oncleanup?: () => void;
  detached?: () => void;
}

interface JanusPluginHandle {
  send(options: JanusSendOptions): void;
  createOffer(options: JanusOfferOptions): void;
  createAnswer(options: JanusAnswerOptions): void;
  handleRemoteJsep(options: { jsep: any }): void;
  hangup(sendRequest?: boolean): void;
  detach(): void;
  getId(): string;
  getPlugin(): string;
}

interface JanusSendOptions {
  message: any;
  jsep?: any;
  success?: (msg: any) => void;
  error?: (error: any) => void;
}

interface JanusOfferOptions {
  media?: {
    audioSend?: boolean;
    audioRecv?: boolean;
    videoSend?: boolean;
    videoRecv?: boolean;
    audio?: boolean | MediaTrackConstraints;
    video?: boolean | MediaTrackConstraints;
    data?: boolean;
    failIfNoAudio?: boolean;
    failIfNoVideo?: boolean;
    screenshareFrameRate?: number;
  };
  tracks?: Array<{
    type: 'audio' | 'video' | 'data';
    capture?: boolean;
    recv?: boolean;
    add?: boolean;
    remove?: boolean;
    replace?: boolean;
    group?: string;
  }>;
  trickle?: boolean;
  stream?: MediaStream;
  success?: (jsep: any) => void;
  error?: (error: any) => void;
}

interface JanusAnswerOptions {
  media?: {
    audioSend?: boolean;
    audioRecv?: boolean;
    videoSend?: boolean;
    videoRecv?: boolean;
    removeAudio?: boolean;
    removeVideo?: boolean;
    replaceAudio?: boolean;
    replaceVideo?: boolean;
  };
  tracks?: Array<{
    type: 'audio' | 'video' | 'data';
    capture?: boolean;
    recv?: boolean;
    add?: boolean;
    remove?: boolean;
    replace?: boolean;
    group?: string;
  }>;
  jsep: any;
  trickle?: boolean;
  stream?: MediaStream;
  success?: (jsep: any) => void;
  error?: (error: any) => void;
}

export {};