import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:xml/xml.dart';
import 'package:voicehost_softphone/models/chat_text_format.dart';
import 'package:voicehost_softphone/models/chat_message.dart';
import 'package:voicehost_softphone/models/chat_gif_reference.dart';
import 'package:voicehost_softphone/models/chat_reaction.dart';
import 'package:voicehost_softphone/services/chat_gif_service.dart';
import 'package:voicehost_softphone/services/chat_history_repository.dart';
import 'package:voicehost_softphone/ui/chat_rich_text.dart';

void main() {
  test('XHTML formatting round-trips escaped text and overlapping styles', () {
    const body = 'Hello & <team>\nGoodbye';
    const formats = [ChatTextFormat(0, 5, 1), ChatTextFormat(8, 14, 15)];
    final html = ChatTextFormat.encode(body, formats)!;
    final message = XmlDocument.parse(
      '<message>${html.toXmlString()}</message>',
    ).rootElement;
    expect(
      ChatTextFormat.decode(message, body).map((r) => r.toJson()),
      formats.map((r) => r.toJson()),
    );
  });
  test('untrusted XHTML cannot substitute text or load remote images', () {
    for (final content in [
      '<span>Different text</span>',
      '<img src="https://example.com/tracker"/>',
      '<script>hello</script>',
    ]) {
      final message = XmlDocument.parse(
        '<message><html xmlns="${ChatTextFormat.htmlNamespace}">'
        '<body xmlns="${ChatTextFormat.xhtmlNamespace}">$content</body></html></message>',
      ).rootElement;
      expect(ChatTextFormat.decode(message, 'hello'), isEmpty);
    }
  });
  test('invalid formatting metadata falls back to plain text', () {
    expect(
      ChatTextFormat.parse([
        {'start': -1, 'end': 3, 'style': 1},
      ], 'abc'),
      isEmpty,
    );
    expect(
      ChatTextFormat.parse([
        {'start': 0, 'end': 5, 'style': 1},
      ], 'abc'),
      isEmpty,
    );
    expect(
      () => ChatTextFormat.encode('abc', [const ChatTextFormat(0, 5, 1)]),
      throwsArgumentError,
    );
  });
  test(
    'visual editor preserves styles through insertion, selection and deletion',
    () {
      final c = ChatRichTextController();
      addTearDown(c.dispose);
      c.value = const TextEditingValue(
        text: 'Hello world',
        selection: TextSelection(baseOffset: 0, extentOffset: 5),
      );
      c.toggle(ChatTextFormat.bold);
      expect(c.formatting.single.toJson(), {'start': 0, 'end': 5, 'style': 1});
      c.selection = const TextSelection.collapsed(offset: 5);
      c.value = const TextEditingValue(
        text: 'Hello! world',
        selection: TextSelection.collapsed(offset: 6),
      );
      expect(c.formatting.single.end, 6);
      c.selection = const TextSelection(baseOffset: 0, extentOffset: 6);
      c.toggle(ChatTextFormat.italic);
      expect(c.formatting.single.style, 3);
      c.value = const TextEditingValue(
        text: 'Hi world',
        selection: TextSelection.collapsed(offset: 2),
      );
      expect(c.formatting.single.end, 2);
      c.clear();
      expect(c.formatting, isEmpty);
      expect(c.activeStyle, 0);
    },
  );
  test(
    'typing style controls and clear formatting operate without a selection',
    () {
      final c = ChatRichTextController();
      addTearDown(c.dispose);
      c.toggle(ChatTextFormat.underline);
      c.value = const TextEditingValue(
        text: 'a',
        selection: TextSelection.collapsed(offset: 1),
      );
      expect(c.formatting.single.style, ChatTextFormat.underline);
      c.toggle(ChatTextFormat.underline);
      c.value = const TextEditingValue(
        text: 'ab',
        selection: TextSelection.collapsed(offset: 2),
      );
      expect(c.formatting.single.end, 1);
      c.clearFormatting();
      expect(c.formatting, isEmpty);
    },
  );
  test('encrypted cache snapshot retains formatting and reaction removals', () {
    final m = ChatMessage(
      id: 'one',
      peer: '10000*208@ejabberd.voicehost.io',
      body: 'Hello',
      outgoing: false,
      timestamp: DateTime.utc(2026),
      status: ChatMessageStatus.received,
      formatting: [const ChatTextFormat(0, 5, 1)],
    );
    final r = ChatReaction(
      peer: m.peer,
      target: m.id,
      actor: m.peer,
      emojis: const [],
      timestamp: DateTime.utc(2026),
    );
    final restored = ChatHistorySnapshot.fromJson(
      jsonDecode(
        jsonEncode(
          ChatHistorySnapshot(messages: [m], reactionUpdates: [r]).toJson(),
        ),
      ),
    );
    expect(restored.messages.single.formatting.single.style, 1);
    expect(restored.reactionUpdates.single.emojis, isEmpty);
    final legacy = ChatMessage.fromJson(m.toJson()..remove('formatting'));
    expect(legacy.formatting, isEmpty);
  });
  test(
    'GIPHY search and trending use a configured key and preserve media URLs',
    () async {
      final requests = <http.Request>[];
      final service = ChatGifService(
        apiKey: 'test-key',
        client: MockClient((request) async {
          requests.add(request);
          expect(request.url.host, 'api.giphy.com');
          expect(request.url.queryParameters['api_key'], 'test-key');
          expect(request.url.queryParameters['rating'], 'g');
          return http.Response(
            jsonEncode({
              'data': [
                for (final url in [
                  'https://media0.giphy.com/media/one/200.gif?cid=provider',
                  'https://example.com/tracker.gif',
                  'http://media.giphy.com/test.gif',
                  'https://media.giphy.com:444/test.gif',
                  'https://media.giphy.com.evil.example/test.gif',
                ])
                  {
                    'id': 'one',
                    'title': 'Happy',
                    'images': {
                      'fixed_height': {'url': url},
                    },
                  },
              ],
            }),
            200,
          );
        }),
      );
      addTearDown(service.close);
      final results = await service.search('happy & hello');
      expect(results.length, 1);
      expect(results.single.url.query, 'cid=provider');
      expect(requests.single.url.path, '/v1/gifs/search');
      expect(requests.single.url.queryParameters['q'], 'happy & hello');
      await service.search('');
      expect(requests.last.url.path, '/v1/gifs/trending');
      await expectLater(service.search('a' * 51), throwsArgumentError);
    },
  );
  test(
    'GIPHY messages store only provider IDs and resolve them through GIPHY',
    () async {
      const ref = ChatGifReference('One123');
      final message = XmlDocument.parse(
        '<message>${ref.encode().toXmlString()}</message>',
      ).rootElement;
      expect(ChatGifReference.decode(message)!.id, ref.id);
      for (final id in ['../account', 'https://tracker.example', 'a' * 129]) {
        expect(ChatGifReference.parse(id), isNull);
      }
      expect(
        ChatGifReference.decode(
          XmlDocument.parse(
            '<message><gif xmlns="urn:voicehost:gif:1" provider="other" id="One123"/></message>',
          ).rootElement,
        ),
        isNull,
      );
      final requests = <http.Request>[];
      final service = ChatGifService(
        apiKey: 'key',
        client: MockClient((request) async {
          requests.add(request);
          return http.Response(
            jsonEncode({
              'data': {
                'id': 'One123',
                'images': {
                  'fixed_height': {
                    'url': 'https://media.giphy.com/media/One123/200.gif',
                  },
                },
              },
            }),
            200,
          );
        }),
      );
      addTearDown(service.close);
      expect((await service.resolve(ref)).id, 'One123');
      expect(requests.single.url.path, '/v1/gifs/One123');
      final m = ChatMessage(
        id: 'gif',
        peer: '10000*208@ejabberd.voicehost.io',
        body: 'GIF · GIPHY',
        outgoing: true,
        timestamp: DateTime.utc(2026),
        status: ChatMessageStatus.sent,
        gif: ref,
      );
      expect(ChatMessage.fromJson(m.toJson()).gif!.id, 'One123');
      expect(jsonEncode(m.toJson()), isNot(contains('https://')));
      expect(
        ChatGifService.isGif(ascii.encode('GIF89a-local-animation')),
        isTrue,
      );
      expect(ChatGifService.isGif(ascii.encode('Not a GIF')), isFalse);
    },
  );
  testWidgets(
    'formatting toolbar fits narrow screens and shows selected styles',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(320, 568));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final c = ChatRichTextController();
      addTearDown(c.dispose);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Column(
              children: [
                ChatFormattingToolbar(controller: c, enabled: true),
                TextField(controller: c),
              ],
            ),
          ),
        ),
      );
      await tester.enterText(find.byType(TextField), 'Hello');
      c.selection = const TextSelection(baseOffset: 0, extentOffset: 5);
      await tester.tap(find.byTooltip('Bold'));
      await tester.pump();
      expect(c.formatting.single.style, ChatTextFormat.bold);
      expect(tester.takeException(), isNull);
    },
  );
}
