import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter/widgets.dart';
import 'package:flutter_callkit_incoming/entities/entities.dart';
import 'package:flutter_callkit_incoming/flutter_callkit_incoming.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../controllers/phone_controller.dart';
import '../core/app_config.dart';
import 'mobile_gateway_service.dart';
import 'ringback_service.dart';
import 'webrtc_service.dart';

class MobileCallCoordinator extends ChangeNotifier with WidgetsBindingObserver {
  MobileCallCoordinator(this.phone)
      : gateway = MobileGatewayService(
          baseUrl: AppConfig.mobileGatewayUrl,
          apiKey: AppConfig.mobileGatewayKey,
        );

  final PhoneController phone;
  final MobileGatewayService gateway;
  final FlutterSecureStorage _storage = const FlutterSecureStorage();
  final WebRtcService _webRtc = WebRtcService();
  final WebRtcService _transferWebRtc = WebRtcService();
  final RingbackService _ringback = RingbackService();

  StreamSubscription<CallEvent?>? _callKitSubscription;
  StreamSubscription<dynamic>? _gatewayEventSubscription;
  StreamSubscription<dynamic>? _transferEventSubscription;
  WebSocket? _gatewaySocket;
  WebSocket? _transferSocket;
  String? _activeGatewayCallId;
  String? _deviceId;
  String? _pushToken;
  String? _lastProvisionSignature;
  bool _provisioning = false;
  bool _gatewayProvisioned = false;
  String? _activeGatewayCaller;
  String? _activeGatewayDisplayName;
  bool _gatewayConnected = false;
  bool _gatewayMediaConnected = false;
  DateTime? _gatewayConnectedAt;
  int _localCandidateCount = 0;
  int _remoteCandidateCount = 0;
  bool _gatewayMuted = false;
  bool _gatewaySpeakerphoneOn = false;
  bool _recoveringCallKitState = false;
  String? _transferId;
  String? _transferTarget;
  String _transferStatus = '';
  bool _transferConnected = false;
  bool _transferBusy = false;
  final List<Map<String, dynamic>> _pendingTransferCandidates = [];

  bool get hasActiveGatewayCall => _activeGatewayCallId != null;
  bool get gatewayProvisioned => _gatewayProvisioned;
  bool get gatewayCallConnected => _gatewayConnected;
  bool get gatewayMediaConnected => _gatewayMediaConnected;
  DateTime? get gatewayConnectedAt => _gatewayConnectedAt;
  bool get gatewayMuted => _gatewayMuted;
  bool get gatewaySpeakerphoneOn => _gatewaySpeakerphoneOn;
  bool get hasActiveTransfer => _transferId != null || _transferBusy;
  bool get attendedTransferActive => _transferId != null;
  bool get attendedTransferConnected => _transferConnected;
  String get transferStatus => _transferStatus;
  String? get transferTarget => _transferTarget;
  String get gatewayCallerDisplay {
    final display = _activeGatewayDisplayName?.trim() ?? '';
    if (display.isNotEmpty) return display;
    final caller = _activeGatewayCaller?.trim() ?? '';
    return caller.isNotEmpty ? caller : 'Unknown';
  }

  String? get gatewayCallerNumber => _activeGatewayCaller;

  Future<void> initialize() async {
    if (!gateway.enabled || !Platform.isIOS) {
      debugPrint('[VoiceHost Mobile] gateway disabled for this build');
      return;
    }

    WidgetsBinding.instance.addObserver(this);
    _deviceId = await _loadOrCreateDeviceId();
    _webRtc.onLog = (message) => debugPrint('[VoiceHost Mobile] $message');
    _webRtc.onLocalCandidate = (candidate) {
      final callId = _activeGatewayCallId;
      if (callId != null) {
        _localCandidateCount++;
        unawaited(gateway.candidate(callId, candidate));
      }
    };
    _webRtc.onIceConnectionStateChanged = (state) {
      final callId = _activeGatewayCallId;
      if (callId == null) return;
      final normalized = state.toLowerCase();
      _gatewayMediaConnected =
          normalized.endsWith('stateconnected') ||
          normalized.endsWith('statecompleted');
      notifyListeners();
      unawaited(_diag(
        'ice_state',
        callId: callId,
        details: {
          'ice_state': state,
          'local_candidates': _localCandidateCount,
          'remote_candidates': _remoteCandidateCount,
        },
      ));
    };
    _webRtc.onConnectionStateChanged = (state) {
      final callId = _activeGatewayCallId;
      if (callId == null) return;
      unawaited(_diag(
        'peer_state',
        callId: callId,
        details: {'peer_state': state},
      ));
    };
    _webRtc.onLocalAudioReady = (count) {
      final callId = _activeGatewayCallId;
      if (callId != null) {
        unawaited(_diag(
          'local_audio_ready',
          callId: callId,
          details: {'local_audio_tracks': count},
        ));
      }
    };
    _webRtc.onRemoteAudioReady = (count) {
      final callId = _activeGatewayCallId;
      if (callId != null) {
        unawaited(_diag(
          'remote_audio_ready',
          callId: callId,
          details: {'remote_audio_tracks': count},
        ));
      }
    };
    _webRtc.onIceGatheringComplete = () {
      final callId = _activeGatewayCallId;
      if (callId != null) {
        unawaited(gateway.candidate(callId, {'completed': true}));
        unawaited(_diag(
          'ice_gathering_complete',
          callId: callId,
          details: {
            'local_candidates': _localCandidateCount,
            'remote_candidates': _remoteCandidateCount,
          },
        ));
      }
    };

    _transferWebRtc.onLog =
        (message) => debugPrint('[VoiceHost Transfer] $message');
    _transferWebRtc.onLocalCandidate = (candidate) {
      final transferId = _transferId;
      if (transferId == null) {
        _pendingTransferCandidates.add(candidate);
      } else {
        unawaited(gateway.transferCandidate(transferId, candidate));
      }
    };
    _transferWebRtc.onIceGatheringComplete = () {
      final candidate = <String, dynamic>{'completed': true};
      final transferId = _transferId;
      if (transferId == null) {
        _pendingTransferCandidates.add(candidate);
      } else {
        unawaited(gateway.transferCandidate(transferId, candidate));
      }
    };

    _callKitSubscription = FlutterCallkitIncoming.onEvent.listen(_handleCallKitEvent);
    _pushToken = await FlutterCallkitIncoming.getDevicePushTokenVoIP();
    phone.addListener(_phoneChanged);
    _phoneChanged();
    debugPrint(
      '[VoiceHost Mobile] device=ready '
      'pushToken=${_pushToken?.isNotEmpty == true ? 'ready' : 'waiting'}',
    );
    unawaited(_recoverAcceptedCallKitCall());
  }

  void _phoneChanged() {
    if (!gateway.enabled) return;
    final token = _pushToken ?? '';
    final signature = [
      token,
      phone.sipUsername,
      phone.sipPassword,
      phone.sipRealm,
      phone.sipProxy,
      phone.extensionDisplayName,
      phone.doNotDisturb.toString(),
    ].join('|');
    if (signature == _lastProvisionSignature) return;
    _lastProvisionSignature = signature;
    unawaited(_provision());
  }

  Future<void> _provision() async {
    if (_provisioning) return;
    final token = _pushToken;
    final deviceId = _deviceId;
    if (token == null || token.isEmpty || deviceId == null) return;
    if (phone.sipUsername.trim().isEmpty || phone.sipPassword.isEmpty) return;

    _provisioning = true;
    try {
      await gateway.registerDevice(
        deviceId: deviceId,
        pushToken: token,
        sipUsername: phone.sipUsername,
        sipPassword: phone.sipPassword,
        sipRealm: phone.sipRealm,
        sipProxy: phone.sipProxy.trim().isEmpty ? null : phone.sipProxy.trim(),
        nickname: phone.extensionDisplayName,
        doNotDisturb: phone.doNotDisturb,
      );
      _gatewayProvisioned = true;
      notifyListeners();
      debugPrint('[VoiceHost Mobile] gateway registration active');
    } catch (error) {
      _gatewayProvisioned = false;
      notifyListeners();
      _lastProvisionSignature = null;
      debugPrint('[VoiceHost Mobile] provisioning failed: $error');
    } finally {
      _provisioning = false;
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final callId = _activeGatewayCallId;
    if (callId != null) {
      unawaited(_diag(
        'app_lifecycle',
        callId: callId,
        details: {'app_state': state.name},
      ));
    }

    // Randy owns the persistent incoming SIP registration. The handset only
    // creates a direct Janus/SIP session when originating an outgoing call.
    if ((state == AppLifecycleState.paused ||
            state == AppLifecycleState.hidden) &&
        !phone.hasActiveDirectCall) {
      unawaited(phone.disconnectDirectRegistrationIfIdle());
    }

    if (state == AppLifecycleState.resumed) {
      unawaited(_recoverAcceptedCallKitCall());
    }
  }

  Future<void> _recoverAcceptedCallKitCall() async {
    if (_recoveringCallKitState || _activeGatewayCallId != null) return;
    _recoveringCallKitState = true;
    try {
      final calls = await FlutterCallkitIncoming.activeCalls();
      for (final call in calls) {
        if (!call.isAccepted || call.id.isEmpty) continue;
        await _diag('callkit_accept_recovered', callId: call.id);
        await _accept(call.id);
        return;
      }
    } catch (error) {
      debugPrint('[VoiceHost Mobile] CallKit state recovery failed: $error');
    } finally {
      _recoveringCallKitState = false;
    }
  }

  Future<void> _handleCallKitEvent(CallEvent? event) async {
    if (event == null) return;
    if (event is CallEventActionDidUpdateDevicePushTokenVoip) {
      _pushToken = await FlutterCallkitIncoming.getDevicePushTokenVoIP();
      _lastProvisionSignature = null;
      _phoneChanged();
      return;
    }
    if (event is CallEventActionCallAccept) {
      unawaited(_diag('callkit_accept', callId: event.callKitParams.id));
      await _accept(event.callKitParams.id);
      return;
    }
    if (event is CallEventActionCallDecline) {
      unawaited(_diag('callkit_decline', callId: event.callKitParams.id));
      await _decline(event.callKitParams.id);
      return;
    }
    if (event is CallEventActionCallEnded) {
      unawaited(_diag('callkit_end', callId: event.callKitParams.id));
      await _end(event.callKitParams.id);
      return;
    }
    if (event is CallEventActionCallTimeout) {
      await _decline(event.id);
      return;
    }
    if (event is CallEventActionCallToggleMute) {
      _gatewayMuted = event.isMuted;
      await _webRtc.setMuted(event.isMuted);
      notifyListeners();
    }
  }

  Future<void> _accept(String callId) async {
    if (_activeGatewayCallId == callId) {
      debugPrint('[VoiceHost Mobile] ignoring duplicate accept for $callId');
      return;
    }
    if (_activeGatewayCallId != null) {
      await _closeGatewayMedia();
    }

    // A gateway/CallKit call must not compete with a handset SIP registration.
    await phone.disconnectDirectRegistrationIfIdle();
    _activeGatewayCallId = callId;

    try {
      final call = await gateway.getCall(callId);
      _activeGatewayCaller = call.caller;
      _activeGatewayDisplayName = call.displayName;
      _gatewayConnected = false;
      _gatewayMediaConnected = false;
      _gatewayConnectedAt = null;
      _localCandidateCount = 0;
      _remoteCandidateCount = 0;
      _gatewayMuted = false;
      _gatewaySpeakerphoneOn = false;
      notifyListeners();

      await _diag(
        'gateway_call_loaded',
        callId: callId,
        details: {'sdp_length': call.offerSdp.length},
      );
      if (call.offerSdp.isEmpty) {
        throw StateError('Gateway call has no WebRTC offer');
      }
      await _listenToGateway(callId);
      await _webRtc.preparePeerConnection(
        preservePendingRemoteCandidates: true,
      );
      final answer = await _webRtc.createAnswer(call.offerSdp);
      await gateway.answer(callId, answer);
      await _diag(
        'answer_sent',
        callId: callId,
        details: {'sdp_length': answer.length},
      );
      debugPrint('[VoiceHost Mobile] answered gateway call $callId');
    } catch (error) {
      debugPrint('[VoiceHost Mobile] answer failed: $error');
      await FlutterCallkitIncoming.endCall(callId);
      await _closeGatewayMedia();
    }
  }

  Future<void> _listenToGateway(String callId) async {
    await _gatewayEventSubscription?.cancel();
    await _gatewaySocket?.close();
    final socket = await gateway.watchCall(callId);
    _gatewaySocket = socket;
    _gatewayEventSubscription = socket.listen((raw) {
      try {
        final decoded = jsonDecode(raw.toString());
        if (decoded is! Map) return;
        final event = Map<String, dynamic>.from(decoded);
        switch (event['type']?.toString()) {
          case 'accepted':
            _gatewayConnected = true;
            _gatewayConnectedAt ??= DateTime.now();
            notifyListeners();
            unawaited(_diag(
              'gateway_accepted',
              callId: callId,
              details: {'gateway_event': 'accepted'},
            ));
            break;
          case 'trickle':
            final candidate = event['candidate'];
            if (candidate is Map) {
              _remoteCandidateCount++;
              unawaited(
                _webRtc.addRemoteCandidate(
                  Map<String, dynamic>.from(candidate),
                ),
              );
            }
            break;
          case 'transfer':
            final state = event['state']?.toString() ?? '';
            if (state == 'transferring') {
              _transferStatus = 'Transferring…';
            } else if (state == 'completed') {
              _transferStatus = 'Transfer complete';
            } else if (state == 'failed') {
              _transferStatus = 'Transfer failed';
              _transferBusy = false;
            } else if (state == 'cancelled') {
              _transferStatus = '';
              _transferBusy = false;
            }
            notifyListeners();
            break;
          case 'hangup':
            unawaited(FlutterCallkitIncoming.endCall(callId));
            unawaited(_closeTransferMedia());
            unawaited(_closeGatewayMedia());
            break;
        }
      } catch (error) {
        debugPrint('[VoiceHost Mobile] gateway event error: $error');
      }
    });
  }

  Future<void> blindTransferActiveCall(String target) async {
    final callId = _activeGatewayCallId;
    final cleanTarget = target.trim();
    if (callId == null || cleanTarget.isEmpty || _transferBusy) return;

    _transferBusy = true;
    _transferTarget = cleanTarget;
    _transferStatus = 'Transferring…';
    notifyListeners();
    try {
      await gateway.blindTransfer(callId, cleanTarget);
      await _diag('blind_transfer_requested', callId: callId);
    } catch (error) {
      _transferBusy = false;
      _transferStatus = 'Transfer failed';
      debugPrint('[VoiceHost Mobile] blind transfer failed: $error');
      notifyListeners();
    }
  }

  Future<void> startAttendedTransfer(String target) async {
    final callId = _activeGatewayCallId;
    final cleanTarget = target.trim();
    if (callId == null ||
        cleanTarget.isEmpty ||
        !_gatewayConnected ||
        _transferBusy ||
        _transferId != null) {
      return;
    }

    _transferBusy = true;
    _transferTarget = cleanTarget;
    _transferStatus = 'Calling transfer target…';
    _transferConnected = false;
    _pendingTransferCandidates.clear();
    notifyListeners();

    try {
      await _transferWebRtc.preparePeerConnection();
      final offer = await _transferWebRtc.createOffer();
      unawaited(_ringback.start());

      final transferId =
          await gateway.startAttendedTransfer(callId, cleanTarget, offer);
      if (transferId.isEmpty) {
        throw StateError('Gateway did not return a transfer id');
      }
      _transferId = transferId;

      for (final candidate
          in List<Map<String, dynamic>>.from(_pendingTransferCandidates)) {
        await gateway.transferCandidate(transferId, candidate);
      }
      _pendingTransferCandidates.clear();

      await _listenToTransfer(transferId);
      await _diag('attended_transfer_started', callId: callId);
    } catch (error) {
      await _ringback.stop();
      _transferBusy = false;
      _transferStatus = 'Transfer failed';
      debugPrint('[VoiceHost Mobile] attended transfer failed: $error');
      await _closeTransferMedia(keepStatus: true);
      notifyListeners();
    }
  }

  Future<void> _listenToTransfer(String transferId) async {
    await _transferEventSubscription?.cancel();
    await _transferSocket?.close();

    final socket = await gateway.watchTransfer(transferId);
    _transferSocket = socket;
    _transferEventSubscription = socket.listen((raw) {
      try {
        final decoded = jsonDecode(raw.toString());
        if (decoded is! Map) return;
        final event = Map<String, dynamic>.from(decoded);
        switch (event['type']?.toString()) {
          case 'calling':
            _transferStatus = 'Calling transfer target…';
            notifyListeners();
            break;
          case 'ringing':
            _transferStatus = 'Transfer target ringing…';
            unawaited(_ringback.start());
            notifyListeners();
            break;
          case 'progress':
            final jsep = event['jsep'];
            if (jsep is Map) {
              final sdp = jsep['sdp']?.toString();
              if (sdp != null && sdp.isNotEmpty) {
                unawaited(_ringback.stop());
                unawaited(_transferWebRtc.applyRemoteAnswer(sdp));
              }
            }
            _transferStatus = 'Connecting transfer target…';
            notifyListeners();
            break;
          case 'accepted':
            final jsep = event['jsep'];
            if (jsep is Map) {
              final sdp = jsep['sdp']?.toString();
              if (sdp != null && sdp.isNotEmpty) {
                unawaited(_transferWebRtc.applyRemoteAnswer(sdp));
              }
            }
            unawaited(_ringback.stop());
            _transferConnected = true;
            _transferStatus = 'Consulting ${_transferTarget ?? 'target'}';
            notifyListeners();
            break;
          case 'trickle':
            final candidate = event['candidate'];
            if (candidate is Map) {
              unawaited(
                _transferWebRtc.addRemoteCandidate(
                  Map<String, dynamic>.from(candidate),
                ),
              );
            }
            break;
          case 'transfer':
            final state = event['state']?.toString() ?? '';
            if (state == 'completing' || state == 'transferring') {
              _transferStatus = 'Completing transfer…';
            } else if (state == 'completed') {
              _transferStatus = 'Transfer complete';
              _transferBusy = false;
              unawaited(_closeTransferMedia(keepStatus: true));
            } else if (state == 'failed') {
              _transferStatus = 'Transfer failed';
              _transferBusy = false;
              unawaited(_closeTransferMedia(keepStatus: true));
            } else if (state == 'cancelled') {
              _transferStatus = '';
              _transferBusy = false;
              unawaited(_closeTransferMedia());
            }
            notifyListeners();
            break;
          case 'hangup':
            _transferStatus = 'Consultation ended';
            _transferBusy = false;
            unawaited(_ringback.stop());
            unawaited(_closeTransferMedia(keepStatus: true));
            notifyListeners();
            break;
          case 'error':
            _transferStatus = 'Transfer failed';
            _transferBusy = false;
            unawaited(_ringback.stop());
            notifyListeners();
            break;
        }
      } catch (error) {
        debugPrint('[VoiceHost Mobile] transfer event error: $error');
      }
    });
  }

  Future<void> completeAttendedTransfer() async {
    final transferId = _transferId;
    if (transferId == null || !_transferConnected) return;
    _transferStatus = 'Completing transfer…';
    notifyListeners();
    try {
      await gateway.completeAttendedTransfer(transferId);
    } catch (error) {
      _transferStatus = 'Transfer failed';
      debugPrint('[VoiceHost Mobile] complete transfer failed: $error');
      notifyListeners();
    }
  }

  Future<void> cancelAttendedTransfer() async {
    final transferId = _transferId;
    if (transferId != null) {
      try {
        await gateway.cancelAttendedTransfer(transferId);
      } catch (error) {
        debugPrint('[VoiceHost Mobile] cancel transfer failed: $error');
      }
    }
    _transferBusy = false;
    _transferStatus = '';
    await _closeTransferMedia();
    notifyListeners();
  }

  Future<void> _closeTransferMedia({bool keepStatus = false}) async {
    await _ringback.stop();
    await _transferEventSubscription?.cancel();
    _transferEventSubscription = null;
    await _transferSocket?.close();
    _transferSocket = null;
    await _transferWebRtc.close();
    _transferId = null;
    _transferConnected = false;
    _pendingTransferCandidates.clear();
    if (!keepStatus) {
      _transferTarget = null;
      _transferStatus = '';
    }
  }

  Future<void> hangupActiveCall() async {
    final callId = _activeGatewayCallId;
    if (callId == null) return;
    if (_transferId != null) {
      await cancelAttendedTransfer();
    }
    await _end(callId);
    try {
      await FlutterCallkitIncoming.endCall(callId);
    } catch (error) {
      debugPrint('[VoiceHost Mobile] CallKit end failed: $error');
    }
  }

  Future<void> toggleGatewayMute() async {
    if (_activeGatewayCallId == null) return;
    _gatewayMuted = !_gatewayMuted;
    await _webRtc.setMuted(_gatewayMuted);
    notifyListeners();
  }

  Future<void> toggleGatewaySpeakerphone() async {
    if (_activeGatewayCallId == null) return;
    _gatewaySpeakerphoneOn = !_gatewaySpeakerphoneOn;
    try {
      await _webRtc.setSpeakerphone(_gatewaySpeakerphoneOn);
    } catch (error) {
      _gatewaySpeakerphoneOn = !_gatewaySpeakerphoneOn;
      debugPrint('[VoiceHost Mobile] speaker route failed: $error');
    }
    notifyListeners();
  }

  Future<void> _decline(String callId) async {
    try {
      await gateway.decline(callId);
    } catch (error) {
      debugPrint('[VoiceHost Mobile] decline failed: $error');
    }
    await _closeGatewayMedia();
  }

  Future<void> _end(String callId) async {
    if (_activeGatewayCallId != callId) return;
    try {
      await gateway.hangup(callId);
    } catch (error) {
      debugPrint('[VoiceHost Mobile] hangup failed: $error');
    }
    await _closeGatewayMedia();
  }

  Future<void> _closeGatewayMedia() async {
    _activeGatewayCallId = null;
    _activeGatewayCaller = null;
    _activeGatewayDisplayName = null;
    _gatewayConnected = false;
    _gatewayMediaConnected = false;
    _gatewayConnectedAt = null;
    _localCandidateCount = 0;
    _remoteCandidateCount = 0;
    _gatewayMuted = false;
    _gatewaySpeakerphoneOn = false;
    _transferBusy = false;
    _transferTarget = null;
    _transferStatus = '';
    await _closeTransferMedia();
    await _gatewayEventSubscription?.cancel();
    _gatewayEventSubscription = null;
    await _gatewaySocket?.close();
    _gatewaySocket = null;
    await _webRtc.close();
    notifyListeners();
  }

  Future<void> _diag(
    String event, {
    String? callId,
    Map<String, Object> details = const {},
  }) async {
    try {
      await gateway.diagnostic(event, callId: callId, details: details);
    } catch (error) {
      debugPrint('[VoiceHost Mobile] diagnostic send failed: $error');
    }
  }

  Future<String> _loadOrCreateDeviceId() async {
    const key = 'voicehost.mobile.device_id';
    final existing = await _storage.read(key: key);
    if (existing != null && existing.isNotEmpty) return existing;
    final random = Random.secure();
    final bytes = List<int>.generate(16, (_) => random.nextInt(256));
    final id = base64UrlEncode(bytes).replaceAll('=', '');
    await _storage.write(key: key, value: id);
    return id;
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    phone.removeListener(_phoneChanged);
    unawaited(_callKitSubscription?.cancel());
    unawaited(_closeTransferMedia());
    unawaited(_closeGatewayMedia());
    super.dispose();
  }
}
