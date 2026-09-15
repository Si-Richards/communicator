import 'package:flutter_test/flutter_test.dart';
import 'package:voicehost_softphone/models/voicemail_summary.dart';

void main() {
  test('parses SIP message-summary MWI body', () {
    final summary = VoicemailSummary.parse('''
Messages-Waiting: yes
Message-Account: sip:160@example.invalid
Voice-Message: 2/7 (0/0)
''');

    expect(summary.waiting, isTrue);
    expect(summary.newMessages, 2);
    expect(summary.oldMessages, 7);
  });

  test('handles no waiting messages', () {
    final summary = VoicemailSummary.parse('''
Messages-Waiting: no
Voice-Message: 0/3 (0/0)
''');

    expect(summary.waiting, isFalse);
    expect(summary.newMessages, 0);
    expect(summary.oldMessages, 3);
  });
}
