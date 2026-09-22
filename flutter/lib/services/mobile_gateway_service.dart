import 'dart:convert';
import 'dart:io';

class GatewayCall {
  const GatewayCall({
    required this.id,
    required this.caller,
    required this.offerSdp,
    this.displayName,
    this.connected = false,
    this.held = false,
    this.direction = 'incoming',
  });

  final String id;
  final String caller;
  final String? displayName;
  final String offerSdp;
  final bool connected;
  final bool held;
  final String direction;

  factory GatewayCall.fromJson(Map<String, dynamic> json) => GatewayCall(
        id: json['id']?.toString() ?? '',
        caller: json['caller']?.toString() ?? 'Unknown',
        displayName: json['display_name']?.toString(),
        offerSdp: json['offer_sdp']?.toString() ?? '',
        connected: json['connected'] == true,
        held: json['held'] == true,
        direction: json['direction']?.toString() ?? 'incoming',
      );
}

class MobileGatewayService {
  MobileGatewayService({required this.baseUrl, required this.apiKey});

  final String baseUrl;
  final String apiKey;

  bool get enabled => baseUrl.trim().isNotEmpty && apiKey.trim().isNotEmpty;

  Future<void> registerDevice({
    required String deviceId,
    required String pushToken,
    required String sipUsername,
    required String sipPassword,
    required String sipRealm,
    required String nickname,
    required bool doNotDisturb,
    String? sipProxy,
  }) async {
    await _jsonRequest(
      'POST',
      '/v1/devices/register',
      body: {
        'device_id': deviceId,
        'platform': 'ios',
        'push_token': pushToken,
        'sip_username': sipUsername,
        'sip_password': sipPassword,
        'sip_realm': sipRealm,
        'sip_proxy': sipProxy,
        'nickname': nickname,
        'dnd': doNotDisturb,
      },
    );
  }

  Future<String> startCall({
    required String deviceId,
    required String target,
    required String offerSdp,
  }) async {
    final json = await _jsonRequest(
      'POST',
      '/v1/devices/$deviceId/calls',
      body: {'target': target, 'sdp': offerSdp},
    );
    return json['call_id']?.toString() ?? '';
  }

  Future<GatewayCall> getCall(String callId) async {
    final json = await _jsonRequest('GET', '/v1/calls/$callId');
    return GatewayCall.fromJson(json);
  }

  Future<void> answer(String callId, String sdp) => _jsonRequest(
        'POST',
        '/v1/calls/$callId/answer',
        body: {'sdp': sdp},
      );

  Future<void> decline(String callId) =>
      _jsonRequest('POST', '/v1/calls/$callId/decline');

  Future<void> hangup(String callId) =>
      _jsonRequest('POST', '/v1/calls/$callId/hangup');

  Future<void> hold(String callId) =>
      _jsonRequest('POST', '/v1/calls/$callId/hold');

  Future<void> resume(String callId) =>
      _jsonRequest('POST', '/v1/calls/$callId/resume');

  Future<void> candidate(String callId, Map<String, dynamic> candidate) =>
      _jsonRequest(
        'POST',
        '/v1/calls/$callId/candidate',
        body: candidate,
      );

  Future<void> blindTransfer(String callId, String target) =>
      _jsonRequest(
        'POST',
        '/v1/calls/$callId/transfer/blind',
        body: {'target': target},
      );

  Future<String> startAttendedTransfer(
    String callId,
    String target,
    String offerSdp,
  ) async {
    final json = await _jsonRequest(
      'POST',
      '/v1/calls/$callId/transfer/attended',
      body: {'target': target, 'sdp': offerSdp},
    );
    return json['transfer_id']?.toString() ?? '';
  }

  Future<void> transferCandidate(
    String transferId,
    Map<String, dynamic> candidate,
  ) =>
      _jsonRequest(
        'POST',
        '/v1/transfers/$transferId/candidate',
        body: candidate,
      );

  Future<void> completeAttendedTransfer(String transferId) =>
      _jsonRequest('POST', '/v1/transfers/$transferId/complete');

  Future<void> cancelAttendedTransfer(String transferId) =>
      _jsonRequest('POST', '/v1/transfers/$transferId/cancel');

  Future<WebSocket> watchTransfer(String transferId) async {
    final uri = Uri.parse(_url('/v1/transfers/$transferId/events'));
    final wsUri = uri.replace(scheme: uri.scheme == 'https' ? 'wss' : 'ws');
    return WebSocket.connect(
      wsUri.toString(),
      headers: {'X-Gateway-Key': apiKey},
    );
  }

  Future<void> diagnostic(
    String event, {
    String? callId,
    Map<String, Object> details = const {},
  }) =>
      _jsonRequest(
        'POST',
        '/v1/diagnostics',
        body: {
          'event': event,
          'call_id': callId,
          'details': details,
        },
      );

  Future<WebSocket> watchCall(String callId) async {
    final uri = Uri.parse(_url('/v1/calls/$callId/events'));
    final wsUri = uri.replace(scheme: uri.scheme == 'https' ? 'wss' : 'ws');
    return WebSocket.connect(
      wsUri.toString(),
      headers: {'X-Gateway-Key': apiKey},
    );
  }

  Future<Map<String, dynamic>> _jsonRequest(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    final client = HttpClient();
    try {
      final request = await client.openUrl(method, Uri.parse(_url(path)));
      request.headers.set(HttpHeaders.acceptHeader, 'application/json');
      request.headers.set('X-Gateway-Key', apiKey);
      if (body != null) {
        request.headers.contentType = ContentType.json;
        request.write(jsonEncode(body));
      }
      final response = await request.close();
      final text = await utf8.decoder.bind(response).join();
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw HttpException(
          'Gateway $method $path failed (${response.statusCode}): $text',
        );
      }
      if (text.trim().isEmpty) return <String, dynamic>{};
      final decoded = jsonDecode(text);
      return decoded is Map
          ? Map<String, dynamic>.from(decoded)
          : <String, dynamic>{};
    } finally {
      client.close(force: true);
    }
  }

  String _url(String path) =>
      '${baseUrl.replaceFirst(RegExp(r'/+$'), '')}$path';
}
