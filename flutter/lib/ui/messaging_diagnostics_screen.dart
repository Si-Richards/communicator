import 'package:flutter/material.dart';

import '../services/xmpp_service.dart';

class MessagingDiagnosticsScreen extends StatefulWidget {
  const MessagingDiagnosticsScreen({super.key, required this.messaging});
  final XmppService messaging;
  @override
  State<MessagingDiagnosticsScreen> createState() =>
      _MessagingDiagnosticsScreenState();
}

class _MessagingDiagnosticsScreenState
    extends State<MessagingDiagnosticsScreen> {
  final _username = TextEditingController();
  final _password = TextEditingController();
  final _recipient = TextEditingController();
  final _message = TextEditingController();
  String? _formError;

  @override
  void dispose() {
    _username.dispose();
    _password.dispose();
    _recipient.dispose();
    _message.dispose();
    super.dispose();
  }

  Future<void> _connect() async {
    setState(() => _formError = null);
    final password = _password.text;
    _password.clear();
    try {
      await widget.messaging.connect(
        username: _username.text,
        password: password,
      );
    } on ArgumentError {
      if (mounted) {
        setState(
          () => _formError =
              'Enter a username without @domain and its test password.',
        );
      }
    } on StateError {
      if (mounted) {
        setState(
          () => _formError = 'Messaging is locked by device provisioning.',
        );
      }
    }
  }

  void _send() {
    try {
      widget.messaging.sendMessage(
        recipient: _recipient.text,
        body: _message.text,
      );
      _message.clear();
      setState(() => _formError = null);
    } on ArgumentError {
      setState(
        () => _formError =
            'Enter a local recipient and a message of up to 10,000 characters.',
      );
    } on StateError {
      setState(() => _formError = 'Connect messaging before sending.');
    }
  }

  @override
  Widget build(BuildContext context) {
    final service = widget.messaging;
    return Scaffold(
      appBar: AppBar(title: const Text('Messaging diagnostics')),
      body: AnimatedBuilder(
        animation: service,
        builder: (context, _) {
          if (!service.accessAllowed) {
            return const Center(
              child: Padding(
                padding: EdgeInsets.all(24),
                child: Text(
                  'App locked. Please contact your administrator.',
                  textAlign: TextAlign.center,
                ),
              ),
            );
          }
          final canConnect =
              service.accessAllowed &&
              [
                XmppState.disconnected,
                XmppState.failed,
              ].contains(service.state);
          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              const Text(
                'Development test',
                style: TextStyle(fontWeight: FontWeight.bold),
              ),
              const SizedBox(height: 8),
              const Text(
                'Use an ejabberd test account. Credentials and messages are held only '
                'for this app session. Background notifications and archive history are not enabled yet.',
              ),
              const SizedBox(height: 16),
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('Server: ${XmppService.domain}'),
                      const Text('Transport: WebSocket / TLS · port 443'),
                      const SizedBox(height: 8),
                      Text(
                        'Status: ${service.state.name}',
                        key: const Key('xmpp-status'),
                        style: TextStyle(
                          color: service.online ? Colors.green.shade700 : null,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                      if (service.jid != null) SelectableText(service.jid!),
                      if (service.error != null) ...[
                        const SizedBox(height: 8),
                        Text(
                          service.error!,
                          style: TextStyle(
                            color: Theme.of(context).colorScheme.error,
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _username,
                enabled: canConnect,
                autocorrect: false,
                enableSuggestions: false,
                decoration: const InputDecoration(
                  labelText: 'Test username',
                  hintText: '207',
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _password,
                enabled: canConnect,
                obscureText: true,
                autocorrect: false,
                enableSuggestions: false,
                decoration: const InputDecoration(labelText: 'Test password'),
                onSubmitted: canConnect ? (_) => _connect() : null,
              ),
              const SizedBox(height: 12),
              FilledButton.icon(
                onPressed: !service.accessAllowed
                    ? null
                    : canConnect
                    ? _connect
                    : () {
                        service.disconnect();
                        _password.clear();
                      },
                icon: Icon(canConnect ? Icons.login : Icons.logout),
                label: Text(canConnect ? 'Connect' : 'Disconnect'),
              ),
              const SizedBox(height: 24),
              TextField(
                controller: _recipient,
                autocorrect: false,
                enableSuggestions: false,
                decoration: const InputDecoration(
                  labelText: 'Test recipient',
                  hintText: '208',
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _message,
                minLines: 1,
                maxLines: 4,
                maxLength: 10000,
                decoration: const InputDecoration(labelText: 'Test message'),
              ),
              FilledButton.icon(
                onPressed: service.online ? _send : null,
                icon: const Icon(Icons.send),
                label: const Text('Send test message'),
              ),
              if (_formError != null)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(
                    _formError!,
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.error,
                    ),
                  ),
                ),
              const SizedBox(height: 24),
              Text(
                'Session messages (${service.messages.length})',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const Text('Open Messages to view and reply to conversations.'),
              const SizedBox(height: 16),
              Text(
                'Recent events',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: 8),
              SelectableText(service.events.reversed.join('\n')),
            ],
          );
        },
      ),
    );
  }
}
