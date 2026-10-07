import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../models/chat_message.dart';
import '../services/xmpp_service.dart';
import 'messaging_diagnostics_screen.dart';

class MessagesScreen extends StatelessWidget {
  const MessagesScreen({super.key, required this.messaging});
  final XmppService messaging;

  Future<void> _newChat(BuildContext context) async {
    final recipient = await showDialog<String>(
      context: context,
      builder: (_) => const _RecipientDialog(),
    );
    if (recipient == null || !context.mounted) return;
    try {
      _openChat(context, messaging.recipientJid(recipient));
    } on ArgumentError {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
            'Enter a local username or an ejabberd.voicehost.io JID.',
          ),
        ),
      );
    }
  }

  void _openChat(BuildContext context, String peer) =>
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => _ChatScreen(messaging: messaging, peer: peer),
        ),
      );

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: messaging,
    builder: (context, _) {
      if (!kDebugMode && !messaging.managedEnabled) {
        return Scaffold(
          appBar: AppBar(title: const Text('Messages')),
          body: const Center(
            child: Padding(
              padding: EdgeInsets.all(24),
              child: Text(
                'Messaging is not enabled for this device.',
                textAlign: TextAlign.center,
              ),
            ),
          ),
        );
      }
      final latest = <String, ChatMessage>{};
      for (final message in messaging.messages) {
        latest[message.peer] = message;
      }
      final conversations = latest.values.toList()
        ..sort((a, b) => b.timestamp.compareTo(a.timestamp));
      return Scaffold(
        appBar: AppBar(
          title: const Text('Messages'),
          actions: [
            if (kDebugMode)
              IconButton(
                tooltip: 'Messaging diagnostics',
                icon: const Icon(Icons.bug_report_outlined),
                onPressed: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) =>
                        MessagingDiagnosticsScreen(messaging: messaging),
                  ),
                ),
              ),
          ],
        ),
        floatingActionButton: messaging.online
            ? FloatingActionButton(
                tooltip: 'New conversation',
                onPressed: () => _newChat(context),
                child: const Icon(Icons.edit_outlined),
              )
            : null,
        body: Column(
          children: [
            ListTile(
              leading: Icon(
                messaging.online ? Icons.chat : Icons.chat_outlined,
              ),
              title: Text('Messaging ${messaging.state.name}'),
              subtitle: Text(
                messaging.error ??
                    messaging.historyError ??
                    (messaging.historyBusy
                        ? 'Recovering conversation history…'
                        : 'Encrypted history saved on this device'),
              ),
            ),
            if (messaging.managedEnabled && !messaging.online)
              TextButton(
                onPressed: messaging.reconnect,
                child: const Text('Reconnect'),
              ),
            if (messaging.historyError != null && messaging.online)
              TextButton(
                onPressed: messaging.historyBusy
                    ? null
                    : messaging.retryHistory,
                child: const Text('Retry history'),
              ),
            if (messaging.hasOlder)
              TextButton(
                onPressed: messaging.online && !messaging.historyBusy
                    ? messaging.loadOlder
                    : null,
                child: const Text('Load older messages'),
              ),
            const Divider(height: 1),
            Expanded(
              child: conversations.isEmpty
                  ? const Center(
                      child: Padding(
                        padding: EdgeInsets.all(24),
                        child: Text(
                          'No conversations yet. Start a conversation when messaging is online.',
                          textAlign: TextAlign.center,
                        ),
                      ),
                    )
                  : ListView.builder(
                      itemCount: conversations.length,
                      itemBuilder: (context, index) {
                        final message = conversations[index];
                        return ListTile(
                          leading: const CircleAvatar(
                            child: Icon(Icons.person_outline),
                          ),
                          title: Text(message.peer.split('@').first),
                          subtitle: Text(
                            message.body,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                          trailing: Text(
                            TimeOfDay.fromDateTime(
                              message.timestamp,
                            ).format(context),
                          ),
                          onTap: () => _openChat(context, message.peer),
                        );
                      },
                    ),
            ),
          ],
        ),
      );
    },
  );
}

class _RecipientDialog extends StatefulWidget {
  const _RecipientDialog();
  @override
  State<_RecipientDialog> createState() => _RecipientDialogState();
}

class _RecipientDialogState extends State<_RecipientDialog> {
  final _recipient = TextEditingController();
  @override
  void dispose() {
    _recipient.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('New conversation'),
    content: TextField(
      controller: _recipient,
      autofocus: true,
      autocorrect: false,
      enableSuggestions: false,
      decoration: const InputDecoration(labelText: 'Username', hintText: '208'),
      onSubmitted: (value) => Navigator.pop(context, value),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('Cancel'),
      ),
      FilledButton(
        onPressed: () => Navigator.pop(context, _recipient.text),
        child: const Text('Open'),
      ),
    ],
  );
}

class _ChatScreen extends StatefulWidget {
  const _ChatScreen({required this.messaging, required this.peer});
  final XmppService messaging;
  final String peer;
  @override
  State<_ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<_ChatScreen> {
  final _text = TextEditingController();
  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  void _send() {
    try {
      widget.messaging.sendMessage(recipient: widget.peer, body: _text.text);
      _text.clear();
    } catch (_) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
            'Could not send. Check your connection and message length.',
          ),
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.messaging,
    builder: (context, _) {
      if (!widget.messaging.accessAllowed) {
        return Scaffold(
          appBar: AppBar(title: const Text('Messages')),
          body: const Center(
            child: Padding(
              padding: EdgeInsets.all(24),
              child: Text(
                'App locked. Please contact your administrator.',
                textAlign: TextAlign.center,
              ),
            ),
          ),
        );
      }
      final messages = widget.messaging.messages
          .where((m) => m.peer == widget.peer)
          .toList();
      return Scaffold(
        appBar: AppBar(title: Text(widget.peer.split('@').first)),
        body: SafeArea(
          child: Column(
            children: [
              if (!widget.messaging.online)
                Padding(
                  padding: const EdgeInsets.all(8),
                  child: Text('Messaging ${widget.messaging.state.name}'),
                ),
              if (widget.messaging.hasOlder)
                TextButton(
                  onPressed:
                      widget.messaging.online && !widget.messaging.historyBusy
                      ? widget.messaging.loadOlder
                      : null,
                  child: const Text('Load older messages'),
                ),
              Expanded(
                child: ListView.builder(
                  reverse: true,
                  padding: const EdgeInsets.all(16),
                  itemCount: messages.length,
                  itemBuilder: (context, index) {
                    final message = messages[messages.length - 1 - index];
                    final colors = Theme.of(context).colorScheme;
                    return Align(
                      alignment: message.outgoing
                          ? Alignment.centerRight
                          : Alignment.centerLeft,
                      child: Container(
                        margin: const EdgeInsets.only(bottom: 10),
                        padding: const EdgeInsets.all(12),
                        constraints: BoxConstraints(
                          maxWidth: MediaQuery.sizeOf(context).width * 0.8,
                        ),
                        decoration: BoxDecoration(
                          color: message.outgoing
                              ? colors.secondary
                              : colors.surfaceContainerHighest,
                          borderRadius: BorderRadius.circular(14),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              message.body,
                              style: TextStyle(
                                color: message.outgoing
                                    ? colors.onSecondary
                                    : colors.onSurface,
                              ),
                            ),
                            const SizedBox(height: 5),
                            Text(
                              '${TimeOfDay.fromDateTime(message.timestamp).format(context)}'
                              '${message.outgoing ? ' · ${message.status.name}' : ''}',
                              style: TextStyle(
                                fontSize: 11,
                                color: message.outgoing
                                    ? colors.onSecondary.withValues(alpha: 0.75)
                                    : colors.onSurfaceVariant,
                              ),
                            ),
                          ],
                        ),
                      ),
                    );
                  },
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 8, 12),
                child: Row(
                  children: [
                    Expanded(
                      child: TextField(
                        controller: _text,
                        minLines: 1,
                        maxLines: 5,
                        enabled: widget.messaging.online,
                        maxLength: 10000,
                        decoration: const InputDecoration(
                          hintText: 'Message…',
                          counterText: '',
                          border: OutlineInputBorder(),
                        ),
                      ),
                    ),
                    IconButton(
                      tooltip: 'Send message',
                      onPressed: widget.messaging.online ? _send : null,
                      icon: const Icon(Icons.send),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      );
    },
  );
}
