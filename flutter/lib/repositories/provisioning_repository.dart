import 'dart:convert';
import 'dart:math';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../models/provisioning.dart';

class ProvisioningRepository {
  ProvisioningRepository({FlutterSecureStorage? secureStorage})
      : _storage = secureStorage ?? const FlutterSecureStorage();

  static const _stateKey = 'voicehost.provisioning.device_state';
  static const _installationIdKey = 'voicehost.provisioning.installation_id';

  final FlutterSecureStorage _storage;

  Future<ProvisionedDeviceState?> load() async {
    final raw = await _storage.read(key: _stateKey);
    if (raw == null || raw.isEmpty) return null;
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map) return null;
      final state = ProvisionedDeviceState.fromJson(
        Map<String, dynamic>.from(decoded),
      );
      return state.deviceId.isEmpty ? null : state;
    } catch (_) {
      return null;
    }
  }

  Future<void> save(ProvisionedDeviceState state) =>
      _storage.write(key: _stateKey, value: jsonEncode(state.toJson()));

  Future<void> clear() => _storage.delete(key: _stateKey);

  Future<String> getOrCreateInstallationId() async {
    final existing = await _storage.read(key: _installationIdKey);
    if (existing != null && existing.isNotEmpty) return existing;

    final random = Random.secure();
    final bytes = List<int>.generate(16, (_) => random.nextInt(256));
    final id =
        bytes.map((value) => value.toRadixString(16).padLeft(2, '0')).join();
    await _storage.write(key: _installationIdKey, value: id);
    return id;
  }
}
