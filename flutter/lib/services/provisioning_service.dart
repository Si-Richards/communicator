import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:http/http.dart' as http;

import '../models/chat_attachment.dart';
import '../models/messaging_room.dart';
import '../models/provisioning.dart';

class ProvisioningException implements Exception {
  const ProvisioningException(this.message, {this.statusCode, this.code});

  final String message;
  final int? statusCode;
  final String? code;

  @override
  String toString() => message;
}

class ProvisioningService {
  ProvisioningService({required String baseUrl, http.Client? client})
    : _baseUrl = baseUrl.trim(),
      _client = client ?? http.Client();

  final String _baseUrl;
  final http.Client _client;

  Uri _uri(String path) {
    var root = _baseUrl.replaceFirst(RegExp(r'/+$'), '');
    if (!root.endsWith('/api/v1')) root = '$root/api/v1';
    return Uri.parse('$root$path');
  }

  Future<List<MessagingRoom>> messagingRooms({
    required String accessToken,
    required String owner,
    String? id,
    Map<String, dynamic>? change,
  }) async {
    final uri = _uri('/device/messaging/rooms${id == null ? '' : '/$id'}');
    final response =
        await (change == null
                ? _client.get(uri, headers: _authHeaders(accessToken))
                : _client.post(
                    uri,
                    headers: _authHeaders(accessToken),
                    body: jsonEncode(change),
                  ))
            .timeout(const Duration(seconds: 25));
    final json = _decode(response);
    if (response.statusCode != 200 && response.statusCode != 201)
      throw _exception(response, json);
    return MessagingRoom.parseList(json, owner);
  }

  Future<ActivationResult> activate({
    required String code,
    required Map<String, dynamic> device,
    Map<String, dynamic>? push,
  }) async {
    final response = await _client
        .post(
          _uri('/device/activate'),
          headers: _jsonHeaders,
          body: jsonEncode({
            'code': code.trim(),
            'device': device,
            if (push != null && push.isNotEmpty) 'push': push,
          }),
        )
        .timeout(const Duration(seconds: 15));
    final json = _decode(response);
    if (response.statusCode != 201 && response.statusCode != 200) {
      throw _exception(response, json);
    }

    final configurationVersion = _int(json['configuration_version']) ?? 0;
    final configJson = _map(json['configuration']);
    return ActivationResult(
      deviceId: json['device_id']?.toString() ?? '',
      accessToken: json['access_token']?.toString() ?? '',
      refreshToken: json['refresh_token']?.toString() ?? '',
      expiresIn: _int(json['expires_in']) ?? 900,
      configurationVersion: configurationVersion,
      configuration: ProvisioningConfiguration.fromJson(
        configJson,
        fallbackVersion: configurationVersion,
      ),
    );
  }

  Future<TokenRefreshResult> refresh(String refreshToken) async {
    final response = await _client
        .post(
          _uri('/device/token/refresh'),
          headers: _jsonHeaders,
          body: jsonEncode({'refresh_token': refreshToken}),
        )
        .timeout(const Duration(seconds: 15));
    final json = _decode(response);
    if (response.statusCode != 200) throw _exception(response, json);
    return TokenRefreshResult(
      accessToken: json['access_token']?.toString() ?? '',
      refreshToken: json['refresh_token']?.toString() ?? '',
      expiresIn: _int(json['expires_in']) ?? 900,
    );
  }

  Future<DeviceCheckInResult> checkIn({
    required String accessToken,
    required Map<String, dynamic> payload,
  }) async {
    final response = await _client
        .post(
          _uri('/device/check-in'),
          headers: _authHeaders(accessToken),
          body: jsonEncode(payload),
        )
        .timeout(const Duration(seconds: 15));
    final json = _decode(response);
    if (response.statusCode != 200) throw _exception(response, json);
    final rawActions = json['actions'];
    return DeviceCheckInResult(
      state: json['state']?.toString() ?? 'active',
      configurationVersion: _int(json['configuration_version']) ?? 0,
      configurationChanged: json['configuration_changed'] == true,
      minimumAppBuild: _int(json['minimum_app_build']),
      forceUpdate: json['force_update'] == true,
      actions: rawActions is List
          ? rawActions.map((value) => value.toString()).toList(growable: false)
          : const [],
    );
  }

  Future<ProvisioningConfiguration> getConfiguration({
    required String accessToken,
  }) async {
    final response = await _client
        .get(_uri('/device/configuration'), headers: _authHeaders(accessToken))
        .timeout(const Duration(seconds: 15));
    final json = _decode(response);
    if (response.statusCode != 200) throw _exception(response, json);
    return ProvisioningConfiguration.fromJson(json);
  }

  Future<void> updatePushTokens({
    required String accessToken,
    required List<Map<String, dynamic>> tokens,
  }) async {
    final response = await _client
        .post(
          _uri('/device/push-tokens'),
          headers: _authHeaders(accessToken),
          body: jsonEncode({'tokens': tokens}),
        )
        .timeout(const Duration(seconds: 15));
    if (response.statusCode != 204 && response.statusCode != 200) {
      throw _exception(response, _decode(response));
    }
  }

  Future<MessagingPushSubscription?> registerMessagingPush({
    required String accessToken,
    required String token,
    required String environment,
  }) async {
    final response = await _client
        .put(
          _uri('/device/messaging/push'),
          headers: _authHeaders(accessToken),
          body: jsonEncode({'token': token, 'environment': environment}),
        )
        .timeout(const Duration(seconds: 15));
    final json = _decode(response);
    if (response.statusCode != 200) {
      throw _exception(response, json);
    }
    return MessagingPushSubscription.fromJson(json);
  }

  Future<void> removeMessagingPush({required String accessToken}) async {
    final response = await _client
        .delete(
          _uri('/device/messaging/push'),
          headers: _authHeaders(accessToken),
        )
        .timeout(const Duration(seconds: 15));
    if (response.statusCode != 204) {
      throw _exception(response, _decode(response));
    }
  }

  Future<ChatAttachment> uploadAttachment({
    required String accessToken,
    required String peer,
    required String name,
    required Uint8List bytes,
  }) async {
    if (bytes.isEmpty || bytes.length > ChatAttachment.maxBytes) {
      throw const ProvisioningException(
        'Attachments must be between 1 byte and 10 MB.',
      );
    }
    final request =
        http.Request(
            'POST',
            _uri(
              '/device/messaging/attachments',
            ).replace(queryParameters: {'peer': peer, 'name': name}),
          )
          ..followRedirects = false
          ..headers.addAll({
            'Authorization': 'Bearer $accessToken',
            'Content-Type': 'application/octet-stream',
          })
          ..bodyBytes = bytes;
    final response = await http.Response.fromStream(
      await _client.send(request).timeout(const Duration(seconds: 90)),
    ).timeout(const Duration(seconds: 90));
    if (response.statusCode != 201) {
      throw _exception(response, _decode(response));
    }
    final attachment = ChatAttachment.fromJson(_decode(response));
    if (attachment.size != bytes.length ||
        attachment.sha256 != sha256.convert(bytes).toString()) {
      throw const ProvisioningException(
        'The uploaded attachment could not be verified.',
      );
    }
    return attachment;
  }

  Future<Uint8List> downloadAttachment({
    required String accessToken,
    required String peer,
    required ChatAttachment attachment,
  }) async {
    final request =
        http.Request(
            'GET',
            _uri(
              '/device/messaging/attachments/${attachment.id}',
            ).replace(queryParameters: {'peer': peer}),
          )
          ..followRedirects = false
          ..headers['Authorization'] = 'Bearer $accessToken';
    final response = await _client
        .send(request)
        .timeout(const Duration(seconds: 30));
    if (response.statusCode != 200) {
      final failure = await http.Response.fromStream(
        response,
      ).timeout(const Duration(seconds: 30));
      throw _exception(failure, _decode(failure));
    }
    final bytes = BytesBuilder(copy: false);
    await (() async {
      await for (final chunk in response.stream.timeout(
        const Duration(seconds: 30),
      )) {
        if (bytes.length + chunk.length > attachment.size) {
          throw const ProvisioningException(
            'The downloaded attachment is larger than expected.',
          );
        }
        bytes.add(chunk);
      }
    })().timeout(
      const Duration(seconds: 90),
      onTimeout: () {
        _client.close();
        throw const ProvisioningException(
          'The attachment download timed out. Please retry.',
        );
      },
    );
    final result = bytes.takeBytes();
    if (result.length != attachment.size ||
        sha256.convert(result).toString() != attachment.sha256) {
      throw const ProvisioningException(
        'The downloaded attachment could not be verified.',
      );
    }
    return result;
  }

  Future<void> logout({
    required String accessToken,
    String reason = 'user_requested',
  }) async {
    final response = await _client
        .post(
          _uri('/device/logout'),
          headers: _authHeaders(accessToken),
          body: jsonEncode({'reason': reason}),
        )
        .timeout(const Duration(seconds: 15));
    if (response.statusCode != 204 && response.statusCode != 200) {
      throw _exception(response, _decode(response));
    }
  }

  Map<String, String> get _jsonHeaders => const {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };

  Map<String, String> _authHeaders(String accessToken) => {
    ..._jsonHeaders,
    'Authorization': 'Bearer $accessToken',
  };

  Map<String, dynamic> _decode(http.Response response) {
    if (response.body.trim().isEmpty) return const {};
    try {
      final value = jsonDecode(response.body);
      return value is Map
          ? Map<String, dynamic>.from(value)
          : const <String, dynamic>{};
    } catch (_) {
      return const {};
    }
  }

  ProvisioningException _exception(
    http.Response response,
    Map<String, dynamic> json,
  ) {
    final error = _map(json['error']);
    return ProvisioningException(
      error['message']?.toString() ??
          'Provisioning request failed (${response.statusCode}).',
      statusCode: response.statusCode,
      code: error['code']?.toString(),
    );
  }

  static Map<String, dynamic> _map(dynamic value) {
    if (value is Map) return Map<String, dynamic>.from(value);
    return const <String, dynamic>{};
  }

  static int? _int(dynamic value) {
    if (value is int) return value;
    return int.tryParse(value?.toString() ?? '');
  }

  void close() => _client.close();
}
