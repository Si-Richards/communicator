import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import '../models/chat_attachment.dart';
import 'attachment_bytes.dart';

class ChatGif {
  const ChatGif({required this.id, required this.title, required this.url});
  final String id, title;
  final Uri url;
}

/// Provider content is copied to the authenticated attachment service on send.
/// Recipients never load tracking URLs from a chat message.
class ChatGifService {
  ChatGifService({http.Client? client, this.apiKey = configuredKey})
    : _client = client ?? http.Client();
  static const configuredKey = String.fromEnvironment('TENOR_API_KEY');
  final String apiKey;
  final http.Client _client;
  bool get available => apiKey.trim().isNotEmpty;
  void close() => _client.close();

  static bool isGif(List<int> bytes) =>
      bytes.length >= 6 &&
      (ascii.decode(bytes.take(6).toList(), allowInvalid: true) == 'GIF87a' ||
          ascii.decode(bytes.take(6).toList(), allowInvalid: true) == 'GIF89a');

  static Uri? _mediaUri(Object? value) {
    final uri = Uri.tryParse(value?.toString() ?? '');
    return uri != null &&
            uri.scheme == 'https' &&
            uri.userInfo.isEmpty &&
            !uri.hasPort &&
            ['media.tenor.com', 'media1.tenor.com'].contains(uri.host)
        ? uri
        : null;
  }

  Future<List<ChatGif>> search(String query) async {
    if (!available) throw StateError('GIF search is not configured.');
    final parameters = {
      'key': apiKey,
      'client_key': 'voicehost_communicator',
      'limit': '24',
      'media_filter': 'tinygif',
      'contentfilter': 'high',
      'locale': 'en_GB',
      'country': 'GB',
      if (query.trim().isNotEmpty) 'q': query.trim(),
    };
    final response = await _client
        .send(
          http.Request(
            'GET',
            Uri.https(
              'tenor.googleapis.com',
              '/v2/${query.trim().isEmpty ? 'featured' : 'search'}',
              parameters,
            ),
          )..followRedirects = false,
        )
        .timeout(const Duration(seconds: 15));
    if (response.statusCode != 200) throw StateError('GIF search failed.');
    final data = jsonDecode(
      utf8.decode(
        await readAttachmentBytes(response.stream, maxBytes: 1024 * 1024),
      ),
    );
    if (data is! Map || data['results'] is! List) {
      throw const FormatException('Invalid GIF search.');
    }
    final results = <ChatGif>[];
    for (final item in (data['results'] as List).take(24)) {
      if (item is! Map || item['media_formats'] is! Map) continue;
      final format = item['media_formats']['tinygif'];
      if (format is! Map || item['id'] is! String) continue;
      final url = _mediaUri(format['url']);
      final size = format['size'];
      if (url == null ||
          size is! int ||
          size < 1 ||
          size > ChatAttachment.maxBytes) {
        continue;
      }
      results.add(
        ChatGif(
          id: item['id'],
          title: item['content_description'] is String
              ? item['content_description']
              : 'GIF',
          url: url,
        ),
      );
    }
    return results;
  }

  Future<void> registerShare(ChatGif gif) async {
    if (!available) return;
    try {
      await _client
          .get(
            Uri.https('tenor.googleapis.com', '/v2/registershare', {
              'key': apiKey,
              'client_key': 'voicehost_communicator',
              'id': gif.id,
            }),
          )
          .timeout(const Duration(seconds: 5));
    } catch (_) {
      /* Provider statistics must never interrupt message delivery. */
    }
  }

  Future<Uint8List> download(ChatGif gif) async {
    if (_mediaUri(gif.url.toString()) == null) {
      throw const FormatException('Invalid GIF URL.');
    }
    final response = await _client
        .send(http.Request('GET', gif.url)..followRedirects = false)
        .timeout(const Duration(seconds: 15));
    if (response.statusCode != 200 ||
        (response.contentLength ?? 0) > ChatAttachment.maxBytes) {
      throw StateError('GIF download failed.');
    }
    final bytes = await readAttachmentBytes(response.stream);
    if (!isGif(bytes)) throw const FormatException('This file is not a GIF.');
    return bytes;
  }
}
