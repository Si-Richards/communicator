import 'chat_attachment.dart';
import 'chat_text_format.dart';
import 'chat_gif_reference.dart';

enum ChatMessageStatus { received, sent, delivered, read, failed }

/// Archived status metadata can precede its message in a backwards page.
class ChatMessageUpdate {
  const ChatMessageUpdate(
    this.peer,
    this.id, {
    required this.outgoing,
    this.displayed = false,
  });
  final String peer;
  final String id;
  final bool outgoing;
  final bool displayed;
  Map<String, dynamic> toJson() => {
    'peer': peer,
    'id': id,
    'outgoing': outgoing,
    'displayed': displayed,
  };
  factory ChatMessageUpdate.fromJson(Map<String, dynamic> json) =>
      ChatMessageUpdate(
        json['peer'] as String,
        json['id'] as String,
        outgoing: json['outgoing'] == true,
        displayed: json['displayed'] == true,
      );
}

class ChatMessage {
  ChatMessage({
    required this.id,
    required this.peer,
    required this.body,
    required this.outgoing,
    required this.timestamp,
    required this.status,
    this.archiveId,
    this.markable = false,
    this.displayed = false,
    this.attachment,
    this.gif,
    this.senderJid,
    this.formatting = const [],
    Set<String>? readBy,
  }) : readBy = readBy ?? <String>{};

  final String? senderJid;
  final Set<String> readBy;
  final String id;
  String get key => senderJid == null ? id : "$senderJid|$id";
  final String peer;
  final String body;
  final List<ChatTextFormat> formatting;
  final bool outgoing;
  final DateTime timestamp;
  final ChatAttachment? attachment;
  final ChatGifReference? gif;
  ChatMessageStatus status;
  String? archiveId;
  bool markable;
  bool displayed;

  /// Late receipts and transport errors must never undo a read confirmation.
  bool advanceStatus(ChatMessageStatus next) {
    if (!outgoing || status == next || status == ChatMessageStatus.read) {
      return false;
    }
    if (next == ChatMessageStatus.received ||
        next == ChatMessageStatus.sent ||
        (next == ChatMessageStatus.failed &&
            status == ChatMessageStatus.delivered)) {
      return false;
    }
    status = next;
    return true;
  }

  Map<String, dynamic> toJson() => {
    'id': id,
    'peer': peer,
    if (senderJid != null) 'sender_jid': senderJid,
    if (readBy.isNotEmpty) 'read_by': readBy.toList(),
    'body': body,
    if (formatting.isNotEmpty)
      'formatting': formatting.map((r) => r.toJson()).toList(),
    'outgoing': outgoing,
    'timestamp': timestamp.toUtc().toIso8601String(),
    'status': status.name,
    if (archiveId != null) 'archive_id': archiveId,
    'markable': markable,
    'displayed': displayed,
    if (attachment != null) 'attachment': attachment!.toJson(),
    if (gif != null) 'giphy_id': gif!.id,
  };

  factory ChatMessage.fromJson(Map<String, dynamic> json) => ChatMessage(
    id: json['id'] as String,
    peer: json['peer'] as String,
    body: json['body'] as String,
    formatting: ChatTextFormat.parse(
      json['formatting'],
      json['body'] as String,
    ),
    outgoing: json['outgoing'] as bool,
    timestamp: DateTime.parse(json['timestamp'] as String).toLocal(),
    status: ChatMessageStatus.values.byName(json['status'] as String),
    archiveId: json['archive_id'] as String?,
    markable: json['markable'] == true,
    displayed: json['displayed'] == true,
    attachment: ChatAttachment.tryFromJson(json['attachment']),
    gif: ChatGifReference.parse(json['giphy_id']),
    senderJid: json['sender_jid'] as String?,
    readBy: (json['read_by'] as List?)?.whereType<String>().toSet(),
  );
}
