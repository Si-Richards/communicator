import '../core/app_config.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';

class WebRtcService {
  RTCPeerConnection? _peerConnection;
  MediaStream? _localStream;
  MediaStream? _remoteStream;
  RTCVideoRenderer? _localRenderer;
  RTCVideoRenderer? _remoteRenderer;
  RTCRtpSender? _videoSender;
  bool _remoteDescriptionSet = false;
  bool _videoEnabled = false;
  bool _remoteVideoAvailable = false;
  final List<RTCIceCandidate> _pendingRemoteCandidates = [];

  void Function(Map<String, dynamic> candidate)? onLocalCandidate;
  VoidCallback? onIceGatheringComplete;
  void Function(String state)? onConnectionStateChanged;
  void Function(String state)? onIceConnectionStateChanged;
  void Function(int count)? onLocalAudioReady;
  void Function(int count)? onRemoteAudioReady;
  void Function(bool enabled)? onLocalVideoChanged;
  void Function(bool available)? onRemoteVideoChanged;
  void Function(String message)? onLog;

  RTCVideoRenderer? get localRenderer => _localRenderer;
  RTCVideoRenderer? get remoteRenderer => _remoteRenderer;
  bool get videoEnabled => _videoEnabled;
  bool get remoteVideoAvailable => _remoteVideoAvailable;
  bool get hasPeerConnection => _peerConnection != null;

  Future<void> preparePeerConnection({
    bool preservePendingRemoteCandidates = false,
    bool video = false,
  }) async {
    final preservedCandidates = preservePendingRemoteCandidates
        ? List<RTCIceCandidate>.from(_pendingRemoteCandidates)
        : <RTCIceCandidate>[];
    await close();
    _pendingRemoteCandidates.addAll(preservedCandidates);

    onLog?.call('Requesting local media: audio=true video=$video');
    _localStream = await navigator.mediaDevices.getUserMedia({
      'audio': {
        'echoCancellation': true,
        'noiseSuppression': true,
        'autoGainControl': true,
      },
      'video': video
          ? {
              'facingMode': 'user',
              'width': {'ideal': 1280},
              'height': {'ideal': 720},
              'frameRate': {'ideal': 30, 'max': 30},
            }
          : false,
    });

    final stream = _localStream!;
    final localAudioTracks = stream.getAudioTracks();
    onLog?.call(
      'Local microphone stream ready: ${localAudioTracks.length} audio track(s)',
    );
    onLocalAudioReady?.call(localAudioTracks.length);

    final localRenderer = RTCVideoRenderer();
    final remoteRenderer = RTCVideoRenderer();
    await localRenderer.initialize();
    await remoteRenderer.initialize();
    localRenderer.srcObject = stream;
    _localRenderer = localRenderer;
    _remoteRenderer = remoteRenderer;

    final iceServers = <Map<String, dynamic>>[];
    if (AppConfig.stunUrl.trim().isNotEmpty) {
      iceServers.add({'urls': [AppConfig.stunUrl.trim()]});
    }
    if (AppConfig.turnUrl.trim().isNotEmpty &&
        AppConfig.turnUsername.trim().isNotEmpty &&
        AppConfig.turnCredential.isNotEmpty) {
      iceServers.add({
        'urls': [AppConfig.turnUrl.trim()],
        'username': AppConfig.turnUsername.trim(),
        'credential': AppConfig.turnCredential,
      });
    }

    onLog?.call(
      'ICE servers configured: STUN=${AppConfig.stunUrl.trim().isNotEmpty} '
      'TURN=${AppConfig.turnUrl.trim().isNotEmpty}',
    );

    _peerConnection = await createPeerConnection(
      {
        'sdpSemantics': 'unified-plan',
        'iceServers': iceServers,
        'iceTransportPolicy': AppConfig.iceTransportPolicy.trim().isEmpty
            ? 'all'
            : AppConfig.iceTransportPolicy.trim(),
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
      onLog?.call('Local ICE candidate type: ${_candidateType(value)}');
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
        final videoTrackCount = _remoteStream?.getVideoTracks().length ?? 0;
        onLog?.call(
          'Remote media attached: $audioTrackCount audio, $videoTrackCount video track(s)',
        );
        onRemoteAudioReady?.call(audioTrackCount);
        final available = videoTrackCount > 0;
        if (_remoteVideoAvailable != available) {
          _remoteVideoAvailable = available;
          onRemoteVideoChanged?.call(available);
        }
      } else {
        onLog?.call('Remote track arrived without an associated MediaStream');
      }
    };

    for (final track in localAudioTracks) {
      track.enabled = true;
      await pc.addTrack(track, stream);
      onLog?.call('Added local audio track ${track.id}');
    }

    final localVideoTracks = stream.getVideoTracks();
    if (localVideoTracks.isNotEmpty) {
      final track = localVideoTracks.first;
      track.enabled = true;
      _videoSender = await pc.addTrack(track, stream);
      _videoEnabled = true;
      onLog?.call('Added local video track ${track.id}');
    } else {
      _videoEnabled = false;
    }
    onLocalVideoChanged?.call(_videoEnabled);

    await Helper.setSpeakerphoneOn(false);
    _remoteDescriptionSet = false;
  }

  Future<String> createOffer() async {
    final pc = _requirePeerConnection();
    final offer = await pc.createOffer({
      'offerToReceiveAudio': true,
      'offerToReceiveVideo': _videoEnabled || _remoteVideoAvailable,
    });
    await pc.setLocalDescription(offer);
    if (offer.sdp == null) throw StateError('WebRTC offer contained no SDP');
    onLog?.call('Local SDP offer: ${summarizeSdp(offer.sdp!)}');
    return offer.sdp!;
  }

  Future<String> createAnswer(String remoteOfferSdp) async {
    final pc = _requirePeerConnection();
    onLog?.call('Remote SDP offer: ${summarizeSdp(remoteOfferSdp)}');
    await _setRemoteDescription(RTCSessionDescription(remoteOfferSdp, 'offer'));
    final answer = await pc.createAnswer({
      'offerToReceiveAudio': true,
      'offerToReceiveVideo': _videoEnabled,
    });
    await pc.setLocalDescription(answer);
    if (answer.sdp == null) throw StateError('WebRTC answer contained no SDP');
    onLog?.call('Local SDP answer: ${summarizeSdp(answer.sdp!)}');
    return answer.sdp!;
  }

  Future<void> applyRemoteAnswer(String sdp) async {
    final pc = _requirePeerConnection();
    final signaling = pc.signalingState.toString().toLowerCase();
    if (_remoteDescriptionSet && signaling.contains('stable')) {
      onLog?.call('Ignoring duplicate remote SDP answer while signalling is stable');
      return;
    }
    onLog?.call('Remote SDP answer: ${summarizeSdp(sdp)}');
    await _setRemoteDescription(RTCSessionDescription(sdp, 'answer'));
  }

  Future<String> applyRemoteOfferAndCreateAnswer(String sdp) async {
    onLog?.call('Remote renegotiation offer: ${summarizeSdp(sdp)}');
    await _setRemoteDescription(RTCSessionDescription(sdp, 'offer'));
    final answer = await _requirePeerConnection().createAnswer({
      'offerToReceiveAudio': true,
      'offerToReceiveVideo': true,
    });
    await _requirePeerConnection().setLocalDescription(answer);
    if (answer.sdp == null) {
      throw StateError('WebRTC renegotiation answer contained no SDP');
    }
    onLog?.call('Local renegotiation answer: ${summarizeSdp(answer.sdp!)}');
    return answer.sdp!;
  }

  Future<String> setVideoEnabled(bool enabled) async {
    final pc = _requirePeerConnection();
    final local = _localStream;
    if (local == null) throw StateError('Local media stream is unavailable');

    if (enabled == _videoEnabled) {
      return createOffer();
    }

    if (enabled) {
      final camera = await navigator.mediaDevices.getUserMedia({
        'audio': false,
        'video': {
          'facingMode': 'user',
          'width': {'ideal': 1280},
          'height': {'ideal': 720},
          'frameRate': {'ideal': 30, 'max': 30},
        },
      });
      final tracks = camera.getVideoTracks();
      if (tracks.isEmpty) {
        await camera.dispose();
        throw StateError('Camera did not provide a video track');
      }
      final track = tracks.first;
      await local.addTrack(track);
      _videoSender = await pc.addTrack(track, local);
      _localRenderer?.srcObject = local;
      _videoEnabled = true;
      onLog?.call('Camera enabled: local video track ${track.id}');
    } else {
      final sender = _videoSender;
      _videoSender = null;
      if (sender != null) {
        try {
          await pc.removeTrack(sender);
        } catch (_) {}
      }
      for (final track in List<MediaStreamTrack>.from(local.getVideoTracks())) {
        try {
          await local.removeTrack(track);
        } catch (_) {}
        await track.stop();
      }
      _localRenderer?.srcObject = local;
      _videoEnabled = false;
      onLog?.call('Camera disabled');
    }

    onLocalVideoChanged?.call(_videoEnabled);
    return createOffer();
  }

  Future<void> switchCamera() async {
    final local = _localStream;
    if (local == null) return;
    final tracks = local.getVideoTracks();
    if (tracks.isEmpty) return;
    await Helper.switchCamera(tracks.first);
    onLog?.call('Active camera switched');
  }

  Future<void> addRemoteCandidate(Map<String, dynamic> object) async {
    if (object['completed'] == true) return;
    final candidateSdp = object['candidate']?.toString();
    if (candidateSdp == null || candidateSdp.isEmpty) return;
    onLog?.call('Remote ICE candidate type: ${_candidateType(candidateSdp)}');
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
    _videoSender = null;
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

    final localRenderer = _localRenderer;
    _localRenderer = null;
    if (localRenderer != null) {
      localRenderer.srcObject = null;
      await localRenderer.dispose();
    }

    final remoteRenderer = _remoteRenderer;
    _remoteRenderer = null;
    if (remoteRenderer != null) {
      remoteRenderer.srcObject = null;
      await remoteRenderer.dispose();
    }

    _videoEnabled = false;
    _remoteVideoAvailable = false;
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

    final sdp = description.sdp ?? '';
    final hasRemoteVideo = hasVideoInSdp(sdp);
    if (_remoteVideoAvailable != hasRemoteVideo) {
      _remoteVideoAvailable = hasRemoteVideo;
      onRemoteVideoChanged?.call(hasRemoteVideo);
    }
  }

  RTCPeerConnection _requirePeerConnection() {
    final pc = _peerConnection;
    if (pc == null) throw StateError('WebRTC peer connection is unavailable');
    return pc;
  }

  static bool hasVideoInSdp(String sdp) =>
      RegExp(r'(?m)^m=video\s+\d+').hasMatch(sdp);

  static String summarizeSdp(String sdp) {
    final audio = _codecsForMedia(sdp, 'audio');
    final video = _codecsForMedia(sdp, 'video');
    final direction = RegExp(r'(?m)^a=(sendrecv|sendonly|recvonly|inactive)$')
            .firstMatch(sdp)
            ?.group(1) ??
        'default';
    return 'audio=[${audio.join(',')}] video=[${video.join(',')}] direction=$direction';
  }

  static List<String> _codecsForMedia(String sdp, String media) {
    final lines = sdp.split(RegExp(r'\r?\n'));
    final mIndex = lines.indexWhere((line) => line.startsWith('m=$media '));
    if (mIndex < 0) return const [];
    var end = lines.length;
    for (var i = mIndex + 1; i < lines.length; i++) {
      if (lines[i].startsWith('m=')) {
        end = i;
        break;
      }
    }
    final codecs = <String>{};
    for (var i = mIndex + 1; i < end; i++) {
      final match = RegExp(r'^a=rtpmap:\d+\s+([^/\s]+)', caseSensitive: false)
          .firstMatch(lines[i]);
      final codec = match?.group(1);
      if (codec != null && codec.isNotEmpty) codecs.add(codec.toUpperCase());
    }
    return codecs.toList(growable: false);
  }

  static String _candidateType(String candidate) {
    final match =
        RegExp(r'\btyp\s+(host|srflx|prflx|relay)\b').firstMatch(candidate);
    return match?.group(1) ?? 'unknown';
  }

  static int? _intValue(dynamic value) {
    if (value is int) return value;
    if (value is num) return value.toInt();
    return int.tryParse(value?.toString() ?? '');
  }
}
