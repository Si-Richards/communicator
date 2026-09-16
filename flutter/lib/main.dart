import 'package:flutter/material.dart';

import 'app.dart';
import 'controllers/phone_controller.dart';
import 'repositories/call_history_repository.dart';
import 'repositories/settings_repository.dart';
import 'services/mobile_call_coordinator.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  final controller = PhoneController(
    settingsRepository: SettingsRepository(),
    historyRepository: CallHistoryRepository(),
  );
  await controller.initialize();

  final mobileCalls = MobileCallCoordinator(controller);
  await mobileCalls.initialize();

  runApp(VoiceHostApp(controller: controller));
}
