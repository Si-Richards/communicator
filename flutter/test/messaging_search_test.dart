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

  final items = <ChatMessage>[
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
  List<ChatMessage> get messages => items;
  @override
  void prepareConversation(String value) {}
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
  testWidgets(
    'unified conversations include empty rooms and search their members',
    (tester) async {
      final service = _SearchService();
      await service.prepareFixture();
      addTearDown(service.dispose);
      await tester.binding.setSurfaceSize(const Size(320, 568));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(
        MaterialApp(home: MessagesScreen(messaging: service)),
      );
      expect(find.text('Rooms'), findsNothing);
      expect(find.text('Create room'), findsOneWidget);
      final search = find.widgetWithText(TextField, 'Search conversations');
      await tester.enterText(search, 'CONNOR 230');
      await tester.pump();
      expect(find.text('Operations'), findsOneWidget);
      expect(find.text('Sales team'), findsNothing);
      await tester.enterText(search, 'sales');
      await tester.pump();
      expect(find.text('Sales team'), findsOneWidget);
      await tester.enterText(search, 'unknown');
      await tester.pump();
      expect(find.text('No matching conversations.'), findsOneWidget);
      await tester.tap(find.byTooltip('Clear conversation search'));
      await tester.pump();
      await tester.scrollUntilVisible(
        find.text('Operations'),
        100,
        scrollable: find.descendant(
          of: find.byType(ListView).first,
          matching: find.byType(Scrollable),
        ),
      );
      expect(find.text('Operations'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'unread filter shows counts, excludes outgoing messages and clears on reads',
    (tester) async {
      final service = _SearchService();
      await service.prepareFixture();
      service.items.add(
        ChatMessage(
          id: 'sent',
          peer: '10000*208@ejabberd.voicehost.io',
          body: 'Sent',
          outgoing: true,
          timestamp: DateTime.utc(2026, 2),
          status: ChatMessageStatus.sent,
        ),
      );
      addTearDown(service.dispose);
      await tester.pumpWidget(
        MaterialApp(home: MessagesScreen(messaging: service)),
      );
      expect(find.text('Unread (2)'), findsOneWidget);
      await tester.tap(find.text('Unread (2)'));
      await tester.pump();
      expect(find.text('Sales team'), findsNothing);
      service.items
          .where((m) => !m.outgoing)
          .forEach((m) => m.displayed = true);
      service.notifyListeners();
      await tester.pump();
      expect(find.text('Unread (0)'), findsOneWidget);
      expect(find.text('No unread conversations.'), findsOneWidget);
      service.setAccessAllowed(false);
      expect(service.unreadCount, 0);
    },
  );
  testWidgets('both tabs share the search style and show messaging status', (
    tester,
  ) async {
    final service = _SearchService();
    await service.prepareFixture();
    addTearDown(service.dispose);
    await tester.pumpWidget(
      MaterialApp(home: MessagesScreen(messaging: service)),
    );
    expect(find.text('Messaging connected · Available'), findsOneWidget);
    final conversation = tester.widget<TextField>(
      find.widgetWithText(TextField, 'Search conversations'),
    );
    await tester.tap(find.text('Directory'));
    await tester.pumpAndSettle();
    final directory = tester.widget<TextField>(
      find.widgetWithText(TextField, 'Search name or extension'),
    );
    expect(directory.decoration!.border, conversation.decoration!.border);
    expect(directory.decoration!.isDense, conversation.decoration!.isDense);
    await tester.enterText(
      find.widgetWithText(TextField, 'Search name or extension'),
      'nothing',
    );
    await tester.pump();
    await tester.tap(find.byTooltip('Clear directory search'));
    await tester.pump();
    expect(
      find.widgetWithText(TextField, 'Search name or extension'),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });
}
