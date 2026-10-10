import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:xml/xml.dart';
import 'package:voicehost_softphone/models/chat_text_format.dart';
import 'package:voicehost_softphone/models/chat_message.dart';
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
    'Tenor search uses configured key and filters unsafe media URLs',
    () async {
      final service = ChatGifService(
        apiKey: 'test-key',
        client: MockClient((request) async {
          expect(request.url.host, 'tenor.googleapis.com');
          expect(request.url.path, '/v2/search');
          expect(request.url.queryParameters['q'], 'happy');
          expect(request.url.queryParameters['media_filter'], 'tinygif');
          return http.Response(
            jsonEncode({
              'results': [
                for (final url in [
                  'https://media.tenor.com/test/tenor.gif',
                  'https://example.com/tracker.gif',
                  'http://media.tenor.com/test.gif',
                  'https://media.tenor.com:444/test.gif',
                ])
                  {
                    'id': 'one',
                    'content_description': 'Happy',
                    'media_formats': {
                      'tinygif': {'url': url, 'size': 100},
                    },
                  },
              ],
            }),
            200,
          );
        }),
      );
      addTearDown(service.close);
      expect((await service.search('happy')).length, 1);
    },
  );
  test('GIF downloads preserve animation bytes and reject non-GIFs', () async {
    final gif = ChatGif(
      id: 'one',
      title: 'Happy',
      url: Uri.parse('https://media.tenor.com/test/tenor.gif'),
    );
    final bytes = Uint8List.fromList(ascii.encode('GIF89a-animation-data'));
    final service = ChatGifService(
      client: MockClient((_) async => http.Response.bytes(bytes, 200)),
    );
    addTearDown(service.close);
    expect(await service.download(gif), bytes);
    final bad = ChatGifService(
      client: MockClient((_) async => http.Response('Not a GIF', 200)),
    );
    addTearDown(bad.close);
    await expectLater(bad.download(gif), throwsFormatException);
  });
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
