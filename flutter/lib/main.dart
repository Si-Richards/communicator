import 'dart:async';

import 'package:flutter/material.dart';

import 'app.dart';
import 'controllers/phone_controller.dart';
import 'controllers/provisioning_controller.dart';
import 'repositories/call_history_repository.dart';
import 'repositories/settings_repository.dart';
import 'services/mobile_call_coordinator.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  final controller = PhoneController(
    settingsRepository: SettingsRepository(),
    historyRepository: CallHistoryRepository(),
  );
  final mobileCalls = MobileCallCoordinator(controller);
  final provisioning = ProvisioningController(
    phone: controller,
    mobileCalls: mobileCalls,
  );

  // Render Flutter immediately. Service initialization deliberately happens
  // after the first frame so a slow Keychain/plugin operation cannot leave
  // iOS permanently displaying the native launch storyboard.
  runApp(
    VoiceHostApp(
      controller: controller,
      mobileCalls: mobileCalls,
      provisioning: provisioning,
    ),
  );

  WidgetsBinding.instance.addPostFrameCallback((_) {
    debugPrint('[VoiceHost Boot] first Flutter frame rendered');
  });

  unawaited(_initializeServices(controller, mobileCalls, provisioning));
}

Future<void> _initializeServices(
  PhoneController controller,
  MobileCallCoordinator mobileCalls,
  ProvisioningController provisioning,
) async {
  final started = DateTime.now();
  debugPrint('[VoiceHost Boot] initialization started');

  try {
    await provisioning.preloadCachedBranding();
    debugPrint(
      '[VoiceHost Boot] cached branding preloaded '
      'after ${DateTime.now().difference(started).inMilliseconds}ms',
    );
  } catch (error, stackTrace) {
    debugPrint('[VoiceHost Boot] cached branding preload failed: $error');
    debugPrintStack(stackTrace: stackTrace);
  }

  try {
    debugPrint('[VoiceHost Boot] phone controller initialization started');
    await controller.initialize();
    debugPrint(
      '[VoiceHost Boot] phone controller initialization completed '
      'after ${DateTime.now().difference(started).inMilliseconds}ms',
    );
  } catch (error, stackTrace) {
    debugPrint('[VoiceHost Boot] phone controller initialization failed: $error');
    debugPrintStack(stackTrace: stackTrace);
  }

  try {
    debugPrint('[VoiceHost Boot] mobile call initialization started');
    await mobileCalls.initialize();
    debugPrint(
      '[VoiceHost Boot] mobile call initialization completed '
      'after ${DateTime.now().difference(started).inMilliseconds}ms',
    );
  } catch (error, stackTrace) {
    debugPrint('[VoiceHost Boot] mobile call initialization failed: $error');
    debugPrintStack(stackTrace: stackTrace);
  }

  try {
    debugPrint('[VoiceHost Boot] provisioning initialization started');
    await provisioning.initialize();
    debugPrint(
      '[VoiceHost Boot] provisioning initialization completed '
      'after ${DateTime.now().difference(started).inMilliseconds}ms',
    );
  } catch (error, stackTrace) {
    debugPrint('[VoiceHost Boot] provisioning initialization failed: $error');
    debugPrintStack(stackTrace: stackTrace);
  }

  debugPrint(
    '[VoiceHost Boot] initialization finished after '
    '${DateTime.now().difference(started).inMilliseconds}ms',
  );
}
