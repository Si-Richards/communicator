import 'package:flutter/material.dart';

class AboutScreen extends StatelessWidget {
  const AboutScreen({super.key});

  static const appName = 'VoiceHost Softphone';
  static const version = '0.2.0';
  static const buildNumber = '2';

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;

    return Scaffold(
      appBar: AppBar(title: const Text('About')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(18, 20, 18, 32),
        children: [
          Center(
            child: Container(
              width: 96,
              height: 96,
              decoration: BoxDecoration(
                color: scheme.primary,
                borderRadius: BorderRadius.circular(24),
              ),
              child: const Icon(
                Icons.phone_in_talk,
                color: Colors.white,
                size: 48,
              ),
            ),
          ),
          const SizedBox(height: 18),
          Text(
            appName,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.headlineSmall,
          ),
          const SizedBox(height: 4),
          Text(
            'Version $version ($buildNumber)',
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodyMedium,
          ),
          const SizedBox(height: 28),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(18),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'VoiceHost',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: 8),
                  const Text(
                    'VoiceHost Softphone provides mobile calling for the '
                    'VoiceHost hosted telephony platform, with native iOS '
                    'calling integration, call waiting, hold, transfers and '
                    'voicemail access.',
                  ),
                ],
              ),
            ),
          ),
          Card(
            child: Column(
              children: [
                const ListTile(
                  leading: Icon(Icons.business_outlined),
                  title: Text('VoiceHost Limited'),
                  subtitle: Text('United Kingdom'),
                ),
                const Divider(height: 1),
                ListTile(
                  leading: const Icon(Icons.description_outlined),
                  title: const Text('Open-source licences'),
                  subtitle: const Text('View licences used by this app'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => showLicensePage(
                    context: context,
                    applicationName: appName,
                    applicationVersion: '$version ($buildNumber)',
                    applicationLegalese: '© 2026 VoiceHost Limited',
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 20),
          Text(
            '© 2026 VoiceHost Limited',
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ],
      ),
    );
  }
}
