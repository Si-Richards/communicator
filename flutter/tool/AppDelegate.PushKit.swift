import AVFAudio
import CallKit
import Flutter
import PushKit
import UIKit
import WebRTC
import flutter_callkit_incoming

@main
@objc class AppDelegate: FlutterAppDelegate, PKPushRegistryDelegate, CallkitIncomingAppDelegate {
    private var voipRegistry: PKPushRegistry?
    private var ringbackPlayer: AVAudioPlayer?
    private var audioChannel: FlutterMethodChannel?

    override func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        GeneratedPluginRegistrant.register(with: self)

        if let controller = window?.rootViewController as? FlutterViewController {
            let channel = FlutterMethodChannel(
                name: "voicehost/audio",
                binaryMessenger: controller.binaryMessenger
            )
            channel.setMethodCallHandler { [weak self] call, result in
                switch call.method {
                case "startRingback":
                    self?.startRingback()
                    result(nil)
                case "stopRingback":
                    self?.stopRingback()
                    result(nil)
                default:
                    result(FlutterMethodNotImplemented)
                }
            }
            audioChannel = channel
        }

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
        print("[VoiceHost PushKit] VoIP token ready (\(credentials.token.count) bytes)")
        SwiftFlutterCallkitIncomingPlugin.sharedInstance?.setDevicePushTokenVoIP(token)
    }

    func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        guard type == .voIP else { return }
        SwiftFlutterCallkitIncomingPlugin.sharedInstance?.setDevicePushTokenVoIP("")
    }

    // flutter_callkit_incoming sends the Dart event first, then invokes these
    // delegate callbacks. Fulfil CallKit actions here; media setup remains in Dart.
    func onAccept(_ call: Call, _ action: CXAnswerCallAction) {
        stopRingback()
        print("[VoiceHost CallKit] answer accepted")
        action.fulfill()
    }

    func onDecline(_ call: Call, _ action: CXEndCallAction) {
        stopRingback()
        print("[VoiceHost CallKit] call declined")
        action.fulfill()
    }

    func onEnd(_ call: Call, _ action: CXEndCallAction) {
        stopRingback()
        print("[VoiceHost CallKit] call ended")
        action.fulfill()
    }

    func onTimeOut(_ call: Call) {
        print("[VoiceHost CallKit] call timed out")
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


    private func startRingback() {
        if ringbackPlayer?.isPlaying == true { return }

        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth])
            try session.setActive(true)

            let player = try AVAudioPlayer(data: makeUKRingbackWav())
            player.numberOfLoops = -1
            player.volume = 0.32
            player.prepareToPlay()
            player.play()
            ringbackPlayer = player
            print("[VoiceHost Audio] local ringback started")
        } catch {
            ringbackPlayer = nil
            print("[VoiceHost Audio] local ringback failed")
        }
    }

    private func stopRingback() {
        guard let player = ringbackPlayer else { return }
        player.stop()
        ringbackPlayer = nil
        print("[VoiceHost Audio] local ringback stopped")
    }

    private func makeUKRingbackWav() -> Data {
        // UK ringback cadence: 400 ms tone, 200 ms silence,
        // 400 ms tone, 2 s silence. The tone combines 400 Hz + 450 Hz.
        let sampleRate = 16_000
        let duration = 3.0
        let sampleCount = Int(Double(sampleRate) * duration)
        let bytesPerSample = 2
        let dataSize = sampleCount * bytesPerSample

        var data = Data()

        func appendASCII(_ value: String) {
            if let bytes = value.data(using: .ascii) {
                data.append(bytes)
            }
        }

        func appendUInt16(_ value: UInt16) {
            var little = value.littleEndian
            Swift.withUnsafeBytes(of: &little) { data.append(contentsOf: $0) }
        }

        func appendUInt32(_ value: UInt32) {
            var little = value.littleEndian
            Swift.withUnsafeBytes(of: &little) { data.append(contentsOf: $0) }
        }

        appendASCII("RIFF")
        appendUInt32(UInt32(36 + dataSize))
        appendASCII("WAVE")
        appendASCII("fmt ")
        appendUInt32(16)
        appendUInt16(1)
        appendUInt16(1)
        appendUInt32(UInt32(sampleRate))
        appendUInt32(UInt32(sampleRate * bytesPerSample))
        appendUInt16(UInt16(bytesPerSample))
        appendUInt16(16)
        appendASCII("data")
        appendUInt32(UInt32(dataSize))

        let amplitude = 5_500.0
        for index in 0..<sampleCount {
            let time = Double(index) / Double(sampleRate)
            let cycle = time.truncatingRemainder(dividingBy: 3.0)
            let toneOn = cycle < 0.4 || (cycle >= 0.6 && cycle < 1.0)

            let value: Double
            if toneOn {
                let a = sin(2.0 * Double.pi * 400.0 * time)
                let b = sin(2.0 * Double.pi * 450.0 * time)
                value = ((a + b) * 0.5) * amplitude
            } else {
                value = 0
            }

            var sample = Int16(max(-32767, min(32767, Int(value)))).littleEndian
            Swift.withUnsafeBytes(of: &sample) { data.append(contentsOf: $0) }
        }

        return data
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

        stopRingback()
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
        data.appName = "VoiceHost"
        data.extra = ["call_id": id, "source": "voicehost-mobile-gateway"]
        data.duration = 45_000
        data.normalHandle = 1
        data.handleType = "number"
        data.supportsVideo = false
        data.maximumCallGroups = 1
        data.maximumCallsPerCallGroup = 1

        // Only advertise controls that the gateway path currently implements.
        // Decline/End remains a native CallKit CXEndCallAction.
        data.supportsHolding = false
        data.supportsDTMF = false
        data.supportsGrouping = false
        data.supportsUngrouping = false

        // Do not let the plugin activate AVAudioSession itself. CallKit owns
        // activation and didActivateAudioSession hands that session to WebRTC.
        data.configureAudioSession = false
        data.audioSessionMode = "voiceChat"
        data.audioSessionActive = false

        do {
            let audioSession = AVAudioSession.sharedInstance()
            try audioSession.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth])
            try audioSession.setPreferredSampleRate(48_000)
            try audioSession.setPreferredIOBufferDuration(0.01)
        } catch {
            print("[VoiceHost CallKit] audio session preconfiguration failed")
        }

        SwiftFlutterCallkitIncomingPlugin.sharedInstance?.showCallkitIncoming(
            data,
            fromPushKit: true
        ) {
            completion()
        }
    }
}
