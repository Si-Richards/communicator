import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models/chat_gif_reference.dart';
import 'attachment_bytes.dart';

class ChatGif {
  const ChatGif({
    required this.id,
    required this.title,
    required this.url,
    required this.previewUrl,
  });
  final String id, title;
  final Uri url, previewUrl;
  ChatGifReference get reference => ChatGifReference(id);
}

/// GIPHY media loads directly on the device; no provider bytes/URLs are stored.
class ChatGifService {
  ChatGifService({http.Client? client, this.apiKey = configuredKey})
    : _client = client ?? http.Client();
  static const configuredKey = String.fromEnvironment('GIPHY_API_KEY');
  final String apiKey;
  final http.Client _client;
  bool get available => apiKey.trim().isNotEmpty;
  void close() => _client.close();

  static bool isGif(List<int> bytes) =>
      bytes.length >= 6 &&
      [
        'GIF87a',
        'GIF89a',
      ].contains(ascii.decode(bytes.take(6).toList(), allowInvalid: true));

  static Uri? mediaUri(Object? value) {
    if (value is! String) return null;
    final uri = Uri.tryParse(value);
    return uri != null &&
            uri.scheme == 'https' &&
            uri.userInfo.isEmpty &&
            !uri.hasPort &&
            RegExp(r'^media[0-9]*\.giphy\.com$').hasMatch(uri.host)
        ? uri
        : null;
  }

  ChatGif? _parse(Object? item) {
    if (item is! Map ||
        !ChatGifReference.validId(item['id']) ||
        item['images'] is! Map) {
      return null;
    }
    final images = item['images'] as Map;
    final rendition = images['fixed_height'];
    if (rendition is! Map) return null;
    final url = mediaUri(rendition['url']);
    final preview = images['fixed_height_small'];
    final previewUrl = preview is Map ? mediaUri(preview['url']) : null;
    if (url == null) return null;
    return ChatGif(
      id: item['id'],
      title: item['title'] is String ? item['title'] : 'GIF',
      url: url,
      previewUrl: previewUrl ?? url,
    );
  }

  Future<Map<String, dynamic>> _request(
    String path, {
    Map<String, String> parameters = const {},
  }) async {
    if (!available) throw StateError('GIF search is not configured.');
    final response = await _client
        .send(
          http.Request(
            'GET',
            Uri.https('api.giphy.com', path, {
              'api_key': apiKey,
              'rating': 'g',
              ...parameters,
            }),
          )..followRedirects = false,
        )
        .timeout(const Duration(seconds: 15));
    if (response.statusCode == 429) {
      throw StateError('GIPHY request limit reached. Please retry later.');
    }
    if (response.statusCode != 200) throw StateError('GIPHY request failed.');
    final data = jsonDecode(
      utf8.decode(
        await readAttachmentBytes(response.stream, maxBytes: 1024 * 1024),
      ),
    );
    if (data is! Map<String, dynamic>) {
      throw const FormatException('Invalid GIPHY response.');
    }
    return data;
  }

  Future<List<ChatGif>> search(String query) async {
    if (query.length > 50) throw ArgumentError('Search up to 50 characters.');
    final data = await _request(
      '/v1/gifs/${query.trim().isEmpty ? 'trending' : 'search'}',
      parameters: {
        'limit': '24',
        'lang': 'en',
        if (query.trim().isNotEmpty) 'q': query,
      },
    );
    if (data['data'] is! List) {
      throw const FormatException('Invalid GIF search.');
    }
    return (data['data'] as List)
        .take(24)
        .map(_parse)
        .whereType<ChatGif>()
        .toList();
  }

  Future<ChatGif> resolve(ChatGifReference reference) async {
    if (!ChatGifReference.validId(reference.id)) {
      throw const FormatException('Invalid GIF identifier.');
    }
    final data = await _request('/v1/gifs/${reference.id}');
    final gif = _parse(data['data']);
    if (gif == null || gif.id != reference.id) {
      throw StateError('This GIF is no longer available.');
    }
    return gif;
  }
}
