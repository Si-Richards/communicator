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
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetoothHFP, .defaultToSpeaker])
        try session.setPreferredSampleRate(48_000)
        try session.setActive(true)
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

        let audioSource = factory.audioSource(with: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil))
        let audioTrack = factory.audioTrack(with: audioSource, trackId: "voicehost-audio")
        _ = connection.add(audioTrack, streamIds: ["voicehost-stream"])

        peerConnection = connection
        localAudioTrack = audioTrack
        remoteDescriptionSet = false
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
        return answer.sdp
    }

    func applyRemoteAnswer(_ sdp: String) async throws {
        try await setRemoteDescription(RTCSessionDescription(type: .answer, sdp: sdp))
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
    }

    func closePeerConnection() {
        peerConnection?.close()
        peerConnection = nil
        localAudioTrack = nil
        remoteDescriptionSet = false
        pendingRemoteCandidates.removeAll()
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
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
        if newState == .complete { onIceGatheringComplete?() }
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        onLocalCandidate?(candidate)
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChangeStandardizedIceConnectionState newState: RTCIceConnectionState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange connectionState: RTCPeerConnectionState) {
        onConnectionStateChanged?(connectionState)
    }
}
