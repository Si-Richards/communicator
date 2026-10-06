enum ChatMessageStatus { received, sent, delivered, failed }

class ChatMessage {
  ChatMessage({
    required this.id,
    required this.peer,
    required this.body,
    required this.outgoing,
    required this.timestamp,
    required this.status,
  });

  final String id;
  final String peer;
  final String body;
  final bool outgoing;
  final DateTime timestamp;
  ChatMessageStatus status;
}
