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
    private var ringbackTimer: Timer?
    private var ringbackRequested = false
    private var audioChannel: FlutterMethodChannel?
    private var callKitChannel: FlutterMethodChannel?
    private var contactsChannel: FlutterMethodChannel?
    private var appChannel: FlutterMethodChannel?
    private let callController = CXCallController()
    private let pendingCallKitActionsKey = "voicehost.pendingCallKitActions"
    private let nativeLogsKey = "voicehost.nativeLogs"

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

        registerVoiceHostChannels()

        return launched
    }

    private func registerVoiceHostChannels() {
        if audioChannel != nil &&
            callKitChannel != nil &&
            contactsChannel != nil &&
            appChannel != nil {
            return
        }

        guard let registrar = self.registrar(
            forPlugin: "VoiceHostNativeBridge"
        ) else {
            recordNativeLog("Native registrar unavailable")
            return
        }

        let messenger = registrar.messenger()

        let audio = FlutterMethodChannel(
            name: "voicehost/audio",
            binaryMessenger: messenger
        )
        audio.setMethodCallHandler { [weak self] call, result in
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
        audioChannel = audio

        let callKit = FlutterMethodChannel(
            name: "voicehost/callkit",
            binaryMessenger: messenger
        )
        callKit.setMethodCallHandler { [weak self] call, result in
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
        callKitChannel = callKit

        let contacts = FlutterMethodChannel(
            name: "voicehost/contacts",
            binaryMessenger: messenger
        )
        contacts.setMethodCallHandler { [weak self] call, result in
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
        contactsChannel = contacts

        let app = FlutterMethodChannel(
            name: "voicehost/app",
            binaryMessenger: messenger
        )
        app.setMethodCallHandler { [weak self] call, result in
            guard let self else {
                result(FlutterMethodNotImplemented)
                return
            }
            switch call.method {
            case "getBuildInfo":
                result(self.buildInfo())
            case "getNativeLogs":
                result(self.nativeLogs())
            case "clearNativeLogs":
                self.clearNativeLogs()
                result(nil)
            default:
                result(FlutterMethodNotImplemented)
            }
        }
        appChannel = app

        recordNativeLog("Application bridge ready")
        recordNativeLog("Native audio channel ready")
        recordNativeLog("Native CallKit recovery channel ready")
        recordNativeLog("Native contacts channel ready")
    }

    func pushRegistry(
        _ registry: PKPushRegistry,
        didUpdate credentials: PKPushCredentials,
        for type: PKPushType
    ) {
        guard type == .voIP else { return }
        let token = credentials.token.map { String(format: "%02x", $0) }.joined()
        recordNativeLog("PushKit token updated (\(credentials.token.count) bytes)")
        SwiftFlutterCallkitIncomingPlugin.sharedInstance?.setDevicePushTokenVoIP(token)
    }

    func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        guard type == .voIP else { return }
        recordNativeLog("PushKit token invalidated")
        SwiftFlutterCallkitIncomingPlugin.sharedInstance?.setDevicePushTokenVoIP("")
    }

    // flutter_callkit_incoming sends the Dart event first, then invokes these
    // delegate callbacks. Fulfil CallKit actions here; media setup remains in Dart.
    func onAccept(_ call: Call, _ action: CXAnswerCallAction) {
        stopRingback()
        persistPendingCallKitAction(type: "accept", id: call.uuid.uuidString)
        recordNativeLog("CallKit answer accepted")
        action.fulfill()
        foregroundAppForCall(id: call.uuid.uuidString)
    }

    func onDecline(_ call: Call, _ action: CXEndCallAction) {
        stopRingback()
        persistPendingCallKitAction(type: "decline", id: call.uuid.uuidString)
        recordNativeLog("CallKit call declined")
        action.fulfill()
    }

    func onEnd(_ call: Call, _ action: CXEndCallAction) {
        stopRingback()
        persistPendingCallKitAction(type: "end", id: call.uuid.uuidString)
        recordNativeLog("CallKit call ended")
        action.fulfill()
    }

    func onTimeOut(_ call: Call) {
        recordNativeLog("CallKit call timed out")
    }

    func didActivateAudioSession(_ audioSession: AVAudioSession) {
        let rtcAudioSession = RTCAudioSession.sharedInstance()
        rtcAudioSession.audioSessionDidActivate(audioSession)
        rtcAudioSession.isAudioEnabled = true
        if ringbackRequested && ringbackPlayer?.isPlaying != true {
            ringbackPlayer?.play()
            recordNativeLog("Local ringback resumed after audio activation")
        }
        recordNativeLog("CallKit WebRTC audio session activated")
    }

    func didDeactivateAudioSession(_ audioSession: AVAudioSession) {
        let rtcAudioSession = RTCAudioSession.sharedInstance()
        rtcAudioSession.audioSessionDidDeactivate(audioSession)
        rtcAudioSession.isAudioEnabled = false
        recordNativeLog("CallKit WebRTC audio session deactivated")
    }

    func providerDidReset() {
        recordNativeLog("CallKit provider reset")
    }


    private func buildInfo() -> [String: String] {
        let info = Bundle.main.infoDictionary ?? [:]
        return [
            "version": info["CFBundleShortVersionString"] as? String ?? "Unknown",
            "build": info["CFBundleVersion"] as? String ?? "Unknown",
        ]
    }

    private func recordNativeLog(_ message: String) {
        let timestamp = ISO8601DateFormatter().string(from: Date())
        var logs = UserDefaults.standard.stringArray(forKey: nativeLogsKey) ?? []
        logs.append("\(timestamp)  \(message)")
        if logs.count > 250 {
            logs.removeFirst(logs.count - 250)
        }
        UserDefaults.standard.set(logs, forKey: nativeLogsKey)
        print("[VoiceHost Native] \(message)")
    }

    private func nativeLogs() -> [String] {
        return Array(
            (UserDefaults.standard.stringArray(forKey: nativeLogsKey) ?? [])
                .reversed()
        )
    }

    private func clearNativeLogs() {
        UserDefaults.standard.removeObject(forKey: nativeLogsKey)
        recordNativeLog("Native diagnostics cleared")
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
            recordNativeLog("Recovered \(actions.count) pending CallKit action(s)")
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
                self.recordNativeLog(
                    opened
                        ? "CallKit foreground request accepted"
                        : "CallKit foreground request unavailable"
                )
            }
        }
    }

    private func endCallKitCall(
        id: String,
        completion: @escaping () -> Void
    ) {
        guard let uuid = UUID(uuidString: id) else {
            recordNativeLog("CallKit invalid end-call UUID")
            completion()
            return
        }

        let transaction = CXTransaction()
        transaction.addAction(CXEndCallAction(call: uuid))
        callController.request(transaction) { error in
            if error != nil {
                self.recordNativeLog("CallKit remote end request was not needed")
            } else {
                self.recordNativeLog("CallKit remote ringing call dismissed")
            }
            DispatchQueue.main.async {
                completion()
            }
        }
    }

    private func startRingback() {
        ringbackRequested = true

        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(
                .playAndRecord,
                mode: .voiceChat,
                options: [.allowBluetooth, .defaultToSpeaker]
            )
            try session.setActive(true)
            try session.overrideOutputAudioPort(.speaker)

            if ringbackPlayer == nil {
                let player = try AVAudioPlayer(data: makeUKRingbackWav())
                player.numberOfLoops = -1
                player.volume = 0.72
                player.prepareToPlay()
                ringbackPlayer = player
            }

            if ringbackPlayer?.isPlaying != true {
                ringbackPlayer?.currentTime = 0
                ringbackPlayer?.play()
            }

            ringbackTimer?.invalidate()
            ringbackTimer = Timer.scheduledTimer(
                withTimeInterval: 1.0,
                repeats: true
            ) { [weak self] _ in
                guard let self, self.ringbackRequested else { return }
                if self.ringbackPlayer?.isPlaying != true {
                    self.ringbackPlayer?.currentTime = 0
                    self.ringbackPlayer?.play()
                    self.recordNativeLog("Local ringback restarted")
                }
            }

            recordNativeLog("Local ringback started")
        } catch {
            ringbackRequested = false
            ringbackTimer?.invalidate()
            ringbackTimer = nil
            ringbackPlayer = nil
            recordNativeLog("Local ringback failed")
        }
    }

    private func stopRingback() {
        ringbackRequested = false
        ringbackTimer?.invalidate()
        ringbackTimer = nil

        if let player = ringbackPlayer {
            player.stop()
            ringbackPlayer = nil
        }

        do {
            try AVAudioSession.sharedInstance().overrideOutputAudioPort(.none)
        } catch {
            recordNativeLog("Unable to restore audio route after ringback")
        }
        recordNativeLog("Local ringback stopped")
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
            recordNativeLog("PushKit received remote ringing-end")
            endCallKitCall(id: id, completion: completion)
            return
        }

        recordNativeLog("PushKit incoming VoIP push received")
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
            recordNativeLog("CallKit audio session preconfiguration failed")
        }

        SwiftFlutterCallkitIncomingPlugin.sharedInstance?.showCallkitIncoming(
            data,
            fromPushKit: true
        ) {
            completion()
        }
    }
}
