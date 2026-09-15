import 'package:flutter/material.dart';

import 'app.dart';
import 'controllers/phone_controller.dart';
import 'repositories/call_history_repository.dart';
import 'repositories/settings_repository.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  final controller = PhoneController(
    settingsRepository: SettingsRepository(),
    historyRepository: CallHistoryRepository(),
  );
  await controller.initialize();

  runApp(VoiceHostApp(controller: controller));
}
