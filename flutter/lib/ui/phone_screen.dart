import 'package:flutter/material.dart';

import '../controllers/phone_controller.dart';
import '../models/call_state.dart';
import '../services/mobile_call_coordinator.dart';

class PhoneScreen extends StatefulWidget {
  const PhoneScreen({
    super.key,
    required this.controller,
    required this.mobileCalls,
  });

  final PhoneController controller;
  final MobileCallCoordinator mobileCalls;

  @override
  State<PhoneScreen> createState() => _PhoneScreenState();
}

class _PhoneScreenState extends State<PhoneScreen> {
  late final TextEditingController _numberController;
  bool _syncingNumber = false;

  static const _keys = [
    ['1', '2', '3'],
    ['4', '5', '6'],
    ['7', '8', '9'],
    ['*', '0', '#'],
  ];

  @override
  void initState() {
    super.initState();
    _numberController = TextEditingController(text: widget.controller.dialledNumber);
    _numberController.addListener(_numberChanged);
    widget.controller.addListener(_syncNumberFromController);
  }

  void _numberChanged() {
    if (_syncingNumber) return;
    if (_numberController.text != widget.controller.dialledNumber) {
      widget.controller.setDialledNumber(_numberController.text);
    }
  }

  void _syncNumberFromController() {
    final value = widget.controller.dialledNumber;
    if (_numberController.text == value) return;
    _syncingNumber = true;
    _numberController.value = TextEditingValue(
      text: value,
      selection: TextSelection.collapsed(offset: value.length),
    );
    _syncingNumber = false;
  }

  @override
  void dispose() {
    widget.controller.removeListener(_syncNumberFromController);
    _numberController
      ..removeListener(_numberChanged)
      ..dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final controller = widget.controller;
    return AnimatedBuilder(
      animation: Listenable.merge([controller, widget.mobileCalls]),
      builder: (context, _) {
        return Scaffold(
          appBar: AppBar(
            title: Text(controller.extensionDisplayName),
            actions: [
              IconButton(
                tooltip: controller.doNotDisturb
                    ? 'Disable Do Not Disturb'
                    : 'Enable Do Not Disturb',
                onPressed: () => controller.setDoNotDisturb(!controller.doNotDisturb),
                icon: Icon(
                  controller.doNotDisturb ? Icons.bedtime : Icons.bedtime_outlined,
                  color: controller.doNotDisturb
                      ? Theme.of(context).colorScheme.primary
                      : null,
                ),
              ),
            ],
          ),
          body: SafeArea(
            child: Column(
              children: [
                _StatusStrip(controller: controller),
                if (controller.errorMessage != null)
                  _ErrorBanner(
                    message: controller.errorMessage!,
                    onDismiss: controller.clearError,
                  ),
                Expanded(
                  child: SingleChildScrollView(
                    padding: const EdgeInsets.fromLTRB(24, 18, 24, 28),
                    child: Column(
                      children: [
                        TextField(
                          controller: _numberController,
                          keyboardType: TextInputType.phone,
                          textAlign: TextAlign.center,
                          style: Theme.of(context).textTheme.headlineLarge,
                          decoration: const InputDecoration(
                            hintText: 'Number',
                            border: InputBorder.none,
                          ),
                        ),
                        const SizedBox(height: 8),
                        _DialPad(
                          keys: _keys,
                          onDigit: controller.appendDigit,
                          onBackspace: controller.backspaceDigit,
                        ),
                        const SizedBox(height: 24),
                        _CallControls(
                          controller: controller,
                          mobileCalls: widget.mobileCalls,
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}

class _StatusStrip extends StatelessWidget {
  const _StatusStrip({required this.controller});

  final PhoneController controller;

  @override
  Widget build(BuildContext context) {
    final statusColor = controller.isRegistered ? Colors.green : Colors.grey;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 6),
      child: Row(
        children: [
          Container(
            width: 9,
            height: 9,
            decoration: BoxDecoration(color: statusColor, shape: BoxShape.circle),
          ),
          const SizedBox(width: 7),
          Text(
            controller.doNotDisturb
                ? '${controller.registrationStatus} · DND'
                : controller.registrationStatus,
            style: Theme.of(context).textTheme.bodySmall,
          ),
          const Spacer(),
          Flexible(
            child: Text(
              _callStatus(controller.callState),
              overflow: TextOverflow.ellipsis,
              textAlign: TextAlign.right,
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ),
        ],
      ),
    );
  }

  static String _callStatus(PhoneCallState state) => switch (state.phase) {
        CallPhase.idle => '',
        CallPhase.outgoing => 'Calling ${state.number ?? ''}',
        CallPhase.ringing => 'Ringing ${state.number ?? ''}',
        CallPhase.incoming => 'Incoming ${state.number ?? ''}',
        CallPhase.earlyMedia => 'Connecting ${state.number ?? ''}',
        CallPhase.connected => 'Connected ${state.number ?? ''}',
        CallPhase.held => 'Held ${state.number ?? ''}',
        CallPhase.ended => state.reason ?? 'Call ended',
      };
}

class _ErrorBanner extends StatelessWidget {
  const _ErrorBanner({required this.message, required this.onDismiss});

  final String message;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.fromLTRB(16, 4, 16, 0),
      padding: const EdgeInsets.fromLTRB(12, 8, 4, 8),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.errorContainer,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        children: [
          Expanded(
            child: Text(
              message,
              style: TextStyle(color: Theme.of(context).colorScheme.onErrorContainer),
            ),
          ),
          IconButton(onPressed: onDismiss, icon: const Icon(Icons.close)),
        ],
      ),
    );
  }
}

class _DialPad extends StatelessWidget {
  const _DialPad({
    required this.keys,
    required this.onDigit,
    required this.onBackspace,
  });

  final List<List<String>> keys;
  final ValueChanged<String> onDigit;
  final VoidCallback onBackspace;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        for (final row in keys)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 6),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                for (final digit in row)
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 12),
                    child: Material(
                      color: Theme.of(context).colorScheme.surfaceContainerHighest,
                      shape: const CircleBorder(),
                      child: InkWell(
                        customBorder: const CircleBorder(),
                        onTap: () => onDigit(digit),
                        onLongPress: digit == '#' ? onBackspace : null,
                        child: SizedBox(
                          width: 72,
                          height: 72,
                          child: Center(
                            child: Text(
                              digit,
                              style: Theme.of(context).textTheme.headlineMedium,
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ),
        const SizedBox(height: 2),
        TextButton.icon(
          onPressed: onBackspace,
          icon: const Icon(Icons.backspace_outlined),
          label: const Text('Delete'),
        ),
      ],
    );
  }
}

class _CallControls extends StatelessWidget {
  const _CallControls({
    required this.controller,
    required this.mobileCalls,
  });

  final PhoneController controller;
  final MobileCallCoordinator mobileCalls;

  @override
  Widget build(BuildContext context) {
    final state = controller.callState;

    if (mobileCalls.hasActiveGatewayCall) {
      final number = mobileCalls.gatewayCallerNumber;
      return Column(
        children: [
          Text(
            mobileCalls.gatewayCallerDisplay,
            style: Theme.of(context).textTheme.headlineSmall,
          ),
          if (number != null &&
              number.isNotEmpty &&
              number != mobileCalls.gatewayCallerDisplay)
            Text(number, style: Theme.of(context).textTheme.bodyMedium),
          const SizedBox(height: 8),
          Text(
            mobileCalls.gatewayCallConnected ? 'Connected' : 'Connecting…',
            style: Theme.of(context).textTheme.bodyMedium,
          ),
          const SizedBox(height: 18),
          Wrap(
            spacing: 16,
            runSpacing: 12,
            alignment: WrapAlignment.center,
            children: [
              FilterChip(
                selected: mobileCalls.gatewayMuted,
                onSelected: (_) => mobileCalls.toggleGatewayMute(),
                avatar: Icon(
                  mobileCalls.gatewayMuted ? Icons.mic_off : Icons.mic,
                ),
                label: Text(
                  mobileCalls.gatewayMuted ? 'Muted' : 'Mute',
                ),
              ),
              FilterChip(
                selected: mobileCalls.gatewaySpeakerphoneOn,
                onSelected: (_) => mobileCalls.toggleGatewaySpeakerphone(),
                avatar: Icon(
                  mobileCalls.gatewaySpeakerphoneOn
                      ? Icons.volume_up
                      : Icons.hearing,
                ),
                label: const Text('Speaker'),
              ),
            ],
          ),
          const SizedBox(height: 22),
          _RoundAction(
            icon: Icons.call_end,
            color: Colors.red,
            label: 'End',
            onTap: mobileCalls.hangupActiveCall,
          ),
        ],
      );
    }

    if (state.phase == CallPhase.incoming) {
      return Column(
        children: [
          Text(
            state.displayName?.isNotEmpty == true
                ? state.displayName!
                : state.number ?? 'Unknown',
            style: Theme.of(context).textTheme.headlineSmall,
          ),
          if (state.displayName?.isNotEmpty == true)
            Text(state.number ?? '', style: Theme.of(context).textTheme.bodyMedium),
          const SizedBox(height: 20),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              _RoundAction(
                icon: Icons.call_end,
                color: Colors.red,
                label: 'Decline',
                onTap: controller.rejectIncomingCall,
              ),
              const SizedBox(width: 48),
              _RoundAction(
                icon: Icons.call,
                color: Colors.green,
                label: 'Answer',
                onTap: controller.answerIncomingCall,
              ),
            ],
          ),
        ],
      );
    }

    if (state.isInCall) {
      return Column(
        children: [
          Wrap(
            spacing: 16,
            runSpacing: 12,
            alignment: WrapAlignment.center,
            children: [
              FilterChip(
                selected: controller.isMuted,
                onSelected: (_) => controller.toggleMute(),
                avatar: Icon(controller.isMuted ? Icons.mic_off : Icons.mic),
                label: Text(controller.isMuted ? 'Muted' : 'Mute'),
              ),
              FilterChip(
                selected: state.phase == CallPhase.held,
                onSelected: (_) => controller.toggleHold(),
                avatar: const Icon(Icons.pause),
                label: Text(state.phase == CallPhase.held ? 'Held' : 'Hold'),
              ),
              FilterChip(
                selected: controller.speakerphoneOn,
                onSelected: (_) => controller.toggleSpeakerphone(),
                avatar: Icon(
                  controller.speakerphoneOn ? Icons.volume_up : Icons.hearing,
                ),
                label: const Text('Speaker'),
              ),
            ],
          ),
          const SizedBox(height: 22),
          _RoundAction(
            icon: Icons.call_end,
            color: Colors.red,
            label: 'End',
            onTap: controller.hangup,
          ),
        ],
      );
    }

    return _RoundAction(
      icon: Icons.call,
      color: Colors.green,
      label: 'Call',
      onTap: controller.isRegistered && controller.dialledNumber.trim().isNotEmpty
          ? () => controller.placeCall()
          : null,
    );
  }
}

class _RoundAction extends StatelessWidget {
  const _RoundAction({
    required this.icon,
    required this.color,
    required this.label,
    required this.onTap,
  });

  final IconData icon;
  final Color color;
  final String label;
  final Future<void> Function()? onTap;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        FilledButton(
          onPressed: onTap == null ? null : () => onTap!(),
          style: FilledButton.styleFrom(
            backgroundColor: color,
            shape: const CircleBorder(),
            minimumSize: const Size(74, 74),
          ),
          child: Icon(icon, size: 30, color: Colors.white),
        ),
        const SizedBox(height: 6),
        Text(label, style: Theme.of(context).textTheme.labelMedium),
      ],
    );
  }
}
