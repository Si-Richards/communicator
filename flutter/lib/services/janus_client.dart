import 'dart:async';
import 'dart:convert';

import 'package:web_socket_channel/io.dart';
import 'package:web_socket_channel/status.dart' as ws_status;

import '../core/app_config.dart';

typedef JsonMap = Map<String, dynamic>;

class JanusException implements Exception {
  JanusException(this.message);
  final String message;

  @override
  String toString() => message;
}

class JanusClient {
  JanusClient({required this.serverUrl});

  final Uri serverUrl;

  void Function(JsonMap payload, JsonMap? jsep)? onPluginEvent;
  void Function(JsonMap candidate)? onRemoteCandidate;
  void Function(String message)? onLog;
  void Function(Object error)? onDisconnected;

  IOWebSocketChannel? _channel;
  StreamSubscription<dynamic>? _subscription;
  Timer? _keepaliveTimer;
  final Map<String, Completer<JsonMap>> _pending = {};
  String? _apiSecret;
  int _transactionCounter = 0;

  int? sessionId;
  int? handleId;

  bool get isConnected => _channel != null && sessionId != null && handleId != null;

  Future<void> connect({String? apiSecret}) async {
    if (_channel != null) return;

    _apiSecret = apiSecret?.trim().isEmpty == true ? null : apiSecret?.trim();
    final channel = IOWebSocketChannel.connect(
      serverUrl,
      protocols: const ['janus-protocol'],
      pingInterval: const Duration(seconds: 20),
      connectTimeout: const Duration(seconds: 15),
    );
    _channel = channel;

    _subscription = channel.stream.listen(
      _handleMessage,
      onError: (Object error, StackTrace stackTrace) {
        onLog?.call('Janus WebSocket error: $error');
        _failPending(error);
        onDisconnected?.call(error);
      },
      onDone: () {
        final error = JanusException(
          'Janus WebSocket closed (${channel.closeCode ?? 'no code'})',
        );
        onLog?.call(error.message);
        _failPending(error);
        onDisconnected?.call(error);
      },
      cancelOnError: false,
    );

    try {
      await channel.ready;
      onLog?.call('Janus WebSocket connected using janus-protocol');

      final create = await _request({'janus': 'create'});
      final data = _jsonMap(create['data']);
      sessionId = _intValue(data?['id']);
      if (sessionId == null) {
        throw JanusException('Janus create response did not include a session id');
      }

      final attach = await _request({
        'janus': 'attach',
        'plugin': AppConfig.janusSipPlugin,
        'session_id': sessionId,
      });
      final attachData = _jsonMap(attach['data']);
      handleId = _intValue(attachData?['id']);
      if (handleId == null) {
        throw JanusException('Janus attach response did not include a handle id');
      }

      _startKeepalive();
      onLog?.call('Attached ${AppConfig.janusSipPlugin} handle $handleId');
    } catch (_) {
      await disconnect();
      rethrow;
    }
  }

  Future<void> disconnect() async {
    _keepaliveTimer?.cancel();
    _keepaliveTimer = null;

    final channel = _channel;
    _channel = null;
    sessionId = null;
    handleId = null;

    await _subscription?.cancel();
    _subscription = null;

    if (channel != null) {
      try {
        await channel.sink.close(ws_status.goingAway);
      } catch (_) {
        // Socket may already be closed.
      }
    }

    _failPending(JanusException('Janus client disconnected'));
  }

  Future<void> sendPlugin({
    required JsonMap body,
    JsonMap? jsep,
  }) async {
    final sid = sessionId;
    final hid = handleId;
    if (sid == null || hid == null) {
      throw JanusException('Janus SIP plugin is not connected');
    }

    final message = <String, dynamic>{
      'janus': 'message',
      'session_id': sid,
      'handle_id': hid,
      'transaction': _transaction(),
      'body': body,
    };
    if (jsep != null) message['jsep'] = jsep;
    _applySecret(message);
    _sendRaw(message);
  }

  Future<void> sendTrickle(JsonMap candidate) async {
    final sid = sessionId;
    final hid = handleId;
    if (sid == null || hid == null) {
      throw JanusException('Janus SIP plugin is not connected');
    }

    final message = <String, dynamic>{
      'janus': 'trickle',
      'session_id': sid,
      'handle_id': hid,
      'transaction': _transaction(),
      'candidate': candidate,
    };
    _applySecret(message);
    _sendRaw(message);
  }

  Future<JsonMap> _request(JsonMap base) async {
    final transaction = _transaction();
    final message = <String, dynamic>{...base, 'transaction': transaction};
    _applySecret(message);

    final completer = Completer<JsonMap>();
    _pending[transaction] = completer;
    _sendRaw(message);

    try {
      return await completer.future.timeout(const Duration(seconds: 15));
    } on TimeoutException {
      _pending.remove(transaction);
      throw JanusException('Timed out waiting for Janus response');
    }
  }

  void _sendRaw(JsonMap message) {
    final channel = _channel;
    if (channel == null) {
      throw JanusException('Janus WebSocket is not connected');
    }
    channel.sink.add(jsonEncode(message));
  }

  void _handleMessage(dynamic raw) {
    try {
      final decoded = jsonDecode(raw is String ? raw : utf8.decode(raw as List<int>));
      if (decoded is! Map) return;
      final object = Map<String, dynamic>.from(decoded);
      final janus = object['janus'] as String?;

      final transaction = object['transaction'] as String?;
      if (transaction != null && janus != 'ack') {
        final completer = _pending.remove(transaction);
        if (completer != null) {
          if (janus == 'error') {
            final error = _jsonMap(object['error']);
            completer.completeError(
              JanusException(error?['reason']?.toString() ?? 'Janus error'),
            );
          } else {
            completer.complete(object);
          }
          return;
        }
      }

      if (janus == 'event') {
        final pluginData = _jsonMap(object['plugindata']);
        final payload = _jsonMap(pluginData?['data']);
        if (payload != null) {
          onPluginEvent?.call(payload, _jsonMap(object['jsep']));
        }
        return;
      }

      if (janus == 'trickle') {
        final candidate = _jsonMap(object['candidate']);
        if (candidate != null) onRemoteCandidate?.call(candidate);
        return;
      }

      if (janus == 'webrtcup' || janus == 'hangup' || janus == 'media') {
        onLog?.call('Janus event: $object');
      }
    } catch (error) {
      onLog?.call('Unable to parse Janus message: $error');
    }
  }

  void _startKeepalive() {
    _keepaliveTimer?.cancel();
    _keepaliveTimer = Timer.periodic(const Duration(seconds: 25), (_) {
      final sid = sessionId;
      if (sid == null || _channel == null) return;
      final message = <String, dynamic>{
        'janus': 'keepalive',
        'session_id': sid,
        'transaction': _transaction(),
      };
      _applySecret(message);
      try {
        _sendRaw(message);
      } catch (_) {
        // The socket listener will report the connection failure.
      }
    });
  }

  void _applySecret(JsonMap message) {
    final secret = _apiSecret;
    if (secret != null && secret.isNotEmpty) message['apisecret'] = secret;
  }

  String _transaction() {
    _transactionCounter++;
    return '${DateTime.now().microsecondsSinceEpoch.toRadixString(36)}${_transactionCounter.toRadixString(36)}';
  }

  void _failPending(Object error) {
    final pending = List<Completer<JsonMap>>.from(_pending.values);
    _pending.clear();
    for (final completer in pending) {
      if (!completer.isCompleted) completer.completeError(error);
    }
  }

  static JsonMap? _jsonMap(dynamic value) {
    if (value is Map) return Map<String, dynamic>.from(value);
    return null;
  }

  static int? _intValue(dynamic value) {
    if (value is int) return value;
    if (value is num) return value.toInt();
    return int.tryParse(value?.toString() ?? '');
  }
}
