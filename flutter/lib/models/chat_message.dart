enum ChatMessageStatus { received, sent, delivered, failed }

class ChatMessage {
  ChatMessage({
    required this.id,
    required this.peer,
    required this.body,
    required this.outgoing,
    required this.timestamp,
    required this.status,
    this.archiveId,
  });

  final String id;
  final String peer;
  final String body;
  final bool outgoing;
  final DateTime timestamp;
  ChatMessageStatus status;
  String? archiveId;

  Map<String, dynamic> toJson() => {
    'id': id,
    'peer': peer,
    'body': body,
    'outgoing': outgoing,
    'timestamp': timestamp.toUtc().toIso8601String(),
    'status': status.name,
    if (archiveId != null) 'archive_id': archiveId,
  };

  factory ChatMessage.fromJson(Map<String, dynamic> json) => ChatMessage(
    id: json['id'] as String,
    peer: json['peer'] as String,
    body: json['body'] as String,
    outgoing: json['outgoing'] as bool,
    timestamp: DateTime.parse(json['timestamp'] as String).toLocal(),
    status: ChatMessageStatus.values.byName(json['status'] as String),
    archiveId: json['archive_id'] as String?,
  );
}
