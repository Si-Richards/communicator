import 'dart:async';

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
  Timer? _callTimer;
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
    _callTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      final foregroundConnected =
          widget.controller.activeCallConnectedAt != null &&
          widget.controller.callState.isConnected;
      final gatewayConnected =
          widget.mobileCalls.hasActiveGatewayCall &&
          widget.mobileCalls.gatewayConnectedAt != null;
      if (foregroundConnected || gatewayConnected) {
        setState(() {});
      }
    });
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
    _callTimer?.cancel();
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
                _StatusStrip(
                  controller: controller,
                  mobileCalls: widget.mobileCalls,
                ),
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
                        Row(
                          children: [
                            const SizedBox(width: 48),
                            Expanded(
                              child: TextField(
                                controller: _numberController,
                                readOnly: true,
                                showCursor: false,
                                enableInteractiveSelection: false,
                                textAlign: TextAlign.center,
                                style: Theme.of(context).textTheme.headlineLarge,
                                decoration: const InputDecoration(
                                  hintText: 'Number',
                                  border: InputBorder.none,
                                ),
                              ),
                            ),
                            SizedBox(
                              width: 48,
                              child: IconButton(
                                tooltip: 'Delete',
                                onPressed: controller.dialledNumber.isEmpty
                                    ? null
                                    : controller.backspaceDigit,
                                icon: const Icon(Icons.backspace_outlined),
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 8),
                        _DialPad(
                          keys: _keys,
                          onDigit: controller.appendDigit,
                          onBackspace: controller.backspaceDigit,
                          showDeleteButton: false,
                        ),
                        const SizedBox(height: 16),
                        _VoicemailButton(
                          controller: controller,
                          mobileCalls: widget.mobileCalls,
                        ),
                        const SizedBox(height: 20),
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
  const _StatusStrip({
    required this.controller,
    required this.mobileCalls,
  });

  final PhoneController controller;
  final MobileCallCoordinator mobileCalls;

  @override
  Widget build(BuildContext context) {
    final mobileReady = mobileCalls.gatewayProvisioned;
    final statusColor = mobileReady
        ? Colors.green
        : controller.isRegistered
            ? Colors.orange
            : Colors.grey;
    final registrationLabel = mobileReady
        ? controller.isRegistered
            ? 'Mobile ready · Outgoing SIP active'
            : 'Mobile ready'
        : controller.registrationStatus;
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
                ? '$registrationLabel · DND'
                : registrationLabel,
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
    this.showDeleteButton = true,
  });

  final List<List<String>> keys;
  final ValueChanged<String> onDigit;
  final VoidCallback onBackspace;
  final bool showDeleteButton;

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
        if (showDeleteButton) ...[
          const SizedBox(height: 2),
          TextButton.icon(
            onPressed: onBackspace,
            icon: const Icon(Icons.backspace_outlined),
            label: const Text('Delete'),
          ),
        ],
      ],
    );
  }
}

class _VoicemailButton extends StatelessWidget {
  const _VoicemailButton({
    required this.controller,
    required this.mobileCalls,
  });

  final PhoneController controller;
  final MobileCallCoordinator mobileCalls;

  @override
  Widget build(BuildContext context) {
    final number = controller.voicemailNumber.trim();
    final count = controller.voicemail.newMessages;
    final enabled = number.isNotEmpty &&
        !controller.callState.isInCall &&
        !mobileCalls.hasActiveGatewayCall;

    return Badge(
      isLabelVisible: count > 0,
      label: Text('$count'),
      child: FilledButton.tonalIcon(
        onPressed: enabled ? () => mobileCalls.placeCall(number) : null,
        icon: const Icon(Icons.voicemail),
        label: const Text('Voicemail'),
      ),
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
            !mobileCalls.gatewayCallConnected
                ? 'Connecting…'
                : mobileCalls.gatewayMediaConnected
                    ? 'Connected · ${_formatCallDuration(mobileCalls.gatewayConnectedAt)}'
                    : 'Connected · Media connecting…',
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
              FilterChip(
                selected: mobileCalls.gatewayHeld,
                onSelected: mobileCalls.gatewayCallConnected
                    ? (_) => mobileCalls.toggleGatewayHold()
                    : null,
                avatar: const Icon(Icons.pause),
                label: Text(mobileCalls.gatewayHeld ? 'Held' : 'Hold'),
              ),
              FilterChip(
                selected: mobileCalls.hasActiveTransfer,
                onSelected: mobileCalls.hasActiveTransfer
                    ? null
                    : (_) async {
                        final request = await _showTransferSheet(context);
                        if (request == null) return;
                        if (request.attended) {
                          await mobileCalls.startAttendedTransfer(request.target);
                        } else {
                          await mobileCalls.blindTransferActiveCall(request.target);
                        }
                      },
                avatar: const Icon(Icons.swap_horiz),
                label: const Text('Transfer'),
              ),
            ],
          ),
          if (mobileCalls.otherGatewayCalls.isNotEmpty) ...[
            const SizedBox(height: 18),
            for (final other in mobileCalls.otherGatewayCalls)
              Card(
                child: ListTile(
                  leading: Icon(
                    other.held ? Icons.pause_circle : Icons.call,
                  ),
                  title: Text(other.displayName),
                  subtitle: Text(
                    other.held
                        ? 'On hold'
                        : other.phase == 'ringing'
                            ? 'Incoming call'
                            : other.connected
                                ? 'Connected'
                                : 'Connecting…',
                  ),
                  trailing: FilledButton(
                    onPressed: other.connected
                        ? () => mobileCalls.switchToGatewayCall(other.id)
                        : null,
                    child: const Text('Switch'),
                  ),
                ),
              ),
          ],
          if (mobileCalls.hasActiveTransfer || mobileCalls.transferStatus.isNotEmpty) ...[
            const SizedBox(height: 18),
            Text(
              mobileCalls.transferStatus,
              style: Theme.of(context).textTheme.titleSmall,
              textAlign: TextAlign.center,
            ),
            if (mobileCalls.attendedTransferActive) ...[
              const SizedBox(height: 12),
              Wrap(
                spacing: 12,
                alignment: WrapAlignment.center,
                children: [
                  FilledButton.icon(
                    onPressed: mobileCalls.attendedTransferConnected
                        ? () => mobileCalls.completeAttendedTransfer()
                        : null,
                    icon: const Icon(Icons.call_merge),
                    label: const Text('Complete transfer'),
                  ),
                  OutlinedButton.icon(
                    onPressed: () => mobileCalls.cancelAttendedTransfer(),
                    icon: const Icon(Icons.close),
                    label: const Text('Cancel'),
                  ),
                ],
              ),
            ],
          ],
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
          if (state.isConnected) ...[
            Text(
              _formatCallDuration(controller.activeCallConnectedAt),
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 14),
          ],
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
              FilterChip(
                selected: controller.hasDirectTransfer,
                onSelected: controller.hasDirectTransfer
                    ? null
                    : (_) async {
                        final request = await _showTransferSheet(context);
                        if (request == null) return;
                        if (request.attended) {
                          await controller.startAttendedTransfer(request.target);
                        } else {
                          await controller.blindTransfer(request.target);
                        }
                      },
                avatar: const Icon(Icons.swap_horiz),
                label: const Text('Transfer'),
              ),
            ],
          ),
          if (controller.hasDirectTransfer ||
              controller.directTransferStatus.isNotEmpty) ...[
            const SizedBox(height: 18),
            Text(
              controller.directTransferStatus,
              style: Theme.of(context).textTheme.titleSmall,
              textAlign: TextAlign.center,
            ),
            if (controller.directAttendedTransferActive) ...[
              const SizedBox(height: 12),
              Wrap(
                spacing: 12,
                alignment: WrapAlignment.center,
                children: [
                  FilledButton.icon(
                    onPressed: controller.directTransferConnected
                        ? () => controller.completeAttendedTransfer()
                        : null,
                    icon: const Icon(Icons.call_merge),
                    label: const Text('Complete transfer'),
                  ),
                  OutlinedButton.icon(
                    onPressed: () => controller.cancelAttendedTransfer(),
                    icon: const Icon(Icons.close),
                    label: const Text('Cancel'),
                  ),
                ],
              ),
            ],
          ],
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
      onTap: controller.dialledNumber.trim().isNotEmpty
          ? () => mobileCalls.placeCall(controller.dialledNumber)
          : null,
    );
  }
}


class _TransferRequest {
  const _TransferRequest({required this.target, required this.attended});

  final String target;
  final bool attended;
}

Future<_TransferRequest?> _showTransferSheet(BuildContext context) {
  return showModalBottomSheet<_TransferRequest>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (_) => const _TransferSheet(),
  );
}

class _TransferSheet extends StatefulWidget {
  const _TransferSheet();

  @override
  State<_TransferSheet> createState() => _TransferSheetState();
}

class _TransferSheetState extends State<_TransferSheet> {
  String _target = '';
  bool _attended = false;

  static const _keys = [
    ['1', '2', '3'],
    ['4', '5', '6'],
    ['7', '8', '9'],
    ['*', '0', '#'],
  ];

  void _digit(String value) => setState(() => _target += value);

  void _backspace() {
    if (_target.isEmpty) return;
    setState(() => _target = _target.substring(0, _target.length - 1));
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(24, 6, 24, 28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('Transfer call', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 12),
            SegmentedButton<bool>(
              segments: const [
                ButtonSegment(
                  value: false,
                  icon: Icon(Icons.forward),
                  label: Text('Blind'),
                ),
                ButtonSegment(
                  value: true,
                  icon: Icon(Icons.phone_in_talk),
                  label: Text('Attended'),
                ),
              ],
              selected: {_attended},
              onSelectionChanged: (values) {
                setState(() => _attended = values.first);
              },
            ),
            const SizedBox(height: 18),
            Text(
              _target.isEmpty ? 'Enter destination' : _target,
              style: Theme.of(context).textTheme.headlineMedium,
            ),
            const SizedBox(height: 8),
            _DialPad(
              keys: _keys,
              onDigit: _digit,
              onBackspace: _backspace,
            ),
            const SizedBox(height: 18),
            SizedBox(
              width: double.infinity,
              child: FilledButton.icon(
                onPressed: _target.isEmpty
                    ? null
                    : () => Navigator.of(context).pop(
                          _TransferRequest(
                            target: _target,
                            attended: _attended,
                          ),
                        ),
                icon: Icon(_attended ? Icons.phone_in_talk : Icons.forward),
                label: Text(
                  _attended ? 'Consult then transfer' : 'Transfer now',
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

String _formatCallDuration(DateTime? connectedAt) {
  if (connectedAt == null) return '00:00';
  final elapsed = DateTime.now().difference(connectedAt);
  final seconds = elapsed.inSeconds < 0 ? 0 : elapsed.inSeconds;
  final hours = seconds ~/ 3600;
  final minutes = (seconds % 3600) ~/ 60;
  final remainder = seconds % 60;
  if (hours > 0) {
    return '${hours.toString().padLeft(2, '0')}:${minutes.toString().padLeft(2, '0')}:${remainder.toString().padLeft(2, '0')}';
  }
  return '${minutes.toString().padLeft(2, '0')}:${remainder.toString().padLeft(2, '0')}';
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
