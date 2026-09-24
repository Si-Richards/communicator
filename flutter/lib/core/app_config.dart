class AppConfig {
  static const defaultJanusUrl = 'wss://devrtc.voicehost.io:443';
  static const defaultSipRealm = 'hpbx.sipconvergence.co.uk';
  static const janusSipPlugin = 'janus.plugin.sip';
  static const userAgent = 'VoiceHost Flutter/0.3.0';

  // Set at build/run time, e.g.
  // --dart-define=VOICEHOST_GATEWAY_URL=https://mobile-dev.voicehost.io
  // --dart-define=VOICEHOST_GATEWAY_KEY=<development key>
  static const mobileGatewayUrl = String.fromEnvironment(
    'VOICEHOST_GATEWAY_URL',
    defaultValue: '',
  );
  static const mobileGatewayKey = String.fromEnvironment(
    'VOICEHOST_GATEWAY_KEY',
    defaultValue: '',
  );

  static const stunUrl = String.fromEnvironment(
    'VOICEHOST_STUN_URL',
    defaultValue: 'stun:stun.voicehost.co.uk:3478',
  );

  static const turnUrl = String.fromEnvironment(
    'VOICEHOST_TURN_URL',
    defaultValue: '',
  );
  static const turnUsername = String.fromEnvironment(
    'VOICEHOST_TURN_USERNAME',
    defaultValue: '',
  );
  static const turnCredential = String.fromEnvironment(
    'VOICEHOST_TURN_CREDENTIAL',
    defaultValue: '',
  );

  static const iceTransportPolicy = String.fromEnvironment(
    'VOICEHOST_ICE_TRANSPORT_POLICY',
    defaultValue: 'all',
  );
}
