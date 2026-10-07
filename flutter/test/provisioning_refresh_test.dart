import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:voicehost_softphone/controllers/phone_controller.dart';
import 'package:voicehost_softphone/controllers/provisioning_controller.dart';
import 'package:voicehost_softphone/models/provisioning.dart';
import 'package:voicehost_softphone/repositories/provisioning_repository.dart';
import 'package:voicehost_softphone/repositories/settings_repository.dart';
import 'package:voicehost_softphone/services/mobile_call_coordinator.dart';
import 'package:voicehost_softphone/services/provisioning_service.dart';

Map<String, dynamic> configuration(int version, {bool legacy = false}) => {
  'version': version,
  'device': {'state': 'active'},
  if (!legacy)
    'messaging': version < 3
        ? {'enabled': false}
        : {
            'enabled': true,
            'jid': '207@ejabberd.voicehost.io',
            'password': 'fixture-secret',
            'websocket': 'wss://ejabberd.voicehost.io/websocket',
          },
};

class MemoryRepository extends ProvisioningRepository {
  MemoryRepository({int advertisedVersion = 2, bool legacy = false})
      : state = ProvisionedDeviceState(
          deviceId: 'fixture-device',
          accessToken: 'fixture-access',
          refreshToken: 'fixture-refresh',
          accessTokenExpiresAt: DateTime.now().add(const Duration(hours: 1)),
          configurationVersion: advertisedVersion,
          deviceState: 'active',
          configuration: ProvisioningConfiguration.fromJson(
            configuration(legacy ? 3 : 2, legacy: legacy),
          ),
        );

  ProvisionedDeviceState state;
  bool failConfigurationSave = false;

  @override
  Future<ProvisionedDeviceState?> load() async => state;

  @override
  Future<void> save(ProvisionedDeviceState value) async {
    if (failConfigurationSave && value.configuration?.messaging?.enabled == true) {
      throw StateError('Fixture secure storage failure');
    }
    state = value;
  }
}

class FixturePhone extends ChangeNotifier implements PhoneController {
  @override
  String provisioningUrl = 'https://provisioning.example';
  @override
  ConfigurationSource configurationSource = ConfigurationSource.provisioning;
  final applied = <ProvisioningConfiguration>[];
  @override
  void applyProvisionedConfiguration(ProvisioningConfiguration config) =>
      applied.add(config);
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class FixtureCalls extends ChangeNotifier implements MobileCallCoordinator {
  bool access = true;
  bool locked = false;
  @override
  String? get voipPushToken => null;
  @override
  Future<void> setProvisioningAccess(bool enabled) async {
    access = enabled;
  }
  @override
  Future<void> setAdministrativeLocked(bool value) async {
    locked = value;
  }
  @override
  void applyProvisionedConfiguration(ProvisioningConfiguration config) {}
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  for (final failure in ['download', 'storage', 'locked']) {
    test('$failure leaves configuration pending and retries after reopening', () async {
      final repository = MemoryRepository();
      final acknowledged = <int>[];
      var fail = true;
      var downloads = 0;
      Future<http.Response> handle(http.Request request) async {
        if (request.url.path.endsWith('/check-in')) {
          final version = (jsonDecode(request.body) as Map)['configuration_version'] as int;
          acknowledged.add(version);
          return http.Response(jsonEncode({
            'state': fail && failure == 'locked' ? 'locked' : 'active',
            'configuration_version': 3,
            'configuration_changed': version != 3,
          }), 200);
        }
        downloads++;
        if (fail && failure != 'storage') {
          return http.Response('{}', failure == 'locked' ? 423 : 503);
        }
        return http.Response(jsonEncode(configuration(3)), 200);
      }

      ProvisioningController controller(FixturePhone phone, FixtureCalls calls) =>
          ProvisioningController(
            phone: phone,
            mobileCalls: calls,
            repository: repository,
            serviceFactory: (url) => ProvisioningService(
              baseUrl: url,
              client: MockClient(handle),
            ),
          );
      repository.failConfigurationSave = failure == 'storage';
      final firstCalls = FixtureCalls();
      final first = controller(FixturePhone(), firstCalls);
      await first.preloadCachedBranding();
      await first.checkIn();
      expect(repository.state.configurationVersion, 2);
      expect(first.configuration?.messaging?.enabled, isFalse);
      if (failure == 'locked') {
        expect(first.isLocked, isTrue);
        expect(firstCalls.access, isFalse);
        expect(firstCalls.locked, isTrue);
      }
      first.dispose();

      fail = false;
      repository.failConfigurationSave = false;
      final phone = FixturePhone();
      final calls = FixtureCalls();
      final reopened = controller(phone, calls);
      addTearDown(reopened.dispose);
      await reopened.preloadCachedBranding();
      await reopened.checkIn();
      expect(acknowledged, [2, 2]);
      expect(downloads, 2);
      expect(reopened.configurationVersion, 3);
      expect(reopened.configuration?.messaging?.configured, isTrue);
      expect(phone.applied.single.messaging?.password, 'fixture-secret');
      expect(calls.access, isTrue);
      await reopened.checkIn();
      expect(acknowledged, [2, 2, 3]);
      expect(downloads, 2);
    });
  }

  for (final legacy in [false, true]) {
    test('repairs ${legacy ? 'missing messaging with matching versions' : 'premature version acknowledgement'}', () async {
      final repository = MemoryRepository(advertisedVersion: 3, legacy: legacy);
      final acknowledged = <int>[];
      var downloads = 0;
      final controller = ProvisioningController(
        phone: FixturePhone(),
        mobileCalls: FixtureCalls(),
        repository: repository,
        serviceFactory: (url) => ProvisioningService(
          baseUrl: url,
          client: MockClient((request) async {
            if (request.url.path.endsWith('/check-in')) {
              acknowledged.add((jsonDecode(request.body) as Map)['configuration_version'] as int);
              // Reproduce a server saying no change despite an incomplete cache.
              return http.Response(jsonEncode({
                'state': 'active',
                'configuration_version': 3,
                'configuration_changed': false,
              }), 200);
            }
            downloads++;
            return http.Response(jsonEncode(configuration(3)), 200);
          }),
        ),
      );
      addTearDown(controller.dispose);
      await controller.preloadCachedBranding();
      await controller.checkIn();
      expect(acknowledged.single, legacy ? 3 : 2);
      expect(controller.configuration?.messaging?.configured, isTrue);
      await controller.checkIn();
      expect(downloads, 1);
    });
  }
}
