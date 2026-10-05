import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_callkit_incoming/entities/entities.dart';
import 'package:flutter_callkit_incoming/flutter_callkit_incoming.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';

import '../controllers/phone_controller.dart';
import '../core/app_config.dart';
import '../models/call_record.dart';
import '../models/provisioning.dart';
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
  final Set<String> _acceptingCallIds = <String>{};
  final List<String> _diagnosticLogs = [];
  static const MethodChannel _nativeCallKitChannel =
      MethodChannel('voicehost/callkit');
  static const MethodChannel _nativeNotificationChannel =
      MethodChannel('voicehost/notifications');

  StreamSubscription<CallEvent?>? _callKitSubscription;
  StreamSubscription<dynamic>? _transferEventSubscription;
  WebSocket? _transferSocket;
  String? _activeGatewayCallId;
  String? _deviceId;
  String? _pushToken;
  String? _notificationToken;
  String? _pendingNavigationTarget;
  String? _lastProvisionSignature;
  bool _provisioning = false;
  bool _gatewayProvisioned = false;
  bool _administrativelyLocked = false;
  bool _provisioningAccessEnabled = false;
  bool _managedReprovisionPending = false;
  bool _recoveringCallKitState = false;
  String? _transferId;
  String? _transferTarget;
  String _transferStatus = '';
  bool _transferConnected = false;
  bool _transferBusy = false;
  Timer? _transferWatchdog;
  Timer? _voicemailPollTimer;
  Timer? _provisionRetryTimer;
  int _provisionRetryAttempt = 0;
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
  bool get gatewayProvisioning => _provisioning;
  bool get gatewayCallConnected => _activeGatewayCall?.connected ?? false;
  bool get gatewayMediaConnected => _activeGatewayCall?.mediaConnected ?? false;
  bool get gatewayHeld => _activeGatewayCall?.held ?? false;
  DateTime? get gatewayConnectedAt => _activeGatewayCall?.connectedAt;
  bool get gatewayMuted => _activeGatewayCall?.muted ?? false;
  bool get gatewaySpeakerphoneOn => _activeGatewayCall?.speakerphoneOn ?? false;
  bool get gatewayVideoEnabled => _activeGatewayCall?.webRtc.videoEnabled ?? false;
  bool get gatewayRemoteVideoAvailable =>
      _activeGatewayCall?.webRtc.remoteVideoAvailable ?? false;
  bool get gatewayIncomingVideoOffered =>
      _activeGatewayCall?.incomingVideoOffered ?? false;
  RTCVideoRenderer? get gatewayLocalVideoRenderer =>
      _activeGatewayCall?.webRtc.localRenderer;
  RTCVideoRenderer? get gatewayRemoteVideoRenderer =>
      _activeGatewayCall?.webRtc.remoteRenderer;
  bool get hasActiveTransfer => _transferId != null || _transferBusy;
  bool get attendedTransferActive => _transferId != null;
  bool get attendedTransferConnected => _transferConnected;
  String get transferStatus => _transferStatus;
  String? get transferTarget => _transferTarget;
  bool get hasPushToken => _pushToken?.isNotEmpty == true;
  String? get voipPushToken => _pushToken;
  String? get notificationPushToken => _notificationToken;
  String? get pendingNavigationTarget => _pendingNavigationTarget;
  String? get runtimeDeviceId => _deviceId;

  String? consumeNavigationTarget() {
    final target = _pendingNavigationTarget;
    _pendingNavigationTarget = null;
    return target;
  }
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

  bool get administrativelyLocked => _administrativelyLocked;
  bool get provisioningAccessEnabled => _provisioningAccessEnabled;

  Future<void> setProvisioningAccess(bool enabled) async {
    if (_provisioningAccessEnabled == enabled) return;
    _provisioningAccessEnabled = enabled;
    _lastProvisionSignature = null;

    if (!enabled) {
      _gatewayProvisioned = false;
      _provisionRetryTimer?.cancel();
      _provisionRetryTimer = null;
      final ids = _gatewayCalls.keys.toList(growable: false);
      for (final id in ids) {
        try {
          await _end(id);
        } catch (_) {}
        try {
          await FlutterCallkitIncoming.endCall(id);
        } catch (_) {}
      }

      final deviceId = _deviceId;
      if (gateway.enabled && deviceId != null) {
        try {
          await gateway.deactivateDevice(deviceId);
          _appendDiagnostic('Mobile gateway registration deactivated');
        } catch (error) {
          // Local lockout must still succeed if RANDY is temporarily
          // unreachable. A later successful registration re-enables PushKit.
          _appendDiagnostic('Mobile gateway deactivation failed: $error');
        }
      }

      await phone.disconnectDirectRegistrationIfIdle();
      _appendDiagnostic('Provisioning access disabled');
    } else {
      _appendDiagnostic('Provisioning access enabled');
      _phoneChanged();
    }
    notifyListeners();
  }

  Future<void> setAdministrativeLocked(bool locked) async {
    if (_administrativelyLocked == locked) return;
    _administrativelyLocked = locked;
    _lastProvisionSignature = null;

    if (locked) {
      _appendDiagnostic('Administrative device lock applied');

      final callIds = _gatewayCalls.keys.toList(growable: false);
      for (final callId in callIds) {
        try {
          await _end(callId);
        } catch (_) {}
        try {
          await FlutterCallkitIncoming.endCall(callId);
        } catch (_) {}
      }

      if (phone.hasActiveDirectCall) {
        try {
          await phone.hangup();
        } catch (_) {}
      } else {
        unawaited(phone.disconnectDirectRegistrationIfIdle());
      }
    } else {
      _appendDiagnostic('Administrative device lock cleared');
    }

    _phoneChanged();
    notifyListeners();
  }

  void applyProvisionedConfiguration(ProvisioningConfiguration config) {
    final managedUrl = config.randyUrl?.trim() ?? '';
    if (managedUrl.isEmpty || managedUrl == gateway.baseUrl.trim()) return;
    if (hasActiveGatewayCall) {
      _appendDiagnostic(
        'Managed RANDY URL update deferred while a call is active',
      );
      return;
    }

    gateway.configure(baseUrl: managedUrl);
    _gatewayProvisioned = false;
    _lastProvisionSignature = null;
    _appendDiagnostic('Managed RANDY endpoint applied');
    _phoneChanged();
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

    _callKitSubscription =
        FlutterCallkitIncoming.onEvent.listen(_handleCallKitEvent);
    _nativeNotificationChannel.setMethodCallHandler(_handleNativeNotification);
    _pushToken = await FlutterCallkitIncoming.getDevicePushTokenVoIP();
    try {
      _notificationToken = await _nativeNotificationChannel
          .invokeMethod<String>('getNotificationToken');
      final pending = await _nativeNotificationChannel
          .invokeMethod<List<dynamic>>('drainPendingActions');
      for (final item in pending ?? const <dynamic>[]) {
        if (item?.toString() == 'voicemail') {
          _pendingNavigationTarget = 'voicemail';
        }
      }
    } on MissingPluginException {
      _notificationToken = null;
    } catch (error) {
      debugPrint('[VoiceHost Mobile] notification bridge startup failed: $error');
    }
    phone.addListener(_phoneChanged);
    _phoneChanged();
    _appendDiagnostic(
      'Device ready · PushKit token '
      '${_pushToken?.isNotEmpty == true ? 'available' : 'waiting'}',
    );
    _schedulePushTokenRefreshRetries();
    unawaited(_recoverCallKitState());
    _scheduleCallKitRecoveryRetries();
    _voicemailPollTimer?.cancel();
    _voicemailPollTimer = Timer.periodic(
      const Duration(seconds: 30),
      (_) => unawaited(_refreshVoicemail()),
    );
    unawaited(_refreshVoicemail());
  }

  Future<dynamic> _handleNativeNotification(MethodCall call) async {
    switch (call.method) {
      case 'notificationTokenUpdated':
        final token = call.arguments?.toString() ?? '';
        if (token.isNotEmpty && token != _notificationToken) {
          _notificationToken = token;
          _lastProvisionSignature = null;
          _appendDiagnostic('APNs notification token updated');
          _phoneChanged();
        }
        break;
      case 'notificationReceived':
        if (call.arguments?.toString() == 'voicemail') {
          unawaited(_refreshVoicemail());
        }
        break;
      case 'notificationTapped':
        if (call.arguments?.toString() == 'voicemail') {
          _pendingNavigationTarget = 'voicemail';
          notifyListeners();
          unawaited(_refreshVoicemail());
          // Clear the native persisted fallback when the live Dart handler
          // has received the tap, avoiding a duplicate deep link next launch.
          unawaited(
            _nativeNotificationChannel
                .invokeMethod<List<dynamic>>('drainPendingActions')
                .catchError((_) => <dynamic>[]),
          );
        }
        break;
    }
    return null;
  }

  void _schedulePushTokenRefreshRetries() {
    for (final delay in const [
      Duration(milliseconds: 250),
      Duration(seconds: 1),
      Duration(seconds: 3),
      Duration(seconds: 6),
    ]) {
      unawaited(
        Future<void>.delayed(delay, () async {
          try {
            final token =
                await FlutterCallkitIncoming.getDevicePushTokenVoIP();
            if (token == null || token.isEmpty || token == _pushToken) return;
            _pushToken = token;
            _lastProvisionSignature = null;
            _appendDiagnostic(
              'PushKit token recovered after startup · available',
            );
            _phoneChanged();
          } catch (error) {
            debugPrint(
              '[VoiceHost Mobile] PushKit token refresh failed: $error',
            );
          }
        }),
      );
    }
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
    if (!gateway.enabled || !_provisioningAccessEnabled) return;
    if (hasActiveGatewayCall) {
      if (!_managedReprovisionPending) {
        _appendDiagnostic(
          'Managed gateway registration update deferred while a call is active',
        );
      }
      _managedReprovisionPending = true;
      _lastProvisionSignature = null;
      return;
    }
    _managedReprovisionPending = false;
    final token = _pushToken ?? '';
    final signature = [
      token,
      _notificationToken ?? '',
      phone.sipUsername,
      phone.sipPassword,
      phone.sipRealm,
      phone.sipProxy,
      phone.extensionDisplayName,
      phone.doNotDisturb.toString(),
      _administrativelyLocked.toString(),
    ].join('|');
    if (signature == _lastProvisionSignature) return;
    _lastProvisionSignature = signature;
    unawaited(_provision());
  }

  Future<void> _provision() async {
    if (_provisioning || !_provisioningAccessEnabled) return;
    final token = _pushToken;
    final deviceId = _deviceId;
    if (token == null || token.isEmpty || deviceId == null) return;
    if (phone.sipUsername.trim().isEmpty || phone.sipPassword.isEmpty) return;

    _provisioning = true;
    try {
      await gateway.registerDevice(
        deviceId: deviceId,
        pushToken: token,
        notificationToken: _notificationToken,
        sipUsername: phone.sipUsername,
        sipPassword: phone.sipPassword,
        sipRealm: phone.sipRealm,
        sipProxy: phone.sipProxy.trim().isEmpty ? null : phone.sipProxy.trim(),
        nickname: phone.extensionDisplayName,
        doNotDisturb: _administrativelyLocked || phone.doNotDisturb,
      );
      _gatewayProvisioned = true;
      _provisionRetryAttempt = 0;
      _provisionRetryTimer?.cancel();
      _provisionRetryTimer = null;
      notifyListeners();
      _appendDiagnostic('Mobile gateway registration active');
      unawaited(_refreshVoicemail());
      unawaited(
        Future<void>.delayed(
          const Duration(milliseconds: 500),
          _refreshVoicemail,
        ),
      );
    } catch (error) {
      _gatewayProvisioned = false;
      notifyListeners();
      _lastProvisionSignature = null;
      _appendDiagnostic('Gateway provisioning failed: $error');
      _scheduleProvisionRetry();
    } finally {
      _provisioning = false;
    }
  }

  void _scheduleProvisionRetry() {
    if (_gatewayProvisioned || _provisionRetryTimer?.isActive == true) return;
    const delays = <Duration>[
      Duration(seconds: 1),
      Duration(seconds: 3),
      Duration(seconds: 8),
      Duration(seconds: 20),
    ];
    final index = _provisionRetryAttempt < delays.length
        ? _provisionRetryAttempt
        : delays.length - 1;
    _provisionRetryAttempt++;
    final delay = delays[index];
    _provisionRetryTimer = Timer(delay, () {
      _provisionRetryTimer = null;
      if (_gatewayProvisioned) return;
      _appendDiagnostic(
        'Retrying mobile gateway registration · attempt=$_provisionRetryAttempt',
      );
      _lastProvisionSignature = null;
      _phoneChanged();
    });
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
      if (!_gatewayProvisioned && !_provisioning) {
        _lastProvisionSignature = null;
        _phoneChanged();
      }
      unawaited(_recoverCallKitState());
      _scheduleCallKitRecoveryRetries();
      unawaited(_refreshVoicemail());
    }
  }

  Future<void> _refreshVoicemail() async {
    final deviceId = _deviceId;
    if (!gateway.enabled || deviceId == null || !_gatewayProvisioned) return;
    try {
      final summary = await gateway.getVoicemail(deviceId);
      phone.updateVoicemailSummary(
        waiting: summary.waiting,
        newMessages: summary.newMessages,
        oldMessages: summary.oldMessages,
      );
    } catch (error) {
      _appendDiagnostic('Voicemail MWI refresh failed: $error');
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
            await _accept(id, recovered: true);
            break;
          case 'decline':
            await _diag('callkit_decline_native_recovered', callId: id);
            await _decline(id);
            break;
          case 'end':
            await _diag('callkit_end_native_recovered', callId: id);
            await _end(id, recoverUnknown: true);
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
          await _accept(call.id, recovered: true);
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

    if (_administrativelyLocked &&
        event is! CallEventActionDidUpdateDevicePushTokenVoip) {
      final id = switch (event) {
        CallEventActionCallIncoming() => event.callKitParams.id,
        CallEventActionCallAccept() => event.callKitParams.id,
        CallEventActionCallDecline() => event.callKitParams.id,
        CallEventActionCallEnded() => event.callKitParams.id,
        CallEventActionCallTimeout() => event.id,
        CallEventActionCallToggleMute() => event.id,
        CallEventActionCallToggleHold() => event.id,
        _ => null,
      };
      if (id != null && id.isNotEmpty) {
        try {
          await gateway.decline(id);
        } catch (_) {}
        try {
          await FlutterCallkitIncoming.endCall(id);
        } catch (_) {}
      }
      _appendDiagnostic('CallKit activity suppressed by administrative lock');
      return;
    }
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
    context.webRtc.onLocalVideoChanged = (enabled) {
      unawaited(_diag(
        'local_video_state',
        callId: context.id,
        details: {'enabled': enabled},
      ));
      notifyListeners();
    };
    context.webRtc.onRemoteVideoChanged = (available) {
      unawaited(_diag(
        'remote_video_state',
        callId: context.id,
        details: {'available': available},
      ));
      notifyListeners();
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
        ..phase = 'ringing'
        ..incomingVideoOffered = WebRtcService.hasVideoInSdp(call.offerSdp);
      _configureGatewayCall(context);
      _gatewayCalls[context.id] = context;
      await _listenToGateway(context);
      _appendDiagnostic('Incoming gateway call tracked');
      notifyListeners();
    } catch (error) {
      _appendDiagnostic('Incoming call tracking failed: $error');
    }
  }

  Future<void> _accept(
    String requestedCallId, {
    bool? video,
    bool recovered = false,
  }) async {
    final acceptStopwatch = Stopwatch()..start();
    void acceptTrace(String stage) {
      final elapsedMs = acceptStopwatch.elapsedMilliseconds;
      _appendDiagnostic(
        'INCOMING_ACCEPT +${elapsedMs}ms '
        '$stage · call=${requestedCallId.toLowerCase()} · '
        'recovered=$recovered',
      );
      unawaited(_diag(
        'incoming_accept_setup',
        callId: requestedCallId,
        details: {
          'stage': stage,
          'elapsed_ms': elapsedMs,
          'recovered': recovered,
        },
      ));
    }

    acceptTrace('begin');
    final normalizedCallId = requestedCallId.toLowerCase();
    if (_acceptingCallIds.contains(normalizedCallId)) {
      _appendDiagnostic(
        'Duplicate CallKit accept ignored · call=$normalizedCallId',
      );
      return;
    }

    final existing = _contextFor(requestedCallId);
    if (existing?.answering == true || existing?.connected == true) {
      return;
    }

    _acceptingCallIds.add(normalizedCallId);
    try {
      acceptTrace('direct_registration_disconnect_start');
      await phone.disconnectDirectRegistrationIfIdle();
      acceptTrace('direct_registration_disconnect_done');

    final previous = _activeGatewayCall;
    if (previous != null &&
        previous.id.toLowerCase() != requestedCallId.toLowerCase() &&
        previous.connected &&
        !previous.held) {
      await _setGatewayHold(previous.id, true);
    }

    _GatewayCallContext? context = existing;
    try {
      acceptTrace('gateway_lookup_start');
      final call = await _loadGatewayCallForAccept(
        requestedCallId,
        retryNotFound: recovered,
      );
      acceptTrace('gateway_lookup_done');
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
      context.incomingVideoOffered = WebRtcService.hasVideoInSdp(call.offerSdp);
      context.mediaConnected = false;
      context.connectedAt = call.connected ? DateTime.now() : null;
      context.localCandidateCount = 0;
      context.remoteCandidateCount = 0;
      _activeGatewayCallId = context.id;
      notifyListeners();

      await _diag(
        'gateway_call_loaded',
        callId: context.id,
        details: {
          'sdp_length': call.offerSdp.length,
          'incoming_video_offered': context.incomingVideoOffered,
          'sdp': WebRtcService.summarizeSdp(call.offerSdp),
        },
      );
      if (call.offerSdp.isEmpty) {
        throw StateError('Gateway call has no WebRTC offer');
      }

      if (context.socket == null) {
        acceptTrace('gateway_socket_start');
        await _listenToGateway(context);
        acceptTrace('gateway_socket_done');
      }
      final useVideo = video ?? context.incomingVideoOffered;
      acceptTrace('webrtc_prepare_start');
      try {
        await context.webRtc.preparePeerConnection(
          preservePendingRemoteCandidates: true,
          video: useVideo && context.incomingVideoOffered,
        );
      } catch (error) {
        if (!useVideo) rethrow;
        _appendDiagnostic(
          'Camera unavailable while answering video call; falling back to audio',
        );
        await context.webRtc.preparePeerConnection(
          preservePendingRemoteCandidates: true,
          video: false,
        );
      }
      acceptTrace('webrtc_prepare_done');
      acceptTrace('answer_create_start');
      final answer = await context.webRtc.createAnswer(call.offerSdp);
      acceptTrace('answer_create_done');
      acceptTrace('gateway_answer_start');
      await gateway.answer(context.id, answer);
      acceptTrace('gateway_answer_done');
      await _diag(
        'answer_sent',
        callId: context.id,
        details: {'sdp_length': answer.length},
      );
      _appendDiagnostic('Gateway call answer sent');
      acceptTrace('complete');
    } catch (error) {
      acceptTrace('failed');
      _appendDiagnostic('Gateway call answer failed: $error');
      final id = context?.id ?? requestedCallId;
      try {
        await FlutterCallkitIncoming.endCall(id);
      } catch (_) {}
      await _closeGatewayCall(id);
    } finally {
      if (context != null) context.answering = false;
    }
    } finally {
      _acceptingCallIds.remove(normalizedCallId);
    }
  }

  Future<GatewayCall> _loadGatewayCallForAccept(
    String callId, {
    required bool retryNotFound,
  }) async {
    const retryDelays = <Duration>[
      Duration.zero,
      Duration(milliseconds: 150),
      Duration(milliseconds: 350),
      Duration(milliseconds: 700),
      Duration(milliseconds: 1200),
    ];

    Object? lastError;
    for (var attempt = 0; attempt < retryDelays.length; attempt++) {
      final delay = retryDelays[attempt];
      if (delay > Duration.zero) {
        await Future<void>.delayed(delay);
      }

      try {
        final call = await gateway.getCall(callId);
        if (attempt > 0) {
          _appendDiagnostic(
            'Recovered gateway call after cold-start retry · '
            'attempt=${attempt + 1}',
          );
        }
        return call;
      } catch (error) {
        lastError = error;
        final notFound = error is HttpException &&
            error.message.contains(' failed (404):');
        if (!retryNotFound || !notFound || attempt == retryDelays.length - 1) {
          rethrow;
        }
        _appendDiagnostic(
          'Cold-start gateway call not ready · '
          'retry=${attempt + 1}/${retryDelays.length - 1}',
        );
      }
    }

    throw lastError ?? StateError('Gateway call recovery failed');
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
            String? acceptedSdp;
            if (acceptedJsep is Map) {
              final sdp = acceptedJsep['sdp']?.toString();
              if (sdp != null && sdp.isNotEmpty) {
                acceptedSdp = sdp;
                unawaited(
                  context.webRtc.applyRemoteAnswer(sdp).then((_) {
                    _appendDiagnostic(
                      'Accepted SDP applied · '
                      '${WebRtcService.summarizeSdp(sdp)}',
                    );
                    notifyListeners();
                  }).catchError((Object error) {
                    _appendDiagnostic(
                      'Accepted SDP apply failed: $error',
                    );
                  }),
                );
              }
            }
            if (context.outgoing) unawaited(_ringback.stop());
            context.phase = 'connected';
            context.connected = true;
            context.held = false;
            context.connectedAt ??= DateTime.now();
            _startGatewayStats(context);
            unawaited(FlutterCallkitIncoming.setCallConnected(context.id));
            notifyListeners();
            if (context.postConnectDtmf.isNotEmpty &&
                !context.postConnectDtmfSent) {
              unawaited(_runPostConnectDtmf(context));
            }
            unawaited(_diag(
              'gateway_accepted',
              callId: context.id,
              details: {
                'gateway_event': 'accepted',
                'jsep': acceptedSdp != null,
                if (acceptedSdp != null)
                  'sdp': WebRtcService.summarizeSdp(acceptedSdp),
              },
            ));
            break;
          case 'updated':
            final updatedJsep = event['jsep'];
            if (updatedJsep is Map) {
              final sdp = updatedJsep['sdp']?.toString();
              if (sdp != null && sdp.isNotEmpty) {
                unawaited(context.webRtc.applyRemoteAnswer(sdp).then((_) {
                  _appendDiagnostic(
                    'Media update completed · '
                    '${WebRtcService.summarizeSdp(sdp)}',
                  );
                  notifyListeners();
                }));
              }
            }
            break;
          case 'updatingcall':
            final updatingJsep = event['jsep'];
            if (updatingJsep is Map) {
              final sdp = updatingJsep['sdp']?.toString();
              if (sdp != null && sdp.isNotEmpty) {
                unawaited(_answerGatewayMediaUpdate(context, sdp));
              }
            }
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
            context.gatewayEnded = true;
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

  Future<void> placeCall(
    String number, {
    bool video = false,
  }) =>
      _placeCall(number, video: video);

  Future<void> placePbxFeatureCall(String dialString) =>
      _placeCall(dialString);

  Future<void> parkActiveCall(String parkCode) async {
    final code = parkCode.trim();
    if (code.isEmpty || !gatewayCallConnected) return;
    final callId = _activeGatewayCallId;
    if (callId != null) {
      await _diag('call_park_requested', callId: callId);
    }
    await blindTransferActiveCall(code);
  }

  Future<void> setRecordingPaused(
    bool paused, {
    required String muteSequence,
    required String unmuteSequence,
  }) async {
    final active = _activeGatewayCall;
    if (active == null || !active.connected) return;
    final sequence = paused ? muteSequence : unmuteSequence;
    await _sendDtmfSequence(active, sequence);
    await _diag(
      paused ? 'recording_pause_requested' : 'recording_resume_requested',
      callId: active.id,
    );
  }

  Future<void> startCallMonitoring({
    required String monitorCode,
    required String seat,
    required String password,
    required bool whisper,
  }) async {
    final cleanCode = monitorCode.trim();
    final cleanSeat = seat.trim();
    final cleanPassword = password.trim();
    if (cleanCode.isEmpty || cleanSeat.isEmpty || cleanPassword.isEmpty) return;

    if (!_gatewayProvisioned || _deviceId == null) {
      // Direct-mode fallback intentionally does not persist or log the
      // supervisor credential. The user can complete the IVR via the keypad.
      await phone.placeCall(cleanCode);
      _appendDiagnostic(
        'Call monitoring access started in direct mode · '
        'complete credentials with keypad',
      );
      return;
    }

    await _placeCall(
      cleanCode,
      postConnectDtmf: [
        _PbxDtmfStep('*$cleanSeat', const Duration(milliseconds: 900)),
        _PbxDtmfStep(
          '$cleanPassword*',
          const Duration(milliseconds: 500),
        ),
        _PbxDtmfStep(
          whisper ? '2' : '1',
          const Duration(milliseconds: 500),
        ),
      ],
    );
  }

  Future<void> _placeCall(
    String number, {
    bool video = false,
    List<_PbxDtmfStep> postConnectDtmf = const [],
  }) async {
    if (!_provisioningAccessEnabled) {
      _appendDiagnostic('Outgoing call blocked until device is provisioned');
      return;
    }
    if (_administrativelyLocked) {
      _appendDiagnostic('Outgoing call blocked by administrative lock');
      return;
    }

    final target = number.trim();
    if (target.isEmpty) return;

    final deviceId = _deviceId;
    if (!_gatewayProvisioned || deviceId == null) {
      await phone.placeCall(target, video);
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

    final callId = _newCallId();
    final stopwatch = Stopwatch()..start();
    void trace(String stage) {
      final elapsedMs = stopwatch.elapsedMilliseconds;
      _appendDiagnostic('OUTBOUND +${elapsedMs}ms $stage');
      unawaited(_diag(
        'outbound_setup',
        callId: callId,
        details: {
          'stage': stage,
          'elapsed_ms': elapsedMs,
        },
      ));
    }

    final webRtc = WebRtcService();
    final pendingCandidates = <Map<String, dynamic>>[];
    final firstCandidate = Completer<void>();
    final preferredCandidate = Completer<void>();
    webRtc.onLog =
        (message) => debugPrint('[VoiceHost Mobile] outbound media: $message');
    webRtc.onLocalCandidate = (candidate) {
      pendingCandidates.add(candidate);
      if (!firstCandidate.isCompleted) {
        firstCandidate.complete();
      }
      final value = candidate['candidate']?.toString() ?? '';
      if (value.contains(' typ srflx ') && !preferredCandidate.isCompleted) {
        preferredCandidate.complete();
      }
    };
    webRtc.onIceGatheringComplete = () {
      pendingCandidates.add({'completed': true});
    };

    final context = _GatewayCallContext(callId, webRtc: webRtc)
      ..caller = target
      ..displayName = target
      ..startedAt = DateTime.now()
      ..outgoing = true
      ..gatewayStarted = false
      ..postConnectDtmf = List<_PbxDtmfStep>.from(postConnectDtmf)
      ..phase = 'calling';
    _gatewayCalls[callId] = context;
    _activeGatewayCallId = callId;
    trace('dial_pressed');
    notifyListeners();

    try {
      trace('callkit_start_requested');
      await FlutterCallkitIncoming.startCall(
        CallKitParams(
          id: callId,
          nameCaller: target,
          handle: target,
          type: video ? 1 : 0,
          extra: const {'source': 'voicehost-mobile-gateway'},
          ios: IOSParams(
            handleType: 'number',
            normalHandle: 1,
            supportsVideo: video,
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
      trace('callkit_start_completed');

      unawaited(_ringback.start());
      trace('ringback_requested');

      trace('webrtc_prepare_started');
      await webRtc.preparePeerConnection(video: video);
      trace('webrtc_prepare_completed');

      trace('offer_create_started');
      await webRtc.createOffer();
      trace('offer_created');

      trace('ice_candidate_wait_started');
      await _waitForInitialOutboundCandidate(
        firstCandidate,
        preferredCandidate,
      );
      trace('ice_candidate_wait_completed');

      final embeddedCandidates = pendingCandidates
          .where((candidate) => candidate['completed'] != true)
          .map((candidate) => Map<String, dynamic>.from(candidate))
          .toList(growable: false);
      final embeddedCandidateValues = embeddedCandidates
          .map((candidate) => candidate['candidate']?.toString() ?? '')
          .where((value) => value.isNotEmpty)
          .toSet();

      final offerWithIce = await webRtc.currentLocalDescriptionSdp(
        candidates: embeddedCandidates,
      );
      _appendDiagnostic(
        'Outgoing media requested · video=$video · '
        '${WebRtcService.summarizeSdp(offerWithIce)} · '
        'embedded_ice=${embeddedCandidateValues.length}',
      );

      trace('randy_start_requested');
      final returnedCallId = await gateway.startCall(
        deviceId: deviceId,
        target: target,
        offerSdp: offerWithIce,
        callId: callId,
      );
      trace('randy_start_completed');

      if (returnedCallId.isEmpty) {
        throw StateError('Gateway did not return a call id');
      }
      if (returnedCallId.toLowerCase() != callId.toLowerCase()) {
        throw StateError(
          'Gateway returned unexpected call id $returnedCallId',
        );
      }
      context.gatewayStarted = true;

      // The user may have ended the CallKit call while WebRTC/Randy was
      // starting. If so, terminate the newly-created SIP call immediately
      // instead of resurrecting a call whose UI has already gone away.
      if (_contextFor(callId) == null) {
        trace('cancelled_during_startup');
        try {
          await gateway.hangup(callId);
        } catch (_) {}
        await _ringback.stop();
        await _ringback.prepareForWebRtcClose();
        await webRtc.close();
        return;
      }

      _configureGatewayCall(context);

      trace('gateway_events_connect_started');
      await _listenToGateway(context);
      trace('gateway_events_connected');

      final initialCandidates = pendingCandidates
          .where((candidate) {
            if (candidate['completed'] == true) return true;
            final value = candidate['candidate']?.toString() ?? '';
            return value.isEmpty || !embeddedCandidateValues.contains(value);
          })
          .map((candidate) => Map<String, dynamic>.from(candidate))
          .toList(growable: false);
      pendingCandidates.clear();

      trace('outbound_ready');
      unawaited(_diag('outbound_call_started', callId: callId));
      unawaited(
        _flushInitialCandidates(
          context,
          initialCandidates,
          onComplete: () => trace('initial_candidates_flushed'),
        ),
      );
      notifyListeners();
    } catch (error) {
      trace('startup_failed');
      await _ringback.stop();

      final activeContext = _contextFor(callId);
      if (activeContext == null) {
        await _ringback.prepareForWebRtcClose();
        await webRtc.close();
      }
      if (context.gatewayStarted) {
        try {
          await gateway.hangup(callId);
        } catch (_) {}
      }
      if (activeContext != null) {
        await _closeGatewayCall(
          activeContext.id,
          result: CallResult.failed,
          resumeAnother: false,
        );
      }
      if (_activeGatewayCallId?.toLowerCase() == callId.toLowerCase()) {
        _activeGatewayCallId = null;
      }
      try {
        await FlutterCallkitIncoming.endCall(callId);
      } catch (_) {}

      debugPrint('[VoiceHost Mobile] outgoing call failed: $error');
      if (previous != null && previous.held) {
        await _setGatewayHold(previous.id, false);
      }
    }
  }

  Future<void> _waitForInitialOutboundCandidate(
    Completer<void> firstCandidate,
    Completer<void> preferredCandidate,
  ) async {
    try {
      await preferredCandidate.future.timeout(
        const Duration(milliseconds: 700),
      );
      _appendDiagnostic('Initial ICE candidate ready · preferred=srflx');
      return;
    } on TimeoutException {
      // Fall back to any gathered candidate, but keep the total wait bounded.
    }

    if (firstCandidate.isCompleted) {
      _appendDiagnostic('Initial ICE candidate ready · preferred=host');
      return;
    }

    try {
      await firstCandidate.future.timeout(
        const Duration(milliseconds: 300),
      );
      _appendDiagnostic('Initial ICE candidate ready · preferred=host');
    } on TimeoutException {
      _appendDiagnostic(
        'Initial ICE candidate wait timed out · starting with current SDP',
      );
    }
  }

  Future<void> _flushInitialCandidates(
    _GatewayCallContext context,
    List<Map<String, dynamic>> candidates, {
    void Function()? onComplete,
  }) async {
    if (candidates.isEmpty) {
      onComplete?.call();
      return;
    }

    try {
      for (final candidate in candidates) {
        if (_contextFor(context.id) == null ||
            context.gatewayEnded ||
            context.closing) {
          break;
        }
        await gateway.candidate(context.id, candidate);
      }
    } catch (error) {
      _appendDiagnostic('Initial ICE candidate flush failed: $error');
    } finally {
      onComplete?.call();
    }
  }

  void _startGatewayStats(_GatewayCallContext context) {
    context.statsTimer?.cancel();
    unawaited(_publishGatewayStats(context));
    context.statsTimer = Timer.periodic(const Duration(seconds: 10), (_) {
      if (!context.connected) return;
      unawaited(_publishGatewayStats(context));
    });
  }

  Future<void> _publishGatewayStats(_GatewayCallContext context) async {
    try {
      final stats = await context.webRtc.collectSanitizedStats();
      if (stats.isEmpty) return;
      await _diag(
        'media_stats',
        callId: context.id,
        details: stats,
      );
    } catch (error) {
      debugPrint('[VoiceHost Mobile] media stats failed: $error');
    }
  }

  Future<void> _answerGatewayMediaUpdate(
    _GatewayCallContext context,
    String offerSdp,
  ) async {
    try {
      final answer =
          await context.webRtc.applyRemoteOfferAndCreateAnswer(offerSdp);
      await gateway.updateMedia(context.id, answer, type: 'answer');
      await _diag(
        'remote_video_update_answered',
        callId: context.id,
        details: {
          'offer': WebRtcService.summarizeSdp(offerSdp),
          'answer': WebRtcService.summarizeSdp(answer),
        },
      );
      notifyListeners();
    } catch (error) {
      _appendDiagnostic('Unable to answer media update: $error');
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

  Future<void> answerActiveGatewayCall({bool video = false}) async {
    final active = _activeGatewayCall;
    if (active == null) return;
    await _accept(active.id, video: video);
  }

  Future<void> toggleGatewayVideo() async {
    final active = _activeGatewayCall;
    if (active == null || !active.connected) return;
    final target = !active.webRtc.videoEnabled;
    var mediaChanged = false;
    try {
      final offer = await active.webRtc.setVideoEnabled(target);
      mediaChanged = true;
      final summary = WebRtcService.summarizeSdp(offer);
      await _diag(
        'video_update_attempt',
        callId: active.id,
        details: {
          'enabled': target,
          'sdp': summary,
        },
      );
      await gateway.updateMedia(active.id, offer, type: 'offer');
      await _diag(
        'video_update_requested',
        callId: active.id,
        details: {
          'enabled': target,
          'sdp': summary,
        },
      );
      notifyListeners();
    } catch (error) {
      await _diag(
        'video_update_failed',
        callId: active.id,
        details: {
          'enabled': target,
          'error': error.toString(),
        },
      );
      if (mediaChanged && active.webRtc.videoEnabled != !target) {
        try {
          await active.webRtc.setVideoEnabled(!target);
        } catch (_) {}
      }
      _appendDiagnostic(
        'Video ${target ? 'enable' : 'disable'} failed: $error',
      );
      notifyListeners();
    }
  }

  Future<void> switchGatewayCamera() async {
    final active = _activeGatewayCall;
    if (active == null || !active.webRtc.videoEnabled) return;
    try {
      await active.webRtc.switchCamera();
      await _diag('camera_switched', callId: active.id);
    } catch (error) {
      _appendDiagnostic('Camera switch failed: $error');
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
      _appendDiagnostic('DTMF sent');
    } catch (error) {
      _appendDiagnostic('DTMF failed: $error');
    }
  }

  Future<void> _sendDtmfSequence(
    _GatewayCallContext context,
    String sequence,
  ) async {
    const allowedDigits = '0123456789*#ABCD';
    final digits = sequence
        .toUpperCase()
        .split('')
        .where(allowedDigits.contains)
        .toList(growable: false);
    for (final digit in digits) {
      if (!context.connected || context.closing || context.gatewayEnded) return;
      await gateway.sendDtmf(context.id, digit);
      await Future<void>.delayed(const Duration(milliseconds: 90));
    }
  }

  Future<void> _runPostConnectDtmf(_GatewayCallContext context) async {
    if (context.postConnectDtmfSent || context.postConnectDtmf.isEmpty) return;
    context.postConnectDtmfSent = true;
    try {
      for (final step in context.postConnectDtmf) {
        await Future<void>.delayed(step.delay);
        if (!context.connected || context.closing || context.gatewayEnded) {
          return;
        }
        await _sendDtmfSequence(context, step.sequence);
      }
      await _diag(
        'pbx_feature_sequence_sent',
        callId: context.id,
        details: {'stage': 'complete'},
      );
    } catch (error) {
      _appendDiagnostic('PBX feature sequence failed: $error');
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

  Future<void> _end(
    String requestedCallId, {
    bool recoverUnknown = false,
  }) async {
    final context = _contextFor(requestedCallId);

    if (context == null) {
      if (!recoverUnknown) {
        _appendDiagnostic('Ignoring duplicate CallKit end for closed call');
        return;
      }
      try {
        await gateway.hangup(requestedCallId);
      } catch (error) {
        debugPrint('[VoiceHost Mobile] recovered hangup failed: $error');
      }
      return;
    }

    if (context.hangupRequested) {
      _appendDiagnostic('Ignoring duplicate hangup request');
      return;
    }

    context.hangupRequested = true;
    if (context.gatewayStarted && !context.gatewayEnded) {
      try {
        await gateway.hangup(context.id);
      } catch (error) {
        debugPrint('[VoiceHost Mobile] hangup failed: $error');
      }
    } else if (!context.gatewayStarted) {
      _appendDiagnostic('Outbound call cancelled during startup');
    }

    await _closeGatewayCall(
      context.id,
      result: context.connected
          ? CallResult.completed
          : context.outgoing
              ? CallResult.cancelled
              : CallResult.declined,
    );
  }

  Future<void> _closeGatewayCall(
    String requestedCallId, {
    bool resumeAnother = true,
    CallResult? result,
  }) async {
    final context = _contextFor(requestedCallId);
    if (context == null || context.closing) return;
    context.closing = true;

    final wasActive = _activeGatewayCallId == context.id;
    if (wasActive && _transferId != null) {
      await _closeTransferMedia();
    }

    context.statsTimer?.cancel();
    context.statsTimer = null;
    await context.subscription?.cancel();
    context.subscription = null;
    await context.socket?.close();
    context.socket = null;
    await _ringback.prepareForWebRtcClose();
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
      if (_managedReprovisionPending) {
        _appendDiagnostic('Applying deferred managed gateway registration update');
        _lastProvisionSignature = null;
        _phoneChanged();
      }
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

  String _newCallId() {
    final random = Random.secure();
    final bytes = List<int>.generate(16, (_) => random.nextInt(256));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    final hex = bytes
        .map((value) => value.toRadixString(16).padLeft(2, '0'))
        .join();
    return '${hex.substring(0, 8)}-'
        '${hex.substring(8, 12)}-'
        '${hex.substring(12, 16)}-'
        '${hex.substring(16, 20)}-'
        '${hex.substring(20)}';
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
    _voicemailPollTimer?.cancel();
    _provisionRetryTimer?.cancel();
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
  bool gatewayStarted = true;
  bool gatewayEnded = false;
  bool hangupRequested = false;
  bool closing = false;
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
  bool incomingVideoOffered = false;
  DateTime? connectedAt;
  int localCandidateCount = 0;
  int remoteCandidateCount = 0;
  List<_PbxDtmfStep> postConnectDtmf = const [];
  bool postConnectDtmfSent = false;
  Timer? statsTimer;
}

class _PbxDtmfStep {
  const _PbxDtmfStep(this.sequence, this.delay);

  final String sequence;
  final Duration delay;
}
