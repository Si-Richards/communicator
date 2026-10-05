import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

class AboutScreen extends StatefulWidget {
  const AboutScreen({super.key});

  @override
  State<AboutScreen> createState() => _AboutScreenState();
}

class _AboutScreenState extends State<AboutScreen> {
  static const MethodChannel _appChannel = MethodChannel('voicehost/app');
  static const appName = 'Softphone';

  String _version = '0.3.0';

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
      });
    } on MissingPluginException {
      // Local builds created before the native app bridge use the fallback.
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('About')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(18, 20, 18, 32),
        children: [
          Text(
            appName,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.headlineSmall,
          ),
          const SizedBox(height: 6),
          Text(
            'Version $_version',
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodyMedium,
          ),
          const SizedBox(height: 20),
          Card(
            child: Column(
              children: [
                ListTile(
                  dense: true,
                  leading: const Icon(Icons.info_outline),
                  title: const Text('Version'),
                  trailing: Text(_version),
                ),
                const Divider(height: 1),
                ListTile(
                  dense: true,
                  visualDensity: const VisualDensity(vertical: -2),
                  leading: const Icon(Icons.description_outlined),
                  title: const Text('Open-source licences'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () {
                    Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => const _CompactLicensesScreen(),
                      ),
                    );
                  },
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _CompactLicensesScreen extends StatefulWidget {
  const _CompactLicensesScreen();

  @override
  State<_CompactLicensesScreen> createState() => _CompactLicensesScreenState();
}

class _CompactLicensesScreenState extends State<_CompactLicensesScreen> {
  late final Future<List<_PackageLicences>> _packages = _loadLicences();

  Future<List<_PackageLicences>> _loadLicences() async {
    final grouped = <String, List<LicenseParagraph>>{};

    await for (final entry in LicenseRegistry.licenses) {
      final packages = entry.packages.isEmpty
          ? const <String>['Other']
          : entry.packages.toList(growable: false);
      for (final package in packages) {
        grouped
            .putIfAbsent(package, () => <LicenseParagraph>[])
            .addAll(entry.paragraphs);
      }
    }

    final result = grouped.entries
        .map(
          (entry) => _PackageLicences(
            name: entry.key,
            paragraphs: entry.value,
          ),
        )
        .toList(growable: false)
      ..sort(
        (left, right) =>
            left.name.toLowerCase().compareTo(right.name.toLowerCase()),
      );
    return result;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Open-source licences')),
      body: FutureBuilder<List<_PackageLicences>>(
        future: _packages,
        builder: (context, snapshot) {
          if (!snapshot.hasData) {
            return const Center(child: CircularProgressIndicator());
          }

          final packages = snapshot.data!;
          return ListView.separated(
            padding: const EdgeInsets.symmetric(vertical: 4),
            itemCount: packages.length,
            separatorBuilder: (_, _) => const Divider(height: 1),
            itemBuilder: (context, index) {
              final package = packages[index];
              return ExpansionTile(
                tilePadding: const EdgeInsets.symmetric(horizontal: 14),
                childrenPadding: const EdgeInsets.fromLTRB(14, 0, 14, 10),
                minTileHeight: 38,
                dense: true,
                title: Text(
                  package.name,
                  style: Theme.of(context).textTheme.bodyMedium,
                ),
                children: [
                  for (final paragraph in package.paragraphs)
                    Padding(
                      padding: EdgeInsets.only(
                        bottom: paragraph.indent == 0 ? 7 : 3,
                        left: paragraph.indent * 12.0,
                      ),
                      child: Align(
                        alignment: Alignment.centerLeft,
                        child: SelectableText(
                          paragraph.text,
                          style: Theme.of(context).textTheme.bodySmall,
                        ),
                      ),
                    ),
                ],
              );
            },
          );
        },
      ),
    );
  }
}

class _PackageLicences {
  const _PackageLicences({
    required this.name,
    required this.paragraphs,
  });

  final String name;
  final List<LicenseParagraph> paragraphs;
}
