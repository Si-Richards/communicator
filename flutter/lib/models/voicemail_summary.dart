class VoicemailSummary {
  const VoicemailSummary({
    required this.waiting,
    required this.newMessages,
    required this.oldMessages,
  });

  const VoicemailSummary.empty()
      : waiting = false,
        newMessages = 0,
        oldMessages = 0;

  final bool waiting;
  final int newMessages;
  final int oldMessages;

  factory VoicemailSummary.parse(String content) {
    var waiting = false;
    var newMessages = 0;
    var oldMessages = 0;

    for (final rawLine in content.split(RegExp(r'\r?\n'))) {
      final line = rawLine.trim();
      final lower = line.toLowerCase();
      if (lower.startsWith('messages-waiting:')) {
        waiting = lower.split(':').skip(1).join(':').trim() == 'yes';
      }
      final match = RegExp(
        r'^voice-message:\s*(\d+)\s*/\s*(\d+)',
        caseSensitive: false,
      ).firstMatch(line);
      if (match != null) {
        newMessages = int.tryParse(match.group(1) ?? '') ?? 0;
        oldMessages = int.tryParse(match.group(2) ?? '') ?? 0;
      }
    }

    return VoicemailSummary(
      waiting: waiting || newMessages > 0,
      newMessages: newMessages,
      oldMessages: oldMessages,
    );
  }
}
