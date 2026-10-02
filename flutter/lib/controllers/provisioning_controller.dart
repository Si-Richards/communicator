import 'dart:async';
import 'dart:io';

import 'package:flutter/widgets.dart';

import '../controllers/phone_controller.dart';
import '../core/app_config.dart';
import '../models/provisioning.dart';
import '../repositories/provisioning_repository.dart';
import '../repositories/settings_repository.dart';
import '../services/mobile_call_coordinator.dart';
import '../services/provisioning_service.dart';

class ProvisioningController extends ChangeNotifier with WidgetsBindingObserver {
  ProvisioningController({
    required this.phone,
    required this.mobileCalls,
    ProvisioningRepository? repository,
  }) : _repository = repository ?? ProvisioningRepository();

  final PhoneController phone;
  final MobileCallCoordinator mobileCalls;
  final ProvisioningRepository _repository;

  ProvisionedDeviceState? _state;
  bool _initialized = false;
  bool _busy = false;
  Timer? _checkInTimer;
  String _status = 'Not provisioned';
  String? _error;
  bool _credentialsInvalid = false;

  bool get initialized => _initialized;
  bool get busy => _busy;
  bool get isEnrolled => _state != null;
  String get status => _status;
  String? get error => _error;
  bool get credentialsInvalid => _credentialsInvalid;
  String? get deviceId => _state?.deviceId;
  String get deviceState => _state?.deviceState ?? 'unprovisioned';
  int get configurationVersion => _state?.configurationVersion ?? 0;
  ProvisioningConfiguration? get configuration => _state?.configuration;
  bool get isLocked => deviceState == 'locked';
  bool get isRevoked => deviceState == 'revoked';
  bool get isRetired => deviceState == 'retired';
  bool get canUseApp =>
      isEnrolled &&
      !_credentialsInvalid &&
      !isLocked &&
      !isRevoked &&
      !isRetired;

  Future<void> initialize() async {
    if (_initialized) return;
    WidgetsBinding.instance.addObserver(this);
    _state = await _repository.load();
    _initialized = true;

    if (_state != null) {
      _status = 'Provisioned';
      final config = _state!.configuration;
      if (config != null) {
        phone.applyProvisionedConfiguration(config);
        mobileCalls.applyProvisionedConfiguration(config);
      }
      // Managed clients always use the provisioning endpoint supplied by
      // the current build. Migrate legacy saved development IP addresses
      // without clearing the existing device ID or refresh credentials.
      final managedUrl = AppConfig.provisioningUrl;
      await phone.setConfigurationSource(
        ConfigurationSource.provisioning,
        provisioningUrl: managedUrl,
      );
      _syncPolling();
      unawaited(mobileCalls.setAdministrativeLocked(isLocked));
      notifyListeners();
      debugPrint(
        '[VoiceHost Provisioning] cached state=$deviceState '
        'source=${phone.configurationSource.name} '
        'url=${phone.provisioningUrl.trim().isEmpty ? 'missing' : 'configured'}',
      );
      if (phone.provisioningUrl.trim().isNotEmpty) {
        unawaited(checkIn());
      }
    } else {
      notifyListeners();
    }
    await mobileCalls.setProvisioningAccess(canUseApp);
  }

  Future<void> activate({
    required String serverUrl,
    required String code,
  }) async {
    if (_busy) return;
    final cleanUrl = serverUrl.trim();
    final cleanCode = code.trim();
    final uri = Uri.tryParse(cleanUrl);
    if (uri == null ||
        !uri.hasScheme ||
        (uri.scheme != 'https' && uri.scheme != 'http')) {
      throw StateError('Enter a valid provisioning server URL.');
    }
    if (cleanCode.isEmpty) {
      throw StateError('Enter the activation code.');
    }

    _setBusy(true, status: 'Activating device…');
    try {
      final installationId = await _repository.getOrCreateInstallationId();
      final service = ProvisioningService(baseUrl: cleanUrl);
      try {
        final pushToken = mobileCalls.voipPushToken;
        final result = await service.activate(
          code: cleanCode,
          device: {
            'installation_id': installationId,
            'platform': _platform,
            'device_type': _deviceType,
            'device_name': phone.extensionDisplayName,
            'app_version': AppConfig.appVersion,
            'app_build': AppConfig.appBuild,
            'os_version': Platform.operatingSystemVersion,
          },
          push: pushToken == null || pushToken.isEmpty
              ? null
              : {
                  'voip_token': pushToken,
                  'environment': AppConfig.pushEnvironment,
                },
        );

        if (result.deviceId.isEmpty ||
            result.accessToken.isEmpty ||
            result.refreshToken.isEmpty) {
          throw const ProvisioningException(
            'Provisioning server returned incomplete device credentials.',
          );
        }

        final expiresAt = DateTime.now().toUtc().add(
              Duration(seconds: result.expiresIn),
            );
        _state = ProvisionedDeviceState(
          deviceId: result.deviceId,
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          accessTokenExpiresAt: expiresAt,
          configurationVersion: result.configurationVersion,
          deviceState: result.configuration.deviceState ?? 'active',
          configuration: result.configuration,
        );
        await _repository.save(_state!);
        await phone.setConfigurationSource(
          ConfigurationSource.provisioning,
          provisioningUrl: cleanUrl,
        );
        phone.applyProvisionedConfiguration(result.configuration);
        mobileCalls.applyProvisionedConfiguration(result.configuration);
        _credentialsInvalid = false;
        _syncPolling();
        await mobileCalls.setProvisioningAccess(canUseApp);
        unawaited(mobileCalls.setAdministrativeLocked(isLocked));
        _error = null;
        _status = 'Provisioned';
      } finally {
        service.close();
      }
    } catch (error) {
      _error = error.toString();
      _status = 'Activation failed';
      rethrow;
    } finally {
      _setBusy(false);
    }
  }

  Future<void> checkIn() async {
    if (_busy || _state == null) return;
    final url = phone.provisioningUrl.trim();
    if (url.isEmpty) return;

    _setBusy(true, status: 'Checking provisioning…');
    final service = ProvisioningService(baseUrl: url);
    try {
      var state = _state!;
      DeviceCheckInResult result;
      try {
        // Always try the current access token first. A stale/invalid refresh
        // credential must not prevent an otherwise-valid access token from
        // checking the authoritative device state and clearing a cached lock.
        result = await service.checkIn(
          accessToken: state.accessToken,
          payload: _checkInPayload(state),
        );
      } on ProvisioningException catch (error) {
        if (error.statusCode != 401) rethrow;
        debugPrint(
          '[VoiceHost Provisioning] access token rejected; attempting refresh',
        );
        await _refreshToken(service);
        state = _state!;
        result = await service.checkIn(
          accessToken: state.accessToken,
          payload: _checkInPayload(state),
        );
      }

      debugPrint(
        '[VoiceHost Provisioning] check-in state=${result.state} '
        'version=${result.configurationVersion} '
        'changed=${result.configurationChanged}',
      );

      var updated = _state!.copyWith(
        deviceState: result.state,
        configurationVersion: result.configurationVersion,
      );

      // Device state is authoritative and must be applied immediately.
      // In particular, a transition from locked -> active must not depend on
      // the optional configuration refresh succeeding.
      _state = updated;
      await _repository.save(updated);
      _credentialsInvalid = false;
      _syncPolling();
      await mobileCalls.setProvisioningAccess(canUseApp);
      await mobileCalls.setAdministrativeLocked(isLocked);
      _error = null;
      _status = switch (updated.deviceState) {
        'locked' => 'Device locked',
        'revoked' => 'Device revoked',
        'retired' => 'Device retired',
        _ => 'Provisioned',
      };
      notifyListeners();

      if (result.configurationChanged ||
          result.actions.contains('refresh_configuration')) {
        try {
          final config = await service.getConfiguration(
            accessToken: updated.accessToken,
          );
          updated = updated.copyWith(
            configurationVersion: config.version,
            configuration: config,
            deviceState: config.deviceState ?? result.state,
          );
          _state = updated;
          await _repository.save(updated);
          phone.applyProvisionedConfiguration(config);
          mobileCalls.applyProvisionedConfiguration(config);
          _syncPolling();
          await mobileCalls.setAdministrativeLocked(isLocked);
          _status = switch (updated.deviceState) {
            'locked' => 'Device locked',
            'revoked' => 'Device revoked',
            'retired' => 'Device retired',
            _ => 'Provisioned',
          };
          notifyListeners();
        } on ProvisioningException catch (error) {
          // Locked devices are intentionally denied configuration retrieval.
          // Keep the successfully synchronized state rather than reverting to
          // stale local state because a configuration refresh was unavailable.
          if (error.statusCode != 423 || updated.deviceState != 'locked') {
            rethrow;
          }
        }
      }
    } catch (error) {
      if (error is ProvisioningException &&
          error.code == 'refresh_token_invalid') {
        _credentialsInvalid = true;
        _status = 'Re-activation required';
        _syncPolling();
      } else {
        _status = 'Provisioning unavailable';
      }
      if (_credentialsInvalid) {
        await mobileCalls.setProvisioningAccess(false);
      }
      _error = error.toString();
      debugPrint('[VoiceHost Provisioning] check-in failed: $error');
    } finally {
      service.close();
      _setBusy(false);
    }
  }

  Future<void> refreshConfiguration() async {
    if (_busy || _state == null) return;
    final url = phone.provisioningUrl.trim();
    if (url.isEmpty) return;

    _setBusy(true, status: 'Refreshing configuration…');
    final service = ProvisioningService(baseUrl: url);
    try {
      await _ensureFreshToken(service);
      final config = await service.getConfiguration(
        accessToken: _state!.accessToken,
      );
      final updated = _state!.copyWith(
        configurationVersion: config.version,
        configuration: config,
        deviceState: config.deviceState ?? _state!.deviceState,
      );
      _state = updated;
      await _repository.save(updated);
      _syncPolling();
      await mobileCalls.setProvisioningAccess(canUseApp);
      unawaited(mobileCalls.setAdministrativeLocked(isLocked));
      phone.applyProvisionedConfiguration(config);
      mobileCalls.applyProvisionedConfiguration(config);
      _error = null;
      _status = 'Provisioned';
    } catch (error) {
      if (error is ProvisioningException &&
          error.code == 'refresh_token_invalid') {
        _credentialsInvalid = true;
        _syncPolling();
        await mobileCalls.setProvisioningAccess(false);
        _status = 'Re-activation required';
      } else {
        _status = 'Configuration refresh failed';
      }
      _error = error.toString();
      rethrow;
    } finally {
      service.close();
      _setBusy(false);
    }
  }

  Future<void> removeManagedConfiguration({
    bool notifyServer = true,
  }) async {
    if (_busy) return;
    _setBusy(true, status: 'Removing managed configuration…');
    final state = _state;
    final url = phone.provisioningUrl.trim();

    if (notifyServer && state != null && url.isNotEmpty) {
      final service = ProvisioningService(baseUrl: url);
      try {
        await _ensureFreshToken(service);
        await service.logout(accessToken: _state!.accessToken);
      } catch (_) {
        // Local removal must remain possible if the server is unavailable.
      } finally {
        service.close();
      }
    }

    await _repository.clear();
    _state = null;
    _credentialsInvalid = false;
    _syncPolling();
    await mobileCalls.setProvisioningAccess(false);
    await mobileCalls.setAdministrativeLocked(false);
    await phone.setConfigurationSource(
      ConfigurationSource.provisioning,
      provisioningUrl: AppConfig.provisioningUrl,
    );
    _error = null;
    _status = 'Not provisioned';
    _setBusy(false);
  }

  Future<void> _ensureFreshToken(ProvisioningService service) async {
    if (_state?.accessTokenExpiring == true) {
      await _refreshToken(service);
    }
  }

  Future<void> _refreshToken(ProvisioningService service) async {
    final current = _state;
    if (current == null) return;
    // A lost HTTP response does not mean rotation failed server-side.
    // Retry the *same* token once; the server's short idempotent replay
    // window returns the same successor pair rather than revoking the device.
    TokenRefreshResult result;
    try {
      result = await service.refresh(current.refreshToken);
    } on TimeoutException {
      result = await service.refresh(current.refreshToken);
    } on SocketException {
      result = await service.refresh(current.refreshToken);
    }
    if (result.accessToken.isEmpty || result.refreshToken.isEmpty) {
      throw const ProvisioningException(
        'Provisioning server returned incomplete refreshed credentials.',
      );
    }
    final updated = current.copyWith(
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      accessTokenExpiresAt: DateTime.now().toUtc().add(
            Duration(seconds: result.expiresIn),
          ),
    );
    _state = updated;
    await _repository.save(updated);
  }

  Map<String, dynamic> _checkInPayload(ProvisionedDeviceState state) {
    final pushToken = mobileCalls.voipPushToken;
    return {
      'configuration_version': state.configurationVersion,
      'app_version': AppConfig.appVersion,
      'app_build': AppConfig.appBuild,
      'os_version': Platform.operatingSystemVersion,
      if (pushToken != null && pushToken.isNotEmpty)
        'push': {
          'voip_token': pushToken,
          'environment': AppConfig.pushEnvironment,
        },
    };
  }

  String get _platform {
    if (Platform.isIOS) return 'ios';
    if (Platform.isAndroid) return 'android';
    if (Platform.isWindows) return 'windows';
    if (Platform.isMacOS) return 'macos';
    return Platform.operatingSystem;
  }

  String get _deviceType =>
      Platform.isIOS || Platform.isAndroid ? 'mobile' : 'desktop';

  void _syncPolling() {
    _checkInTimer?.cancel();
    _checkInTimer = null;
    if (!isEnrolled ||
        _credentialsInvalid ||
        phone.provisioningUrl.trim().isEmpty) {
      return;
    }

    _checkInTimer = Timer.periodic(
      Duration(seconds: isLocked ? 10 : 60),
      (_) => unawaited(checkIn()),
    );
  }

  void _setBusy(bool value, {String? status}) {
    _busy = value;
    if (status != null) _status = status;
    notifyListeners();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed &&
        isEnrolled &&
        !_credentialsInvalid &&
        phone.provisioningUrl.trim().isNotEmpty) {
      unawaited(checkIn());
    }
  }

  @override
  void dispose() {
    _checkInTimer?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }
}
