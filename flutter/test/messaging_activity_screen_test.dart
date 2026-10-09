import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:voicehost_softphone/models/chat_message.dart';
import 'package:voicehost_softphone/models/messaging_presence.dart';
import 'package:voicehost_softphone/services/chat_history_repository.dart';
import 'package:voicehost_softphone/services/xmpp_service.dart';
import 'package:voicehost_softphone/ui/messages_screen.dart';

const _peer = '10000*230@ejabberd.voicehost.io';

class _ScreenMessaging extends XmppService {
  _ScreenMessaging() : super(historyRepository: MemoryChatHistoryRepository());
  final items = <ChatMessage>[];
  final displayedIds = <String>[];
  bool invalidPeer = false;
  @override
  String recipientJid(String value) {
    if (invalidPeer) throw ArgumentError('Different account');
    return super.recipientJid(value);
  }

  @override
  bool get online => true;
  @override
  List<ChatMessage> get messages => List.unmodifiable(items);
  @override
  String contactLabel(String jid) => 'Connor · 230';
  @override
  MessagingPresence presenceFor(String jid) => MessagingPresence.available;
  @override
  void prepareConversation(String value) {}
  @override
  void markConversationDisplayed(String value, String id) {
    displayedIds.add(id);
    for (final message in items) {
      if (!message.outgoing && message.id == id) message.displayed = true;
    }
  }

  void incoming(String id) {
    items.add(_message(id));
    notifyListeners();
  }
}

ChatMessage _message(String id, {bool outgoing = false}) => ChatMessage(
  id: id,
  peer: _peer,
  body: 'Message $id',
  outgoing: outgoing,
  timestamp: DateTime.utc(2026),
  status: outgoing ? ChatMessageStatus.sent : ChatMessageStatus.received,
  markable: !outgoing,
);

Widget _app(_ScreenMessaging service, {GlobalKey<NavigatorState>? navigator}) =>
    MaterialApp(
      navigatorKey: navigator,
      navigatorObservers: [messagingRouteObserver],
      home: MessagingChatScreen(messaging: service, peer: _peer),
    );

void main() {
  testWidgets('account changes close access to the previous conversation', (
    tester,
  ) async {
    final service = _ScreenMessaging();
    addTearDown(service.dispose);
    await tester.pumpWidget(_app(service));
    service.invalidPeer = true;
    service.incoming('different-account');
    await tester.pump();
    expect(service.displayedIds, isEmpty);
    expect(
      find.text('This conversation is unavailable for your account.'),
      findsOneWidget,
    );
    expect(find.text('Message different-account'), findsNothing);
  });
  testWidgets(
    'visible foreground chat shows friendly name and marks displayed',
    (tester) async {
      final service = _ScreenMessaging()..items.add(_message('visible'));
      addTearDown(service.dispose);
      await tester.pumpWidget(_app(service));
      await tester.pump();
      expect(find.text('Connor · 230'), findsOneWidget);
      expect(find.text('Available'), findsOneWidget);
      expect(service.displayedIds, ['visible']);
    },
  );

  testWidgets('messages outside the viewport are not marked read', (
    tester,
  ) async {
    final service = _ScreenMessaging()..items.add(_message('not-visible'));
    for (var i = 0; i < 60; i++) {
      service.items.add(_message('out-$i', outgoing: true));
    }
    addTearDown(service.dispose);
    await tester.pumpWidget(_app(service));
    await tester.pump();
    expect(service.displayedIds, isEmpty);
  });

  testWidgets('covered route stops reading and reads on return', (
    tester,
  ) async {
    final service = _ScreenMessaging();
    final navigator = GlobalKey<NavigatorState>();
    addTearDown(service.dispose);
    await tester.pumpWidget(_app(service, navigator: navigator));
    navigator.currentState!.push(
      MaterialPageRoute<void>(
        builder: (_) => const Scaffold(body: Text('Other screen')),
      ),
    );
    await tester.pumpAndSettle();
    service.incoming('covered');
    await tester.pump();
    expect(service.displayedIds, isEmpty);
    navigator.currentState!.pop();
    await tester.pumpAndSettle();
    expect(service.displayedIds, ['covered']);
  });

  testWidgets(
    'inactive app does not read and foreground resume reads visible message',
    (tester) async {
      final service = _ScreenMessaging();
      addTearDown(service.dispose);
      await tester.pumpWidget(_app(service));
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      service.incoming('background');
      await tester.pump();
      expect(service.displayedIds, isEmpty);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();
      expect(service.displayedIds, ['background']);
    },
  );
}
