import 'dart:async';

import 'package:flutter/foundation.dart'
    show defaultTargetPlatform, TargetPlatform;
import 'package:flutter/material.dart';

import 'controllers/phone_controller.dart';
import 'controllers/provisioning_controller.dart';
import 'models/provisioning.dart';
import 'services/mobile_call_coordinator.dart';
import 'services/xmpp_service.dart';
import 'ui/call_history_screen.dart';
import 'ui/contacts_screen.dart';
import 'ui/messages_screen.dart';
import 'ui/phone_screen.dart';
import 'ui/provisioning_screen.dart';
import 'ui/voicemail_screen.dart';

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
      title: 'Softphone',
      debugShowCheckedModeBanner: false,
      navigatorObservers: [messagingRouteObserver],
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
        progressIndicatorTheme: const ProgressIndicatorThemeData(color: orange),
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

class _MainShellState extends State<MainShell> with WidgetsBindingObserver {
  int _selectedIndex = 0;
  final _messaging = XmppService();
  Timer? _pushTimer;
  bool _pushRegistering = false;
  String? _pushIdentity;
  DateTime _nextPushAttempt = DateTime.fromMillisecondsSinceEpoch(0);
  MessagingNotification? _pendingMessageTap;
  bool _openingMessageTap = false;
  final Set<String> _openedNotificationIds = {};

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    final lifecycle = WidgetsBinding.instance.lifecycleState;
    _messaging.setForeground(
      lifecycle == null || lifecycle == AppLifecycleState.resumed,
    );
    if (lifecycle == AppLifecycleState.paused ||
        lifecycle == AppLifecycleState.detached) {
      _messaging.pause();
    }
    widget.provisioning.addListener(_syncMessagingAccess);
    _syncMessagingAccess();
    widget.mobileCalls.addListener(_handleNotificationNavigation);
    widget.mobileCalls.addListener(_syncPushRegistration);
    _pushTimer = Timer.periodic(
      const Duration(seconds: 30),
      (_) => _syncPushRegistration(),
    );

    WidgetsBinding.instance.addPostFrameCallback(
      (_) => _handleNotificationNavigation(),
    );
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    widget.provisioning.removeListener(_syncMessagingAccess);
    _messaging.dispose();
    widget.mobileCalls.removeListener(_handleNotificationNavigation);
    widget.mobileCalls.removeListener(_syncPushRegistration);
    _pushTimer?.cancel();
    super.dispose();
  }

  void _syncMessagingAccess() {
    final provisioning = widget.provisioning;
    if (!provisioning.isEnrolled ||
        provisioning.credentialsInvalid ||
        provisioning.isRevoked ||
        provisioning.isRetired) {
      unawaited(_messaging.forgetHistory());
    }
    _messaging.setAccessAllowed(provisioning.canUseApp);
    final configuration = provisioning.configuration;
    _messaging.configureManaged(
      configuration?.features['messaging'] == false
          ? null
          : configuration?.messaging,
    );
    if (!provisioning.canUseApp || configuration?.messaging?.enabled != true) {
      _messaging.configurePush(null);
    }
    _syncPushRegistration();
    if (_pendingMessageTap != null && !_openingMessageTap) {
      unawaited(_openMessageNotification());
    }
  }

  void _syncPushRegistration() {
    final provisioning = widget.provisioning;
    final identity =
        '${provisioning.deviceId}|${provisioning.configuration?.messaging?.jid}|${widget.mobileCalls.notificationPushToken}';
    if (identity != _pushIdentity) {
      _pushIdentity = identity;
      _nextPushAttempt = DateTime.fromMillisecondsSinceEpoch(0);
    }
    if (!mounted ||
        _pushRegistering ||
        provisioning.busy ||
        !provisioning.canUseApp ||
        defaultTargetPlatform != TargetPlatform.iOS ||
        provisioning.configuration?.features['messaging'] == false ||
        provisioning.configuration?.messaging?.enabled != true ||
        provisioning.configuration?.messaging?.ready != true ||
        DateTime.now().isBefore(_nextPushAttempt)) {
      return;
    }
    final device = provisioning.deviceId;
    final jid = provisioning.configuration?.messaging?.jid;
    _pushRegistering = true;
    _nextPushAttempt = DateTime.now().add(const Duration(seconds: 60));
    unawaited(() async {
      try {
        final subscription = await provisioning.registerMessagingPush();
        if (!mounted ||
            !provisioning.canUseApp ||
            provisioning.deviceId != device ||
            provisioning.configuration?.messaging?.jid != jid) {
          return;
        }
        _messaging.configurePush(subscription);
      } catch (_) {
        debugPrint(
          '[VoiceHost Messaging] notification registration will retry',
        );
      } finally {
        _pushRegistering = false;
      }
    }());
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _messaging.setForeground(state == AppLifecycleState.resumed);
    if (state == AppLifecycleState.resumed) {
      _messaging.resume();
    } else if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.detached) {
      _messaging.pause();
    }
  }

  void _goToPhone() => setState(() => _selectedIndex = 0);

  void _handleNotificationNavigation() {
    if (!mounted) {
      return;
    }
    final target = widget.mobileCalls.consumeNavigationTarget();
    if (target == 'messaging') {
      _pendingMessageTap = widget.mobileCalls.consumeMessagingNotification();
      unawaited(_openMessageNotification());
      return;
    }
    if (target != 'voicemail' || !widget.provisioning.canUseApp) {
      return;
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) {
        return;
      }
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => VoicemailScreen(
            controller: widget.controller,
            mobileCalls: widget.mobileCalls,
            onGoToPhone: () {
              if (mounted) {
                Navigator.of(context).pop();
                _goToPhone();
              }
            },
          ),
        ),
      );
    });
  }

  Future<void> _openMessageNotification() async {
    final tap = _pendingMessageTap;
    final provisioning = widget.provisioning;
    if (tap == null ||
        _openingMessageTap ||
        provisioning.busy ||
        !provisioning.initialized ||
        !provisioning.isEnrolled) {
      return;
    }
    _openingMessageTap = true;
    try {
      await provisioning.checkIn();
      if (!mounted || provisioning.error != null) {
        return;
      }
      final configuration = provisioning.configuration;
      if (!provisioning.canUseApp ||
          configuration?.features['messaging'] == false ||
          configuration?.messaging?.enabled != true ||
          configuration?.messaging?.jid != tap.ownerJid) {
        _pendingMessageTap = null;
        return;
      }
      _syncMessagingAccess();
      final peer = _messaging.recipientJid(tap.peerJid);
      _pendingMessageTap = null;
      if (!_openedNotificationIds.add(tap.eventId)) {
        return;
      }
      if (_openedNotificationIds.length > 20) {
        _openedNotificationIds.remove(_openedNotificationIds.first);
      }
      setState(() => _selectedIndex = 3);
      Navigator.of(context).popUntil((route) => route.isFirst);
      unawaited(
        Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => MessagingChatScreen(
              messaging: _messaging,
              peer: peer,
              provisioning: widget.provisioning,
            ),
          ),
        ),
      );
    } on ArgumentError {
      _pendingMessageTap = null;
    } catch (_) {
      // Preserve the pending tap for the next successful provisioning check.
    } finally {
      _openingMessageTap = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final controller = widget.controller;
    final screens = [
      PhoneScreen(
        controller: controller,
        mobileCalls: widget.mobileCalls,
        provisioning: widget.provisioning,
        messaging: _messaging,
      ),
      CallHistoryScreen(
        controller: controller,
        mobileCalls: widget.mobileCalls,
        onGoToPhone: _goToPhone,
      ),
      ContactsScreen(
        controller: controller,
        provisioning: widget.provisioning,
        onGoToPhone: _goToPhone,
      ),
      MessagesScreen(messaging: _messaging, provisioning: widget.provisioning),
    ];

    return AnimatedBuilder(
      animation: Listenable.merge([controller, widget.provisioning]),
      builder: (context, _) {
        if (!widget.provisioning.startupReady) {
          return _ProvisioningLoadingScreen(provisioning: widget.provisioning);
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
  const _ProvisioningLoadingScreen({required this.provisioning});

  final ProvisioningController provisioning;

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
                  provisioning.brandingName,
                  style: Theme.of(context).textTheme.headlineMedium?.copyWith(
                    color: navy,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 24),
                if (provisioning.startupError == null)
                  const CircularProgressIndicator(),
                const SizedBox(height: 14),
                Text(
                  provisioning.startupError ?? 'Checking device provisioning…',
                  textAlign: TextAlign.center,
                ),
                if (provisioning.startupError != null) ...[
                  const SizedBox(height: 16),
                  FilledButton(
                    onPressed: () => unawaited(provisioning.retryStartup()),
                    child: const Text('Retry'),
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
                  style: Theme.of(context).textTheme.headlineMedium
                      ?.copyWith(color: navy, fontWeight: FontWeight.w700),
                ),
                const SizedBox(height: 12),
                Text(
                  provisioning.credentialsInvalid
                      ? 'This device needs to be re-activated by your administrator.'
                      : 'This app is locked. Please contact your administrator.',
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.bodyLarge
                      ?.copyWith(color: navy, height: 1.45),
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
