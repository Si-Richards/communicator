import 'dart:async';

import 'package:flutter/material.dart';

import '../models/chat_gif_reference.dart';
import '../services/chat_gif_service.dart';

/// Resolve a trusted provider ID, then load GIPHY media directly on this device.
class ChatGiphyMessage extends StatefulWidget {
  const ChatGiphyMessage({super.key, required this.reference});
  final ChatGifReference reference;
  @override
  State<ChatGiphyMessage> createState() => _ChatGiphyMessageState();
}

class _ChatGiphyMessageState extends State<ChatGiphyMessage> {
  final _service = ChatGifService();
  ChatGif? _gif;
  bool _busy = true;
  int _generation = 0;
  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  @override
  void didUpdateWidget(covariant ChatGiphyMessage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.reference.id != widget.reference.id) unawaited(_load());
  }

  Future<void> _load() async {
    final generation = ++_generation;
    setState(() {
      _gif = null;
      _busy = true;
    });
    try {
      final gif = await _service.resolve(widget.reference);
      if (mounted && generation == _generation) setState(() => _gif = gif);
    } catch (_) {
      /* Show the retry affordance without logging keys/media URLs. */
    } finally {
      if (mounted && generation == _generation) setState(() => _busy = false);
    }
  }

  @override
  void dispose() {
    _service.close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      SizedBox(
        width: 220,
        height: 160,
        child: _busy
            ? const Center(child: CircularProgressIndicator())
            : _gif == null
            ? Center(
                child: TextButton.icon(
                  onPressed: _service.available ? _load : null,
                  icon: const Icon(Icons.refresh),
                  label: const Text('GIF unavailable'),
                ),
              )
            : Image.network(
                _gif!.url.toString(),
                fit: BoxFit.contain,
                cacheWidth: 440,
                errorBuilder: (_, _, _) => TextButton(
                  onPressed: _load,
                  child: const Text('Retry GIF'),
                ),
              ),
      ),
      const Text('Powered By GIPHY', style: TextStyle(fontSize: 11)),
    ],
  );
}
