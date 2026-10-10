import 'package:flutter/material.dart';

import '../models/messaging_presence.dart';
import '../services/xmpp_service.dart';

class MessagingSearchField extends StatelessWidget {
  const MessagingSearchField({
    super.key,
    required this.controller,
    required this.hint,
    required this.clearTooltip,
    required this.onChanged,
  });
  final TextEditingController controller;
  final String hint, clearTooltip;
  final ValueChanged<String> onChanged;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.all(12),
    child: TextField(
      controller: controller,
      decoration: InputDecoration(
        hintText: hint,
        prefixIcon: const Icon(Icons.search),
        border: const OutlineInputBorder(),
        isDense: true,
        suffixIcon: controller.text.isEmpty
            ? null
            : IconButton(
                tooltip: clearTooltip,
                onPressed: () {
                  controller.clear();
                  onChanged('');
                },
                icon: const Icon(Icons.close),
              ),
      ),
      onChanged: onChanged,
    ),
  );
}

class MessagingUnreadBadge extends StatelessWidget {
  const MessagingUnreadBadge({super.key, required this.count, this.child});
  final int count;
  final Widget? child;
  @override
  Widget build(BuildContext context) => Semantics(
    label: count > 0 ? '$count unread messages' : 'No unread messages',
    child: Badge(
      isLabelVisible: count > 0,
      label: Text(count > 99 ? '99+' : '$count'),
      child: child,
    ),
  );
}

class MessagingStatusControl extends StatelessWidget {
  const MessagingStatusControl({super.key, required this.messaging});
  final XmppService messaging;
  @override
  Widget build(BuildContext context) {
    final color = !messaging.online
        ? Colors.grey
        : switch (messaging.ownPresence) {
            MessagingPresence.available => Colors.green.shade700,
            MessagingPresence.away => Colors.amber.shade800,
            MessagingPresence.busy => Colors.red.shade700,
            _ => Colors.grey,
          };
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      child: PopupMenuButton<MessagingPresence>(
        tooltip: 'Change messaging status',
        enabled: messaging.accessAllowed,
        initialValue: messaging.ownPresence,
        onSelected: messaging.setPresence,
        itemBuilder: (_) => [
          for (final status in [
            MessagingPresence.available,
            MessagingPresence.away,
            MessagingPresence.busy,
          ])
            PopupMenuItem(value: status, child: Text(status.label)),
        ],
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 8),
          child: Row(
            children: [
              Icon(
                messaging.online ? Icons.circle : Icons.cloud_off_outlined,
                color: color,
                size: 16,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  messaging.online
                      ? 'Messaging connected · ${messaging.ownPresence.label}'
                      : 'Messaging ${messaging.state.name}',
                ),
              ),
              const Icon(Icons.expand_more, size: 18),
            ],
          ),
        ),
      ),
    );
  }
}
