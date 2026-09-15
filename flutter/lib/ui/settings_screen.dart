import 'package:flutter/material.dart';

import '../controllers/phone_controller.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key, required this.controller});

  final PhoneController controller;

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
  late final TextEditingController _voicemailNumber;

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
    _voicemailNumber = TextEditingController(text: model.voicemailNumber);
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
      _voicemailNumber,
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
        voicemailNumber: _voicemailNumber.text,
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

  Future<void> _saveAndRegister() async {
    await _save();
    await widget.controller.connectAndRegister();
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
                title: 'Calling',
                children: [
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    title: const Text('Do Not Disturb'),
                    subtitle: const Text(
                      'Incoming calls are declined with SIP 486 on this device.',
                    ),
                    value: model.doNotDisturb,
                    onChanged: model.setDoNotDisturb,
                  ),
                  TextField(
                    controller: _voicemailNumber,
                    keyboardType: TextInputType.phone,
                    decoration: const InputDecoration(
                      labelText: 'Voicemail number / feature code',
                      hintText: 'e.g. platform-specific code',
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 4),
              FilledButton.icon(
                onPressed: _saving ? null : () => _save(),
                icon: const Icon(Icons.save),
                label: const Text('Save Settings'),
              ),
              const SizedBox(height: 10),
              if (model.isRegistered)
                OutlinedButton.icon(
                  onPressed: () => model.disconnect(),
                  icon: const Icon(Icons.link_off),
                  label: const Text('Disconnect'),
                )
              else
                FilledButton.tonalIcon(
                  onPressed: _saving ? null : () => _saveAndRegister(),
                  icon: const Icon(Icons.login),
                  label: const Text('Save, Connect & Register'),
                ),
              const SizedBox(height: 12),
              Text(
                'Status: ${model.registrationStatus}',
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodySmall,
              ),
              if (model.connectionDiagnostic.isNotEmpty)
                Text(
                  'WebRTC: ${model.connectionDiagnostic}',
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.bodySmall,
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
