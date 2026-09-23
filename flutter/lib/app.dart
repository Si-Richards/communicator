import 'package:flutter/material.dart';

import 'controllers/phone_controller.dart';
import 'services/mobile_call_coordinator.dart';
import 'ui/call_history_screen.dart';
import 'ui/contacts_screen.dart';
import 'ui/phone_screen.dart';
import 'ui/settings_screen.dart';

class VoiceHostApp extends StatelessWidget {
  const VoiceHostApp({
    super.key,
    required this.controller,
    required this.mobileCalls,
  });

  final PhoneController controller;
  final MobileCallCoordinator mobileCalls;

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
          onPrimary: Colors.white,
          primaryContainer: orange,
          onPrimaryContainer: Colors.white,
          secondary: navy,
        ),
        appBarTheme: const AppBarTheme(
          backgroundColor: orange,
          foregroundColor: Colors.white,
          surfaceTintColor: Colors.transparent,
          iconTheme: IconThemeData(color: Colors.white),
          actionsIconTheme: IconThemeData(color: Colors.white),
          titleTextStyle: TextStyle(
            color: Colors.white,
            fontSize: 20,
            fontWeight: FontWeight.w600,
          ),
        ),
        navigationBarTheme: NavigationBarThemeData(
          backgroundColor: orange,
          indicatorColor: Colors.white.withValues(alpha: 0.20),
          iconTheme: WidgetStateProperty.resolveWith(
            (states) => const IconThemeData(color: Colors.white),
          ),
          labelTextStyle: WidgetStateProperty.resolveWith(
            (states) => TextStyle(
              color: Colors.white,
              fontWeight: states.contains(WidgetState.selected)
                  ? FontWeight.w700
                  : FontWeight.w500,
            ),
          ),
        ),
        filledButtonTheme: FilledButtonThemeData(
          style: FilledButton.styleFrom(
            backgroundColor: orange,
            foregroundColor: Colors.white,
          ),
        ),
        floatingActionButtonTheme: const FloatingActionButtonThemeData(
          backgroundColor: orange,
          foregroundColor: Colors.white,
        ),
        progressIndicatorTheme: const ProgressIndicatorThemeData(
          color: orange,
        ),
        useMaterial3: true,
        scaffoldBackgroundColor: const Color(0xFFF8F9FB),
      ),
      home: MainShell(controller: controller, mobileCalls: mobileCalls),
    );
  }
}

class MainShell extends StatefulWidget {
  const MainShell({
    super.key,
    required this.controller,
    required this.mobileCalls,
  });

  final PhoneController controller;
  final MobileCallCoordinator mobileCalls;

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
      PhoneScreen(controller: controller, mobileCalls: widget.mobileCalls),
      CallHistoryScreen(
        controller: controller,
        mobileCalls: widget.mobileCalls,
        onGoToPhone: _goToPhone,
      ),
      ContactsScreen(controller: controller, onGoToPhone: _goToPhone),
      SettingsScreen(
        controller: controller,
        mobileCalls: widget.mobileCalls,
      ),
    ];

    return AnimatedBuilder(
      animation: controller,
      builder: (context, _) {
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
              const NavigationDestination(
                icon: Icon(Icons.contacts_outlined),
                selectedIcon: Icon(Icons.contacts),
                label: 'Contacts',
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
