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

  StreamSubscription<CallEvent?>? _callKitSubscription;
  StreamSubscription<dynamic>? _gatewayEventSubscription;
  WebSocket? _gatewaySocket;
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

  bool get hasActiveGatewayCall => _activeGatewayCallId != null;
  bool get gatewayProvisioned => _gatewayProvisioned;
  bool get gatewayCallConnected => _gatewayConnected;
  bool get gatewayMediaConnected => _gatewayMediaConnected;
  DateTime? get gatewayConnectedAt => _gatewayConnectedAt;
  bool get gatewayMuted => _gatewayMuted;
  bool get gatewaySpeakerphoneOn => _gatewaySpeakerphoneOn;
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

    _callKitSubscription = FlutterCallkitIncoming.onEvent.listen(_handleCallKitEvent);
    _pushToken = await FlutterCallkitIncoming.getDevicePushTokenVoIP();
    phone.addListener(_phoneChanged);
    _phoneChanged();
    debugPrint(
      '[VoiceHost Mobile] device=$_deviceId '
      'pushToken=${_pushToken?.isNotEmpty == true ? 'ready' : 'waiting'}',
    );
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
      debugPrint(
        '[VoiceHost Mobile] gateway registration active for ${phone.sipUsername}',
      );
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
      await _decline(event.callKitParams.id);
      return;
    }
    if (event is CallEventActionCallEnded) {
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
          case 'hangup':
            unawaited(FlutterCallkitIncoming.endCall(callId));
            unawaited(_closeGatewayMedia());
            break;
        }
      } catch (error) {
        debugPrint('[VoiceHost Mobile] gateway event error: $error');
      }
    });
  }

  Future<void> hangupActiveCall() async {
    final callId = _activeGatewayCallId;
    if (callId == null) return;
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
    unawaited(_closeGatewayMedia());
    super.dispose();
  }
}
