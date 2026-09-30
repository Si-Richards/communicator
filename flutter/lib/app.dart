import 'package:flutter/material.dart';

import 'controllers/phone_controller.dart';
import 'controllers/provisioning_controller.dart';
import 'services/mobile_call_coordinator.dart';
import 'ui/call_history_screen.dart';
import 'ui/contacts_screen.dart';
import 'ui/messages_screen.dart';
import 'ui/phone_screen.dart';
import 'ui/provisioning_screen.dart';

class VoiceHostApp extends StatelessWidget {
  const VoiceHostApp({
    super.key,
    required this.controller,
    required this.mobileCalls,
    required this.provisioning,
  });

  final PhoneController controller;
  final MobileCallCoordinator mobileCalls;
  final ProvisioningController provisioning;

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
      home: MainShell(
        controller: controller,
        mobileCalls: mobileCalls,
        provisioning: provisioning,
      ),
    );
  }
}

class MainShell extends StatefulWidget {
  const MainShell({
    super.key,
    required this.controller,
    required this.mobileCalls,
    required this.provisioning,
  });

  final PhoneController controller;
  final MobileCallCoordinator mobileCalls;
  final ProvisioningController provisioning;

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
      PhoneScreen(
        controller: controller,
        mobileCalls: widget.mobileCalls,
        provisioning: widget.provisioning,
      ),
      CallHistoryScreen(
        controller: controller,
        mobileCalls: widget.mobileCalls,
        onGoToPhone: _goToPhone,
      ),
      ContactsScreen(controller: controller, onGoToPhone: _goToPhone),
      const MessagesScreen(),
    ];

    return AnimatedBuilder(
      animation: Listenable.merge([controller, widget.provisioning]),
      builder: (context, _) {
        if (!widget.provisioning.initialized) {
          return const _ProvisioningLoadingScreen();
        }

        if (!widget.provisioning.isEnrolled ||
            widget.provisioning.credentialsInvalid) {
          return ProvisioningScreen(
            phone: controller,
            provisioning: widget.provisioning,
            activationGate: true,
          );
        }

        if (!widget.provisioning.canUseApp) {
          return _ProvisioningLockedScreen(
            controller: controller,
            provisioning: widget.provisioning,
          );
        }

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
                icon: Icon(Icons.message_outlined),
                selectedIcon: Icon(Icons.message),
                label: 'Messages',
              ),
            ],
          ),
        );
      },
    );
  }
}


class _ProvisioningLoadingScreen extends StatelessWidget {
  const _ProvisioningLoadingScreen();

  @override
  Widget build(BuildContext context) {
    const orange = Color(0xFFFF6600);
    const navy = Color(0xFF113B53);
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.phone_in_talk, size: 64, color: orange),
                const SizedBox(height: 24),
                Text(
                  'VoiceHost',
                  style: Theme.of(context).textTheme.headlineMedium?.copyWith(
                        color: navy,
                        fontWeight: FontWeight.w700,
                      ),
                ),
                const SizedBox(height: 24),
                const CircularProgressIndicator(),
                const SizedBox(height: 14),
                const Text('Checking device provisioning…'),
              ],
            ),
          ),
        ),
      ),
    );
  }
}


class _ProvisioningLockedScreen extends StatelessWidget {
  const _ProvisioningLockedScreen({
    required this.controller,
    required this.provisioning,
  });

  final PhoneController controller;
  final ProvisioningController provisioning;

  @override
  Widget build(BuildContext context) {
    const navy = Color(0xFF113B53);
    const orange = Color(0xFFFF6600);

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Container(
                  width: 88,
                  height: 88,
                  decoration: BoxDecoration(
                    color: orange.withValues(alpha: 0.10),
                    shape: BoxShape.circle,
                  ),
                  child: const Icon(
                    Icons.lock_outline,
                    size: 44,
                    color: orange,
                  ),
                ),
                const SizedBox(height: 28),
                Text(
                  'App locked',
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.headlineMedium?.copyWith(
                        color: navy,
                        fontWeight: FontWeight.w700,
                      ),
                ),
                const SizedBox(height: 12),
                Text(
                  provisioning.credentialsInvalid
                      ? 'This device needs to be re-activated by your administrator.'
                      : 'This app is locked. Please contact your administrator.',
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                        color: navy,
                        height: 1.45,
                      ),
                ),
                if (provisioning.credentialsInvalid) ...[
                  const SizedBox(height: 24),
                  FilledButton.icon(
                    onPressed: () {
                      Navigator.of(context).push(
                        MaterialPageRoute<void>(
                          builder: (_) => ProvisioningScreen(
                            phone: controller,
                            provisioning: provisioning,
                          ),
                        ),
                      );
                    },
                    icon: const Icon(Icons.key_outlined),
                    label: const Text('Re-activate device'),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}
