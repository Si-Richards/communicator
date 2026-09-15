import 'package:flutter/material.dart';

import 'controllers/phone_controller.dart';
import 'ui/call_history_screen.dart';
import 'ui/phone_screen.dart';
import 'ui/settings_screen.dart';
import 'ui/voicemail_screen.dart';

class VoiceHostApp extends StatelessWidget {
  const VoiceHostApp({super.key, required this.controller});

  final PhoneController controller;

  @override
  Widget build(BuildContext context) {
    const orange = Color(0xFFFF6600);
    const navy = Color(0xFF113B53);

    return MaterialApp(
      title: 'VoiceHost',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          seedColor: orange,
          primary: orange,
          secondary: navy,
        ),
        useMaterial3: true,
        scaffoldBackgroundColor: const Color(0xFFF8F9FB),
      ),
      home: MainShell(controller: controller),
    );
  }
}

class MainShell extends StatefulWidget {
  const MainShell({super.key, required this.controller});

  final PhoneController controller;

  @override
  State<MainShell> createState() => _MainShellState();
}

class _MainShellState extends State<MainShell> {
  int _selectedIndex = 0;

  void _goToPhone() => setState(() => _selectedIndex = 0);

  @override
  Widget build(BuildContext context) {
    final controller = widget.controller;
    final screens = [
      PhoneScreen(controller: controller),
      CallHistoryScreen(controller: controller, onGoToPhone: _goToPhone),
      VoicemailScreen(controller: controller, onGoToPhone: _goToPhone),
      SettingsScreen(controller: controller),
    ];

    return AnimatedBuilder(
      animation: controller,
      builder: (context, _) {
        final newMessages = controller.voicemail.newMessages;
        return Scaffold(
          body: IndexedStack(index: _selectedIndex, children: screens),
          bottomNavigationBar: NavigationBar(
            selectedIndex: _selectedIndex,
            onDestinationSelected: (index) {
              setState(() => _selectedIndex = index);
            },
            destinations: [
              const NavigationDestination(
                icon: Icon(Icons.phone_outlined),
                selectedIcon: Icon(Icons.phone),
                label: 'Phone',
              ),
              const NavigationDestination(
                icon: Icon(Icons.history),
                selectedIcon: Icon(Icons.history),
                label: 'Recents',
              ),
              NavigationDestination(
                icon: Badge(
                  isLabelVisible: newMessages > 0,
                  label: Text('$newMessages'),
                  child: const Icon(Icons.voicemail_outlined),
                ),
                selectedIcon: Badge(
                  isLabelVisible: newMessages > 0,
                  label: Text('$newMessages'),
                  child: const Icon(Icons.voicemail),
                ),
                label: 'Voicemail',
              ),
              const NavigationDestination(
                icon: Icon(Icons.settings_outlined),
                selectedIcon: Icon(Icons.settings),
                label: 'Settings',
              ),
            ],
          ),
        );
      },
    );
  }
}
