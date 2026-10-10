import 'dart:async';

import 'package:flutter/material.dart';

import '../services/chat_gif_service.dart';

class ChatGifPicker extends StatefulWidget {
  const ChatGifPicker({super.key});
  @override
  State<ChatGifPicker> createState() => _ChatGifPickerState();
}

class _ChatGifPickerState extends State<ChatGifPicker> {
  final _service = ChatGifService();
  final _query = TextEditingController();
  List<ChatGif> _gifs = [];
  Timer? _debounce;
  int _generation = 0;
  bool _busy = true;
  String? _error;
  @override
  void initState() {
    super.initState();
    unawaited(_search());
  }

  Future<void> _search() async {
    final generation = ++_generation;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final results = await _service.search(_query.text);
      if (mounted && generation == _generation) {
        setState(() {
          _gifs = results;
        });
      }
    } catch (_) {
      if (mounted && generation == _generation) {
        setState(() {
          _error = 'Could not load GIFs. Please retry.';
        });
      }
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
    _debounce?.cancel();
    _query.dispose();
    _service.close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('Choose a GIF'),
    content: SizedBox(
      width: 440,
      height: 440,
      child: Column(
        children: [
          TextField(
            controller: _query,
            maxLength: 50,
            decoration: const InputDecoration(
              hintText: 'Search GIFs',
              prefixIcon: Icon(Icons.search),
              counterText: '',
            ),
            onChanged: (_) {
              // Invalidate old results immediately, not after the debounce expires.
              _generation++;
              setState(() {
                _busy = true;
              });
              _debounce?.cancel();
              _debounce = Timer(const Duration(milliseconds: 400), _search);
            },
            onSubmitted: (_) {
              _debounce?.cancel();
              unawaited(_search());
            },
          ),
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 8),
            child: Text('Powered By GIPHY', style: TextStyle(fontSize: 12)),
          ),
          Expanded(
            child: _busy
                ? const Center(child: CircularProgressIndicator())
                : _error != null
                ? Center(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(_error!),
                        TextButton(
                          onPressed: _search,
                          child: const Text('Retry'),
                        ),
                      ],
                    ),
                  )
                : _gifs.isEmpty
                ? const Center(child: Text('No matching GIFs.'))
                : GridView.builder(
                    gridDelegate:
                        const SliverGridDelegateWithFixedCrossAxisCount(
                          crossAxisCount: 2,
                          mainAxisSpacing: 8,
                          crossAxisSpacing: 8,
                        ),
                    itemCount: _gifs.length,
                    itemBuilder: (context, index) {
                      final gif = _gifs[index];
                      return Semantics(
                        button: true,
                        label: gif.title,
                        child: InkWell(
                          onTap: () => Navigator.pop(context, gif),
                          child: Image.network(
                            gif.previewUrl.toString(),
                            fit: BoxFit.cover,
                            cacheWidth: 320,
                            errorBuilder: (_, _, _) =>
                                const Icon(Icons.broken_image_outlined),
                          ),
                        ),
                      );
                    },
                  ),
          ),
        ],
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('Cancel'),
      ),
    ],
  );
}
