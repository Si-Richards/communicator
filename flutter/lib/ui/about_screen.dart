import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

class AboutScreen extends StatefulWidget {
  const AboutScreen({super.key});

  @override
  State<AboutScreen> createState() => _AboutScreenState();
}

class _AboutScreenState extends State<AboutScreen> {
  static const MethodChannel _appChannel = MethodChannel('voicehost/app');
  static const appName = 'VoiceHost Softphone';

  String _version = '0.2.0';
  String _buildNumber = '4';

  @override
  void initState() {
    super.initState();
    unawaited(_loadBuildInfo());
  }

  Future<void> _loadBuildInfo() async {
    try {
      final raw = await _appChannel.invokeMethod<dynamic>('getBuildInfo');
      if (!mounted || raw is! Map) return;
      setState(() {
        _version = raw['version']?.toString() ?? _version;
        _buildNumber = raw['build']?.toString() ?? _buildNumber;
      });
    } on MissingPluginException {
      // Local builds created before the native app bridge use the fallback.
    } catch (_) {}
  }

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
          const SizedBox(height: 6),
          Text(
            'Version $_version · Build $_buildNumber',
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodyMedium,
          ),
          const SizedBox(height: 28),
          Card(
            child: Column(
              children: [
                ListTile(
                  leading: const Icon(Icons.info_outline),
                  title: const Text('Version'),
                  trailing: Text(_version),
                ),
                const Divider(height: 1),
                ListTile(
                  leading: const Icon(Icons.build_outlined),
                  title: const Text('Build'),
                  trailing: Text(_buildNumber),
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
                    applicationVersion: '$_version ($_buildNumber)',
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
