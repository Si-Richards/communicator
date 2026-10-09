import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:voicehost_softphone/models/chat_message.dart';
import 'package:voicehost_softphone/models/provisioning.dart';
import 'package:voicehost_softphone/models/messaging_presence.dart';
import 'package:voicehost_softphone/services/chat_history_repository.dart';

void main() {
  test(
    'old caches default activity settings and new caches retain read metadata',
    () {
      final old = ChatHistorySnapshot.fromJson({'version': 1, 'messages': []});
      expect(old.shareTyping, isTrue);
      expect(old.shareReadReceipts, isTrue);
      expect(old.presence, MessagingPresence.available);
      final snapshot = ChatHistorySnapshot(
        shareTyping: false,
        shareReadReceipts: false,
        presence: MessagingPresence.busy,
        statusUpdates: [
          const ChatMessageUpdate(
            '208@ejabberd.voicehost.io',
            'read',
            outgoing: true,
            displayed: true,
          ),
        ],
        messages: [
          ChatMessage(
            id: 'read',
            peer: '208@ejabberd.voicehost.io',
            body: 'text',
            outgoing: true,
            timestamp: DateTime.utc(2026),
            status: ChatMessageStatus.read,
            markable: true,
            displayed: true,
          ),
        ],
      );
      final recovered = ChatHistorySnapshot.fromJson(snapshot.toJson());
      expect(recovered.shareTyping, isFalse);
      expect(recovered.shareReadReceipts, isFalse);
      expect(recovered.presence, MessagingPresence.busy);
      expect(recovered.messages.single.status, ChatMessageStatus.read);
      expect(recovered.messages.single.markable, isTrue);
      expect(recovered.messages.single.displayed, isTrue);
      expect(recovered.statusUpdates.single.id, 'read');
      expect(recovered.statusUpdates.single.displayed, isTrue);
    },
  );

  test(
    'history survives reopening, is encrypted and is isolated by account',
    () async {
      final root = await Directory.systemTemp.createTemp('encrypted-chat-test');
      addTearDown(() => root.delete(recursive: true));
      EncryptedChatHistoryRepository repository() =>
          EncryptedChatHistoryRepository(
            directory: () async => root,
            key: () async => List.filled(32, 7),
          );
      final history = ChatHistorySnapshot(
        cursor: 'archive-1',
        messages: [
          ChatMessage(
            id: 'message-1',
            peer: '208@ejabberd.voicehost.io',
            body: 'private message that must be encrypted',
            outgoing: true,
            timestamp: DateTime.utc(2026, 10, 7),
            status: ChatMessageStatus.delivered,
            archiveId: 'archive-1',
          ),
        ],
      );
      await repository().save('207|server-a', history);
      final files = await Directory(
        '${root.path}/message-cache',
      ).list().toList();
      final ciphertext = await (files.single as File).readAsString();
      expect(ciphertext, isNot(contains('private message')));
      expect(ciphertext, isNot(contains('208@')));
      final recovered = await repository().load('207|server-a');
      expect(recovered.messages.single.body, history.messages.single.body);
      expect(recovered.messages.single.status, ChatMessageStatus.delivered);
      expect(recovered.cursor, 'archive-1');
      expect((await repository().load('208|server-a')).messages, isEmpty);
      expect((await repository().load('207|server-b')).messages, isEmpty);
      await repository().save('207|server-a', history);
      expect(await (files.single as File).readAsString(), isNot(ciphertext));
      await repository().delete('207|server-a');
      expect((await repository().load('207|server-a')).messages, isEmpty);
    },
  );

  test('tampered ciphertext cannot be silently loaded', () async {
    final root = await Directory.systemTemp.createTemp('tampered-chat-test');
    addTearDown(() => root.delete(recursive: true));
    final repository = EncryptedChatHistoryRepository(
      directory: () async => root,
      key: () async => List.filled(32, 1),
    );
    await repository.save('account', ChatHistorySnapshot());
    final file =
        (await Directory('${root.path}/message-cache').list().toList()).single
            as File;
    final envelope = jsonDecode(await file.readAsString()) as Map;
    final bytes = base64Decode(envelope['ciphertext'] as String);
    bytes[0] ^= 1;
    envelope['ciphertext'] = base64Encode(bytes);
    await file.writeAsString(jsonEncode(envelope));
    await expectLater(repository.load('account'), throwsA(isA<Exception>()));
  });

  test('managed configuration round trips and rejects unsafe transports', () {
    Map<String, dynamic> config(String endpoint) => {
      'version': 2,
      'messaging': {
        'enabled': true,
        'jid': '207@ejabberd.voicehost.io',
        'password': 'dedicated-secret',
        'websocket': endpoint,
      },
    };
    final parsed = ProvisioningConfiguration.fromJson(
      config('wss://ejabberd.voicehost.io/websocket'),
    );
    expect(parsed.messaging!.configured, isTrue);
    expect(
      ProvisioningConfiguration.fromJson(parsed.toJson()).messaging!.password,
      'dedicated-secret',
    );
    for (final endpoint in [
      'ws://server/websocket',
      'wss://user:pass@server/websocket',
      'wss://server/websocket?secret=password',
    ]) {
      expect(
        ProvisioningConfiguration.fromJson(
          config(endpoint),
        ).messaging!.configured,
        isFalse,
      );
    }
    expect(
      ProvisioningConfiguration.fromJson({'version': 1}).messaging,
      isNull,
    );
  });
}
