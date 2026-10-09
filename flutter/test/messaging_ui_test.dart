import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:voicehost_softphone/services/xmpp_service.dart';
import 'package:voicehost_softphone/models/messaging_contact.dart';
import 'package:voicehost_softphone/ui/messages_screen.dart';
import 'package:voicehost_softphone/ui/messaging_diagnostics_screen.dart';

void main() {
  testWidgets(
    'directory searches extensions and opens a contact without exposing its JID',
    (tester) async {
      final service = _DirectoryService();
      await tester.pumpWidget(
        MaterialApp(home: MessagesScreen(messaging: service)),
      );
      await tester.tap(find.text('Directory'));
      await tester.pumpAndSettle();
      expect(find.text('Reception'), findsOneWidget);
      expect(find.text('Extension 208'), findsOneWidget);
      expect(find.textContaining('10000*'), findsNothing);
      await tester.enterText(find.byType(TextField), '208');
      await tester.pump();
      await tester.tap(find.text('Reception'));
      await tester.pumpAndSettle();
      expect(find.text('Reception · 208'), findsOneWidget);
      expect(find.textContaining('ejabberd.voicehost.io'), findsNothing);
      await tester.pumpWidget(const SizedBox.shrink());
      service.dispose();
    },
  );
  testWidgets('provisioning lock hides test inputs and unlock restores them', (
    tester,
  ) async {
    final service = XmppService();
    await tester.binding.setSurfaceSize(const Size(320, 568));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(home: MessagingDiagnosticsScreen(messaging: service)),
    );
    await tester.scrollUntilVisible(find.text('Test username'), 200);
    expect(find.text('Test username'), findsOneWidget);
    expect(tester.takeException(), isNull);
    service.setAccessAllowed(false);
    await tester.pump();
    expect(
      find.text('App locked. Please contact your administrator.'),
      findsOneWidget,
    );
    expect(find.text('Test username'), findsNothing);
    service.setAccessAllowed(true);
    await tester.pump();
    await tester.scrollUntilVisible(find.text('Test username'), 200);
    expect(find.text('Test username'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    service.dispose();
  });
}

class _DirectoryService extends XmppService {
  @override
  bool get online => true;
  @override
  bool get managedEnabled => true;
  @override
  List<MessagingContact> get directory => const [
    MessagingContact(
      jid: '10000*208@ejabberd.voicehost.io',
      extension: '208',
      name: 'Reception',
    ),
  ];
  @override
  String contactLabel(String jid) => 'Reception · 208';
}
