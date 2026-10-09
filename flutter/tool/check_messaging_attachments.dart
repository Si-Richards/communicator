import 'dart:convert';
import 'dart:io';

import 'package:voicehost_softphone/models/chat_attachment.dart';
import 'package:voicehost_softphone/models/chat_message.dart';
import 'package:voicehost_softphone/services/attachment_bytes.dart';

Future<void> main() async {
  final attachment = ChatAttachment(
    id: 'a' * 64,
    name: 'photo.png',
    mediaType: 'image/png',
    size: 3,
    sha256: 'b' * 64,
  );
  final message = ChatMessage(
    id: 'message',
    peer: '10000*230@ejabberd.voicehost.io',
    body: attachment.summary,
    outgoing: true,
    timestamp: DateTime.now(),
    status: ChatMessageStatus.sent,
    attachment: attachment,
  );
  final saved =
      jsonDecode(jsonEncode(message.toJson())) as Map<String, dynamic>;
  final restored = ChatMessage.fromJson(saved);
  assert(restored.attachment!.id == attachment.id);
  assert(restored.attachment!.sha256 == attachment.sha256);
  assert(restored.attachment!.isImage);
  assert(restored.attachment!.sizeLabel == '1 KB');
  assert(!jsonEncode(saved).contains('https://'));
  final old = Map<String, dynamic>.from(saved)..remove('attachment');
  assert(ChatMessage.fromJson(old).attachment == null);
  for (final bad in [
    {'id': 'https://outside.example/file'},
    {'name': '../file'},
    {'name': 'line\nfeed'},
    {'media_type': 'image/svg+xml'},
    {'size': 0},
    {'size': ChatAttachment.maxBytes + 1},
    {'sha256': 'invalid'},
  ]) {
    assert(
      ChatAttachment.tryFromJson({...attachment.toJson(), ...bad}) == null,
    );
  }
  final bytes = await readAttachmentBytes(
    Stream.fromIterable([
      [1],
      [2, 3],
    ]),
  );
  assert(bytes.length == 3 && bytes[2] == 3);
  for (final stream in [
    Stream<List<int>>.empty(),
    Stream.value(List<int>.filled(ChatAttachment.maxBytes + 1, 0)),
  ]) {
    var rejected = false;
    try {
      await readAttachmentBytes(stream);
    } on ArgumentError {
      rejected = true;
    }
    assert(rejected);
  }
  stdout.writeln(
    'Attachment metadata, history compatibility and bounded reads passed.',
  );
}
