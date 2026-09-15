import 'package:flutter/material.dart';

import '../controllers/phone_controller.dart';

class VoicemailScreen extends StatelessWidget {
  const VoicemailScreen({
    super.key,
    required this.controller,
    required this.onGoToPhone,
  });

  final PhoneController controller;
  final VoidCallback onGoToPhone;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: controller,
      builder: (context, _) {
        final summary = controller.voicemail;
        return Scaffold(
          appBar: AppBar(
            title: const Text('Voicemail'),
            actions: [
              IconButton(
                tooltip: 'Refresh voicemail status',
                onPressed: controller.isRegistered
                    ? controller.refreshVoicemailStatus
                    : null,
                icon: const Icon(Icons.refresh),
              ),
            ],
          ),
          body: ListView(
            padding: const EdgeInsets.all(20),
            children: [
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(20),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Icon(
                            summary.waiting ? Icons.voicemail : Icons.mark_email_read,
                            size: 38,
                            color: summary.waiting
                                ? Theme.of(context).colorScheme.primary
                                : Theme.of(context).colorScheme.outline,
                          ),
                          const SizedBox(width: 14),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  summary.waiting
                                      ? 'Voicemail waiting'
                                      : 'No new voicemail',
                                  style: Theme.of(context).textTheme.titleLarge,
                                ),
                                Text(
                                  'MWI: ${controller.voicemailSubscriptionStatus}',
                                  style: Theme.of(context).textTheme.bodySmall,
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 22),
                      Row(
                        children: [
                          Expanded(
                            child: _CountTile(
                              label: 'New',
                              value: summary.newMessages,
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: _CountTile(
                              label: 'Saved',
                              value: summary.oldMessages,
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 18),
              FilledButton.icon(
                onPressed: controller.canCallVoicemail
                    ? () async {
                        onGoToPhone();
                        await controller.callVoicemail();
                      }
                    : null,
                icon: const Icon(Icons.phone),
                label: const Text('Call Voicemail'),
              ),
              if (controller.voicemailNumber.trim().isEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 12),
                  child: Text(
                    'Set the VoiceHost voicemail number or feature code in Settings before calling voicemail.',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ),
              const SizedBox(height: 28),
              Text('Visual voicemail', style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 8),
              Text(
                'Message waiting indication is live over SIP. Listing, playing, transcribing and deleting individual messages will be connected to the VoiceHost voicemail API in the next phase.',
                style: Theme.of(context).textTheme.bodyMedium,
              ),
            ],
          ),
        );
      },
    );
  }
}

class _CountTile extends StatelessWidget {
  const _CountTile({required this.label, required this.value});

  final String label;
  final int value;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Column(
        children: [
          Text('$value', style: Theme.of(context).textTheme.headlineMedium),
          Text(label),
        ],
      ),
    );
  }
}
