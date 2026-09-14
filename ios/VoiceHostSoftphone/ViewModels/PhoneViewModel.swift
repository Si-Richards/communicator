import Foundation
import WebRTC

@MainActor
final class PhoneViewModel: ObservableObject {
    @Published var extensionNickname: String {
        didSet { UserDefaults.standard.set(extensionNickname, forKey: Self.nicknameKey) }
    }
    @Published var doNotDisturb: Bool {
        didSet { UserDefaults.standard.set(doNotDisturb, forKey: Self.dndKey) }
    }
    @Published var voicemailAccessNumber: String {
        didSet { UserDefaults.standard.set(voicemailAccessNumber, forKey: Self.voicemailAccessNumberKey) }
    }

    @Published var sipUsername = ""
    @Published var sipPassword = ""
    @Published var sipRealm = AppConfig.defaultSIPRealm
    @Published var sipProxy = ""
    @Published var janusURL = AppConfig.defaultJanusURL.absoluteString
    @Published var janusAPISecret = ""

    @Published private(set) var isRegistered = false
    @Published private(set) var registrationStatus = "Offline"
    @Published private(set) var callState: CallState = .idle
    @Published private(set) var errorMessage: String?
    @Published private(set) var callHistory: [CallRecord]
    @Published private(set) var voicemailWaiting = false
    @Published private(set) var voicemailNewCount = 0
    @Published private(set) var voicemailOldCount = 0
    @Published private(set) var voicemailSubscriptionStatus = "Not subscribed"
    @Published var dialledNumber = ""
    @Published var isMuted = false

    private struct ActiveCallContext {
        let direction: CallRecord.Direction
        let number: String
        let displayName: String?
        let startedAt: Date
        var connectedAt: Date?
    }

    private static let nicknameKey = "voicehost.extensionNickname"
    private static let dndKey = "voicehost.doNotDisturb"
    private static let voicemailAccessNumberKey = "voicehost.voicemailAccessNumber"
    private static let historyKey = "voicehost.callHistory.v1"
    private static let maximumHistoryRecords = 500

    private var janus: JanusClient?
    private var sip: JanusSIPPlugin?
    private let webRTC = WebRTCEngine()
    private var incomingOfferSDP: String?
    private var currentNumber = ""
    private var canSendTrickle = false
    private var pendingLocalCandidates: [[String: Any]] = []
    private var activeCall: ActiveCallContext?

    init() {
        extensionNickname = UserDefaults.standard.string(forKey: Self.nicknameKey) ?? ""
        doNotDisturb = UserDefaults.standard.bool(forKey: Self.dndKey)
        voicemailAccessNumber = UserDefaults.standard.string(forKey: Self.voicemailAccessNumberKey) ?? ""
        callHistory = Self.loadCallHistory()

        webRTC.onLocalCandidate = { [weak self] candidate in
            Task { @MainActor in
                await self?.queueOrSend(candidate: candidate)
            }
        }
        webRTC.onIceGatheringComplete = { [weak self] in
            Task { @MainActor in
                await self?.queueOrSend(candidateObject: ["completed": true])
            }
        }
    }

    var extensionDisplayName: String {
        let nickname = extensionNickname.trimmingCharacters(in: .whitespacesAndNewlines)
        if !nickname.isEmpty { return nickname }

        let username = sipUsername.trimmingCharacters(in: .whitespacesAndNewlines)
        if !username.isEmpty { return username }

        return "Phone"
    }

    var canRegister: Bool {
        !sipUsername.trimmingCharacters(in: .whitespaces).isEmpty &&
        !sipPassword.isEmpty &&
        URL(string: janusURL) != nil
    }

    var canCallVoicemail: Bool {
        isRegistered && !voicemailAccessNumber.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    func connectAndRegister() async {
        errorMessage = nil
        registrationStatus = "Connecting…"

        guard let url = URL(string: janusURL) else {
            errorMessage = "Invalid Janus URL"
            registrationStatus = "Offline"
            return
        }

        let proxyValue = sipProxy.trimmingCharacters(in: .whitespacesAndNewlines)
        let account = SIPAccount(
            username: sipUsername.trimmingCharacters(in: .whitespacesAndNewlines),
            password: sipPassword,
            realm: sipRealm.trimmingCharacters(in: .whitespacesAndNewlines),
            proxy: proxyValue.isEmpty ? nil : proxyValue,
            displayName: extensionNickname.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        )

        let janus = JanusClient(serverURL: url)
        let sip = JanusSIPPlugin(janus: janus)
        self.janus = janus
        self.sip = sip

        janus.onPluginEvent = { [weak self] payload, jsep in
            Task { @MainActor in self?.handleSIPEvent(payload, jsep: jsep) }
        }
        janus.onRemoteCandidate = { [weak self] candidate in
            Task { @MainActor in await self?.handleRemoteCandidate(candidate) }
        }

        do {
            try await janus.connect(apiSecret: janusAPISecret)
            registrationStatus = "Registering…"
            try await sip.register(account)
        } catch {
            registrationStatus = "Offline"
            isRegistered = false
            errorMessage = error.localizedDescription
        }
    }

    func disconnect() {
        if activeCall != nil {
            finalizeActiveCall(result: localEndResult())
        }
        janus?.disconnect()
        webRTC.closePeerConnection()
        janus = nil
        sip = nil
        isRegistered = false
        registrationStatus = "Offline"
        voicemailSubscriptionStatus = "Not subscribed"
        voicemailWaiting = false
        voicemailNewCount = 0
        voicemailOldCount = 0
        callState = .idle
    }

    func placeCall() async {
        let number = normalizedDialString(dialledNumber)
        await startOutgoingCall(to: number)
    }

    func callVoicemail() async {
        let number = normalizedDialString(voicemailAccessNumber)
        guard !number.isEmpty else {
            errorMessage = "Set the voicemail access number in Settings first."
            return
        }
        dialledNumber = number
        await startOutgoingCall(to: number)
    }

    func refreshVoicemailStatus() async {
        guard isRegistered, let sip else {
            voicemailSubscriptionStatus = "Not registered"
            return
        }

        voicemailSubscriptionStatus = "Subscribing…"
        do {
            try await sip.subscribeMessageSummary()
        } catch {
            voicemailSubscriptionStatus = "Unavailable"
        }
    }

    func answerIncomingCall() async {
        guard let offer = incomingOfferSDP, let sip else {
            errorMessage = "The incoming SIP INVITE did not contain an SDP offer. Offerless INVITEs are not implemented in the first milestone."
            return
        }
        canSendTrickle = false
        pendingLocalCandidates.removeAll()
        do {
            try webRTC.prepareAudioSession()
            try webRTC.createPeerConnection()
            let answer = try await webRTC.createAnswer(for: offer)
            try await sip.accept(answerSDP: answer)
            canSendTrickle = true
            await flushLocalCandidates()
        } catch {
            errorMessage = error.localizedDescription
            finalizeActiveCall(result: .failed)
            webRTC.closePeerConnection()
            callState = .ended(reason: error.localizedDescription)
        }
    }

    func rejectIncomingCall() async {
        try? await sip?.decline()
        finalizeActiveCall(result: .declined)
        resetCall()
    }

    func hangup() async {
        try? await sip?.hangup()
        finalizeActiveCall(result: localEndResult())
        resetCall()
    }

    func toggleMute() {
        isMuted.toggle()
        webRTC.setMuted(isMuted)
    }

    func toggleHold() async {
        switch callState {
        case .connected(let number):
            do {
                try await sip?.hold()
                callState = .held(number: number)
            } catch { errorMessage = error.localizedDescription }
        case .held(let number):
            do {
                try await sip?.unhold()
                callState = .connected(number: number)
            } catch { errorMessage = error.localizedDescription }
        default:
            break
        }
    }

    func sendDTMF(_ digit: String) async {
        guard callState.isInCall else { return }
        try? await sip?.sendDTMF(digit)
    }

    func deleteCallRecord(id: UUID) {
        callHistory.removeAll { $0.id == id }
        persistCallHistory()
    }

    func deleteCallRecords(at offsets: IndexSet) {
        for index in offsets.sorted(by: >) where callHistory.indices.contains(index) {
            callHistory.remove(at: index)
        }
        persistCallHistory()
    }

    func clearCallHistory() {
        callHistory.removeAll()
        persistCallHistory()
    }

    func clearError() {
        errorMessage = nil
    }

    private func startOutgoingCall(to number: String) async {
        guard isRegistered, !number.isEmpty, let sip, !callState.isInCall else { return }
        errorMessage = nil
        currentNumber = number
        activeCall = ActiveCallContext(
            direction: .outgoing,
            number: number,
            displayName: nil,
            startedAt: Date(),
            connectedAt: nil
        )
        callState = .outgoing(number: number)
        canSendTrickle = false
        pendingLocalCandidates.removeAll()

        do {
            try webRTC.prepareAudioSession()
            try webRTC.createPeerConnection()
            let offer = try await webRTC.createOffer()
            try await sip.call(number: number, realm: sipRealm, offerSDP: offer)
            canSendTrickle = true
            await flushLocalCandidates()
        } catch {
            errorMessage = error.localizedDescription
            callState = .ended(reason: error.localizedDescription)
            finalizeActiveCall(result: .failed)
            webRTC.closePeerConnection()
        }
    }

    private func handleSIPEvent(_ payload: [String: Any], jsep: [String: Any]?) {
        if let error = payload["error"] as? String {
            errorMessage = error
            return
        }

        guard let result = payload["result"] as? [String: Any],
              let event = result["event"] as? String else { return }

        switch event {
        case "registering":
            registrationStatus = "Registering…"

        case "registered":
            isRegistered = true
            registrationStatus = "Online"
            Task { await refreshVoicemailStatus() }

        case "registration_failed":
            isRegistered = false
            let reason = result["reason"] as? String ?? "Registration failed"
            registrationStatus = "Registration failed"
            errorMessage = reason

        case "subscribing":
            voicemailSubscriptionStatus = "Subscribing…"

        case "subscribe_succeeded":
            voicemailSubscriptionStatus = "Active"

        case "subscribe_failed":
            voicemailSubscriptionStatus = "Unavailable"

        case "notify":
            if (result["notify"] as? String)?.lowercased() == "message-summary" {
                updateVoicemailSummary(from: result["content"] as? String ?? "")
                voicemailSubscriptionStatus = "Active"
            }

        case "calling":
            callState = .outgoing(number: currentNumber)

        case "ringing":
            callState = .ringing(number: currentNumber)

        case "progress":
            if let answer = jsep?["sdp"] as? String {
                Task { try? await webRTC.applyRemoteAnswer(answer) }
            }
            callState = .earlyMedia(number: currentNumber)

        case "accepted":
            if let answer = jsep?["sdp"] as? String {
                Task { try? await webRTC.applyRemoteAnswer(answer) }
            }
            if activeCall?.connectedAt == nil {
                activeCall?.connectedAt = Date()
            }
            callState = .connected(number: currentNumber)

        case "incomingcall":
            canSendTrickle = false
            pendingLocalCandidates.removeAll()
            let callerURI = result["username"] as? String ?? "Unknown"
            let caller = extractUser(from: callerURI)
            let displayName = result["displayname"] as? String

            if doNotDisturb {
                activeCall = ActiveCallContext(
                    direction: .incoming,
                    number: caller,
                    displayName: displayName,
                    startedAt: Date(),
                    connectedAt: nil
                )
                finalizeActiveCall(result: .missed)
                Task { try? await sip?.decline(code: 486) }
                currentNumber = ""
                incomingOfferSDP = nil
                callState = .idle
                return
            }

            currentNumber = caller
            incomingOfferSDP = jsep?["sdp"] as? String
            activeCall = ActiveCallContext(
                direction: .incoming,
                number: caller,
                displayName: displayName,
                startedAt: Date(),
                connectedAt: nil
            )
            callState = .incoming(number: caller, displayName: displayName)

        case "hangup":
            let reason = result["reason"] as? String
            finalizeActiveCall(result: remoteEndResult())
            callState = .ended(reason: reason)
            webRTC.closePeerConnection()
            incomingOfferSDP = nil

        default:
            break
        }
    }

    private func updateVoicemailSummary(from content: String) {
        var waiting: Bool?
        var newCount: Int?
        var oldCount: Int?

        for rawLine in content.components(separatedBy: .newlines) {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            let lower = line.lowercased()

            if lower.hasPrefix("messages-waiting:") {
                let value = lower.split(separator: ":", maxSplits: 1).last?
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                waiting = value == "yes"
            }

            if lower.hasPrefix("voice-message:") {
                let value = line.split(separator: ":", maxSplits: 1).last?
                    .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let countsToken = value.split(separator: " ").first.map(String.init) ?? value
                let counts = countsToken.split(separator: "/", maxSplits: 1)
                if let first = counts.first { newCount = Int(first) }
                if counts.count > 1 { oldCount = Int(counts[1]) }
            }
        }

        if let newCount { voicemailNewCount = newCount }
        if let oldCount { voicemailOldCount = oldCount }
        if let waiting {
            voicemailWaiting = waiting || voicemailNewCount > 0
        } else {
            voicemailWaiting = voicemailNewCount > 0
        }
    }

    private func handleRemoteCandidate(_ object: [String: Any]) async {
        if object["completed"] as? Bool == true { return }
        guard let sdp = object["candidate"] as? String else { return }
        let mid = object["sdpMid"] as? String
        let mLine = Int32((object["sdpMLineIndex"] as? NSNumber)?.intValue ?? 0)
        try? await webRTC.addRemoteCandidate(RTCIceCandidate(sdp: sdp, sdpMLineIndex: mLine, sdpMid: mid))
    }

    private func queueOrSend(candidate: RTCIceCandidate) async {
        var object: [String: Any] = [
            "candidate": candidate.sdp,
            "sdpMLineIndex": candidate.sdpMLineIndex
        ]
        if let sdpMid = candidate.sdpMid { object["sdpMid"] = sdpMid }
        await queueOrSend(candidateObject: object)
    }

    private func queueOrSend(candidateObject: [String: Any]) async {
        guard canSendTrickle, let janus else {
            pendingLocalCandidates.append(candidateObject)
            return
        }
        try? await janus.sendTrickle(candidate: candidateObject)
    }

    private func flushLocalCandidates() async {
        guard let janus else { return }
        let queued = pendingLocalCandidates
        pendingLocalCandidates.removeAll()
        for candidate in queued {
            try? await janus.sendTrickle(candidate: candidate)
        }
    }

    private func finalizeActiveCall(result: CallRecord.Result) {
        guard let call = activeCall else { return }
        activeCall = nil

        let duration: TimeInterval
        if let connectedAt = call.connectedAt {
            duration = max(0, Date().timeIntervalSince(connectedAt))
        } else {
            duration = 0
        }

        let record = CallRecord(
            direction: call.direction,
            number: call.number,
            displayName: call.displayName,
            startedAt: call.startedAt,
            duration: duration,
            result: result
        )
        callHistory.insert(record, at: 0)
        if callHistory.count > Self.maximumHistoryRecords {
            callHistory.removeLast(callHistory.count - Self.maximumHistoryRecords)
        }
        persistCallHistory()
    }

    private func localEndResult() -> CallRecord.Result {
        guard let call = activeCall else { return .cancelled }
        if call.connectedAt != nil { return .completed }
        return call.direction == .incoming ? .declined : .cancelled
    }

    private func remoteEndResult() -> CallRecord.Result {
        guard let call = activeCall else { return .failed }
        if call.connectedAt != nil { return .completed }
        return call.direction == .incoming ? .missed : .failed
    }

    private func persistCallHistory() {
        guard let data = try? JSONEncoder().encode(callHistory) else { return }
        UserDefaults.standard.set(data, forKey: Self.historyKey)
    }

    private static func loadCallHistory() -> [CallRecord] {
        guard let data = UserDefaults.standard.data(forKey: historyKey),
              let records = try? JSONDecoder().decode([CallRecord].self, from: data) else {
            return []
        }
        return records
    }

    private func resetCall() {
        webRTC.closePeerConnection()
        incomingOfferSDP = nil
        currentNumber = ""
        canSendTrickle = false
        pendingLocalCandidates.removeAll()
        isMuted = false
        callState = .idle
    }

    private func normalizedDialString(_ value: String) -> String {
        value.filter { $0.isNumber || $0 == "+" || $0 == "*" || $0 == "#" }
    }

    private func extractUser(from sipURI: String) -> String {
        sipURI
            .replacingOccurrences(of: "sip:", with: "")
            .split(separator: "@").first.map(String.init) ?? sipURI
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
