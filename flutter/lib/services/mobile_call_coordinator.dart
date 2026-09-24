import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_callkit_incoming/entities/entities.dart';
import 'package:flutter_callkit_incoming/flutter_callkit_incoming.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../controllers/phone_controller.dart';
import '../core/app_config.dart';
import '../models/call_record.dart';
import 'mobile_gateway_service.dart';
import 'ringback_service.dart';
import 'webrtc_service.dart';

class GatewayCallSummary {
  const GatewayCallSummary({
    required this.id,
    required this.displayName,
    required this.number,
    required this.connected,
    required this.held,
    required this.phase,
  });

  final String id;
  final String displayName;
  final String? number;
  final bool connected;
  final bool held;
  final String phase;
}

class MobileCallCoordinator extends ChangeNotifier with WidgetsBindingObserver {
  MobileCallCoordinator(this.phone)
      : gateway = MobileGatewayService(
          baseUrl: AppConfig.mobileGatewayUrl,
          apiKey: AppConfig.mobileGatewayKey,
        );

  final PhoneController phone;
  final MobileGatewayService gateway;
  final FlutterSecureStorage _storage = const FlutterSecureStorage();
  final WebRtcService _transferWebRtc = WebRtcService();
  final RingbackService _ringback = RingbackService();
  final Map<String, _GatewayCallContext> _gatewayCalls = {};
  final List<String> _diagnosticLogs = [];
  static const MethodChannel _nativeCallKitChannel =
      MethodChannel('voicehost/callkit');

  StreamSubscription<CallEvent?>? _callKitSubscription;
  StreamSubscription<dynamic>? _transferEventSubscription;
  WebSocket? _transferSocket;
  String? _activeGatewayCallId;
  String? _deviceId;
  String? _pushToken;
  String? _lastProvisionSignature;
  bool _provisioning = false;
  bool _gatewayProvisioned = false;
  bool _recoveringCallKitState = false;
  String? _transferId;
  String? _transferTarget;
  String _transferStatus = '';
  bool _transferConnected = false;
  bool _transferBusy = false;
  Timer? _transferWatchdog;
  final List<Map<String, dynamic>> _pendingTransferCandidates = [];

  _GatewayCallContext? get _activeGatewayCall {
    final id = _activeGatewayCallId;
    return id == null ? null : _gatewayCalls[id];
  }

  _GatewayCallContext? _contextFor(String callId) {
    final direct = _gatewayCalls[callId];
    if (direct != null) return direct;
    final normalized = callId.toLowerCase();
    for (final entry in _gatewayCalls.entries) {
      if (entry.key.toLowerCase() == normalized) return entry.value;
    }
    return null;
  }

  bool get hasActiveGatewayCall => _activeGatewayCall != null;
  int get gatewayCallCount => _gatewayCalls.length;
  bool get gatewayProvisioned => _gatewayProvisioned;
  bool get gatewayCallConnected => _activeGatewayCall?.connected ?? false;
  bool get gatewayMediaConnected => _activeGatewayCall?.mediaConnected ?? false;
  bool get gatewayHeld => _activeGatewayCall?.held ?? false;
  DateTime? get gatewayConnectedAt => _activeGatewayCall?.connectedAt;
  bool get gatewayMuted => _activeGatewayCall?.muted ?? false;
  bool get gatewaySpeakerphoneOn => _activeGatewayCall?.speakerphoneOn ?? false;
  bool get hasActiveTransfer => _transferId != null || _transferBusy;
  bool get attendedTransferActive => _transferId != null;
  bool get attendedTransferConnected => _transferConnected;
  String get transferStatus => _transferStatus;
  String? get transferTarget => _transferTarget;
  bool get hasPushToken => _pushToken?.isNotEmpty == true;
  List<String> get diagnosticLogs =>
      List<String>.unmodifiable(_diagnosticLogs.reversed);

  String get gatewayCallerDisplay {
    final active = _activeGatewayCall;
    final display = active?.displayName?.trim() ?? '';
    if (display.isNotEmpty) return display;
    final caller = active?.caller?.trim() ?? '';
    return caller.isNotEmpty ? caller : 'Unknown';
  }

  String? get gatewayCallerNumber => _activeGatewayCall?.caller;

  List<GatewayCallSummary> get otherGatewayCalls => _gatewayCalls.values
      .where((call) => call.id != _activeGatewayCallId)
      .map(
        (call) => GatewayCallSummary(
          id: call.id,
          displayName: call.displayName?.trim().isNotEmpty == true
              ? call.displayName!.trim()
              : (call.caller?.trim().isNotEmpty == true
                  ? call.caller!.trim()
                  : 'Unknown'),
          number: call.caller,
          connected: call.connected,
          held: call.held,
          phase: call.phase,
        ),
      )
      .toList(growable: false);

  void _appendDiagnostic(String message) {
    final timestamp = DateTime.now().toIso8601String();
    _diagnosticLogs.add('$timestamp  $message');
    if (_diagnosticLogs.length > 250) {
      _diagnosticLogs.removeRange(0, _diagnosticLogs.length - 250);
    }
    debugPrint('[VoiceHost Mobile] $message');
    notifyListeners();
  }

  void clearDiagnosticLogs() {
    _diagnosticLogs.clear();
    notifyListeners();
  }

  Future<String> sendTestPush() async {
    final deviceId = _deviceId;
    if (!gateway.enabled) {
      throw StateError('Mobile gateway is not configured in this build.');
    }
    if (deviceId == null || !_gatewayProvisioned) {
      throw StateError('This device is not provisioned with the mobile gateway.');
    }
    if (!hasPushToken) {
      throw StateError('No PushKit token is available on this device.');
    }

    _appendDiagnostic('Push test requested');
    try {
      final environment = await gateway.testPush(deviceId);
      _appendDiagnostic(
        environment.isEmpty
            ? 'Push test accepted by gateway'
            : 'Push test sent via APNs $environment',
      );
      return environment;
    } catch (error) {
      _appendDiagnostic('Push test failed: $error');
      rethrow;
    }
  }

  Future<void> initialize() async {
    if (!gateway.enabled || !Platform.isIOS) {
      _appendDiagnostic('Mobile gateway disabled for this build');
      return;
    }

    WidgetsBinding.instance.addObserver(this);
    _deviceId = await _loadOrCreateDeviceId();
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
    _appendDiagnostic(
      'Device ready · PushKit token '
      '${_pushToken?.isNotEmpty == true ? 'available' : 'waiting'}',
    );
    unawaited(_recoverCallKitState());
    _scheduleCallKitRecoveryRetries();
  }

  void _scheduleCallKitRecoveryRetries() {
    for (final delay in const [
      Duration(milliseconds: 250),
      Duration(seconds: 1),
      Duration(seconds: 3),
    ]) {
      unawaited(
        Future<void>.delayed(delay, () async {
          if (!gateway.enabled) return;
          await _recoverCallKitState();
        }),
      );
    }
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
      _appendDiagnostic('Mobile gateway registration active');
    } catch (error) {
      _gatewayProvisioned = false;
      notifyListeners();
      _lastProvisionSignature = null;
      _appendDiagnostic('Gateway provisioning failed: $error');
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
      unawaited(_recoverCallKitState());
      _scheduleCallKitRecoveryRetries();
    }
  }

  Future<void> _recoverCallKitState() async {
    await _drainNativeCallKitActions();
    await _recoverAcceptedCallKitCall();
  }

  Future<void> _drainNativeCallKitActions() async {
    try {
      final raw = await _nativeCallKitChannel
              .invokeMethod<List<dynamic>>('drainPendingActions') ??
          const <dynamic>[];

      for (final item in raw) {
        if (item is! Map) continue;
        final action = Map<String, dynamic>.from(item);
        final type = action['type']?.toString() ?? '';
        final id = action['id']?.toString() ?? '';
        if (id.isEmpty) continue;

        switch (type) {
          case 'accept':
            await _diag('callkit_accept_native_recovered', callId: id);
            await _accept(id);
            break;
          case 'decline':
            await _diag('callkit_decline_native_recovered', callId: id);
            await _decline(id);
            break;
          case 'end':
            await _diag('callkit_end_native_recovered', callId: id);
            await _end(id);
            break;
        }
      }
    } on MissingPluginException {
      // Native recovery bridge is not present on older/local builds.
    } catch (error) {
      _appendDiagnostic('Native CallKit recovery failed: $error');
    }
  }

  Future<void> _recoverAcceptedCallKitCall() async {
    if (_recoveringCallKitState) return;
    _recoveringCallKitState = true;
    try {
      final calls = await FlutterCallkitIncoming.activeCalls();
      for (final call in calls) {
        if (call.id.isEmpty) continue;
        if (call.isAccepted) {
          if (_contextFor(call.id)?.connected == true) continue;
          await _diag('callkit_accept_recovered', callId: call.id);
          await _accept(call.id);
        } else {
          await _trackIncomingCall(call.id);
        }
      }
    } catch (error) {
      _appendDiagnostic('CallKit state recovery failed: $error');
    } finally {
      _recoveringCallKitState = false;
    }
  }

  Future<void> _handleCallKitEvent(CallEvent? event) async {
    if (event == null) return;
    if (event is CallEventActionDidUpdateDevicePushTokenVoip) {
      _pushToken = await FlutterCallkitIncoming.getDevicePushTokenVoIP();
      _appendDiagnostic(
        'PushKit token updated · '
        '${_pushToken?.isNotEmpty == true ? 'available' : 'empty'}',
      );
      _lastProvisionSignature = null;
      _phoneChanged();
      return;
    }
    if (event is CallEventActionCallIncoming) {
      _appendDiagnostic('CallKit incoming event received');
      unawaited(_trackIncomingCall(event.callKitParams.id));
      return;
    }
    if (event is CallEventActionCallAccept) {
      _appendDiagnostic('CallKit accept event received');
      unawaited(_diag('callkit_accept', callId: event.callKitParams.id));
      await _accept(event.callKitParams.id);
      return;
    }
    if (event is CallEventActionCallDecline) {
      _appendDiagnostic('CallKit decline event received');
      unawaited(_diag('callkit_decline', callId: event.callKitParams.id));
      await _decline(event.callKitParams.id);
      return;
    }
    if (event is CallEventActionCallEnded) {
      _appendDiagnostic('CallKit end event received');
      unawaited(_diag('callkit_end', callId: event.callKitParams.id));
      await _end(event.callKitParams.id);
      return;
    }
    if (event is CallEventActionCallTimeout) {
      await _decline(event.id);
      return;
    }
    if (event is CallEventActionCallToggleMute) {
      final context = _contextFor(event.id);
      if (context == null) return;
      context.muted = event.isMuted;
      await context.webRtc.setMuted(context.held || context.muted);
      notifyListeners();
      return;
    }
    if (event is CallEventActionCallToggleHold) {
      final context = _contextFor(event.id);
      if (context == null) return;
      await _setGatewayHold(
        context.id,
        event.isOnHold,
        syncCallKit: false,
      );
    }
  }

  void _configureGatewayCall(_GatewayCallContext context) {
    context.webRtc.onLog =
        (message) => debugPrint('[VoiceHost Mobile] media: $message');
    context.webRtc.onLocalCandidate = (candidate) {
      context.localCandidateCount++;
      unawaited(gateway.candidate(context.id, candidate));
    };
    context.webRtc.onIceConnectionStateChanged = (state) {
      final normalized = state.toLowerCase();
      context.mediaConnected =
          normalized.endsWith('stateconnected') ||
          normalized.endsWith('statecompleted');
      notifyListeners();
      unawaited(_diag(
        'ice_state',
        callId: context.id,
        details: {
          'ice_state': state,
          'local_candidates': context.localCandidateCount,
          'remote_candidates': context.remoteCandidateCount,
        },
      ));
    };
    context.webRtc.onConnectionStateChanged = (state) {
      unawaited(_diag(
        'peer_state',
        callId: context.id,
        details: {'peer_state': state},
      ));
    };
    context.webRtc.onLocalAudioReady = (count) {
      unawaited(_diag(
        'local_audio_ready',
        callId: context.id,
        details: {'local_audio_tracks': count},
      ));
    };
    context.webRtc.onRemoteAudioReady = (count) {
      unawaited(_diag(
        'remote_audio_ready',
        callId: context.id,
        details: {'remote_audio_tracks': count},
      ));
    };
    context.webRtc.onIceGatheringComplete = () {
      unawaited(gateway.candidate(context.id, {'completed': true}));
      unawaited(_diag(
        'ice_gathering_complete',
        callId: context.id,
        details: {
          'local_candidates': context.localCandidateCount,
          'remote_candidates': context.remoteCandidateCount,
        },
      ));
    };
  }

  Future<void> _trackIncomingCall(String requestedCallId) async {
    if (_contextFor(requestedCallId) != null) return;
    try {
      final call = await gateway.getCall(requestedCallId);
      final context = _GatewayCallContext(call.id)
        ..caller = call.caller
        ..displayName = call.displayName
        ..startedAt = DateTime.now()
        ..phase = 'ringing';
      _configureGatewayCall(context);
      _gatewayCalls[context.id] = context;
      await _listenToGateway(context);
      _appendDiagnostic('Incoming gateway call tracked');
      notifyListeners();
    } catch (error) {
      _appendDiagnostic('Incoming call tracking failed: $error');
    }
  }

  Future<void> _accept(String requestedCallId) async {
    final existing = _contextFor(requestedCallId);
    if (existing?.answering == true || existing?.connected == true) {
      return;
    }

    await phone.disconnectDirectRegistrationIfIdle();

    final previous = _activeGatewayCall;
    if (previous != null &&
        previous.id.toLowerCase() != requestedCallId.toLowerCase() &&
        previous.connected &&
        !previous.held) {
      await _setGatewayHold(previous.id, true);
    }

    _GatewayCallContext? context = existing;
    try {
      final call = await gateway.getCall(requestedCallId);
      context ??= _GatewayCallContext(call.id)..startedAt = DateTime.now();
      if (!_gatewayCalls.containsKey(context.id)) {
        _configureGatewayCall(context);
        _gatewayCalls[context.id] = context;
      }

      context.answering = true;
      context.caller = call.caller;
      context.displayName = call.displayName;
      context.connected = call.connected;
      context.held = call.held;
      context.mediaConnected = false;
      context.connectedAt = call.connected ? DateTime.now() : null;
      context.localCandidateCount = 0;
      context.remoteCandidateCount = 0;
      _activeGatewayCallId = context.id;
      notifyListeners();

      await _diag(
        'gateway_call_loaded',
        callId: context.id,
        details: {'sdp_length': call.offerSdp.length},
      );
      if (call.offerSdp.isEmpty) {
        throw StateError('Gateway call has no WebRTC offer');
      }

      if (context.socket == null) {
        await _listenToGateway(context);
      }
      await context.webRtc.preparePeerConnection(
        preservePendingRemoteCandidates: true,
      );
      final answer = await context.webRtc.createAnswer(call.offerSdp);
      await gateway.answer(context.id, answer);
      await _diag(
        'answer_sent',
        callId: context.id,
        details: {'sdp_length': answer.length},
      );
      _appendDiagnostic('Gateway call answer sent');
    } catch (error) {
      _appendDiagnostic('Gateway call answer failed: $error');
      final id = context?.id ?? requestedCallId;
      try {
        await FlutterCallkitIncoming.endCall(id);
      } catch (_) {}
      await _closeGatewayCall(id);
    } finally {
      if (context != null) context.answering = false;
    }
  }

  Future<void> _listenToGateway(_GatewayCallContext context) async {
    await context.subscription?.cancel();
    await context.socket?.close();

    final socket = await gateway.watchCall(context.id);
    context.socket = socket;
    context.subscription = socket.listen((raw) {
      try {
        final decoded = jsonDecode(raw.toString());
        if (decoded is! Map) return;
        final event = Map<String, dynamic>.from(decoded);
        switch (event['type']?.toString()) {
          case 'calling':
            context.phase = 'calling';
            if (context.outgoing) unawaited(_ringback.start());
            notifyListeners();
            break;
          case 'ringing':
            context.phase = 'ringing';
            if (context.outgoing) unawaited(_ringback.start());
            notifyListeners();
            break;
          case 'progress':
            context.phase = 'ringing';
            final progressJsep = event['jsep'];
            if (context.outgoing && progressJsep is Map) {
              final sdp = progressJsep['sdp']?.toString();
              if (sdp != null && sdp.isNotEmpty) {
                unawaited(context.webRtc.applyRemoteAnswer(sdp));
              }
            }
            notifyListeners();
            break;
          case 'accepted':
            final acceptedJsep = event['jsep'];
            if (context.outgoing && acceptedJsep is Map) {
              final sdp = acceptedJsep['sdp']?.toString();
              if (sdp != null && sdp.isNotEmpty) {
                unawaited(context.webRtc.applyRemoteAnswer(sdp));
              }
            }
            if (context.outgoing) unawaited(_ringback.stop());
            context.phase = 'connected';
            context.connected = true;
            context.held = false;
            context.connectedAt ??= DateTime.now();
            unawaited(FlutterCallkitIncoming.setCallConnected(context.id));
            notifyListeners();
            unawaited(_diag(
              'gateway_accepted',
              callId: context.id,
              details: {'gateway_event': 'accepted'},
            ));
            break;
          case 'hold':
            context.held = event['held'] == true;
            context.phase = context.held ? 'held' : 'connected';
            unawaited(
              context.webRtc.setMuted(context.held || context.muted),
            );
            notifyListeners();
            break;
          case 'trickle':
            final candidate = event['candidate'];
            if (candidate is Map) {
              context.remoteCandidateCount++;
              unawaited(
                context.webRtc.addRemoteCandidate(
                  Map<String, dynamic>.from(candidate),
                ),
              );
            }
            break;
          case 'transfer':
            if (context.id != _activeGatewayCallId) break;
            final state = event['state']?.toString() ?? '';
            if (state == 'transferring') {
              _transferStatus = 'Transferring…';
            } else if (state == 'completed') {
              _transferWatchdog?.cancel();
              _transferStatus = 'Transfer complete';
              _transferBusy = false;
            } else if (state == 'failed') {
              _transferWatchdog?.cancel();
              final status = event['status']?.toString();
              _transferStatus = status == null || status.isEmpty
                  ? 'Transfer failed'
                  : 'Transfer failed ($status)';
              _transferBusy = false;
              _transferTarget = null;
            } else if (state == 'cancelled') {
              _transferStatus = '';
              _transferBusy = false;
            }
            notifyListeners();
            break;
          case 'hangup':
            if (context.outgoing) unawaited(_ringback.stop());
            unawaited(FlutterCallkitIncoming.endCall(context.id));
            if (context.id == _activeGatewayCallId) {
              unawaited(_closeTransferMedia());
            }
            final result = context.connected
                ? CallResult.completed
                : context.outgoing
                    ? CallResult.failed
                    : CallResult.missed;
            unawaited(_closeGatewayCall(context.id, result: result));
            break;
        }
      } catch (error) {
        debugPrint('[VoiceHost Mobile] gateway event error: $error');
      }
    });
  }

  Future<void> _setGatewayHold(
    String callId,
    bool held, {
    bool syncCallKit = true,
  }) async {
    final context = _contextFor(callId);
    if (context == null || !context.connected) return;

    if (!held) {
      for (final other in _gatewayCalls.values.toList(growable: false)) {
        if (other.id == context.id || !other.connected || other.held) continue;
        await _setGatewayHold(other.id, true);
      }
      _activeGatewayCallId = context.id;
    }

    if (context.held == held) {
      notifyListeners();
      return;
    }

    try {
      if (held) {
        await gateway.hold(context.id);
      } else {
        await gateway.resume(context.id);
      }
      context.held = held;
      context.phase = held ? 'held' : 'connected';
      await context.webRtc.setMuted(held || context.muted);

      if (syncCallKit) {
        try {
          await FlutterCallkitIncoming.holdCall(
            context.id,
            isOnHold: held,
          );
        } catch (error) {
          debugPrint('[VoiceHost Mobile] CallKit hold sync failed: $error');
        }
      }
      notifyListeners();
    } catch (error) {
      debugPrint('[VoiceHost Mobile] hold/resume failed: $error');
    }
  }

  Future<void> toggleGatewayHold() async {
    final active = _activeGatewayCall;
    if (active == null || !active.connected) return;
    await _setGatewayHold(active.id, !active.held);
  }

  Future<void> switchToGatewayCall(String callId) async {
    final target = _contextFor(callId);
    if (target == null || !target.connected) return;

    final current = _activeGatewayCall;
    if (current != null && current.id != target.id && !current.held) {
      await _setGatewayHold(current.id, true);
    }
    _activeGatewayCallId = target.id;
    if (target.held) {
      await _setGatewayHold(target.id, false);
    } else {
      notifyListeners();
    }
  }

  Future<void> placeCall(String number) async {
    final target = number.trim();
    if (target.isEmpty) return;

    final deviceId = _deviceId;
    if (!_gatewayProvisioned || deviceId == null) {
      await phone.placeCall(target);
      return;
    }

    if (_gatewayCalls.length >= 2) {
      debugPrint('[VoiceHost Mobile] no free mobile call slot');
      return;
    }

    final previous = _activeGatewayCall;
    if (previous != null && previous.connected && !previous.held) {
      await _setGatewayHold(previous.id, true);
    }

    final webRtc = WebRtcService();
    final pendingCandidates = <Map<String, dynamic>>[];
    webRtc.onLog =
        (message) => debugPrint('[VoiceHost Mobile] outbound media: $message');
    webRtc.onLocalCandidate = pendingCandidates.add;
    webRtc.onIceGatheringComplete = () {
      pendingCandidates.add({'completed': true});
    };

    try {
      await _ringback.start();
      _appendDiagnostic('Local ringback requested');
      await webRtc.preparePeerConnection();
      final offer = await webRtc.createOffer();
      final callId = await gateway.startCall(
        deviceId: deviceId,
        target: target,
        offerSdp: offer,
      );
      if (callId.isEmpty) {
        throw StateError('Gateway did not return a call id');
      }

      final context = _GatewayCallContext(callId, webRtc: webRtc)
        ..caller = target
        ..displayName = target
        ..startedAt = DateTime.now()
        ..outgoing = true
        ..phase = 'calling';
      _gatewayCalls[callId] = context;
      _activeGatewayCallId = callId;
      _configureGatewayCall(context);

      await FlutterCallkitIncoming.startCall(
        CallKitParams(
          id: callId,
          nameCaller: target,
          handle: target,
          type: 0,
          extra: const {'source': 'voicehost-mobile-gateway'},
          ios: const IOSParams(
            handleType: 'number',
            normalHandle: 1,
            supportsVideo: false,
            maximumCallGroups: 2,
            maximumCallsPerCallGroup: 1,
            supportsDTMF: false,
            supportsHolding: true,
            supportsGrouping: false,
            supportsUngrouping: false,
            configureAudioSession: false,
            audioSessionMode: 'voiceChat',
            audioSessionActive: false,
          ),
        ),
      );

      await _listenToGateway(context);

      for (final candidate in pendingCandidates) {
        await gateway.candidate(callId, candidate);
      }
      pendingCandidates.clear();

      await _diag('outbound_call_started', callId: callId);
      notifyListeners();
    } catch (error) {
      await _ringback.stop();
      await webRtc.close();
      final active = _activeGatewayCall;
      if (active != null && active.outgoing && active.caller == target) {
        try {
          await FlutterCallkitIncoming.endCall(active.id);
        } catch (_) {}
        await _closeGatewayCall(
          active.id,
          result: CallResult.failed,
          resumeAnother: false,
        );
        _activeGatewayCallId = null;
      }
      debugPrint('[VoiceHost Mobile] outgoing call failed: $error');
      if (previous != null && previous.held) {
        await _setGatewayHold(previous.id, false);
      }
    }
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
      _transferWatchdog?.cancel();
      _transferWatchdog = Timer(const Duration(seconds: 22), () {
        if (_transferBusy && _transferId == null) {
          _transferBusy = false;
          _transferTarget = null;
          _transferStatus = 'Transfer not completed';
          notifyListeners();
        }
      });
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
        !gatewayCallConnected ||
        gatewayHeld ||
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
              final status = event['status']?.toString();
              _transferStatus = status == null || status.isEmpty
                  ? 'Transfer failed'
                  : 'Transfer failed ($status)';
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
    final active = _activeGatewayCall;
    if (active == null) return;
    if (_transferId != null) {
      await cancelAttendedTransfer();
    }
    await _end(active.id);
    try {
      await FlutterCallkitIncoming.endCall(active.id);
    } catch (error) {
      debugPrint('[VoiceHost Mobile] CallKit end failed: $error');
    }
  }

  Future<void> toggleGatewayMute() async {
    final active = _activeGatewayCall;
    if (active == null) return;
    active.muted = !active.muted;
    await active.webRtc.setMuted(active.held || active.muted);
    notifyListeners();
  }

  Future<void> sendGatewayDtmf(String digit) async {
    final active = _activeGatewayCall;
    if (active == null || !active.connected) return;

    const allowedDigits = '0123456789*#ABCD';
    if (digit.length != 1 || !allowedDigits.contains(digit)) return;

    try {
      await gateway.sendDtmf(active.id, digit);
      _appendDiagnostic('DTMF sent · digit=$digit');
    } catch (error) {
      _appendDiagnostic('DTMF failed: $error');
    }
  }

  Future<void> toggleGatewaySpeakerphone() async {
    final active = _activeGatewayCall;
    if (active == null) return;
    active.speakerphoneOn = !active.speakerphoneOn;
    try {
      await active.webRtc.setSpeakerphone(active.speakerphoneOn);
    } catch (error) {
      active.speakerphoneOn = !active.speakerphoneOn;
      debugPrint('[VoiceHost Mobile] speaker route failed: $error');
    }
    notifyListeners();
  }

  Future<void> _decline(String requestedCallId) async {
    final context = _contextFor(requestedCallId);
    final callId = context?.id ?? requestedCallId;
    try {
      await gateway.decline(callId);
    } catch (error) {
      debugPrint('[VoiceHost Mobile] decline failed: $error');
    }
    if (context != null) {
      await _closeGatewayCall(
        context.id,
        result: context.connected
            ? CallResult.completed
            : CallResult.declined,
      );
    }
  }

  Future<void> _end(String requestedCallId) async {
    final context = _contextFor(requestedCallId);
    final callId = context?.id ?? requestedCallId;
    try {
      await gateway.hangup(callId);
    } catch (error) {
      debugPrint('[VoiceHost Mobile] hangup failed: $error');
    }
    if (context != null) {
      await _closeGatewayCall(
        context.id,
        result: context.connected
            ? CallResult.completed
            : context.outgoing
                ? CallResult.cancelled
                : CallResult.declined,
      );
    }
  }

  Future<void> _closeGatewayCall(
    String requestedCallId, {
    bool resumeAnother = true,
    CallResult? result,
  }) async {
    final context = _contextFor(requestedCallId);
    if (context == null) return;

    final wasActive = _activeGatewayCallId == context.id;
    if (wasActive && _transferId != null) {
      await _closeTransferMedia();
    }

    await context.subscription?.cancel();
    context.subscription = null;
    await context.socket?.close();
    context.socket = null;
    await context.webRtc.close();

    if (!context.historyRecorded && result != null) {
      context.historyRecorded = true;
      await phone.recordExternalCall(
        direction: context.outgoing
            ? CallDirection.outgoing
            : CallDirection.incoming,
        number: context.caller?.trim().isNotEmpty == true
            ? context.caller!.trim()
            : 'Unknown',
        displayName: context.displayName,
        startedAt: context.startedAt ?? DateTime.now(),
        connectedAt: context.connectedAt,
        result: result,
      );
      _appendDiagnostic('Call history updated · result=${result.name}');
    }

    _gatewayCalls.remove(context.id);

    if (wasActive) {
      _activeGatewayCallId = null;
      final remaining = _gatewayCalls.values
          .where((call) => call.connected)
          .toList(growable: false);
      if (remaining.isNotEmpty) {
        final next = remaining.first;
        _activeGatewayCallId = next.id;
        if (resumeAnother && next.held) {
          await _setGatewayHold(next.id, false);
        }
      }
    }

    if (_gatewayCalls.isEmpty) {
      _transferWatchdog?.cancel();
      _transferBusy = false;
      _transferTarget = null;
      _transferStatus = '';
    }
    notifyListeners();
  }

  Future<void> _closeAllGatewayCalls() async {
    final ids = _gatewayCalls.keys.toList(growable: false);
    for (final id in ids) {
      await _closeGatewayCall(id, resumeAnother: false);
    }
    _activeGatewayCallId = null;
  }

  Future<void> _diag(
    String event, {
    String? callId,
    Map<String, Object> details = const {},
  }) async {
    final detailText = details.isEmpty
        ? ''
        : ' · ${details.entries.map((entry) => '${entry.key}=${entry.value}').join(', ')}';
    _appendDiagnostic('$event$detailText');
    try {
      await gateway.diagnostic(event, callId: callId, details: details);
    } catch (error) {
      _appendDiagnostic('Diagnostic upload failed: $error');
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
    _transferWatchdog?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    phone.removeListener(_phoneChanged);
    unawaited(_callKitSubscription?.cancel());
    unawaited(_closeTransferMedia());
    unawaited(_closeAllGatewayCalls());
    super.dispose();
  }
}


class _GatewayCallContext {
  _GatewayCallContext(this.id, {WebRtcService? webRtc})
      : webRtc = webRtc ?? WebRtcService();

  final String id;
  final WebRtcService webRtc;
  bool outgoing = false;
  String phase = 'connecting';
  StreamSubscription<dynamic>? subscription;
  WebSocket? socket;
  String? caller;
  String? displayName;
  DateTime? startedAt;
  bool historyRecorded = false;
  bool answering = false;
  bool connected = false;
  bool mediaConnected = false;
  bool held = false;
  bool muted = false;
  bool speakerphoneOn = false;
  DateTime? connectedAt;
  int localCandidateCount = 0;
  int remoteCandidateCount = 0;
}
