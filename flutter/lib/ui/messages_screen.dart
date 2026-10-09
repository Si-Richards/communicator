import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:image_picker/image_picker.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../models/chat_message.dart';
import '../models/chat_attachment.dart';
import '../controllers/provisioning_controller.dart';
import '../services/attachment_bytes.dart';
import '../models/messaging_presence.dart';
import '../services/xmpp_service.dart';
import 'messaging_diagnostics_screen.dart';

final messagingRouteObserver = RouteObserver<ModalRoute<dynamic>>();

class MessagesScreen extends StatelessWidget {
  const MessagesScreen({super.key, required this.messaging, this.provisioning});
  final XmppService messaging;
  final ProvisioningController? provisioning;

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
          builder: (_) => MessagingChatScreen(
            messaging: messaging,
            peer: peer,
            provisioning: provisioning,
          ),
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
              IconButton(
                tooltip: 'Messaging preferences',
                icon: const Icon(Icons.tune),
                onPressed: () => showDialog<void>(
                  context: context,
                  builder: (_) => _ActivitySettingsDialog(messaging: messaging),
                ),
              ),
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
                                leading: _PresenceAvatar(
                                  presence: messaging.presenceFor(message.peer),
                                ),
                                title: Text(
                                  messaging.contactLabel(message.peer),
                                ),
                                subtitle: Text(
                                  messaging.isTyping(message.peer)
                                      ? 'Typing…'
                                      : message.body,
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

class _PresenceAvatar extends StatelessWidget {
  const _PresenceAvatar({required this.presence});
  final MessagingPresence presence;
  @override
  Widget build(BuildContext context) {
    final color = switch (presence) {
      MessagingPresence.available => Colors.green.shade700,
      MessagingPresence.away => Colors.amber.shade800,
      MessagingPresence.busy => Colors.red.shade700,
      _ => Colors.grey.shade600,
    };
    return Semantics(
      label: presence.label,
      child: Stack(
        children: [
          const CircleAvatar(child: Icon(Icons.person_outline)),
          Positioned(
            right: 0,
            bottom: 0,
            child: Container(
              width: 12,
              height: 12,
              decoration: BoxDecoration(
                color: color,
                shape: BoxShape.circle,
                border: Border.all(
                  color: Theme.of(context).colorScheme.surface,
                  width: 2,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _MessageStatusIcon extends StatelessWidget {
  const _MessageStatusIcon({required this.status});
  final ChatMessageStatus status;
  @override
  Widget build(BuildContext context) {
    final label = switch (status) {
      ChatMessageStatus.read => 'Read',
      ChatMessageStatus.delivered => 'Delivered',
      ChatMessageStatus.failed => 'Failed to send',
      _ => 'Sent',
    };
    return Tooltip(
      message: label,
      child: Semantics(
        label: label,
        child: Icon(
          switch (status) {
            ChatMessageStatus.read ||
            ChatMessageStatus.delivered => Icons.done_all,
            ChatMessageStatus.failed => Icons.error_outline,
            _ => Icons.done,
          },
          size: 16,
          color: status == ChatMessageStatus.read
              ? const Color(0xFF80D8FF)
              : status == ChatMessageStatus.failed
              ? const Color(0xFFFFAB91)
              : Theme.of(
                  context,
                ).colorScheme.onSecondary.withValues(alpha: 0.75),
        ),
      ),
    );
  }
}

class _ActivitySettingsDialog extends StatelessWidget {
  const _ActivitySettingsDialog({required this.messaging});
  final XmppService messaging;
  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: messaging,
    builder: (context, _) => AlertDialog(
      title: const Text('Messaging preferences'),
      content: SizedBox(
        width: 360,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            DropdownButtonFormField<MessagingPresence>(
              initialValue: messaging.ownPresence,
              decoration: const InputDecoration(
                labelText: 'My messaging status',
              ),
              items: [
                for (final state in [
                  MessagingPresence.available,
                  MessagingPresence.away,
                  MessagingPresence.busy,
                ])
                  DropdownMenuItem(value: state, child: Text(state.label)),
              ],
              onChanged: messaging.accessAllowed
                  ? (value) {
                      if (value != null) messaging.setPresence(value);
                    }
                  : null,
            ),
            const SizedBox(height: 8),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('Share typing activity'),
              value: messaging.shareTyping,
              onChanged: messaging.accessAllowed
                  ? (value) => messaging.setActivitySharing(typing: value)
                  : null,
            ),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('Share read receipts'),
              subtitle: const Text('Delivery receipts remain enabled.'),
              value: messaging.shareReadReceipts,
              onChanged: messaging.accessAllowed
                  ? (value) => messaging.setActivitySharing(readReceipts: value)
                  : null,
            ),
            const Text(
              'These preferences apply to this device. Messaging status is separate from call Do Not Disturb.',
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Done'),
        ),
      ],
    ),
  );
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
                      leading: _PresenceAvatar(
                        presence: messaging.presenceFor(contact.jid),
                      ),
                      title: Text(contact.label),
                      subtitle: Text(messaging.presenceFor(contact.jid).label),
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

class MessagingChatScreen extends StatefulWidget {
  const MessagingChatScreen({
    super.key,
    required this.messaging,
    required this.peer,
    this.provisioning,
  });
  final XmppService messaging;
  final String peer;
  final ProvisioningController? provisioning;
  @override
  State<MessagingChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<MessagingChatScreen>
    with WidgetsBindingObserver, RouteAware {
  final _text = TextEditingController();
  final _scroll = ScrollController();
  final _viewport = GlobalKey();
  final _messageKeys = <String, GlobalKey>{};
  ModalRoute<dynamic>? _route;
  bool _readScheduled = false;
  bool _attachmentBusy = false;
  String _attachmentActivity = '';
  Uint8List? _draftBytes;
  String? _draftName;
  String? _draftOwner;
  String? _draftDevice;
  String? _draftPeer;
  bool _draftPhoto = false;

  bool _attachmentOwnerAllowed(String? owner, String? device) =>
      mounted &&
      _peerAllowed &&
      widget.messaging.accessAllowed &&
      widget.provisioning?.attachmentsAvailable == true &&
      widget.provisioning?.configuration?.messaging?.jid == owner &&
      widget.provisioning?.deviceId == device;

  void _attachmentError(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _selectAttachment(String source) async {
    if (_attachmentBusy || widget.provisioning?.attachmentsAvailable != true) {
      return;
    }
    final owner = widget.provisioning!.configuration!.messaging!.jid;
    final device = widget.provisioning!.deviceId;
    final peer = widget.peer;
    setState(() {
      _attachmentBusy = true;
      _attachmentActivity = 'Preparing attachment…';
    });
    try {
      String name;
      Stream<List<int>> stream;
      int? size;
      if (source == 'file') {
        final file = await FilePicker.pickFile();
        if (file == null) {
          return;
        }
        size = file.lengthSync() ?? await file.length();
        name = file.name;
        stream = file.readAsByteStream();
      } else {
        final image = await ImagePicker().pickImage(
          source: source == 'camera' ? ImageSource.camera : ImageSource.gallery,
          maxWidth: 2048,
          maxHeight: 2048,
          imageQuality: 85,
          requestFullMetadata: false,
        );
        if (image == null) return;
        size = await image.length();
        name = image.name;
        stream = image.openRead();
      }
      if (size != null && size > ChatAttachment.maxBytes) {
        throw ArgumentError('Attachments must be no larger than 10 MB.');
      }
      final bytes = await readAttachmentBytes(stream);
      if (!_attachmentOwnerAllowed(owner, device) || widget.peer != peer) {
        return;
      }
      name = name
          .replaceAll('\\', '/')
          .split('/')
          .last
          .replaceAll(RegExp(r'[\x00-\x1f\x7f]'), '')
          .trim();
      if (name.isEmpty) name = 'attachment';
      if (name.length > 160) name = name.substring(0, 160);
      setState(() {
        _draftBytes = bytes;
        _draftName = name;
        _draftPhoto = source != 'file';
        _draftOwner = owner;
        _draftDevice = device;
        _draftPeer = peer;
      });
    } on ArgumentError catch (error) {
      _attachmentError(error.message.toString());
    } catch (_) {
      _attachmentError(
        'Could not select the attachment. Check permissions and try again.',
      );
    } finally {
      if (mounted) setState(() => _attachmentBusy = false);
    }
  }

  Future<void> _sendAttachment() async {
    final bytes = _draftBytes;
    if (bytes == null ||
        _attachmentBusy ||
        !_attachmentOwnerAllowed(_draftOwner, _draftDevice) ||
        _draftPeer != widget.peer) {
      return;
    }
    final caption = _text.text;
    final peer = widget.peer;
    setState(() {
      _attachmentBusy = true;
      _attachmentActivity = 'Uploading attachment…';
    });
    try {
      final attachment = await widget.provisioning!.uploadMessagingAttachment(
        peer: peer,
        name: _draftName!,
        bytes: bytes,
      );
      if (!_attachmentOwnerAllowed(_draftOwner, _draftDevice) ||
          widget.peer != peer) {
        return;
      }
      // Keep the selected file and caption for retry if XMPP disconnected
      // during upload; never send it to a newly selected account.
      widget.messaging.sendMessage(
        recipient: peer,
        body: caption.trim().isEmpty ? attachment.summary : caption,
        attachment: attachment,
      );
      setState(() {
        _draftBytes = null;
        _draftName = null;
      });
      _text.clear();
    } catch (_) {
      _attachmentError(
        'Could not send the attachment. Check your connection and try again. The file is still selected.',
      );
    } finally {
      if (mounted) setState(() => _attachmentBusy = false);
    }
  }

  Future<void> _saveAttachment(
    ChatAttachment attachment,
    Uint8List bytes,
  ) async {
    await FilePicker.saveFile(
      dialogTitle: 'Save attachment',
      fileName: attachment.name,
      bytes: bytes,
      mimeType: attachment.mediaType,
    );
  }

  Future<void> _openAttachment(ChatAttachment attachment) async {
    if (_attachmentBusy || widget.provisioning?.attachmentsAvailable != true) {
      return;
    }
    final owner = widget.provisioning!.configuration!.messaging!.jid;
    final device = widget.provisioning!.deviceId;
    final peer = widget.peer;
    setState(() {
      _attachmentBusy = true;
      _attachmentActivity = 'Downloading attachment…';
    });
    try {
      final bytes = await widget.provisioning!.downloadMessagingAttachment(
        peer: peer,
        attachment: attachment,
      );
      if (!_attachmentOwnerAllowed(owner, device) || widget.peer != peer) {
        return;
      }
      if (attachment.isImage) {
        if (!mounted) return;
        await showDialog<void>(
          context: context,
          builder: (dialogContext) => AnimatedBuilder(
            animation: widget.provisioning!,
            builder: (_, _) {
              final allowed =
                  _attachmentOwnerAllowed(owner, device) && widget.peer == peer;
              return AlertDialog(
                title: Text(attachment.name),
                content: allowed
                    ? SizedBox(
                        width: 600,
                        height: 360,
                        child: InteractiveViewer(
                          child: Image(
                            image: ResizeImage(
                              MemoryImage(bytes),
                              width: 2048,
                              height: 2048,
                              policy: ResizeImagePolicy.fit,
                            ),
                            fit: BoxFit.contain,
                            errorBuilder: (_, _, _) => const Center(
                              child: Text(
                                'Image preview unavailable. You can save the file.',
                              ),
                            ),
                          ),
                        ),
                      )
                    : const Text('This attachment is unavailable.'),
                actions: [
                  TextButton(
                    onPressed: () => Navigator.of(dialogContext).pop(),
                    child: const Text('Close'),
                  ),
                  if (allowed)
                    TextButton(
                      onPressed: () async {
                        try {
                          await _saveAttachment(attachment, bytes);
                        } catch (_) {
                          _attachmentError(
                            'Could not save the attachment. Please retry.',
                          );
                        }
                      },
                      child: const Text('Save'),
                    ),
                ],
              );
            },
          ),
        );
      } else {
        await _saveAttachment(attachment, bytes);
      }
    } catch (_) {
      _attachmentError(
        'Could not download this attachment. It may have expired, or your connection or access changed.',
      );
    } finally {
      if (mounted) setState(() => _attachmentBusy = false);
    }
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _scroll.addListener(_scheduleRead);
    _text.addListener(_typingChanged);
    widget.provisioning?.addListener(_discardUnavailableDraft);
  }

  void _discardUnavailableDraft() {
    if (_draftBytes == null ||
        (_attachmentOwnerAllowed(_draftOwner, _draftDevice) &&
            _draftPeer == widget.peer)) {
      return;
    }
    setState(() {
      _draftBytes = null;
      _draftName = null;
    });
    _text.clear();
  }

  @override
  void didUpdateWidget(covariant MessagingChatScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.provisioning != widget.provisioning) {
      oldWidget.provisioning?.removeListener(_discardUnavailableDraft);
      widget.provisioning?.addListener(_discardUnavailableDraft);
    }
    if (oldWidget.peer != widget.peer ||
        oldWidget.provisioning != widget.provisioning) {
      _draftBytes = null;
      _draftName = null;
      _text.clear();
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final route = ModalRoute.of(context);
    if (_route != route) {
      messagingRouteObserver.unsubscribe(this);
      _route = route;
      if (route != null) messagingRouteObserver.subscribe(this, route);
    }
    _scheduleRead();
  }

  bool get _visible =>
      mounted &&
      _peerAllowed &&
      (_route?.isCurrent ?? false) &&
      (WidgetsBinding.instance.lifecycleState == null ||
          WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed);

  bool get _peerAllowed {
    try {
      return widget.messaging.recipientJid(widget.peer) == widget.peer;
    } on ArgumentError {
      return false;
    }
  }

  void _typingChanged() {
    if (_visible && widget.messaging.online) {
      widget.messaging.updateTyping(
        widget.peer,
        composing: _text.text.isNotEmpty,
      );
    }
  }

  @override
  void didPushNext() => widget.messaging.stopTyping(widget.peer);
  @override
  void didPopNext() => _scheduleRead();
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _scheduleRead();
    } else {
      widget.messaging.stopTyping(widget.peer);
    }
  }

  void _scheduleRead() {
    if (_readScheduled || !mounted) return;
    _readScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _readScheduled = false;
      if (!_visible ||
          !widget.messaging.online ||
          !widget.messaging.accessAllowed) {
        return;
      }
      widget.messaging.prepareConversation(widget.peer);
      final viewport = _viewport.currentContext?.findRenderObject();
      if (viewport is! RenderBox || !viewport.hasSize) return;
      final bounds = viewport.localToGlobal(Offset.zero) & viewport.size;
      for (final message in widget.messaging.messages.reversed) {
        if (message.peer != widget.peer ||
            message.outgoing ||
            message.displayed) {
          continue;
        }
        final box = _messageKeys[message.id]?.currentContext
            ?.findRenderObject();
        if (box is! RenderBox || !box.hasSize || !box.attached) continue;
        final rect = box.localToGlobal(Offset.zero) & box.size;
        final visible = bounds.intersect(rect);
        if (visible.width > 0 &&
            visible.height >= (rect.height < 24 ? rect.height : 24)) {
          widget.messaging.markConversationDisplayed(widget.peer, message.id);
          break;
        }
      }
    });
  }

  @override
  void dispose() {
    messagingRouteObserver.unsubscribe(this);
    WidgetsBinding.instance.removeObserver(this);
    widget.provisioning?.removeListener(_discardUnavailableDraft);
    widget.messaging.stopTyping(widget.peer);
    _scroll.dispose();
    _text.dispose();
    super.dispose();
  }

  void _send() {
    if (_draftBytes != null) {
      _sendAttachment();
      return;
    }
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
    animation: Listenable.merge([
      widget.messaging,
      if (widget.provisioning != null) widget.provisioning!,
    ]),
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
      if (!_peerAllowed) {
        return Scaffold(
          appBar: AppBar(title: const Text('Messages')),
          body: const Center(
            child: Text('This conversation is unavailable for your account.'),
          ),
        );
      }
      final messages = widget.messaging.messages
          .where((m) => m.peer == widget.peer)
          .toList();
      _scheduleRead();
      final ids = messages.map((m) => m.id).toSet();
      _messageKeys.removeWhere((id, _) => !ids.contains(id));
      return Scaffold(
        appBar: AppBar(
          title: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(widget.messaging.contactLabel(widget.peer)),
              Text(
                widget.messaging.isTyping(widget.peer)
                    ? '${widget.messaging.contactLabel(widget.peer)} is typing…'
                    : widget.messaging.presenceFor(widget.peer).label,
                style: const TextStyle(fontSize: 12, color: Colors.white),
              ),
            ],
          ),
        ),
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
                  key: _viewport,
                  controller: _scroll,
                  reverse: true,
                  padding: const EdgeInsets.all(16),
                  itemCount: messages.length,
                  itemBuilder: (context, index) {
                    final message = messages[messages.length - 1 - index];
                    final colors = Theme.of(context).colorScheme;
                    return Align(
                      key: message.outgoing
                          ? ValueKey('out-${message.id}')
                          : _messageKeys.putIfAbsent(message.id, GlobalKey.new),
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
                            if (message.attachment != null)
                              TextButton.icon(
                                style: TextButton.styleFrom(
                                  foregroundColor: message.outgoing
                                      ? colors.onSecondary
                                      : colors.onSurface,
                                ),
                                onPressed:
                                    !_attachmentBusy &&
                                        widget
                                                .provisioning
                                                ?.attachmentsAvailable ==
                                            true
                                    ? () => _openAttachment(message.attachment!)
                                    : null,
                                icon: Icon(
                                  message.attachment!.isImage
                                      ? Icons.photo_outlined
                                      : Icons.insert_drive_file_outlined,
                                ),
                                label: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(
                                      message.attachment!.name,
                                      maxLines: 2,
                                      overflow: TextOverflow.ellipsis,
                                    ),
                                    Text(
                                      '${message.attachment!.sizeLabel} · ${message.attachment!.isImage ? 'View photo' : 'Save file'}',
                                      style: const TextStyle(fontSize: 11),
                                    ),
                                  ],
                                ),
                              ),
                            if (message.attachment == null ||
                                message.body != message.attachment!.summary)
                              Text(
                                message.body,
                                style: TextStyle(
                                  color: message.outgoing
                                      ? colors.onSecondary
                                      : colors.onSurface,
                                ),
                              ),
                            const SizedBox(height: 5),
                            Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Text(
                                  TimeOfDay.fromDateTime(
                                    message.timestamp,
                                  ).format(context),
                                  style: TextStyle(
                                    fontSize: 11,
                                    color: message.outgoing
                                        ? colors.onSecondary.withValues(
                                            alpha: 0.75,
                                          )
                                        : colors.onSurfaceVariant,
                                  ),
                                ),
                                if (message.outgoing) ...[
                                  const SizedBox(width: 6),
                                  _MessageStatusIcon(status: message.status),
                                ],
                              ],
                            ),
                          ],
                        ),
                      ),
                    );
                  },
                ),
              ),
              if (_attachmentBusy) ...[
                const LinearProgressIndicator(),
                Padding(
                  padding: const EdgeInsets.all(8),
                  child: Text(_attachmentActivity),
                ),
              ],
              if (_draftBytes != null &&
                  _attachmentOwnerAllowed(_draftOwner, _draftDevice))
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: Card(
                    child: ListTile(
                      leading: _draftPhoto
                          ? Image.memory(
                              _draftBytes!,
                              width: 48,
                              height: 48,
                              cacheWidth: 96,
                              fit: BoxFit.cover,
                              errorBuilder: (_, _, _) =>
                                  const Icon(Icons.photo_outlined),
                            )
                          : const Icon(Icons.insert_drive_file_outlined),
                      title: Text(
                        _draftName!,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      subtitle: const Text(
                        'Ready to send · add a caption below',
                      ),
                      trailing: IconButton(
                        tooltip: 'Remove selected attachment',
                        onPressed: _attachmentBusy
                            ? null
                            : () => setState(() {
                                _draftBytes = null;
                                _draftName = null;
                              }),
                        icon: const Icon(Icons.close),
                      ),
                    ),
                  ),
                ),
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 8, 12),
                child: Row(
                  children: [
                    if (widget.provisioning?.attachmentsAvailable == true)
                      PopupMenuButton<String>(
                        tooltip: 'Attach photo or file',
                        enabled: widget.messaging.online && !_attachmentBusy,
                        onSelected: _selectAttachment,
                        itemBuilder: (_) => [
                          if (defaultTargetPlatform == TargetPlatform.iOS ||
                              defaultTargetPlatform == TargetPlatform.android)
                            const PopupMenuItem(
                              value: 'camera',
                              child: Text('Take photo'),
                            ),
                          const PopupMenuItem(
                            value: 'photos',
                            child: Text('Choose photo'),
                          ),
                          const PopupMenuItem(
                            value: 'file',
                            child: Text('Choose file'),
                          ),
                        ],
                        icon: const Icon(Icons.attach_file),
                      ),
                    Expanded(
                      child: TextField(
                        controller: _text,
                        minLines: 1,
                        maxLines: 5,
                        enabled: widget.messaging.online && !_attachmentBusy,
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
                      onPressed: widget.messaging.online && !_attachmentBusy
                          ? _send
                          : null,
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
