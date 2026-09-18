import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter_callkit_incoming/entities/entities.dart';
import 'package:flutter_callkit_incoming/flutter_callkit_incoming.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../controllers/phone_controller.dart';
import '../core/app_config.dart';
import 'mobile_gateway_service.dart';
import 'webrtc_service.dart';

class MobileCallCoordinator {
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

  Future<void> initialize() async {
    if (!gateway.enabled || !Platform.isIOS) {
      debugPrint('[VoiceHost Mobile] gateway disabled for this build');
      return;
    }

    _deviceId = await _loadOrCreateDeviceId();
    _webRtc.onLog = (message) => debugPrint('[VoiceHost Mobile] $message');
    _webRtc.onLocalCandidate = (candidate) {
      final callId = _activeGatewayCallId;
      if (callId != null) unawaited(gateway.candidate(callId, candidate));
    };
    _webRtc.onIceGatheringComplete = () {
      final callId = _activeGatewayCallId;
      if (callId != null) {
        unawaited(gateway.candidate(callId, {'completed': true}));
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
    if (!gateway.enabled || !phone.isRegistered) return;
    final token = _pushToken ?? '';
    final signature = [
      token,
      phone.sipUsername,
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
      debugPrint(
        '[VoiceHost Mobile] gateway registration active for ${phone.sipUsername}',
      );
    } catch (error) {
      _lastProvisionSignature = null;
      debugPrint('[VoiceHost Mobile] provisioning failed: $error');
    } finally {
      _provisioning = false;
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
      await _webRtc.setMuted(event.isMuted);
    }
  }

  Future<void> _accept(String callId) async {
    try {
      final call = await gateway.getCall(callId);
      if (call.offerSdp.isEmpty) {
        throw StateError('Gateway call has no WebRTC offer');
      }
      _activeGatewayCallId = callId;
      await _listenToGateway(callId);
      await _webRtc.preparePeerConnection(
        preservePendingRemoteCandidates: true,
      );
      final answer = await _webRtc.createAnswer(call.offerSdp);
      await gateway.answer(callId, answer);
      await FlutterCallkitIncoming.setCallConnected(callId);
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
          case 'trickle':
            final candidate = event['candidate'];
            if (candidate is Map) {
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

  Future<void> _decline(String callId) async {
    try {
      await gateway.decline(callId);
    } catch (error) {
      debugPrint('[VoiceHost Mobile] decline failed: $error');
    }
    await _closeGatewayMedia();
  }

  Future<void> _end(String callId) async {
    try {
      await gateway.hangup(callId);
    } catch (error) {
      debugPrint('[VoiceHost Mobile] hangup failed: $error');
    }
    await _closeGatewayMedia();
  }

  Future<void> _closeGatewayMedia() async {
    _activeGatewayCallId = null;
    await _gatewayEventSubscription?.cancel();
    _gatewayEventSubscription = null;
    await _gatewaySocket?.close();
    _gatewaySocket = null;
    await _webRtc.close();
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

  Future<void> dispose() async {
    phone.removeListener(_phoneChanged);
    await _callKitSubscription?.cancel();
    await _closeGatewayMedia();
  }
}
