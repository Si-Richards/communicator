import 'package:flutter/material.dart';

import '../controllers/phone_controller.dart';
import '../repositories/settings_repository.dart';
import '../services/mobile_call_coordinator.dart';
import 'about_screen.dart';
import 'diagnostics_screen.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({
    super.key,
    required this.controller,
    required this.mobileCalls,
  });

  final PhoneController controller;
  final MobileCallCoordinator mobileCalls;

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  late final TextEditingController _nickname;
  late final TextEditingController _sipUsername;
  late final TextEditingController _sipPassword;
  late final TextEditingController _sipRealm;
  late final TextEditingController _sipProxy;
  late final TextEditingController _janusUrl;
  late final TextEditingController _janusSecret;
  late final TextEditingController _provisioningUrl;
  late ConfigurationSource _configurationSource;

  bool _saving = false;

  @override
  void initState() {
    super.initState();
    final model = widget.controller;
    _nickname = TextEditingController(text: model.nickname);
    _sipUsername = TextEditingController(text: model.sipUsername);
    _sipPassword = TextEditingController(text: model.sipPassword);
    _sipRealm = TextEditingController(text: model.sipRealm);
    _sipProxy = TextEditingController(text: model.sipProxy);
    _janusUrl = TextEditingController(text: model.janusUrl);
    _janusSecret = TextEditingController(text: model.janusApiSecret);
    _provisioningUrl = TextEditingController(text: model.provisioningUrl);
    _configurationSource = model.configurationSource;
  }

  @override
  void dispose() {
    for (final controller in [
      _nickname,
      _sipUsername,
      _sipPassword,
      _sipRealm,
      _sipProxy,
      _janusUrl,
      _janusSecret,
      _provisioningUrl,
    ]) {
      controller.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    if (_saving) return;
    setState(() => _saving = true);
    try {
      await widget.controller.saveSettings(
        nickname: _nickname.text,
        sipUsername: _sipUsername.text,
        sipPassword: _sipPassword.text,
        sipRealm: _sipRealm.text,
        sipProxy: _sipProxy.text,
        janusUrl: _janusUrl.text,
        janusApiSecret: _janusSecret.text,
        configurationSource: _configurationSource,
        provisioningUrl: _provisioningUrl.text,
      );
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Settings saved')),
        );
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final model = widget.controller;
    return AnimatedBuilder(
      animation: model,
      builder: (context, _) {
        return Scaffold(
          appBar: AppBar(title: const Text('Settings')),
          body: ListView(
            padding: const EdgeInsets.all(16),
            children: [
              _SectionCard(
                title: 'Configuration',
                children: [
                  DropdownButtonFormField<ConfigurationSource>(
                    initialValue: _configurationSource,
                    decoration: const InputDecoration(
                      labelText: 'Configuration source',
                    ),
                    items: const [
                      DropdownMenuItem(
                        value: ConfigurationSource.manual,
                        child: Text('Manual'),
                      ),
                      DropdownMenuItem(
                        value: ConfigurationSource.provisioning,
                        child: Text('Provisioning server'),
                      ),
                    ],
                    onChanged: (value) {
                      if (value == null) return;
                      setState(() => _configurationSource = value);
                    },
                  ),
                  if (_configurationSource == ConfigurationSource.provisioning)
                    TextField(
                      controller: _provisioningUrl,
                      keyboardType: TextInputType.url,
                      autocorrect: false,
                      decoration: const InputDecoration(
                        labelText: 'Provisioning server',
                        hintText: 'https://provision.voicehost.io',
                        helperText:
                            'Activation-code enrolment will use this server.',
                      ),
                    ),
                  if (_configurationSource == ConfigurationSource.provisioning)
                    const Text(
                      'Provisioning mode is enabled. Manual SIP and Janus '
                      'settings remain available until this device is enrolled.',
                    ),
                ],
              ),
              _SectionCard(
                title: 'SIP account',
                children: [
                  TextField(
                    controller: _nickname,
                    textCapitalization: TextCapitalization.words,
                    decoration: const InputDecoration(
                      labelText: 'Nickname',
                      helperText: 'Shown at the top of the Phone screen.',
                    ),
                  ),
                  TextField(
                    controller: _sipUsername,
                    keyboardType: TextInputType.text,
                    autocorrect: false,
                    decoration: const InputDecoration(
                      labelText: 'Username / extension',
                    ),
                  ),
                  TextField(
                    controller: _sipPassword,
                    obscureText: true,
                    autocorrect: false,
                    decoration: const InputDecoration(labelText: 'Password'),
                  ),
                  TextField(
                    controller: _sipRealm,
                    autocorrect: false,
                    decoration: const InputDecoration(labelText: 'Realm'),
                  ),
                  TextField(
                    controller: _sipProxy,
                    autocorrect: false,
                    decoration: const InputDecoration(
                      labelText: 'Proxy',
                      hintText: 'Optional',
                    ),
                  ),
                ],
              ),
              _SectionCard(
                title: 'Janus',
                children: [
                  TextField(
                    controller: _janusUrl,
                    keyboardType: TextInputType.url,
                    autocorrect: false,
                    decoration: const InputDecoration(
                      labelText: 'WebSocket URL',
                    ),
                  ),
                  TextField(
                    controller: _janusSecret,
                    obscureText: true,
                    autocorrect: false,
                    decoration: const InputDecoration(
                      labelText: 'API secret',
                      helperText: 'Development only; never compile this into the app.',
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
                    onTap: () {
                      Navigator.of(context).push(
                        MaterialPageRoute<void>(
                          builder: (_) => DiagnosticsScreen(
                            controller: widget.controller,
                            mobileCalls: widget.mobileCalls,
                          ),
                        ),
                      );
                    },
                  ),
                  const Divider(height: 1),
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: const Icon(Icons.info_outline),
                    title: const Text('About VoiceHost'),
                    subtitle: const Text(
                      'Version, build information and licences',
                    ),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: () {
                      Navigator.of(context).push(
                        MaterialPageRoute<void>(
                          builder: (_) => const AboutScreen(),
                        ),
                      );
                    },
                  ),
                ],
              ),
              const SizedBox(height: 4),
              FilledButton.icon(
                onPressed: _saving ? null : () => _save(),
                icon: const Icon(Icons.save),
                label: const Text('Save Settings'),
              ),
              if (model.errorMessage != null) ...[
                const SizedBox(height: 12),
                Text(
                  model.errorMessage!,
                  textAlign: TextAlign.center,
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ],
            ],
          ),
        );
      },
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
