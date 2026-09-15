import 'package:flutter/material.dart';

import '../controllers/phone_controller.dart';
import '../models/call_record.dart';

class CallHistoryScreen extends StatelessWidget {
  const CallHistoryScreen({
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
        return Scaffold(
          appBar: AppBar(
            title: const Text('Recents'),
            actions: [
              if (controller.callHistory.isNotEmpty)
                PopupMenuButton<String>(
                  onSelected: (value) {
                    if (value == 'clear') controller.clearCallHistory();
                  },
                  itemBuilder: (context) => const [
                    PopupMenuItem(
                      value: 'clear',
                      child: Text('Clear call history'),
                    ),
                  ],
                ),
            ],
          ),
          body: controller.callHistory.isEmpty
              ? const _EmptyHistory()
              : ListView.separated(
                  itemCount: controller.callHistory.length,
                  separatorBuilder: (_, _) => const Divider(height: 1),
                  itemBuilder: (context, index) {
                    final record = controller.callHistory[index];
                    return Dismissible(
                      key: ValueKey(record.id),
                      direction: DismissDirection.endToStart,
                      background: Container(
                        alignment: Alignment.centerRight,
                        padding: const EdgeInsets.only(right: 24),
                        color: Theme.of(context).colorScheme.error,
                        child: const Icon(Icons.delete, color: Colors.white),
                      ),
                      onDismissed: (_) => controller.deleteCallRecord(record.id),
                      child: ListTile(
                        leading: CircleAvatar(
                          backgroundColor: _iconColor(record).withValues(alpha: 0.12),
                          child: Icon(_icon(record), color: _iconColor(record)),
                        ),
                        title: Text(
                          record.displayName?.trim().isNotEmpty == true
                              ? record.displayName!
                              : record.number,
                          style: TextStyle(
                            fontWeight: FontWeight.w600,
                            color: record.result == CallResult.missed
                                ? Theme.of(context).colorScheme.error
                                : null,
                          ),
                        ),
                        subtitle: Text(_subtitle(record)),
                        trailing: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(
                              _timeText(record.startedAt),
                              style: Theme.of(context).textTheme.bodySmall,
                            ),
                            IconButton(
                              tooltip: 'Call ${record.number}',
                              onPressed: controller.isRegistered &&
                                      !controller.callState.isInCall
                                  ? () {
                                      controller.setDialledNumber(record.number);
                                      onGoToPhone();
                                      controller.placeCall(record.number);
                                    }
                                  : null,
                              icon: const Icon(Icons.phone),
                            ),
                          ],
                        ),
                        onTap: () {
                          controller.setDialledNumber(record.number);
                          onGoToPhone();
                        },
                      ),
                    );
                  },
                ),
        );
      },
    );
  }

  String _subtitle(CallRecord record) {
    final direction =
        record.direction == CallDirection.incoming ? 'Incoming' : 'Outgoing';
    final duration = record.durationSeconds > 0 ? ' · ${record.durationText}' : '';
    return '$direction · ${record.resultText}$duration';
  }

  String _timeText(DateTime value) {
    final local = value.toLocal();
    final now = DateTime.now();
    final sameDay = local.year == now.year &&
        local.month == now.month &&
        local.day == now.day;
    final hh = local.hour.toString().padLeft(2, '0');
    final mm = local.minute.toString().padLeft(2, '0');
    if (sameDay) return '$hh:$mm';
    return '${local.day}/${local.month} $hh:$mm';
  }

  IconData _icon(CallRecord record) => switch (record.result) {
        CallResult.completed => record.direction == CallDirection.incoming
            ? Icons.call_received
            : Icons.call_made,
        CallResult.missed => Icons.phone_missed,
        CallResult.declined => Icons.call_end,
        CallResult.failed => Icons.error_outline,
        CallResult.cancelled => Icons.call_end,
      };

  Color _iconColor(CallRecord record) => switch (record.result) {
        CallResult.completed => Colors.green,
        CallResult.missed || CallResult.failed => Colors.red,
        CallResult.declined || CallResult.cancelled => Colors.grey,
      };
}

class _EmptyHistory extends StatelessWidget {
  const _EmptyHistory();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.history,
              size: 58,
              color: Theme.of(context).colorScheme.outline,
            ),
            const SizedBox(height: 16),
            Text('No recent calls', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 6),
            const Text(
              'Incoming, outgoing, missed and declined calls will appear here.',
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }
}
