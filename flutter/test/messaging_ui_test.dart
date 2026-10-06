import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:voicehost_softphone/services/xmpp_service.dart';
import 'package:voicehost_softphone/ui/messaging_diagnostics_screen.dart';

void main() {
  testWidgets('provisioning lock hides test inputs and unlock restores them', (
    tester,
  ) async {
    final service = XmppService();
    await tester.binding.setSurfaceSize(const Size(320, 568));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(home: MessagingDiagnosticsScreen(messaging: service)),
    );
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
    expect(find.text('Test username'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    service.dispose();
  });
}
