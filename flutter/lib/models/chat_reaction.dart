import 'package:characters/characters.dart';

/// The most recent complete emoji set for one sender and one target message.
class ChatReaction {
  const ChatReaction({
    required this.peer,
    required this.target,
    required this.actor,
    required this.emojis,
    required this.timestamp,
  });
  static const namespace = 'urn:xmpp:reactions:0';
  static const choices = [
    '👍',
    '👎',
    '❤️',
    '😂',
    '🎉',
    '😮',
    '😢',
    '🙏',
    '✅',
    '👀',
    '🔥',
    '💯',
  ];
  final String peer, target, actor;
  final List<String> emojis;
  final DateTime timestamp;
  String get key => '$peer\u0000$target\u0000$actor';
  Map<String, dynamic> toJson() => {
    'peer': peer,
    'target': target,
    'actor': actor,
    'emojis': emojis,
    'timestamp': timestamp.toUtc().toIso8601String(),
  };
  static bool validEmoji(String emoji) {
    if (emoji.isEmpty || emoji.length > 32 || emoji.characters.length != 1) {
      return false;
    }
    bool base(int r) =>
        (r >= 0x1f000 && r <= 0x1faff) ||
        (r >= 0x2600 && r <= 0x27bf) ||
        (r >= 0x2194 && r <= 0x21ff) ||
        (r >= 0x2300 && r <= 0x23ff) ||
        (r >= 0x2b00 && r <= 0x2bff) ||
        [
          0xa9,
          0xae,
          0x203c,
          0x2049,
          0x2122,
          0x2139,
          0x3030,
          0x303d,
          0x3297,
          0x3299,
        ].contains(r);
    final runes = emoji.runes.toList();
    final keycap = runes.contains(0x20e3);
    return (runes.any(base) || keycap) &&
        runes.every(
          (r) =>
              base(r) ||
              [0x200d, 0xfe0e, 0xfe0f, 0x20e3].contains(r) ||
              (r >= 0xe0020 && r <= 0xe007f) ||
              (keycap && ((r >= 0x30 && r <= 0x39) || r == 0x23 || r == 0x2a)),
        );
  }

  static ChatReaction? parse(Object? json) {
    if (json is! Map ||
        json['peer'] is! String ||
        json['target'] is! String ||
        json['actor'] is! String ||
        json['emojis'] is! List) {
      return null;
    }
    final target = json['target'] as String;
    final time = DateTime.tryParse(json['timestamp']?.toString() ?? '');
    final emojis = (json['emojis'] as List)
        .whereType<String>()
        .toSet()
        .toList();
    if (target.isEmpty ||
        target.length > 256 ||
        time == null ||
        emojis.length > 12 ||
        emojis.any((e) => !validEmoji(e))) {
      return null;
    }
    return ChatReaction(
      peer: json['peer'],
      target: target,
      actor: json['actor'],
      emojis: emojis,
      timestamp: time,
    );
  }
}
