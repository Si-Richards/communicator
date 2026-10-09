import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:voicehost_softphone/controllers/phone_controller.dart';
import 'package:voicehost_softphone/controllers/provisioning_controller.dart';
import 'package:voicehost_softphone/models/provisioning.dart';
import 'package:voicehost_softphone/repositories/provisioning_repository.dart';
import 'package:voicehost_softphone/repositories/settings_repository.dart';
import 'package:voicehost_softphone/services/mobile_call_coordinator.dart';

ProvisionedDeviceState savedDevice({String state = 'active'}) =>
    ProvisionedDeviceState(
      deviceId: 'saved-device',
      accessToken: 'fixture-access',
      refreshToken: 'fixture-refresh',
      accessTokenExpiresAt: DateTime.now().add(const Duration(hours: 1)),
      configurationVersion: 1,
      deviceState: state,
      configuration: ProvisioningConfiguration.fromJson({
        'version': 1,
        'device': {'state': state},
        'telephony': {'extension': '213'},
      }),
    );

class StartupRepository extends ProvisioningRepository {
  StartupRepository(this.read);

  final Future<ProvisionedDeviceState?> Function() read;
  int reads = 0;
  int clears = 0;

  @override
  Future<ProvisionedDeviceState?> load() {
    reads++;
    return read();
  }

  @override
  Future<void> clear() async {
    clears++;
  }
}

class StartupPhone extends ChangeNotifier implements PhoneController {
  @override
  String provisioningUrl = '';
  @override
  ConfigurationSource configurationSource = ConfigurationSource.provisioning;
  int applied = 0;
  Future<void>? migrationWait;

  @override
  void applyProvisionedConfiguration(ProvisioningConfiguration config) {
    applied++;
  }

  @override
  Future<void> setConfigurationSource(
    ConfigurationSource source, {
    String? provisioningUrl,
  }) async {
    configurationSource = source;
    this.provisioningUrl = provisioningUrl ?? '';
    await migrationWait;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class StartupCalls extends ChangeNotifier implements MobileCallCoordinator {
  final accessChanges = <bool>[];
  final lockChanges = <bool>[];
  int applied = 0;

  @override
  Future<void> setProvisioningAccess(bool enabled) async {
    accessChanges.add(enabled);
  }

  @override
  Future<void> setAdministrativeLocked(bool locked) async {
    lockChanges.add(locked);
  }

  @override
  void applyProvisionedConfiguration(ProvisioningConfiguration config) {
    applied++;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class StartupController extends ProvisioningController {
  StartupController(StartupRepository repository, {Duration? timeout})
    : super(
        phone: StartupPhone(),
        mobileCalls: StartupCalls(),
        repository: repository,
        cachedStateTimeout: timeout ?? const Duration(seconds: 1),
      );

  // These tests isolate startup from subsequent server reconciliation.
  @override
  Future<void> checkIn() async {}
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'timeout preserves enrollment and allows a retry without ending a call',
    () async {
      final staleRead = Completer<ProvisionedDeviceState?>();
      var fail = true;
      final repository = StartupRepository(
        () => fail ? staleRead.future : Future.value(savedDevice()),
      );
      final controller = StartupController(
        repository,
        timeout: const Duration(milliseconds: 20),
      );
      addTearDown(controller.dispose);

      await expectLater(
        controller.preloadCachedBranding(),
        throwsA(isA<TimeoutException>()),
      );
      expect(controller.startupReady, isFalse);
      expect(controller.startupError, isNotNull);
      expect(controller.canUseApp, isFalse);
      expect(repository.clears, 0);
      expect((controller.mobileCalls as StartupCalls).accessChanges, isEmpty);

      fail = false;
      await controller.retryStartup();
      expect(controller.startupReady, isTrue);
      expect(controller.startupError, isNull);
      expect(controller.deviceId, 'saved-device');
      expect(controller.canUseApp, isTrue);
      expect(repository.reads, 2);

      // A late background result must not erase the successfully loaded state.
      staleRead.complete(null);
      await Future<void>.delayed(Duration.zero);
      expect(controller.deviceId, 'saved-device');
      expect(repository.clears, 0);
      expect((controller.mobileCalls as StartupCalls).accessChanges, isEmpty);
    },
  );

  test(
    'foreground resume recovers a failed background initialization',
    () async {
      var fail = true;
      final repository = StartupRepository(() async {
        if (fail) throw StateError('Protected storage unavailable');
        return savedDevice();
      });
      final controller = StartupController(repository);
      addTearDown(controller.dispose);

      await expectLater(controller.initialize(), throwsA(isA<StateError>()));
      expect(controller.initialized, isFalse);
      expect(controller.startupReady, isFalse);
      expect((controller.mobileCalls as StartupCalls).accessChanges, isEmpty);

      fail = false;
      // Exercise the real observer registration, which must precede the read.
      WidgetsBinding.instance.handleAppLifecycleStateChanged(
        AppLifecycleState.resumed,
      );
      await Future<void>.delayed(Duration.zero);
      expect(controller.initialized, isTrue);
      expect(controller.deviceId, 'saved-device');
      expect((controller.phone as StartupPhone).applied, 1);
      expect((controller.mobileCalls as StartupCalls).accessChanges, [true]);
      expect(repository.clears, 0);
    },
  );

  test(
    'resume during a pending background read retries after its failure',
    () async {
      final background = Completer<ProvisionedDeviceState?>();
      var fail = true;
      final repository = StartupRepository(
        () => fail ? background.future : Future.value(savedDevice()),
      );
      final controller = StartupController(repository);
      addTearDown(controller.dispose);
      final first = controller.preloadCachedBranding();
      final failure = expectLater(first, throwsA(isA<StateError>()));
      controller.didChangeAppLifecycleState(AppLifecycleState.resumed);
      fail = false;
      background.completeError(StateError('Protected storage unavailable'));
      await failure;
      await Future<void>.delayed(Duration.zero);
      expect(repository.reads, 2);
      expect(controller.startupReady, isTrue);
      expect(controller.deviceId, 'saved-device');
    },
  );

  test(
    'overlapping preload and initialization share one saved-state read',
    () async {
      final read = Completer<ProvisionedDeviceState?>();
      final repository = StartupRepository(() => read.future);
      final controller = StartupController(repository);
      addTearDown(controller.dispose);
      final preload = controller.preloadCachedBranding();
      final first = controller.initialize();
      final second = controller.initialize();
      final retry = controller.retryStartup();
      expect(repository.reads, 1);
      read.complete(savedDevice());
      await Future.wait([preload, first, second, retry]);
      expect((controller.phone as StartupPhone).applied, 1);
      expect((controller.mobileCalls as StartupCalls).applied, 1);
      expect((controller.mobileCalls as StartupCalls).accessChanges, [true]);
    },
  );

  for (final state in ['locked', 'revoked', 'retired']) {
    test(
      'cached $state state still blocks app access after recovery',
      () async {
        var fail = true;
        final repository = StartupRepository(() async {
          if (fail) throw StateError('Protected storage unavailable');
          return savedDevice(state: state);
        });
        final controller = StartupController(repository);
        addTearDown(controller.dispose);
        await expectLater(controller.initialize(), throwsA(isA<StateError>()));
        fail = false;
        await controller.retryStartup();
        expect(controller.startupReady, isTrue);
        expect(controller.deviceState, state);
        expect(controller.canUseApp, isFalse);
        expect((controller.mobileCalls as StartupCalls).accessChanges, [false]);
        expect((controller.mobileCalls as StartupCalls).lockChanges, [
          state == 'locked',
        ]);
      },
    );
  }

  test(
    'cached state releases startup before slow service reconciliation',
    () async {
      final repository = StartupRepository(() async => savedDevice());
      final controller = StartupController(repository);
      addTearDown(controller.dispose);
      final migration = Completer<void>();
      final phone = controller.phone as StartupPhone;
      phone.migrationWait = migration.future;
      final pending = controller.initialize();
      await Future<void>.delayed(Duration.zero);
      expect(controller.startupReady, isTrue);
      expect(controller.canUseApp, isTrue);
      expect(controller.startupError, isNull);
      expect(phone.applied, 1);
      migration.complete();
      await pending;
    },
  );

  test(
    'an actual missing cache releases startup to the activation screen',
    () async {
      final repository = StartupRepository(() async => null);
      final controller = StartupController(repository);
      addTearDown(controller.dispose);
      await controller.initialize();
      expect(controller.startupReady, isTrue);
      expect(controller.startupError, isNull);
      expect(controller.isEnrolled, isFalse);
      expect(controller.canUseApp, isFalse);
      expect((controller.mobileCalls as StartupCalls).accessChanges, [false]);
    },
  );

  test('a pending read cannot notify or change state after disposal', () async {
    final read = Completer<ProvisionedDeviceState?>();
    final repository = StartupRepository(() => read.future);
    final controller = StartupController(repository);
    final pending = controller.initialize();
    controller.dispose();
    read.complete(savedDevice());
    await pending;
    expect(controller.startupReady, isFalse);
    expect((controller.mobileCalls as StartupCalls).accessChanges, isEmpty);
    expect(repository.clears, 0);
  });
}
