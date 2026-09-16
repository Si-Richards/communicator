import 'dart:convert';
import 'dart:io';

class GatewayCall {
  const GatewayCall({
    required this.id,
    required this.caller,
    required this.offerSdp,
    this.displayName,
  });

  final String id;
  final String caller;
  final String? displayName;
  final String offerSdp;

  factory GatewayCall.fromJson(Map<String, dynamic> json) => GatewayCall(
        id: json['id']?.toString() ?? '',
        caller: json['caller']?.toString() ?? 'Unknown',
        displayName: json['display_name']?.toString(),
        offerSdp: json['offer_sdp']?.toString() ?? '',
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

  Future<void> candidate(String callId, Map<String, dynamic> candidate) =>
      _jsonRequest(
        'POST',
        '/v1/calls/$callId/candidate',
        body: candidate,
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
