import AVFAudio
import Flutter
import PushKit
import UIKit
import WebRTC
import flutter_callkit_incoming

@main
@objc class AppDelegate: FlutterAppDelegate, PKPushRegistryDelegate, CallkitIncomingAppDelegate {
    private var voipRegistry: PKPushRegistry?

    override func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        GeneratedPluginRegistrant.register(with: self)

        // CallKit owns AVAudioSession activation for incoming VoIP calls.
        // Keep WebRTC audio manual until CallKit activates the session.
        let rtcAudioSession = RTCAudioSession.sharedInstance()
        rtcAudioSession.useManualAudio = true
        rtcAudioSession.isAudioEnabled = false

        let registry = PKPushRegistry(queue: .main)
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
        voipRegistry = registry

        return super.application(application, didFinishLaunchingWithOptions: launchOptions)
    }

    func pushRegistry(
        _ registry: PKPushRegistry,
        didUpdate credentials: PKPushCredentials,
        for type: PKPushType
    ) {
        guard type == .voIP else { return }
        let token = credentials.token.map { String(format: "%02x", $0) }.joined()
        print("[VoiceHost PushKit] token=\(token)")
        SwiftFlutterCallkitIncomingPlugin.sharedInstance?.setDevicePushTokenVoIP(token)
    }

    func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        guard type == .voIP else { return }
        SwiftFlutterCallkitIncomingPlugin.sharedInstance?.setDevicePushTokenVoIP("")
    }

    // flutter_callkit_incoming sends the Dart event first, then invokes these
    // delegate callbacks. Fulfil CallKit actions here; media setup remains in Dart.
    func onAccept(_ call: Call, _ action: CXAnswerCallAction) {
        print("[VoiceHost CallKit] answer accepted \(call.uuid)")
        action.fulfill()
    }

    func onDecline(_ call: Call, _ action: CXEndCallAction) {
        print("[VoiceHost CallKit] call declined \(call.uuid)")
        action.fulfill()
    }

    func onEnd(_ call: Call, _ action: CXEndCallAction) {
        print("[VoiceHost CallKit] call ended \(call.uuid)")
        action.fulfill()
    }

    func onTimeOut(_ call: Call) {
        print("[VoiceHost CallKit] call timed out \(call.uuid)")
    }

    func didActivateAudioSession(_ audioSession: AVAudioSession) {
        let rtcAudioSession = RTCAudioSession.sharedInstance()
        rtcAudioSession.audioSessionDidActivate(audioSession)
        rtcAudioSession.isAudioEnabled = true
        print("[VoiceHost CallKit] WebRTC audio session activated")
    }

    func didDeactivateAudioSession(_ audioSession: AVAudioSession) {
        let rtcAudioSession = RTCAudioSession.sharedInstance()
        rtcAudioSession.audioSessionDidDeactivate(audioSession)
        rtcAudioSession.isAudioEnabled = false
        print("[VoiceHost CallKit] WebRTC audio session deactivated")
    }

    func providerDidReset() {
        print("[VoiceHost CallKit] provider reset")
    }

    func pushRegistry(
        _ registry: PKPushRegistry,
        didReceiveIncomingPushWith payload: PKPushPayload,
        for type: PKPushType,
        completion: @escaping () -> Void
    ) {
        guard type == .voIP else {
            completion()
            return
        }

        let body = payload.dictionaryPayload
        let id = body["id"] as? String ?? UUID().uuidString
        let caller = body["handle"] as? String ?? "Unknown"
        let callerName = body["nameCaller"] as? String ?? caller

        let data = flutter_callkit_incoming.Data(
            id: id,
            nameCaller: callerName,
            handle: caller,
            type: 0
        )
        data.extra = ["call_id": id, "source": "voicehost-mobile-gateway"]
        data.duration = 45_000
        data.supportsHolding = true
        data.supportsDTMF = true
        data.supportsGrouping = false
        data.supportsUngrouping = false

        SwiftFlutterCallkitIncomingPlugin.sharedInstance?.showCallkitIncoming(
            data,
            fromPushKit: true
        ) {
            completion()
        }
    }
}
