import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:voicehost_softphone/models/chat_message.dart';
import 'package:voicehost_softphone/models/messaging_room.dart';
import 'package:voicehost_softphone/services/chat_history_repository.dart';
import 'package:voicehost_softphone/services/xmpp_service.dart';
import 'package:voicehost_softphone/ui/messages_screen.dart';

class _SearchService extends XmppService {
  _SearchService() : super(historyRepository: MemoryChatHistoryRepository());
  bool connected = false;
  @override
  bool get online => connected;
  Future<void> prepareFixture() async {
    pause();
    await connect(username: '10000*207', password: 'local-fixture-only');
    replaceRooms(fixtureRooms);
    connected = true;
  }

  @override
  List<ChatMessage> get messages => [
    for (final ext in ['208', '230'])
      ChatMessage(
        id: ext,
        peer: '10000*$ext@ejabberd.voicehost.io',
        body: ext == '208' ? 'Meeting tomorrow' : 'Invoice ready',
        outgoing: false,
        timestamp: DateTime.utc(2026),
        status: ChatMessageStatus.received,
      ),
  ];
  @override
  String contactLabel(String jid) =>
      jid.contains('208') ? 'Reception · 208' : 'Accounts · 230';
  List<MessagingRoom> get fixtureRooms => [
    MessagingRoom(
      jid: 'vh-${'a' * 32}@rooms.ejabberd.voicehost.io',
      name: 'Sales team',
      revision: 1,
      members: [
        const MessagingRoomMember(
          jid: '10000*207@ejabberd.voicehost.io',
          name: 'Simon',
          extension: '207',
          role: 'owner',
        ),
        const MessagingRoomMember(
          jid: '10000*208@ejabberd.voicehost.io',
          name: 'Reception',
          extension: '208',
          role: 'owner',
        ),
      ],
    ),
    MessagingRoom(
      jid: 'vh-${'b' * 32}@rooms.ejabberd.voicehost.io',
      name: 'Operations',
      revision: 1,
      members: [
        const MessagingRoomMember(
          jid: '10000*207@ejabberd.voicehost.io',
          name: 'Simon',
          extension: '207',
          role: 'owner',
        ),
        const MessagingRoomMember(
          jid: '10000*230@ejabberd.voicehost.io',
          name: 'Connor',
          extension: '230',
          role: 'owner',
        ),
      ],
    ),
  ];
}

void main() {
  testWidgets(
    'conversation search matches names, extensions, text and clears',
    (tester) async {
      final service = _SearchService();
      await service.prepareFixture();
      addTearDown(service.dispose);
      await tester.pumpWidget(
        MaterialApp(home: MessagesScreen(messaging: service)),
      );
      final search = find.widgetWithText(TextField, 'Search conversations');
      await tester.enterText(search, 'RECEPTION 208');
      await tester.pump();
      expect(find.text('Reception · 208'), findsOneWidget);
      expect(find.text('Accounts · 230'), findsNothing);
      await tester.enterText(search, 'invoice');
      await tester.pump();
      expect(find.text('Accounts · 230'), findsOneWidget);
      expect(find.text('Reception · 208'), findsNothing);
      await tester.enterText(search, 'unknown');
      await tester.pump();
      expect(find.text('No matching conversations.'), findsOneWidget);
      await tester.tap(find.byTooltip('Clear conversation search'));
      await tester.pump();
      expect(find.text('Accounts · 230'), findsOneWidget);
      expect(find.text('Reception · 208'), findsOneWidget);
    },
  );
  testWidgets('room search matches names and member names/extensions', (
    tester,
  ) async {
    final service = _SearchService();
    await service.prepareFixture();
    addTearDown(service.dispose);
    await tester.binding.setSurfaceSize(const Size(320, 568));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(home: MessagesScreen(messaging: service)),
    );
    await tester.tap(find.text('Rooms'));
    await tester.pumpAndSettle();
    final search = find.widgetWithText(TextField, 'Search rooms');
    await tester.enterText(search, 'CONNOR 230');
    await tester.pump();
    expect(find.text('Operations'), findsOneWidget);
    expect(find.text('Sales team'), findsNothing);
    await tester.enterText(search, 'sales');
    await tester.pump();
    expect(find.text('Sales team'), findsOneWidget);
    await tester.enterText(search, 'unknown');
    await tester.pump();
    expect(find.text('No matching rooms.'), findsOneWidget);
    await tester.tap(find.byTooltip('Clear room search'));
    await tester.pump();
    expect(find.text('Operations'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
