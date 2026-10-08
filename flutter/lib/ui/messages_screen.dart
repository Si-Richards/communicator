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
      builder: (_) => _RecipientDialog(messaging: messaging),
    );
    if (recipient == null || !context.mounted) return;
    try {
      _openChat(context, messaging.recipientJid(recipient));
    } on ArgumentError {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Enter an extension in your account.')),
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
      if (!messaging.accessAllowed) {
        return Scaffold(
          appBar: AppBar(title: const Text('Messages')),
          body: const Center(
            child: Text('App locked. Please contact your administrator.'),
          ),
        );
      }
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
      return DefaultTabController(
        length: 2,
        child: Scaffold(
          appBar: AppBar(
            title: const Text('Messages'),
            bottom: const TabBar(
              labelColor: Colors.white,
              unselectedLabelColor: Colors.white70,
              indicatorColor: Colors.white,
              tabs: [
                Tab(text: 'Conversations'),
                Tab(text: 'Directory'),
              ],
            ),
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
          body: TabBarView(
            children: [
              Column(
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
                                title: Text(
                                  messaging.contactLabel(message.peer),
                                ),
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
              _AccountDirectory(
                messaging: messaging,
                onSelect: (jid) => _openChat(context, jid),
              ),
            ],
          ),
        ),
      );
    },
  );
}

class _RecipientDialog extends StatefulWidget {
  const _RecipientDialog({required this.messaging});
  final XmppService messaging;
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
      decoration: const InputDecoration(
        labelText: 'Extension',
        hintText: '208',
      ),
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

class _AccountDirectory extends StatefulWidget {
  const _AccountDirectory({required this.messaging, required this.onSelect});
  final XmppService messaging;
  final ValueChanged<String> onSelect;
  @override
  State<_AccountDirectory> createState() => _AccountDirectoryState();
}

class _AccountDirectoryState extends State<_AccountDirectory> {
  String _query = '';
  @override
  Widget build(BuildContext context) {
    final messaging = widget.messaging;
    final contacts = messaging.directory
        .where(
          (contact) =>
              contact.extension.toLowerCase().contains(_query) ||
              contact.name.toLowerCase().contains(_query),
        )
        .toList();
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.all(16),
          child: TextField(
            decoration: const InputDecoration(
              labelText: 'Search name or extension',
              prefixIcon: Icon(Icons.search),
              border: OutlineInputBorder(),
            ),
            onChanged: (value) =>
                setState(() => _query = value.trim().toLowerCase()),
          ),
        ),
        Row(
          children: [
            const SizedBox(width: 16),
            const Expanded(child: Text('Account users')),
            TextButton.icon(
              onPressed: messaging.online && !messaging.directoryBusy
                  ? messaging.refreshDirectory
                  : null,
              icon: const Icon(Icons.refresh),
              label: const Text('Refresh'),
            ),
            const SizedBox(width: 8),
          ],
        ),
        if (messaging.directoryBusy) const LinearProgressIndicator(),
        if (messaging.directoryError != null)
          Padding(
            padding: const EdgeInsets.all(16),
            child: Text(messaging.directoryError!),
          ),
        Expanded(
          child: contacts.isEmpty
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Text(
                      messaging.directoryBusy
                          ? 'Loading account users…'
                          : _query.isNotEmpty
                          ? 'No matching account users.'
                          : !messaging.online
                          ? 'Connect messaging to load account users.'
                          : 'No other messaging users in your account yet.',
                      textAlign: TextAlign.center,
                    ),
                  ),
                )
              : ListView.builder(
                  itemCount: contacts.length,
                  itemBuilder: (context, index) {
                    final contact = contacts[index];
                    return ListTile(
                      leading: const CircleAvatar(
                        child: Icon(Icons.person_outline),
                      ),
                      title: Text(
                        contact.name.isEmpty ? contact.extension : contact.name,
                      ),
                      subtitle: Text('Extension ${contact.extension}'),
                      onTap: messaging.online
                          ? () => widget.onSelect(contact.jid)
                          : null,
                    );
                  },
                ),
        ),
      ],
    );
  }
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
        appBar: AppBar(title: Text(widget.messaging.contactLabel(widget.peer))),
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
