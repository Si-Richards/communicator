import 'package:flutter/foundation.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';

class WebRtcService {
  RTCPeerConnection? _peerConnection;
  MediaStream? _localStream;
  MediaStream? _remoteStream;
  RTCVideoRenderer? _remoteRenderer;
  bool _remoteDescriptionSet = false;
  final List<RTCIceCandidate> _pendingRemoteCandidates = [];

  void Function(Map<String, dynamic> candidate)? onLocalCandidate;
  VoidCallback? onIceGatheringComplete;
  void Function(String state)? onConnectionStateChanged;
  void Function(String state)? onIceConnectionStateChanged;
  void Function(int count)? onLocalAudioReady;
  void Function(int count)? onRemoteAudioReady;
  void Function(String message)? onLog;

  Future<void> preparePeerConnection({
    bool preservePendingRemoteCandidates = false,
  }) async {
    final preservedCandidates = preservePendingRemoteCandidates
        ? List<RTCIceCandidate>.from(_pendingRemoteCandidates)
        : <RTCIceCandidate>[];
    await close();
    _pendingRemoteCandidates.addAll(preservedCandidates);

    onLog?.call('Requesting microphone stream');
    _localStream = await navigator.mediaDevices.getUserMedia({
      'audio': {
        'echoCancellation': true,
        'noiseSuppression': true,
        'autoGainControl': true,
      },
      'video': false,
    });

    final stream = _localStream!;
    final localAudioTracks = stream.getAudioTracks();
    onLog?.call('Local microphone stream ready: ${localAudioTracks.length} audio track(s)');
    onLocalAudioReady?.call(localAudioTracks.length);

    final renderer = RTCVideoRenderer();
    await renderer.initialize();
    // Do not set renderer.muted before srcObject exists. flutter_webrtc throws
    // "The media stream is null" when the muted property is changed without
    // an attached MediaStream.
    _remoteRenderer = renderer;

    _peerConnection = await createPeerConnection(
      {
        'sdpSemantics': 'unified-plan',
        'iceServers': <Map<String, dynamic>>[],
      },
      {
        'optional': [
          {'DtlsSrtpKeyAgreement': true},
        ],
      },
    );

    final pc = _peerConnection!;
    pc.onIceCandidate = (candidate) {
      final value = candidate.candidate;
      if (value == null || value.isEmpty) return;
      onLocalCandidate?.call({
        'candidate': value,
        'sdpMid': candidate.sdpMid,
        'sdpMLineIndex': candidate.sdpMLineIndex,
      });
    };
    pc.onIceGatheringState = (state) {
      onLog?.call('ICE gathering: $state');
      if (state == RTCIceGatheringState.RTCIceGatheringStateComplete) {
        onIceGatheringComplete?.call();
      }
    };
    pc.onIceConnectionState = (state) {
      onLog?.call('ICE connection: $state');
      onIceConnectionStateChanged?.call(state.toString());
    };
    pc.onConnectionState = (state) {
      onLog?.call('Peer connection: $state');
      onConnectionStateChanged?.call(state.toString());
    };
    pc.onTrack = (event) {
      onLog?.call(
        'Remote track: ${event.track.kind} ${event.track.id} enabled=${event.track.enabled}',
      );
      event.track.enabled = true;
      if (event.streams.isNotEmpty) {
        _remoteStream = event.streams.first;
        _remoteRenderer?.srcObject = _remoteStream;
        final audioTrackCount = _remoteStream?.getAudioTracks().length ?? 0;
        onLog?.call(
          'Remote media stream attached: $audioTrackCount audio track(s)',
        );
        onRemoteAudioReady?.call(audioTrackCount);
      } else {
        onLog?.call('Remote track arrived without an associated MediaStream');
      }
    };

    for (final track in localAudioTracks) {
      track.enabled = true;
      await pc.addTrack(track, stream);
      onLog?.call('Added local audio track ${track.id}');
    }

    await Helper.setSpeakerphoneOn(false);
    _remoteDescriptionSet = false;
  }

  Future<String> createOffer() async {
    final pc = _requirePeerConnection();
    final offer = await pc.createOffer({
      'offerToReceiveAudio': true,
      'offerToReceiveVideo': false,
    });
    await pc.setLocalDescription(offer);
    if (offer.sdp == null) throw StateError('WebRTC offer contained no SDP');
    onLog?.call('Local SDP offer created');
    return offer.sdp!;
  }

  Future<String> createAnswer(String remoteOfferSdp) async {
    final pc = _requirePeerConnection();
    await _setRemoteDescription(
      RTCSessionDescription(remoteOfferSdp, 'offer'),
    );
    final answer = await pc.createAnswer({
      'offerToReceiveAudio': true,
      'offerToReceiveVideo': false,
    });
    await pc.setLocalDescription(answer);
    if (answer.sdp == null) throw StateError('WebRTC answer contained no SDP');
    onLog?.call('Local SDP answer created');
    return answer.sdp!;
  }

  Future<void> applyRemoteAnswer(String sdp) async {
    if (_remoteDescriptionSet) return;
    await _setRemoteDescription(RTCSessionDescription(sdp, 'answer'));
    onLog?.call('Remote SDP answer applied');
  }

  Future<void> addRemoteCandidate(Map<String, dynamic> object) async {
    if (object['completed'] == true) return;
    final candidateSdp = object['candidate']?.toString();
    if (candidateSdp == null || candidateSdp.isEmpty) return;
    final candidate = RTCIceCandidate(
      candidateSdp,
      object['sdpMid']?.toString(),
      _intValue(object['sdpMLineIndex']),
    );

    if (!_remoteDescriptionSet) {
      _pendingRemoteCandidates.add(candidate);
      return;
    }
    await _requirePeerConnection().addCandidate(candidate);
  }

  Future<void> setMuted(bool muted) async {
    final local = _localStream;
    if (local == null) {
      onLog?.call('Ignoring mute=$muted because no local media stream exists');
      return;
    }
    for (final track in local.getAudioTracks()) {
      track.enabled = !muted;
    }
  }

  Future<void> setSpeakerphone(bool enabled) => Helper.setSpeakerphoneOn(enabled);

  Future<void> close() async {
    final pc = _peerConnection;
    _peerConnection = null;
    if (pc != null) {
      try {
        await pc.close();
      } catch (_) {}
      try {
        await pc.dispose();
      } catch (_) {}
    }

    final local = _localStream;
    _localStream = null;
    if (local != null) {
      for (final track in local.getTracks()) {
        await track.stop();
      }
      await local.dispose();
    }

    final remote = _remoteStream;
    _remoteStream = null;
    if (remote != null) {
      try {
        await remote.dispose();
      } catch (_) {}
    }

    final renderer = _remoteRenderer;
    _remoteRenderer = null;
    if (renderer != null) {
      renderer.srcObject = null;
      await renderer.dispose();
    }

    _remoteDescriptionSet = false;
    _pendingRemoteCandidates.clear();
  }

  Future<void> _setRemoteDescription(RTCSessionDescription description) async {
    final pc = _requirePeerConnection();
    await pc.setRemoteDescription(description);
    _remoteDescriptionSet = true;

    final queued = List<RTCIceCandidate>.from(_pendingRemoteCandidates);
    _pendingRemoteCandidates.clear();
    for (final candidate in queued) {
      await pc.addCandidate(candidate);
    }
  }

  RTCPeerConnection _requirePeerConnection() {
    final pc = _peerConnection;
    if (pc == null) throw StateError('WebRTC peer connection is unavailable');
    return pc;
  }

  static int? _intValue(dynamic value) {
    if (value is int) return value;
    if (value is num) return value.toInt();
    return int.tryParse(value?.toString() ?? '');
  }
}
