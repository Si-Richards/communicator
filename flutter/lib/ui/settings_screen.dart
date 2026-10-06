import 'package:flutter/material.dart';

import '../controllers/phone_controller.dart';
import '../controllers/provisioning_controller.dart';
import '../services/mobile_call_coordinator.dart';
import 'about_screen.dart';
import 'diagnostics_screen.dart';
import 'provisioning_screen.dart';

/// VoiceHost owns telephony and connection configuration. There are no
/// editable SIP, Janus or provisioning-endpoint controls in managed builds.
class SettingsScreen extends StatelessWidget {
  const SettingsScreen({
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
    return AnimatedBuilder(
      animation: provisioning,
      builder: (context, _) => Scaffold(
        appBar: AppBar(title: const Text('Settings')),
        body: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            _SectionCard(
              title: 'Managed configuration',
              children: [
                const Text(
                  'Your extension, credentials and connection settings are '
                  'managed by VoiceHost and cannot be edited on this device.',
                ),
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(Icons.verified_user_outlined),
                  title: Text(provisioning.isEnrolled
                      ? 'Managed device'
                      : 'Provision device'),
                  subtitle: Text(provisioning.status),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (_) => ProvisioningScreen(
                        phone: controller,
                        provisioning: provisioning,
                      ),
                    ),
                  ),
                ),
              ],
            ),
            _SectionCard(
              title: 'Application',
              children: [
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(Icons.monitor_heart_outlined),
                  title: const Text('Diagnostics'),
                  subtitle: const Text(
                    'PushKit, CallKit, gateway status and recent logs',
                  ),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (_) => DiagnosticsScreen(
                        controller: controller,
                        mobileCalls: mobileCalls,
                      ),
                    ),
                  ),
                ),
                const Divider(height: 1),
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(Icons.info_outline),
                  title: const Text('About'),
                  subtitle: const Text(
                    'Version, build information and licences',
                  ),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (_) => AboutScreen(
                        brandingName: provisioning.brandingName,
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _SectionCard extends StatelessWidget {
  const _SectionCard({required this.title, required this.children});

  final String title;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.only(bottom: 14),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(18, 16, 18, 18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
            for (var index = 0; index < children.length; index++) ...[
              children[index],
              if (index != children.length - 1) const SizedBox(height: 8),
            ],
          ],
        ),
      ),
    );
  }
}
