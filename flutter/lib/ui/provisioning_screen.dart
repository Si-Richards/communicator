import 'package:flutter/material.dart';

import '../controllers/phone_controller.dart';
import '../controllers/provisioning_controller.dart';
import '../core/app_config.dart';

class ProvisioningScreen extends StatefulWidget {
  const ProvisioningScreen({
    super.key,
    required this.phone,
    required this.provisioning,
    this.activationGate = false,
  });

  final PhoneController phone;
  final ProvisioningController provisioning;
  final bool activationGate;

  @override
  State<ProvisioningScreen> createState() => _ProvisioningScreenState();
}

class _ProvisioningScreenState extends State<ProvisioningScreen> {
  final TextEditingController _code = TextEditingController();
  bool _showCode = false;

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  Future<void> _activate() async {
    try {
      await widget.provisioning.activate(
        serverUrl: AppConfig.provisioningUrl,
        code: _code.text,
      );
      if (!mounted) return;
      _code.clear();
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Device provisioned successfully')),
      );
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(error.toString())),
      );
    }
  }

  Future<void> _remove() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Remove managed configuration?'),
        content: const Text(
          'This removes the provisioned device credentials from this app. '
          'A new activation code will be required before the app can be used again.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Remove'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    await widget.provisioning.removeManagedConfiguration();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: widget.provisioning,
      builder: (context, _) {
        final model = widget.provisioning;
        final config = model.configuration;
        return Scaffold(
          appBar: widget.activationGate
              ? null
              : AppBar(title: const Text('Provisioning')),
          body: ListView(
            padding: const EdgeInsets.all(16),
            children: [
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(18),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        model.credentialsInvalid
                            ? 'Re-activate device'
                            : model.isEnrolled
                                ? 'Managed device'
                                : widget.activationGate
                                    ? 'Activate VoiceHost'
                                    : 'Activate device',
                        style: Theme.of(context).textTheme.titleLarge,
                      ),
                      const SizedBox(height: 8),
                      Text(model.status),
                      if (model.deviceId != null) ...[
                        const SizedBox(height: 6),
                        SelectableText(
                          'Device: ${model.deviceId}',
                          style: Theme.of(context).textTheme.bodySmall,
                        ),
                      ],
                      if (model.isEnrolled) ...[
                        const SizedBox(height: 6),
                        Text(
                          'Configuration version: '
                          '${model.configurationVersion}',
                        ),
                        const SizedBox(height: 6),
                        Text(
                          config?.messaging == null
                              ? 'Messaging: no settings in cached configuration'
                              : config!.features['messaging'] == false
                                  ? 'Messaging: disabled by feature policy'
                                  : !config.messaging!.enabled
                                      ? 'Messaging: disabled by administrator'
                                      : !config.messaging!.configured
                                          ? 'Messaging: provisioned settings incomplete'
                                          : 'Messaging: configured (${config.messaging!.jid})',
                        ),
                      ],
                      if (model.error != null) ...[
                        const SizedBox(height: 10),
                        Text(
                          model.error!,
                          style: TextStyle(
                            color: Theme.of(context).colorScheme.error,
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
              if (!model.isEnrolled || model.credentialsInvalid) ...[
                if (widget.activationGate) ...[
                  const SizedBox(height: 10),
                  Center(
                    child: Text(
                      'Enter the activation code supplied by your administrator.',
                      textAlign: TextAlign.center,
                    ),
                  ),
                  const SizedBox(height: 18),
                ],
                TextField(
                  controller: _code,
                  obscureText: !_showCode,
                  autocorrect: false,
                  textCapitalization: TextCapitalization.characters,
                  decoration: InputDecoration(
                    labelText: 'Activation code',
                    hintText: 'VH7K-P92M',
                    suffixIcon: IconButton(
                      tooltip: _showCode ? 'Hide code' : 'Show code',
                      onPressed: () => setState(() => _showCode = !_showCode),
                      icon: Icon(
                        _showCode ? Icons.visibility_off : Icons.visibility,
                      ),
                    ),
                  ),
                  onSubmitted: (_) {
                    if (!model.busy) _activate();
                  },
                ),
                const SizedBox(height: 18),
                FilledButton.icon(
                  onPressed: model.busy ? null : _activate,
                  icon: model.busy
                      ? const SizedBox.square(
                          dimension: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.key_outlined),
                  label: Text(
                    model.credentialsInvalid
                        ? 'Re-activate Device'
                        : 'Activate Device',
                  ),
                ),
              ] else ...[
                if (config != null)
                  Card(
                    child: Padding(
                      padding: const EdgeInsets.all(18),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'Managed configuration',
                            style: Theme.of(context).textTheme.titleMedium,
                          ),
                          const SizedBox(height: 10),
                          _Row(
                            label: 'Strategy',
                            value: config.connectionStrategy,
                          ),
                          _Row(
                            label: 'Telephony',
                            value: config.telephonyMode,
                          ),
                          if (config.extension != null)
                            _Row(
                              label: 'Extension',
                              value: config.extension!,
                            ),
                          if (config.janusUrl != null)
                            _Row(label: 'Janus', value: config.janusUrl!),
                        ],
                      ),
                    ),
                  ),
                const SizedBox(height: 8),
                OutlinedButton.icon(
                  onPressed: model.busy
                      ? null
                      : () => widget.provisioning.refreshConfiguration(),
                  icon: const Icon(Icons.refresh),
                  label: const Text('Refresh Configuration'),
                ),
                const SizedBox(height: 8),
                TextButton.icon(
                  onPressed: model.busy ? null : _remove,
                  icon: const Icon(Icons.link_off),
                  label: const Text('Remove Managed Configuration'),
                ),
              ],
            ],
          ),
        );
      },
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 92,
            child: Text(
              label,
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
          ),
          Expanded(child: SelectableText(value)),
        ],
      ),
    );
  }
}
