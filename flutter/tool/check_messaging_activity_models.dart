// Run with: dart --enable-asserts tool/check_messaging_activity_models.dart
import 'dart:io';

import 'package:voicehost_softphone/models/chat_message.dart';
import 'package:voicehost_softphone/models/messaging_presence.dart';

void main() {
  ChatMessage message({bool outgoing = true}) => ChatMessage(
    id: 'one',
    peer: '10000*230@ejabberd.voicehost.io',
    body: 'test',
    outgoing: outgoing,
    timestamp: DateTime.utc(2026),
    status: outgoing ? ChatMessageStatus.sent : ChatMessageStatus.received,
  );
  final sent = message();
  assert(sent.advanceStatus(ChatMessageStatus.delivered));
  assert(!sent.advanceStatus(ChatMessageStatus.failed));
  assert(sent.advanceStatus(ChatMessageStatus.read));
  assert(!sent.advanceStatus(ChatMessageStatus.delivered));
  assert(!sent.advanceStatus(ChatMessageStatus.failed));
  assert(!sent.advanceStatus(ChatMessageStatus.sent));
  final incoming = message(outgoing: false);
  assert(!incoming.advanceStatus(ChatMessageStatus.read));
  final failed = message();
  assert(failed.advanceStatus(ChatMessageStatus.failed));
  assert(failed.advanceStatus(ChatMessageStatus.delivered));
  final restored = ChatMessage.fromJson(sent.toJson());
  assert(restored.status == ChatMessageStatus.read);
  assert(!restored.displayed && !restored.markable);
  incoming.displayed = true;
  incoming.markable = true;
  final read = ChatMessage.fromJson(incoming.toJson());
  assert(read.displayed && read.markable);
  final legacy = Map<String, dynamic>.from(incoming.toJson())
    ..remove('displayed')
    ..remove('markable');
  assert(!ChatMessage.fromJson(legacy).displayed);
  assert(!ChatMessage.fromJson(legacy).markable);
  assert(aggregatePresence([]) == MessagingPresence.offline);
  assert(
    aggregatePresence([MessagingPresence.away, MessagingPresence.busy]) ==
        MessagingPresence.busy,
  );
  assert(
    aggregatePresence([MessagingPresence.available, MessagingPresence.busy]) ==
        MessagingPresence.available,
  );
  assert(aggregatePresence([MessagingPresence.away]) == MessagingPresence.away);
  assert(MessagingPresence.unknown.label == 'Status unavailable');
  const update = ChatMessageUpdate(
    '10000*230@ejabberd.voicehost.io',
    'one',
    outgoing: true,
    displayed: true,
  );
  final restoredUpdate = ChatMessageUpdate.fromJson(update.toJson());
  assert(restoredUpdate.peer == update.peer && restoredUpdate.id == update.id);
  assert(restoredUpdate.outgoing && restoredUpdate.displayed);
  stdout.writeln('Messaging activity model checks passed.');
}
