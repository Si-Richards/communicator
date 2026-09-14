import Foundation

enum AppConfig {
    static let defaultJanusURL = URL(string: "wss://devrtc.voicehost.io:443")!
    static let defaultSIPRealm = "hpbx.sipconvergence.co.uk"
    static let userAgent = "VoiceHost-iOS/0.1"

    /// The existing web client currently uses a Janus API secret. Do not hard-code
    /// a production secret into an iOS application. For development this value is
    /// entered at runtime and should later be replaced by short-lived backend-issued
    /// credentials or another server-side access-control mechanism.
    static let janusPlugin = "janus.plugin.sip"
}
