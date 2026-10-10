import 'dart:typed_data';

import 'package:flutter/material.dart';

import '../controllers/provisioning_controller.dart';
import '../models/chat_attachment.dart';

/// Only authenticated first-party attachment bytes are displayed in a chat.
class ChatGifMessage extends StatefulWidget {
  const ChatGifMessage({
    super.key,
    required this.provisioning,
    required this.peer,
    required this.attachment,
  });
  final ProvisioningController provisioning;
  final String peer;
  final ChatAttachment attachment;
  @override
  State<ChatGifMessage> createState() => _ChatGifMessageState();
}

class _ChatGifMessageState extends State<ChatGifMessage> {
  Uint8List? _bytes;
  String? _owner, _device;
  bool _busy = false;
  int _generation = 0;
  bool get _allowed =>
      widget.provisioning.attachmentsAvailable &&
      widget.provisioning.configuration?.messaging?.jid == _owner &&
      widget.provisioning.deviceId == _device;
  @override
  void initState() {
    super.initState();
    widget.provisioning.addListener(_accessChanged);
    _load();
  }

  void _accessChanged() {
    if (!_allowed && mounted) {
      _generation++;
      setState(() {
        _bytes = null;
        _busy = false;
      });
    }
  }

  @override
  void didUpdateWidget(covariant ChatGifMessage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.provisioning != widget.provisioning ||
        oldWidget.peer != widget.peer ||
        oldWidget.attachment.id != widget.attachment.id) {
      oldWidget.provisioning.removeListener(_accessChanged);
      widget.provisioning.addListener(_accessChanged);
      _bytes = null;
      _load();
    }
  }

  Future<void> _load() async {
    final generation = ++_generation;
    final owner = widget.provisioning.configuration?.messaging?.jid;
    final device = widget.provisioning.deviceId;
    _owner = owner;
    _device = device;
    if (owner == null || !_allowed) return;
    setState(() {
      _busy = true;
    });
    try {
      final bytes = await widget.provisioning.downloadMessagingAttachment(
        peer: widget.peer,
        attachment: widget.attachment,
      );
      if (mounted && generation == _generation && _allowed) {
        setState(() {
          _bytes = bytes;
        });
      }
    } catch (_) {
      /* Offer a manual retry without logging message data. */
    } finally {
      if (mounted && generation == _generation) {
        setState(() {
          _busy = false;
        });
      }
    }
  }

  @override
  void dispose() {
    _generation++;
    widget.provisioning.removeListener(_accessChanged);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => _bytes != null && _allowed
      ? ClipRRect(
          borderRadius: BorderRadius.circular(8),
          child: Image.memory(
            _bytes!,
            width: 220,
            height: 160,
            fit: BoxFit.contain,
            cacheWidth: 440,
            gaplessPlayback: true,
            semanticLabel: 'Animated GIF',
            errorBuilder: (_, _, _) => const Text('GIF preview unavailable.'),
          ),
        )
      : _busy
      ? const SizedBox(
          height: 80,
          child: Center(child: CircularProgressIndicator()),
        )
      : TextButton.icon(
          onPressed: widget.provisioning.attachmentsAvailable ? _load : null,
          icon: const Icon(Icons.gif_box_outlined),
          label: const Text('Load GIF'),
        );
}
