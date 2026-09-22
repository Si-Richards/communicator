import 'dart:async';

import 'package:flutter/foundation.dart';

import '../core/app_config.dart';
import '../models/call_record.dart';
import '../models/call_state.dart';
import '../models/sip_account.dart';
import '../models/voicemail_summary.dart';
import '../repositories/call_history_repository.dart';
import '../repositories/settings_repository.dart';
import '../services/janus_client.dart';
import '../services/janus_sip_service.dart';
import '../services/ringback_service.dart';
import '../services/webrtc_service.dart';

class PhoneController extends ChangeNotifier {
  PhoneController({
    required SettingsRepository settingsRepository,
    required CallHistoryRepository historyRepository,
    WebRtcService? webRtc,
  })  : _settingsRepository = settingsRepository,
        _historyRepository = historyRepository,
        _webRtc = webRtc ?? WebRtcService() {
    _webRtc.onLocalCandidate = (candidate) {
      unawaited(_queueOrSendCandidate(candidate));
    };
    _webRtc.onIceGatheringComplete = () {
      unawaited(_queueOrSendCandidate({'completed': true}));
    };
    _webRtc.onLog = _log;
    _webRtc.onConnectionStateChanged = (state) {
      connectionDiagnostic = state;
      notifyListeners();
    };
  }

  final SettingsRepository _settingsRepository;
  final CallHistoryRepository _historyRepository;
  final WebRtcService _webRtc;
  final RingbackService _ringback = RingbackService();

  JanusClient? _janus;
  JanusSipService? _sip;
  Timer? _endedResetTimer;
  Timer? _directDisconnectTimer;

  String nickname = '';
  String sipUsername = '';
  String sipPassword = '';
  String sipRealm = AppConfig.defaultSipRealm;
  String sipProxy = '';
  String janusUrl = AppConfig.defaultJanusUrl;
  String janusApiSecret = '';
  String voicemailNumber = '';
  bool doNotDisturb = false;

  bool isRegistered = false;
  String registrationStatus = 'Standby';
  String voicemailSubscriptionStatus = 'Not subscribed';
  VoicemailSummary voicemail = const VoicemailSummary.empty();
  PhoneCallState callState = const PhoneCallState.idle();
  String? errorMessage;
  String dialledNumber = '';
  bool isMuted = false;
  bool speakerphoneOn = false;
  String connectionDiagnostic = '';
  List<CallRecord> callHistory = [];

  String? _incomingOfferSdp;
  String _currentNumber = '';
  bool _canSendTrickle = false;
  bool _connectRequestRunning = false;
  bool _registrationPending = false;
  final List<Map<String, dynamic>> _pendingLocalCandidates = [];
  _ActiveCallContext? _activeCall;

  String get extensionDisplayName {
    final cleanNickname = nickname.trim();
    if (cleanNickname.isNotEmpty) return cleanNickname;
    final cleanUsername = sipUsername.trim();
    if (cleanUsername.isNotEmpty) return cleanUsername;
    return 'Phone';
  }

  bool get canRegister =>
      sipUsername.trim().isNotEmpty &&
      sipPassword.isNotEmpty &&
      Uri.tryParse(janusUrl) != null;

  bool get canCallVoicemail =>
      canRegister && voicemailNumber.trim().isNotEmpty && !callState.isInCall;

  DateTime? get activeCallConnectedAt => _activeCall?.connectedAt;
  bool get hasActiveDirectCall => callState.isInCall || _activeCall != null;

  Future<bool> ensureRegistered({
    Duration timeout = const Duration(seconds: 8),
  }) async {
    if (isRegistered) return true;
    if (!canRegister) return false;

    if (!_connectRequestRunning && !_registrationPending) {
      await connectAndRegister();
    }

    final deadline = DateTime.now().add(timeout);
    while (!isRegistered && DateTime.now().isBefore(deadline)) {
      if (!_connectRequestRunning &&
          !_registrationPending &&
          registrationStatus == 'Registration failed') {
        break;
      }
      await Future<void>.delayed(const Duration(milliseconds: 100));
    }
    return isRegistered;
  }

  Future<void> initialize() async {
    final settings = await _settingsRepository.load();
    nickname = settings.nickname;
    sipUsername = settings.sipUsername;
    sipPassword = settings.sipPassword;
    sipRealm = settings.sipRealm;
    sipProxy = settings.sipProxy;
    janusUrl = settings.janusUrl;
    janusApiSecret = settings.janusApiSecret;
    voicemailNumber = settings.voicemailNumber;
    doNotDisturb = settings.doNotDisturb;
    callHistory = await _historyRepository.load();
    notifyListeners();
  }

  Future<void> saveSettings({
    required String nickname,
    required String sipUsername,
    required String sipPassword,
    required String sipRealm,
    required String sipProxy,
    required String janusUrl,
    required String janusApiSecret,
    required String voicemailNumber,
  }) async {
    this.nickname = nickname.trim();
    this.sipUsername = sipUsername.trim();
    this.sipPassword = sipPassword;
    this.sipRealm = sipRealm.trim().isEmpty
        ? AppConfig.defaultSipRealm
        : sipRealm.trim();
    this.sipProxy = sipProxy.trim();
    this.janusUrl = janusUrl.trim().isEmpty
        ? AppConfig.defaultJanusUrl
        : janusUrl.trim();
    this.janusApiSecret = janusApiSecret.trim();
    this.voicemailNumber = voicemailNumber.trim();
    await _persistSettings();
    notifyListeners();
  }

  Future<void> setDoNotDisturb(bool enabled) async {
    doNotDisturb = enabled;
    await _settingsRepository.saveDoNotDisturb(enabled);
    notifyListeners();
  }

  void setDialledNumber(String value) {
    dialledNumber = value;
    notifyListeners();
  }

  void appendDigit(String digit) {
    dialledNumber += digit;
    notifyListeners();
    if (callState.isConnected) {
      unawaited(sendDtmf(digit));
    }
  }

  void backspaceDigit() {
    if (dialledNumber.isEmpty) return;
    dialledNumber = dialledNumber.substring(0, dialledNumber.length - 1);
    notifyListeners();
  }

  Future<void> connectAndRegister() async {
    if (_connectRequestRunning || _registrationPending) return;
    _connectRequestRunning = true;
    clearError();
    if (!canRegister) {
      _connectRequestRunning = false;
      _setError('Enter a SIP username and password before registering.');
      return;
    }

    final uri = Uri.tryParse(janusUrl);
    if (uri == null || (uri.scheme != 'ws' && uri.scheme != 'wss')) {
      _setError('Janus URL must be a ws:// or wss:// URL.');
      _connectRequestRunning = false;
      return;
    }

    await disconnect(clearRegistrationState: false);
    isRegistered = false;
    registrationStatus = 'Connecting…';
    notifyListeners();

    final janus = JanusClient(serverUrl: uri);
    final sip = JanusSipService(janus);
    _janus = janus;
    _sip = sip;

    janus.onLog = _log;
    janus.onPluginEvent = (payload, jsep) {
      unawaited(_handleSipEvent(payload, jsep));
    };
    janus.onRemoteCandidate = (candidate) {
      unawaited(_webRtc.addRemoteCandidate(candidate));
    };
    janus.onDisconnected = (error) {
      _registrationPending = false;
      _log('Janus disconnected: $error');
      if (isRegistered) {
        isRegistered = false;
        registrationStatus = 'Standby';
        notifyListeners();
      }
    };

    try {
      await janus.connect(apiSecret: janusApiSecret);
      registrationStatus = 'Registering…';
      _registrationPending = true;
      notifyListeners();
      await sip.register(
        SipAccount(
          username: sipUsername.trim(),
          password: sipPassword,
          realm: sipRealm.trim(),
          proxy: sipProxy.trim().isEmpty ? null : sipProxy.trim(),
          displayName: nickname.trim().isEmpty ? null : nickname.trim(),
        ),
      );
    } catch (error) {
      _registrationPending = false;
      isRegistered = false;
      registrationStatus = 'Offline';
      _setError(error.toString());
    } finally {
      _connectRequestRunning = false;
    }
  }

  Future<void> disconnect({bool clearRegistrationState = true}) async {
    _directDisconnectTimer?.cancel();
    if (_activeCall != null) {
      await _finalizeActiveCall(_localEndResult());
    }
    _endedResetTimer?.cancel();
    await _ringback.stop();
    await _webRtc.close();
    await _janus?.disconnect();
    _janus = null;
    _sip = null;
    _incomingOfferSdp = null;
    _currentNumber = '';
    _pendingLocalCandidates.clear();
    _canSendTrickle = false;
    _registrationPending = false;
    isMuted = false;
    speakerphoneOn = false;
    callState = const PhoneCallState.idle();
    voicemailSubscriptionStatus = 'Not subscribed';
    if (clearRegistrationState) {
      isRegistered = false;
      registrationStatus = 'Standby';
    }
    notifyListeners();
  }

  Future<void> placeCall([String? requestedNumber]) async {
    _endedResetTimer?.cancel();
    _directDisconnectTimer?.cancel();

    final number = _normalizeDialString(requestedNumber ?? dialledNumber);
    if (number.isEmpty || callState.isInCall) return;

    clearError();

    if (!isRegistered) {
      final registered = await ensureRegistered();
      if (!registered) {
        _setError('Unable to establish the outgoing SIP session.');
        return;
      }
    }

    final sip = _sip;
    if (sip == null) {
      _setError('Outgoing SIP session is unavailable.');
      return;
    }

    dialledNumber = number;
    _currentNumber = number;
    _activeCall = _ActiveCallContext(
      direction: CallDirection.outgoing,
      number: number,
      startedAt: DateTime.now(),
    );
    callState = PhoneCallState(phase: CallPhase.outgoing, number: number);
    _canSendTrickle = false;
    _pendingLocalCandidates.clear();
    notifyListeners();

    try {
      await _webRtc.preparePeerConnection();
      final offer = await _webRtc.createOffer();
      await sip.call(number: number, realm: sipRealm, offerSdp: offer);
      // Start local ringback as soon as the INVITE is handed to Janus.
      // 183 + SDP, answer, failure or hangup will stop it.
      unawaited(_ringback.start());
      _canSendTrickle = true;
      await _flushLocalCandidates();
    } catch (error) {
      await _ringback.stop();
      await _finalizeActiveCall(CallResult.failed);
      await _webRtc.close();
      _showEnded(error.toString());
      _setError(error.toString());
      _scheduleDirectDisconnect();
    }
  }

  Future<void> answerIncomingCall() async {
    final offer = _incomingOfferSdp;
    final sip = _sip;
    if (offer == null || sip == null) {
      _setError(
        'Incoming call did not include an SDP offer. Offerless INVITEs are not implemented yet.',
      );
      return;
    }

    _canSendTrickle = false;
    _pendingLocalCandidates.clear();
    try {
      await _webRtc.preparePeerConnection(preservePendingRemoteCandidates: true);
      final answer = await _webRtc.createAnswer(offer);
      await sip.accept(answer);
      _canSendTrickle = true;
      await _flushLocalCandidates();
    } catch (error) {
      await _finalizeActiveCall(CallResult.failed);
      await _webRtc.close();
      _showEnded(error.toString());
      _setError(error.toString());
    }
  }

  Future<void> rejectIncomingCall() async {
    try {
      await _sip?.decline();
    } catch (_) {}
    await _finalizeActiveCall(CallResult.declined);
    await _resetCall();
    _scheduleDirectDisconnect();
  }

  Future<void> hangup() async {
    await _ringback.stop();
    try {
      await _sip?.hangup();
    } catch (_) {}
    await _finalizeActiveCall(_localEndResult());
    await _webRtc.close();
    _showEnded('Call ended');
    _scheduleDirectDisconnect();
  }

  Future<void> toggleMute() async {
    isMuted = !isMuted;
    await _webRtc.setMuted(isMuted);
    notifyListeners();
  }

  Future<void> toggleSpeakerphone() async {
    speakerphoneOn = !speakerphoneOn;
    try {
      await _webRtc.setSpeakerphone(speakerphoneOn);
    } catch (error) {
      speakerphoneOn = !speakerphoneOn;
      _setError('Unable to change audio route: $error');
    }
    notifyListeners();
  }

  Future<void> toggleHold() async {
    final sip = _sip;
    if (sip == null) return;
    try {
      if (callState.phase == CallPhase.connected) {
        await sip.hold();
        callState = PhoneCallState(
          phase: CallPhase.held,
          number: callState.number,
        );
      } else if (callState.phase == CallPhase.held) {
        await sip.unhold();
        callState = PhoneCallState(
          phase: CallPhase.connected,
          number: callState.number,
        );
      }
      notifyListeners();
    } catch (error) {
      _setError(error.toString());
    }
  }

  Future<void> sendDtmf(String digit) async {
    if (!callState.isConnected) return;
    try {
      await _sip?.sendDtmf(digit);
    } catch (error) {
      _setError('DTMF failed: $error');
    }
  }

  Future<void> callVoicemail() async {
    final number = voicemailNumber.trim();
    if (number.isEmpty) {
      _setError('Set the voicemail number or feature code in Settings first.');
      return;
    }
    await placeCall(number);
  }

  Future<void> refreshVoicemailStatus() async {
    final sip = _sip;
    if (!isRegistered || sip == null) return;
    voicemailSubscriptionStatus = 'Subscribing…';
    notifyListeners();
    try {
      await sip.subscribeMessageSummary();
    } catch (error) {
      voicemailSubscriptionStatus = 'Unavailable';
      _log('Voicemail SUBSCRIBE failed: $error');
      notifyListeners();
    }
  }

  Future<void> deleteCallRecord(String id) async {
    callHistory.removeWhere((record) => record.id == id);
    await _historyRepository.save(callHistory);
    notifyListeners();
  }

  Future<void> clearCallHistory() async {
    callHistory.clear();
    await _historyRepository.save(callHistory);
    notifyListeners();
  }

  void clearError() {
    if (errorMessage == null) return;
    errorMessage = null;
    notifyListeners();
  }

  Future<void> _handleSipEvent(
    Map<String, dynamic> payload,
    Map<String, dynamic>? jsep,
  ) async {
    final pluginError = payload['error']?.toString();
    if (pluginError != null && pluginError.isNotEmpty) {
      _setError(pluginError);
      return;
    }

    final result = _map(payload['result']);
    final event = result?['event']?.toString();
    if (event == null) return;

    switch (event) {
      case 'registering':
        registrationStatus = 'Registering…';
        notifyListeners();
        break;
      case 'registered':
        _registrationPending = false;
        isRegistered = true;
        registrationStatus = 'Online';
        notifyListeners();
        unawaited(refreshVoicemailStatus());
        break;
      case 'registration_failed':
        _registrationPending = false;
        isRegistered = false;
        registrationStatus = 'Registration failed';
        _setError(result?['reason']?.toString() ?? 'SIP registration failed');
        break;
      case 'subscribing':
        voicemailSubscriptionStatus = 'Subscribing…';
        notifyListeners();
        break;
      case 'subscribe_succeeded':
        voicemailSubscriptionStatus = 'Active';
        notifyListeners();
        break;
      case 'subscribe_failed':
        voicemailSubscriptionStatus = 'Unavailable';
        notifyListeners();
        break;
      case 'notify':
        if (result?['notify']?.toString().toLowerCase() == 'message-summary') {
          voicemail = VoicemailSummary.parse(result?['content']?.toString() ?? '');
          voicemailSubscriptionStatus = 'Active';
          notifyListeners();
        }
        break;
      case 'calling':
        if (_activeCall?.direction == CallDirection.outgoing) {
          unawaited(_ringback.start());
        }
        callState = PhoneCallState(
          phase: CallPhase.outgoing,
          number: _currentNumber,
        );
        notifyListeners();
        break;
      case 'ringing':
        if (_activeCall?.direction == CallDirection.outgoing) {
          unawaited(_ringback.start());
        }
        callState = PhoneCallState(
          phase: CallPhase.ringing,
          number: _currentNumber,
        );
        notifyListeners();
        break;
      case 'progress':
        final progressSdp = jsep?['sdp']?.toString();
        if (progressSdp != null && progressSdp.isNotEmpty) {
          await _ringback.stop();
          await _webRtc.applyRemoteAnswer(progressSdp);
        } else if (_activeCall?.direction == CallDirection.outgoing) {
          unawaited(_ringback.start());
        }
        callState = PhoneCallState(
          phase: CallPhase.earlyMedia,
          number: _currentNumber,
        );
        notifyListeners();
        break;
      case 'accepted':
        await _ringback.stop();
        final acceptedSdp = jsep?['sdp']?.toString();
        if (acceptedSdp != null && acceptedSdp.isNotEmpty) {
          await _webRtc.applyRemoteAnswer(acceptedSdp);
        }
        final active = _activeCall;
        if (active != null && active.connectedAt == null) {
          active.connectedAt = DateTime.now();
        }
        callState = PhoneCallState(
          phase: CallPhase.connected,
          number: _currentNumber,
        );
        notifyListeners();
        break;
      case 'incomingcall':
        await _handleIncomingCall(result ?? const {}, jsep);
        break;
      case 'missed_call':
        await _recordStandaloneMissedCall(result ?? const {});
        break;
      case 'hangup':
        await _ringback.stop();
        final reason = result?['reason']?.toString();
        await _finalizeActiveCall(_remoteEndResult());
        await _webRtc.close();
        _showEnded(reason ?? 'Call ended');
        _scheduleDirectDisconnect();
        break;
      default:
        _log('Unhandled SIP event: $event');
        break;
    }
  }

  Future<void> _handleIncomingCall(
    Map<String, dynamic> result,
    Map<String, dynamic>? jsep,
  ) async {
    final callerUri = result['username']?.toString() ?? 'Unknown';
    final caller = _extractUser(callerUri);
    final displayName = result['displayname']?.toString();

    if (doNotDisturb) {
      final record = CallRecord(
        direction: CallDirection.incoming,
        number: caller,
        displayName: displayName,
        startedAt: DateTime.now(),
        durationSeconds: 0,
        result: CallResult.missed,
      );
      callHistory.insert(0, record);
      await _historyRepository.save(callHistory);
      try {
        await _sip?.decline(code: 486);
      } catch (_) {}
      notifyListeners();
      return;
    }

    _endedResetTimer?.cancel();
    _currentNumber = caller;
    _incomingOfferSdp = jsep?['sdp']?.toString();
    _activeCall = _ActiveCallContext(
      direction: CallDirection.incoming,
      number: caller,
      displayName: displayName,
      startedAt: DateTime.now(),
    );
    callState = PhoneCallState(
      phase: CallPhase.incoming,
      number: caller,
      displayName: displayName,
    );
    notifyListeners();
  }

  Future<void> _recordStandaloneMissedCall(Map<String, dynamic> result) async {
    final callerUri = result['caller']?.toString() ??
        result['username']?.toString() ??
        'Unknown';
    final record = CallRecord(
      direction: CallDirection.incoming,
      number: _extractUser(callerUri),
      displayName: result['displayname']?.toString(),
      startedAt: DateTime.now(),
      durationSeconds: 0,
      result: CallResult.missed,
    );
    callHistory.insert(0, record);
    await _historyRepository.save(callHistory);
    notifyListeners();
  }

  Future<void> _queueOrSendCandidate(Map<String, dynamic> candidate) async {
    final janus = _janus;
    if (!_canSendTrickle || janus == null) {
      _pendingLocalCandidates.add(candidate);
      return;
    }
    try {
      await janus.sendTrickle(candidate);
    } catch (error) {
      _log('Unable to send ICE candidate: $error');
    }
  }

  Future<void> _flushLocalCandidates() async {
    final janus = _janus;
    if (janus == null) return;
    final queued = List<Map<String, dynamic>>.from(_pendingLocalCandidates);
    _pendingLocalCandidates.clear();
    for (final candidate in queued) {
      try {
        await janus.sendTrickle(candidate);
      } catch (error) {
        _log('Unable to flush ICE candidate: $error');
      }
    }
  }

  Future<void> _finalizeActiveCall(CallResult result) async {
    final active = _activeCall;
    if (active == null) return;
    _activeCall = null;

    final connectedAt = active.connectedAt;
    final duration = connectedAt == null
        ? 0
        : DateTime.now().difference(connectedAt).inSeconds.clamp(0, 86400).toInt();
    callHistory.insert(
      0,
      CallRecord(
        direction: active.direction,
        number: active.number,
        displayName: active.displayName,
        startedAt: active.startedAt,
        durationSeconds: duration,
        result: result,
      ),
    );
    if (callHistory.length > CallHistoryRepository.maximumRecords) {
      callHistory = callHistory
          .take(CallHistoryRepository.maximumRecords)
          .toList(growable: true);
    }
    await _historyRepository.save(callHistory);
  }

  CallResult _localEndResult() {
    final active = _activeCall;
    if (active == null) return CallResult.cancelled;
    if (active.connectedAt != null) return CallResult.completed;
    return active.direction == CallDirection.incoming
        ? CallResult.declined
        : CallResult.cancelled;
  }

  CallResult _remoteEndResult() {
    final active = _activeCall;
    if (active == null) return CallResult.failed;
    if (active.connectedAt != null) return CallResult.completed;
    return active.direction == CallDirection.incoming
        ? CallResult.missed
        : CallResult.failed;
  }

  Future<void> _resetCall() async {
    _endedResetTimer?.cancel();
    await _ringback.stop();
    await _webRtc.close();
    _incomingOfferSdp = null;
    _currentNumber = '';
    _pendingLocalCandidates.clear();
    _canSendTrickle = false;
    isMuted = false;
    speakerphoneOn = false;
    callState = const PhoneCallState.idle();
    notifyListeners();
  }

  void _showEnded(String reason) {
    unawaited(_ringback.stop());
    _incomingOfferSdp = null;
    _currentNumber = '';
    _pendingLocalCandidates.clear();
    _canSendTrickle = false;
    isMuted = false;
    speakerphoneOn = false;
    callState = PhoneCallState(phase: CallPhase.ended, reason: reason);
    notifyListeners();

    _endedResetTimer?.cancel();
    _endedResetTimer = Timer(const Duration(seconds: 2), () {
      if (callState.phase == CallPhase.ended) {
        callState = const PhoneCallState.idle();
        notifyListeners();
      }
    });
  }

  void _scheduleDirectDisconnect() {
    _directDisconnectTimer?.cancel();
    _directDisconnectTimer = Timer(const Duration(milliseconds: 300), () {
      unawaited(disconnectDirectRegistrationIfIdle());
    });
  }

  Future<void> disconnectDirectRegistrationIfIdle() async {
    if (hasActiveDirectCall) return;

    _directDisconnectTimer?.cancel();
    _directDisconnectTimer = null;

    final sip = _sip;
    final janus = _janus;
    _sip = null;
    _janus = null;
    _registrationPending = false;
    _connectRequestRunning = false;
    _canSendTrickle = false;
    _pendingLocalCandidates.clear();

    try {
      await sip?.unregister();
    } catch (_) {}
    try {
      await janus?.disconnect();
    } catch (_) {}

    isRegistered = false;
    registrationStatus = 'Standby';
    voicemailSubscriptionStatus = 'Not subscribed';
    connectionDiagnostic = '';
    notifyListeners();
  }

  Future<void> _persistSettings() => _settingsRepository.save(
        SoftphoneSettings(
          nickname: nickname,
          sipUsername: sipUsername,
          sipPassword: sipPassword,
          sipRealm: sipRealm,
          sipProxy: sipProxy,
          janusUrl: janusUrl,
          janusApiSecret: janusApiSecret,
          voicemailNumber: voicemailNumber,
          doNotDisturb: doNotDisturb,
        ),
      );

  String _normalizeDialString(String value) {
    return value.replaceAll(RegExp(r'[^0-9+*#]'), '');
  }

  String _extractUser(String sipUri) {
    final withoutScheme = sipUri.replaceFirst(RegExp(r'^sips?:'), '');
    return withoutScheme.split('@').first;
  }

  void _setError(String message) {
    errorMessage = message;
    notifyListeners();
  }

  void _log(String message) {
    debugPrint('[VoiceHost] $message');
  }

  static Map<String, dynamic>? _map(dynamic value) {
    if (value is Map) return Map<String, dynamic>.from(value);
    return null;
  }

  @override
  void dispose() {
    _endedResetTimer?.cancel();
    _directDisconnectTimer?.cancel();
    unawaited(_ringback.stop());
    unawaited(_webRtc.close());
    unawaited(_janus?.disconnect());
    super.dispose();
  }
}

class _ActiveCallContext {
  _ActiveCallContext({
    required this.direction,
    required this.number,
    required this.startedAt,
    this.displayName,
  });

  final CallDirection direction;
  final String number;
  final String? displayName;
  final DateTime startedAt;
  DateTime? connectedAt;
}
