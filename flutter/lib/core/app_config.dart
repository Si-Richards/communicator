class AppConfig {
  static const defaultJanusUrl = 'wss://devrtc.voicehost.io:443';
  static const defaultSipRealm = 'hpbx.sipconvergence.co.uk';
  static const janusSipPlugin = 'janus.plugin.sip';
  static const userAgent = 'VoiceHost Flutter/0.2.0';

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
}
