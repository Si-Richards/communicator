import AVFAudio
import CallKit
import Contacts
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
    private var callKitChannel: FlutterMethodChannel?
    private var contactsChannel: FlutterMethodChannel?
    private let callController = CXCallController()
    private let pendingCallKitActionsKey = "voicehost.pendingCallKitActions"

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

        let launched = super.application(
            application,
            didFinishLaunchingWithOptions: launchOptions
        )

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

            let callKitChannel = FlutterMethodChannel(
                name: "voicehost/callkit",
                binaryMessenger: controller.binaryMessenger
            )
            callKitChannel.setMethodCallHandler { [weak self] call, result in
                guard let self else {
                    result([])
                    return
                }
                switch call.method {
                case "drainPendingActions":
                    result(self.drainPendingCallKitActions())
                default:
                    result(FlutterMethodNotImplemented)
                }
            }
            self.callKitChannel = callKitChannel

            let contactsChannel = FlutterMethodChannel(
                name: "voicehost/contacts",
                binaryMessenger: controller.binaryMessenger
            )
            contactsChannel.setMethodCallHandler { [weak self] call, result in
                guard let self else {
                    result(
                        FlutterError(
                            code: "CONTACTS_UNAVAILABLE",
                            message: "Contacts service unavailable",
                            details: nil
                        )
                    )
                    return
                }
                switch call.method {
                case "getContacts":
                    self.loadContacts(result: result)
                case "openSettings":
                    self.openAppSettings(result: result)
                default:
                    result(FlutterMethodNotImplemented)
                }
            }
            self.contactsChannel = contactsChannel

            print("[VoiceHost Audio] native audio channel ready")
            print("[VoiceHost CallKit] native recovery channel ready")
            print("[VoiceHost Contacts] native contacts channel ready")
        } else {
            print("[VoiceHost Audio] native audio channel unavailable")
        }

        return launched
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
        persistPendingCallKitAction(type: "accept", id: call.uuid.uuidString)
        print("[VoiceHost CallKit] answer accepted")
        action.fulfill()
        foregroundAppForCall(id: call.uuid.uuidString)
    }

    func onDecline(_ call: Call, _ action: CXEndCallAction) {
        stopRingback()
        persistPendingCallKitAction(type: "decline", id: call.uuid.uuidString)
        print("[VoiceHost CallKit] call declined")
        action.fulfill()
    }

    func onEnd(_ call: Call, _ action: CXEndCallAction) {
        stopRingback()
        persistPendingCallKitAction(type: "end", id: call.uuid.uuidString)
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


    private func loadContacts(result: @escaping FlutterResult) {
        let store = CNContactStore()
        let status = CNContactStore.authorizationStatus(for: .contacts)

        // CNAuthorizationStatus.limited was added in iOS 18 and has raw value 4.
        // Treat it like authorized so contacts selected by the user remain usable.
        if status == .authorized || status.rawValue == 4 {
            fetchContacts(from: store, result: result)
            return
        }

        if status == .notDetermined {
            store.requestAccess(for: .contacts) { [weak self] granted, error in
                guard let self else { return }
                if granted {
                    self.fetchContacts(from: store, result: result)
                } else {
                    DispatchQueue.main.async {
                        result(
                            FlutterError(
                                code: "CONTACTS_DENIED",
                                message: error?.localizedDescription ??
                                    "Contacts access was not granted",
                                details: nil
                            )
                        )
                    }
                }
            }
            return
        }

        result(
            FlutterError(
                code: "CONTACTS_DENIED",
                message: "Contacts access is disabled for VoiceHost",
                details: nil
            )
        )
    }

    private func fetchContacts(
        from store: CNContactStore,
        result: @escaping FlutterResult
    ) {
        DispatchQueue.global(qos: .userInitiated).async {
            let nameKeys = CNContactFormatter.descriptorForRequiredKeys(
                for: .fullName
            )
            let keys: [CNKeyDescriptor] = [
                nameKeys,
                CNContactOrganizationNameKey as CNKeyDescriptor,
                CNContactPhoneNumbersKey as CNKeyDescriptor,
            ]
            let request = CNContactFetchRequest(keysToFetch: keys)
            request.sortOrder = .userDefault

            var payload: [[String: Any]] = []
            do {
                try store.enumerateContacts(with: request) { contact, _ in
                    let numbers = contact.phoneNumbers
                        .map { $0.value.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) }
                        .filter { !$0.isEmpty }
                    if numbers.isEmpty {
                        return
                    }

                    var name = CNContactFormatter.string(
                        from: contact,
                        style: .fullName
                    )?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    if name.isEmpty {
                        name = contact.organizationName
                            .trimmingCharacters(in: .whitespacesAndNewlines)
                    }
                    if name.isEmpty {
                        name = numbers[0]
                    }

                    payload.append([
                        "name": name,
                        "numbers": numbers,
                    ])
                }

                DispatchQueue.main.async {
                    result(payload)
                }
            } catch {
                DispatchQueue.main.async {
                    result(
                        FlutterError(
                            code: "CONTACTS_ERROR",
                            message: error.localizedDescription,
                            details: nil
                        )
                    )
                }
            }
        }
    }

    private func openAppSettings(result: @escaping FlutterResult) {
        guard let url = URL(string: UIApplication.openSettingsURLString) else {
            result(false)
            return
        }

        UIApplication.shared.open(url, options: [:]) { opened in
            result(opened)
        }
    }

    private func persistPendingCallKitAction(type: String, id: String) {
        var actions = UserDefaults.standard.array(
            forKey: pendingCallKitActionsKey
        ) as? [[String: String]] ?? []

        if !actions.contains(where: {
            $0["type"] == type && $0["id"]?.lowercased() == id.lowercased()
        }) {
            actions.append(["type": type, "id": id])
            if actions.count > 12 {
                actions.removeFirst(actions.count - 12)
            }
            UserDefaults.standard.set(actions, forKey: pendingCallKitActionsKey)
        }
    }

    private func drainPendingCallKitActions() -> [[String: String]] {
        let actions = UserDefaults.standard.array(
            forKey: pendingCallKitActionsKey
        ) as? [[String: String]] ?? []
        UserDefaults.standard.removeObject(forKey: pendingCallKitActionsKey)
        if !actions.isEmpty {
            print("[VoiceHost CallKit] recovered \(actions.count) native action(s)")
        }
        return actions
    }

    private func foregroundAppForCall(id: String) {
        guard UIApplication.shared.applicationState != .active,
              let encoded = id.addingPercentEncoding(
                  withAllowedCharacters: .urlPathAllowed
              ),
              let url = URL(string: "voicehost-softphone://call/\(encoded)")
        else {
            return
        }

        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { opened in
                print(
                    opened
                        ? "[VoiceHost CallKit] foreground request accepted"
                        : "[VoiceHost CallKit] foreground request unavailable"
                )
            }
        }
    }

    private func endCallKitCall(
        id: String,
        completion: @escaping () -> Void
    ) {
        guard let uuid = UUID(uuidString: id) else {
            print("[VoiceHost CallKit] invalid end-call UUID")
            completion()
            return
        }

        let transaction = CXTransaction()
        transaction.addAction(CXEndCallAction(call: uuid))
        callController.request(transaction) { error in
            if error != nil {
                print("[VoiceHost CallKit] remote end request was not needed")
            } else {
                print("[VoiceHost CallKit] remote ringing call dismissed")
            }
            DispatchQueue.main.async {
                completion()
            }
        }
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

    private func makeUKRingbackWav() -> Foundation.Data {
        // UK ringback cadence: 400 ms tone, 200 ms silence,
        // 400 ms tone, 2 s silence. The tone combines 400 Hz + 450 Hz.
        let sampleRate = 16_000
        let duration = 3.0
        let sampleCount = Int(Double(sampleRate) * duration)
        let bytesPerSample = 2
        let dataSize = sampleCount * bytesPerSample

        var data = Foundation.Data()

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

        // Randy sends this when the SIP INVITE disappears before we answer,
        // e.g. the call was answered on another registered endpoint. Handle it
        // natively because Flutter may still be suspended while CallKit rings.
        if body["action"] as? String == "end" {
            print("[VoiceHost PushKit] received remote ringing-end")
            endCallKitCall(id: id, completion: completion)
            return
        }

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
        // Two separate CallKit groups allow an active call plus a waiting/held
        // call. We intentionally do not support conferencing/grouping yet.
        data.maximumCallGroups = 2
        data.maximumCallsPerCallGroup = 1

        data.supportsHolding = true
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
