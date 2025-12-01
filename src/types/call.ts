// Call types for multi-handle call waiting system

export interface Call {
  id: string;
  handleId: string;
  status: 'idle' | 'calling' | 'ringing' | 'incall' | 'held' | 'incoming';
  direction: 'incoming' | 'outgoing';
  phoneNumber: string;
  callerId?: string;
  startTime?: Date;
  remoteJsep?: any;
  remoteStream?: MediaStream;
  localStream?: MediaStream;
  isOnHold: boolean;
}

export interface CallsState {
  calls: Call[];
  activeCallId?: string;
  waitingCall?: {
    id: string;
    phoneNumber: string;
    callerId?: string;
    remoteJsep?: any;
  };
  registered: boolean;
  sipStatus: string;
  doNotDisturb: boolean;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  multiCallSupported: boolean;
}

export interface DialogInfo {
  callId?: string;
  fromTag?: string;
  toTag?: string;
  remoteUri?: string;
}

export interface SipHandle {
  id: string;
  plugin: any;
  registered: boolean;
}