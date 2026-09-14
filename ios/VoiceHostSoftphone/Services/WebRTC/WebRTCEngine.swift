import AVFoundation
import Foundation
import WebRTC

final class WebRTCEngine: NSObject {
    enum EngineError: LocalizedError {
        case peerConnectionUnavailable
        case missingSDP

        var errorDescription: String? {
            switch self {
            case .peerConnectionUnavailable: return "WebRTC peer connection is unavailable."
            case .missingSDP: return "WebRTC did not produce an SDP description."
            }
        }
    }

    var onLocalCandidate: ((RTCIceCandidate) -> Void)?
    var onIceGatheringComplete: (() -> Void)?
    var onConnectionStateChanged: ((RTCPeerConnectionState) -> Void)?

    private let factory: RTCPeerConnectionFactory
    private var peerConnection: RTCPeerConnection?
    private var localAudioTrack: RTCAudioTrack?
    private var remoteAudioTrack: RTCAudioTrack?
    private var remoteDescriptionSet = false
    private var pendingRemoteCandidates: [RTCIceCandidate] = []

    override init() {
        RTCInitializeSSL()
        let encoderFactory = RTCDefaultVideoEncoderFactory()
        let decoderFactory = RTCDefaultVideoDecoderFactory()
        factory = RTCPeerConnectionFactory(encoderFactory: encoderFactory, decoderFactory: decoderFactory)
        super.init()
    }

    deinit {
        RTCCleanupSSL()
    }

    func prepareAudioSession() throws {
        // We manage the underlying AVAudioSession ourselves so that the app can
        // later hand control cleanly to CallKit. WebRTC must explicitly be told
        // that its VoIP audio unit is allowed to start.
        let rtcAudioSession = RTCAudioSession.sharedInstance()
        rtcAudioSession.useManualAudio = true
        rtcAudioSession.isAudioEnabled = false

        let session = AVAudioSession.sharedInstance()
        try session.setCategory(
            .playAndRecord,
            mode: .voiceChat,
            options: [.allowBluetoothHFP, .defaultToSpeaker]
        )
        try session.setPreferredSampleRate(48_000)
        try session.setPreferredIOBufferDuration(0.01)
        try session.setActive(true)

        rtcAudioSession.isAudioEnabled = true

        print("[WebRTC] audio session active")
        print("[WebRTC] category=\(session.category.rawValue) mode=\(session.mode.rawValue)")
        print("[WebRTC] inputAvailable=\(session.isInputAvailable) sampleRate=\(session.sampleRate)")
        print("[WebRTC] route=\(session.currentRoute)")
    }

    func createPeerConnection(iceServers: [RTCIceServer] = []) throws {
        closePeerConnection()

        let configuration = RTCConfiguration()
        configuration.sdpSemantics = .unifiedPlan
        configuration.iceServers = iceServers
        configuration.continualGatheringPolicy = .gatherContinually

        let constraints = RTCMediaConstraints(
            mandatoryConstraints: nil,
            optionalConstraints: ["DtlsSrtpKeyAgreement": "true"]
        )

        guard let connection = factory.peerConnection(
            with: configuration,
            constraints: constraints,
            delegate: self
        ) else {
            throw EngineError.peerConnectionUnavailable
        }

        let audioSource = factory.audioSource(
            with: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        )
        let audioTrack = factory.audioTrack(with: audioSource, trackId: "voicehost-audio")
        audioTrack.isEnabled = true
        _ = connection.add(audioTrack, streamIds: ["voicehost-stream"])

        peerConnection = connection
        localAudioTrack = audioTrack
        remoteAudioTrack = nil
        remoteDescriptionSet = false

        print("[WebRTC] peer connection created; local audio track enabled=\(audioTrack.isEnabled)")
    }

    func createOffer() async throws -> String {
        guard let peerConnection else { throw EngineError.peerConnectionUnavailable }

        let constraints = RTCMediaConstraints(
            mandatoryConstraints: ["OfferToReceiveAudio": "true", "OfferToReceiveVideo": "false"],
            optionalConstraints: nil
        )

        let offer: RTCSessionDescription = try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<RTCSessionDescription, Error>) in
            peerConnection.offer(for: constraints) { description, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                guard let description else {
                    continuation.resume(throwing: EngineError.missingSDP)
                    return
                }
                continuation.resume(returning: description)
            }
        }

        try await setLocalDescription(offer)
        print("[WebRTC] local offer set")
        return offer.sdp
    }

    func createAnswer(for remoteOfferSDP: String) async throws -> String {
        guard let peerConnection else { throw EngineError.peerConnectionUnavailable }

        let remote = RTCSessionDescription(type: .offer, sdp: remoteOfferSDP)
        try await setRemoteDescription(remote)

        let constraints = RTCMediaConstraints(
            mandatoryConstraints: ["OfferToReceiveAudio": "true", "OfferToReceiveVideo": "false"],
            optionalConstraints: nil
        )

        let answer: RTCSessionDescription = try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<RTCSessionDescription, Error>) in
            peerConnection.answer(for: constraints) { description, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                guard let description else {
                    continuation.resume(throwing: EngineError.missingSDP)
                    return
                }
                continuation.resume(returning: description)
            }
        }

        try await setLocalDescription(answer)
        print("[WebRTC] local answer set")
        return answer.sdp
    }

    func applyRemoteAnswer(_ sdp: String) async throws {
        // Janus can expose SDP at progress and again at accepted. Avoid applying
        // an identical answer twice to an already-stable PeerConnection.
        if let existing = peerConnection?.remoteDescription,
           existing.type == .answer,
           existing.sdp == sdp {
            print("[WebRTC] duplicate remote answer ignored")
            return
        }

        try await setRemoteDescription(RTCSessionDescription(type: .answer, sdp: sdp))
        print("[WebRTC] remote answer set")
    }

    func addRemoteCandidate(_ candidate: RTCIceCandidate) async throws {
        guard let peerConnection, remoteDescriptionSet else {
            pendingRemoteCandidates.append(candidate)
            return
        }
        try await add(candidate, to: peerConnection)
    }

    func setMuted(_ muted: Bool) {
        localAudioTrack?.isEnabled = !muted
        print("[WebRTC] local audio muted=\(muted)")
    }

    func closePeerConnection() {
        peerConnection?.close()
        peerConnection = nil
        localAudioTrack = nil
        remoteAudioTrack = nil
        remoteDescriptionSet = false
        pendingRemoteCandidates.removeAll()

        let rtcAudioSession = RTCAudioSession.sharedInstance()
        if rtcAudioSession.useManualAudio {
            rtcAudioSession.isAudioEnabled = false
        }
    }

    private func setLocalDescription(_ description: RTCSessionDescription) async throws {
        guard let peerConnection else { throw EngineError.peerConnectionUnavailable }

        try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<Void, Error>) in
            peerConnection.setLocalDescription(description) { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: ())
                }
            }
        }
    }

    private func setRemoteDescription(_ description: RTCSessionDescription) async throws {
        guard let peerConnection else { throw EngineError.peerConnectionUnavailable }

        try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<Void, Error>) in
            peerConnection.setRemoteDescription(description) { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: ())
                }
            }
        }

        remoteDescriptionSet = true
        let queued = pendingRemoteCandidates
        pendingRemoteCandidates.removeAll()
        for candidate in queued {
            try await add(candidate, to: peerConnection)
        }
    }

    private func add(_ candidate: RTCIceCandidate, to peerConnection: RTCPeerConnection) async throws {
        try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<Void, Error>) in
            peerConnection.add(candidate) { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: ())
                }
            }
        }
    }
}

extension WebRTCEngine: RTCPeerConnectionDelegate {
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {
        print("[WebRTC] signaling state=\(stateChanged.rawValue)")
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {
        if let track = stream.audioTracks.first {
            track.isEnabled = true
            remoteAudioTrack = track
            print("[WebRTC] remote audio stream added track=\(track.trackId) enabled=\(track.isEnabled)")
        }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        print("[WebRTC] ICE connection state=\(newState.rawValue)")
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
        print("[WebRTC] ICE gathering state=\(newState.rawValue)")
        if newState == .complete { onIceGatheringComplete?() }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        print("[WebRTC] local ICE candidate mid=\(candidate.sdpMid ?? "nil") index=\(candidate.sdpMLineIndex)")
        onLocalCandidate?(candidate)
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didChangeStandardizedIceConnectionState newState: RTCIceConnectionState) {
        print("[WebRTC] standardized ICE state=\(newState.rawValue)")
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange connectionState: RTCPeerConnectionState) {
        print("[WebRTC] peer connection state=\(connectionState.rawValue)")
        onConnectionStateChanged?(connectionState)
    }

    func peerConnection(
        _ peerConnection: RTCPeerConnection,
        didAdd rtpReceiver: RTCRtpReceiver,
        streams mediaStreams: [RTCMediaStream]
    ) {
        guard let track = rtpReceiver.track as? RTCAudioTrack else { return }
        track.isEnabled = true
        remoteAudioTrack = track
        print("[WebRTC] remote RTP audio track added id=\(track.trackId) enabled=\(track.isEnabled)")
    }
}
