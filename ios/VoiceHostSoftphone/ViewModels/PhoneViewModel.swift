import Foundation
import WebRTC

@MainActor
final class PhoneViewModel: ObservableObject {
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
    @Published var dialledNumber = ""
    @Published var isMuted = false

    private var janus: JanusClient?
    private var sip: JanusSIPPlugin?
    private let webRTC = WebRTCEngine()
    private var incomingOfferSDP: String?
    private var currentNumber = ""
    private var canSendTrickle = false
    private var pendingLocalCandidates: [[String: Any]] = []

    init() {
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

    var canRegister: Bool {
        !sipUsername.trimmingCharacters(in: .whitespaces).isEmpty &&
        !sipPassword.isEmpty &&
        URL(string: janusURL) != nil
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
            displayName: nil
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
        janus?.disconnect()
        webRTC.closePeerConnection()
        janus = nil
        sip = nil
        isRegistered = false
        registrationStatus = "Offline"
        callState = .idle
    }

    func placeCall() async {
        let number = normalizedDialString(dialledNumber)
        guard isRegistered, !number.isEmpty, let sip else { return }
        errorMessage = nil
        currentNumber = number
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
            webRTC.closePeerConnection()
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
        }
    }

    func rejectIncomingCall() async {
        try? await sip?.decline()
        resetCall()
    }

    func hangup() async {
        try? await sip?.hangup()
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

    func clearError() {
        errorMessage = nil
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

        case "registration_failed":
            isRegistered = false
            let reason = result["reason"] as? String ?? "Registration failed"
            registrationStatus = "Registration failed"
            errorMessage = reason

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
            callState = .connected(number: currentNumber)

        case "incomingcall":
            canSendTrickle = false
            pendingLocalCandidates.removeAll()
            let callerURI = result["username"] as? String ?? "Unknown"
            let caller = extractUser(from: callerURI)
            let displayName = result["displayname"] as? String
            currentNumber = caller
            incomingOfferSDP = jsep?["sdp"] as? String
            callState = .incoming(number: caller, displayName: displayName)

        case "hangup":
            let reason = result["reason"] as? String
            callState = .ended(reason: reason)
            webRTC.closePeerConnection()
            incomingOfferSDP = nil

        default:
            break
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
