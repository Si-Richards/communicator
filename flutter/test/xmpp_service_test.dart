import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:web_socket_channel/io.dart';
import 'package:xml/xml.dart';
import 'package:voicehost_softphone/models/chat_message.dart';
import 'package:voicehost_softphone/models/provisioning.dart';
import 'package:voicehost_softphone/services/xmpp_service.dart';
import 'package:voicehost_softphone/services/chat_history_repository.dart';

void main() {
  late _XmppServer server;
  final services = <XmppService>[];

  setUp(() async {
    server = await _XmppServer.start();
  });
  tearDown(() async {
    for (final service in services) {
      service.dispose();
    }
    services.clear();
    await server.close();
  });

  XmppService client({ChatHistoryRepository? history}) {
    final service = XmppService(
      historyRepository: history ?? MemoryChatHistoryRepository(),
      channelFactory: (_) =>
          IOWebSocketChannel.connect(server.uri, protocols: ['xmpp']),
    );
    services.add(service);
    return service;
  }

  Future<void> login(XmppService service, String user) async {
    await service.connect(username: user, password: 'private-test-password');
    await _until(() => service.online);
  }

  test('automatic account waits for readiness then uses the full SIP identity', () async {
    final alice = client();
    alice.configureManaged(const MessagingConfiguration(
      enabled: true,
      ready: false,
      jid: '10000*207@ejabberd.voicehost.io',
      password: 'private-test-password',
      websocket: 'wss://ejabberd.voicehost.io/websocket',
    ));
    await alice.reconnect();
    expect(server.connections, isEmpty);
    expect(alice.error, contains('being prepared'));
    alice.configureManaged(const MessagingConfiguration(
      enabled: true,
      jid: '10000*207@ejabberd.voicehost.io',
      password: 'private-test-password',
      websocket: 'wss://ejabberd.voicehost.io/websocket',
    ));
    await _until(() => alice.online);
    final bob = client();
    await login(bob, '10000*208');
    alice.sendMessage(recipient: '10000*208', body: 'Full SIP identity');
    await _until(() => bob.messages.isNotEmpty);
    expect(bob.messages.single.peer, '10000*207@ejabberd.voicehost.io');
  });

  test(
    'TLS endpoint is fixed and no connection occurs during construction',
    () {
      final service = client();
      expect(
        XmppService.endpoint.toString(),
        'wss://ejabberd.voicehost.io/websocket',
      );
      expect(service.state, XmppState.disconnected);
      expect(server.connections, isEmpty);
      expect(
        () => service.sendMessage(recipient: '208', body: 'hello'),
        throwsStateError,
      );
    },
  );

  test(
    'two users authenticate, bind, exchange escaped text and receipts',
    () async {
      final alice = client();
      final bob = client();
      await login(alice, '207');
      await login(bob, '208');
      expect(alice.jid, startsWith('207@ejabberd.voicehost.io/VoiceHost-'));
      expect(server.authenticatedUsers, ['207', '208']);
      alice.sendMessage(recipient: '208', body: '<hello> & "world"');
      await _until(() => bob.messages.length == 1);
      await _until(
        () => alice.messages.single.status == ChatMessageStatus.delivered,
      );
      expect(bob.messages.single.body, '<hello> & "world"');
      expect(bob.messages.single.peer, '207@ejabberd.voicehost.io');
      expect(bob.messages.single.outgoing, isFalse);
      bob.sendMessage(recipient: '207', body: 'Reply from 208');
      await _until(() => alice.messages.length == 2);
      await _until(
        () => bob.messages.last.status == ChatMessageStatus.delivered,
      );
      expect(alice.messages.last.body, 'Reply from 208');
      expect(alice.events.join('\n'), isNot(contains('private-test-password')));
      expect(alice.events.join('\n'), isNot(contains('hello')));
      expect(alice.events.join('\n'), isNot(contains('207@')));
    },
  );

  test(
    'authentication failure is terminal, sanitized, and cannot send',
    () async {
      server.rejectAuth = true;
      final service = client();
      await service.connect(username: '207', password: 'secret');
      await _until(() => service.state == XmppState.failed);
      expect(service.error, contains('Authentication rejected'));
      expect(service.events.join('\n'), isNot(contains('secret')));
      expect(
        () => service.sendMessage(recipient: '208', body: 'hello'),
        throwsStateError,
      );
      await Future<void>.delayed(const Duration(milliseconds: 100));
      expect(server.connections.length, 1);
    },
  );

  test(
    'online requires the correct bound identity and legacy session result',
    () async {
      server.requireSession = true;
      final service = client();
      await login(service, '207');
      expect(server.sessionRequests, 1);
      service.disconnect();
      server.wrongIdentity = true;
      await service.connect(username: '207', password: 'secret');
      await _until(() => service.state == XmppState.failed);
      expect(service.online, isFalse);
      expect(service.error, contains('unexpected XMPP identity'));
    },
  );

  test(
    'duplicate delayed incoming text is stored once and a ping is answered',
    () async {
      final service = client();
      await login(service, '207');
      const message =
          '<message xmlns="jabber:client" type="chat" id="duplicate" '
          'from="208@ejabberd.voicehost.io/other"><body>archived &amp; text</body>'
          '<delay xmlns="urn:xmpp:delay" stamp="2026-10-06T12:00:00Z"/></message>';
      server.connections.single.add('$message$message');
      await _until(() => service.messages.isNotEmpty);
      expect(service.messages.length, 1);
      expect(
        service.messages.single.timestamp.toUtc(),
        DateTime.utc(2026, 10, 6, 12),
      );
      server.connections.single.add(
        '<iq xmlns="jabber:client" type="get" '
        'id="ping-1" from="ejabberd.voicehost.io"><ping xmlns="urn:xmpp:ping"/></iq>',
      );
      await _until(
        () => server.received.any(
          (iq) =>
              iq.getAttribute('id') == 'ping-1' &&
              iq.getAttribute('type') == 'result',
        ),
      );
    },
  );

  test(
    'background pauses and resume reconnects; lock clears and blocks access',
    () async {
      final service = client();
      await login(service, '207');
      service.sendMessage(recipient: '208', body: 'private conversation');
      service.pause();
      expect(service.state, XmppState.paused);
      expect(service.online, isFalse);
      service.resume();
      await _until(() => service.online);
      expect(service.messages.length, 1);
      service.setAccessAllowed(false);
      expect(service.messages, isEmpty);
      expect(
        service.events.join('\n'),
        isNot(contains('private conversation')),
      );
      expect(
        () => service.connect(username: '208', password: 'secret'),
        throwsStateError,
      );
      service.setAccessAllowed(true);
      await login(service, '208');
      expect(service.messages, isEmpty);
    },
  );

  test(
    'network closure reconnects and switching accounts clears messages',
    () async {
      final service = client();
      await login(service, '207');
      service.sendMessage(recipient: '208', body: 'one account only');
      await server.connections.single.close();
      await _until(() => service.state == XmppState.reconnecting);
      await _until(() => service.online);
      expect(server.connections.length, 2);
      await login(service, '208');
      expect(service.messages, isEmpty);
      service.disconnect();
      expect(service.state, XmppState.disconnected);
    },
  );

  test('disconnect cancels a pending WebSocket handshake', () async {
    server.upgradeDelay = const Duration(milliseconds: 100);
    final service = client();
    final pending = service.connect(username: '207', password: 'secret');
    expect(service.state, XmppState.connecting);
    service.disconnect();
    await pending;
    expect(service.state, XmppState.disconnected);
    expect(server.authenticatedUsers, isEmpty);
  });

  test(
    'rejects non-local recipients and invalid XML without logging payload',
    () async {
      final service = client();
      await login(service, '207');
      expect(
        () => service.sendMessage(
          recipient: 'user@external.example',
          body: 'text',
        ),
        throwsArgumentError,
      );
      expect(
        () => service.sendMessage(recipient: '208', body: ' '),
        throwsArgumentError,
      );
      server.connections.single.add('<message secret="never-log-this">');
      await _until(() => service.state == XmppState.failed);
      expect(service.events.join('\n'), isNot(contains('never-log-this')));
    },
  );
  const account = '207@ejabberd.voicehost.io';
  const storageAccount = '$account|wss://ejabberd.voicehost.io/websocket';
  const managed = MessagingConfiguration(
    enabled: true,
    jid: account,
    password: 'private-test-password',
    websocket: 'wss://ejabberd.voicehost.io/websocket',
  );

  test(
    'managed login recovers newest archive page and loads older history',
    () async {
      server.archive.addAll([
        for (var i = 1; i <= 5; i++) _Archived('$i', 'message-$i'),
      ]);
      final service = client();
      service.configureManaged(managed);
      await _until(() => service.online && !service.historyBusy);
      expect(service.messages.map((m) => m.body), ['message-4', 'message-5']);
      expect(service.hasOlder, isTrue);
      await service.loadOlder();
      await service.loadOlder();
      expect(service.messages.map((m) => m.body), [
        for (var i = 1; i <= 5; i++) 'message-$i',
      ]);
      expect(service.hasOlder, isFalse);
      expect(server.archiveQueries.map((q) => q.before), ['', '4', '2']);
    },
  );

  test(
    'restart and reconnect page missed messages without duplicate outgoing text',
    () async {
      final history = MemoryChatHistoryRepository();
      server.archive.add(_Archived('1', 'first'));
      final service = client(history: history);
      await login(service, '207');
      await _until(() => !service.historyBusy);
      service.sendMessage(recipient: '208', body: 'sent locally');
      final sent = service.messages.last;
      server.archive.add(
        _Archived('2', sent.body, clientId: sent.id, outgoing: true),
      );
      service.pause();
      server.archive.addAll([
        for (var i = 3; i <= 6; i++) _Archived('$i', 'missed-$i'),
      ]);
      final restarted = client(history: history);
      await login(restarted, '207');
      await _until(() => !restarted.historyBusy);
      expect(
        restarted.messages.where((m) => m.body == 'sent locally'),
        hasLength(1),
      );
      expect(
        restarted.messages.where((m) => m.body.startsWith('missed-')),
        hasLength(4),
      );
      expect(
        server.archiveQueries.where((q) => q.after != null).map((q) => q.after),
        ['1', '3', '5'],
      );
      expect((await history.load(storageAccount)).cursor, '6');
    },
  );

  test(
    'archive wrappers from another user and uncorrelated queries are ignored',
    () async {
      server.forgeArchive = true;
      server.archive.add(_Archived('1', 'trusted'));
      final service = client();
      await login(service, '207');
      await _until(() => !service.historyBusy);
      expect(service.messages.single.body, 'trusted');
      expect(
        server.received.where(
          (s) =>
              s.getElement('received', namespace: 'urn:xmpp:receipts') != null,
        ),
        isEmpty,
      );
    },
  );

  test(
    'disconnect during archive page does not commit messages or cursor',
    () async {
      server.holdArchive = true;
      server.archive.add(_Archived('1', 'recover after reconnect'));
      final history = MemoryChatHistoryRepository();
      final service = client(history: history);
      await login(service, '207');
      await _until(() => server.archiveQueries.isNotEmpty);
      service.pause();
      await service.flushHistory();
      expect(service.messages, isEmpty);
      expect((await history.load(storageAccount)).cursor, isNull);
      server.holdArchive = false;
      service.resume();
      await _until(() => service.online && !service.historyBusy);
      expect(service.messages.single.body, 'recover after reconnect');
    },
  );

  test(
    'expired archive cursor recovers recent history and retains local text',
    () async {
      final history = MemoryChatHistoryRepository();
      await history.save(
        storageAccount,
        ChatHistorySnapshot(
          cursor: 'expired',
          messages: [
            ChatMessage(
              id: 'old',
              peer: '208@ejabberd.voicehost.io',
              body: 'local history',
              outgoing: false,
              timestamp: DateTime.utc(2025),
              status: ChatMessageStatus.received,
            ),
          ],
        ),
      );
      server.archive.add(_Archived('1', 'recent history'));
      final service = client(history: history);
      await login(service, '207');
      await _until(() => !service.historyBusy);
      expect(service.messages.map((m) => m.body), [
        'local history',
        'recent history',
      ]);
      expect(service.historyError, contains('cursor expired'));
      expect((await history.load(storageAccount)).cursor, '1');
    },
  );

  test(
    'lock hides history, unlock restores it, logout purges the cache',
    () async {
      final history = MemoryChatHistoryRepository();
      server.archive.add(_Archived('1', 'private text'));
      final service = client(history: history);
      service.configureManaged(managed);
      await _until(() => service.online && !service.historyBusy);
      service.setAccessAllowed(false);
      expect(service.messages, isEmpty);
      expect((await history.load(storageAccount)).messages, hasLength(1));
      service.setAccessAllowed(true);
      service.configureManaged(managed);
      await _until(() => service.online && !service.historyBusy);
      expect(service.messages.single.body, 'private text');
      service.setAccessAllowed(false);
      await service.forgetHistory();
      expect((await history.load(storageAccount)).messages, isEmpty);
    },
  );

  test(
    'failed durable write never advances archive cursor; retry deduplicates',
    () async {
      final history = _FailingHistoryRepository();
      server.archive.add(_Archived('1', 'recoverable text'));
      final service = client(history: history);
      await login(service, '207');
      await _until(() => !service.historyBusy);
      expect((await history.load(storageAccount)).cursor, isNull);
      expect(service.historyError, contains('could not be saved'));
      history.failWrites = false;
      await service.retryHistory();
      expect(service.messages.single.body, 'recoverable text');
      expect((await history.load(storageAccount)).cursor, '1');
    },
  );

  test(
    'changing managed account isolates history and manual login cannot override it',
    () async {
      final history = MemoryChatHistoryRepository();
      final service = client(history: history);
      service.configureManaged(managed);
      await _until(() => service.online && !service.historyBusy);
      service.sendMessage(recipient: '208', body: 'account 207 only');
      await service.flushHistory();
      service.configureManaged(
        const MessagingConfiguration(
          enabled: true,
          jid: '209@ejabberd.voicehost.io',
          password: 'other-secret',
          websocket: 'wss://ejabberd.voicehost.io/websocket',
        ),
      );
      await _until(
        () =>
            service.online &&
            service.jid!.startsWith('209@') &&
            !service.historyBusy,
      );
      expect(service.messages, isEmpty);
      await expectLater(
        service.connect(username: '207', password: 'secret'),
        throwsStateError,
      );
      expect(
        (await history.load(storageAccount)).messages.single.body,
        'account 207 only',
      );
    },
  );

  test('unsupported archive keeps live messaging usable', () async {
    server.mamSupported = false;
    final service = client();
    await login(service, '207');
    await _until(() => !service.historyBusy);
    expect(service.historyError, contains('archive is unavailable'));
    service.sendMessage(recipient: '208', body: 'still usable');
    expect(service.messages.single.body, 'still usable');
  });
}

Future<void> _until(bool Function() predicate) async {
  final deadline = DateTime.now().add(const Duration(seconds: 5));
  while (!predicate()) {
    if (DateTime.now().isAfter(deadline)) {
      throw TimeoutException('Expected state not reached');
    }
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
}

/// Local wire-level fixture, not a mocked copy of the client's state machine.
class _XmppServer {
  _XmppServer(this.http);
  final HttpServer http;
  final connections = <WebSocket>[];
  final received = <XmlElement>[];
  final authenticatedUsers = <String>[];
  final users = <String, WebSocket>{};
  final archive = <_Archived>[];
  final archiveQueries = <({String? before, String? after})>[];
  bool mamSupported = true;
  bool forgeArchive = false;
  bool holdArchive = false;
  bool rejectAuth = false;
  bool requireSession = false;
  bool wrongIdentity = false;
  int sessionRequests = 0;
  Duration upgradeDelay = Duration.zero;
  Uri get uri => Uri.parse('ws://127.0.0.1:${http.port}/websocket');

  static Future<_XmppServer> start() async {
    final instance = _XmppServer(
      await HttpServer.bind(InternetAddress.loopbackIPv4, 0),
    );
    instance.http.listen(instance.accept);
    return instance;
  }

  Future<void> accept(HttpRequest request) async {
    await Future<void>.delayed(upgradeDelay);
    final socket = await WebSocketTransformer.upgrade(
      request,
      protocolSelector: (protocols) =>
          protocols.contains('xmpp') ? 'xmpp' : null,
    );
    connections.add(socket);
    var authenticated = false;
    var user = '';
    socket.listen((dynamic data) {
      if (socket.readyState != WebSocket.open) return;
      final stanza = XmlDocument.parse(data as String).rootElement;
      received.add(stanza);
      switch (stanza.name.local) {
        case 'open':
          _sendFixture(
            socket,
            '<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" '
            'from="ejabberd.voicehost.io" version="1.0"/>',
          );
          _sendFixture(
            socket,
            '<stream:features xmlns:stream="http://etherx.jabber.org/streams">'
            '${authenticated ? '<bind xmlns="urn:ietf:params:xml:ns:xmpp-bind"/>'
                      '${requireSession ? '<session xmlns="urn:ietf:params:xml:ns:xmpp-session"/>' : ''}' : '<mechanisms xmlns="urn:ietf:params:xml:ns:xmpp-sasl"><mechanism>PLAIN</mechanism></mechanisms>'}'
            '</stream:features>',
          );
        case 'auth':
          user = utf8.decode(base64Decode(stanza.innerText)).split('\u0000')[1];
          if (rejectAuth) {
            _sendFixture(
              socket,
              '<failure xmlns="urn:ietf:params:xml:ns:xmpp-sasl"><not-authorized/></failure>',
            );
          } else {
            authenticated = true;
            authenticatedUsers.add(user);
            _sendFixture(
              socket,
              '<success xmlns="urn:ietf:params:xml:ns:xmpp-sasl"/>',
            );
          }
        case 'iq':
          final bind = stanza.getElement(
            'bind',
            namespace: 'urn:ietf:params:xml:ns:xmpp-bind',
          );
          if (bind != null) {
            final resource = bind
                .getElement(
                  'resource',
                  namespace: 'urn:ietf:params:xml:ns:xmpp-bind',
                )!
                .innerText;
            users[user] = socket;
            _sendFixture(
              socket,
              '<iq xmlns="jabber:client" type="result" id="${stanza.getAttribute('id')}">'
              '<bind xmlns="urn:ietf:params:xml:ns:xmpp-bind">'
              '<jid>${wrongIdentity ? 'wrong' : user}@ejabberd.voicehost.io/$resource</jid></bind></iq>',
            );
          } else if (stanza.getElement(
                'session',
                namespace: 'urn:ietf:params:xml:ns:xmpp-session',
              ) !=
              null) {
            sessionRequests++;
            _sendFixture(
              socket,
              '<iq xmlns="jabber:client" type="result" id="${stanza.getAttribute('id')}"/>',
            );
          } else if (stanza.getElement(
                'query',
                namespace: 'http://jabber.org/protocol/disco#info',
              ) !=
              null) {
            _sendFixture(
              socket,
              '<iq xmlns="jabber:client" type="result" id="${stanza.getAttribute('id')}">'
              '<query xmlns="http://jabber.org/protocol/disco#info">'
              '${mamSupported ? '<feature var="urn:xmpp:mam:2"/>' : ''}</query></iq>',
            );
          } else if (stanza.getElement('query', namespace: 'urn:xmpp:mam:2') !=
              null) {
            archiveResponse(socket, stanza, user);
          }
        case 'message':
          final recipient = stanza.getAttribute('to')!.split('@').first;
          stanza.setAttribute('from', '$user@ejabberd.voicehost.io/fixture');
          final target = users[recipient];
          if (target != null) _sendFixture(target, stanza.toXmlString());
      }
    });
  }

  void archiveResponse(WebSocket socket, XmlElement stanza, String user) {
    final query = stanza.getElement('query', namespace: 'urn:xmpp:mam:2')!;
    final set = query.getElement(
      'set',
      namespace: 'http://jabber.org/protocol/rsm',
    )!;
    final before = set
        .getElement('before', namespace: 'http://jabber.org/protocol/rsm')
        ?.innerText;
    final after = set
        .getElement('after', namespace: 'http://jabber.org/protocol/rsm')
        ?.innerText;
    archiveQueries.add((before: before, after: after));
    if (after != null && !archive.any((m) => m.id == after)) {
      _sendFixture(
        socket,
        '<iq xmlns="jabber:client" type="error" id="${stanza.getAttribute('id')}">'
        '<error type="cancel"><item-not-found xmlns="urn:ietf:params:xml:ns:xmpp-stanzas"/></error></iq>',
      );
      return;
    }
    final start = after != null
        ? archive.indexWhere((m) => m.id == after) + 1
        : 0;
    final end = before != null && before.isNotEmpty
        ? archive.indexWhere((m) => m.id == before)
        : archive.length;
    final candidates = archive.sublist(start, end);
    final page = before != null
        ? candidates
              .skip(candidates.length > 2 ? candidates.length - 2 : 0)
              .toList()
        : candidates.take(2).toList();
    final queryId = query.getAttribute('queryid')!;
    if (forgeArchive) {
      _sendFixture(
        socket,
        _Archived(
          'forged',
          'forged',
        ).xml(queryId, user, from: '208@ejabberd.voicehost.io'),
      );
      _sendFixture(
        socket,
        _Archived('uncorrelated', 'uncorrelated').xml('wrong-query', user),
      );
    }
    for (final message in page) {
      _sendFixture(socket, message.xml(queryId, user));
    }
    if (holdArchive) return;
    _sendFixture(
      socket,
      '<iq xmlns="jabber:client" type="result" id="${stanza.getAttribute('id')}">'
      '<fin xmlns="urn:xmpp:mam:2" complete="${candidates.length <= 2}">'
      '<set xmlns="http://jabber.org/protocol/rsm">'
      '${page.isEmpty ? '' : '<first>${page.first.id}</first><last>${page.last.id}</last>'}'
      '</set></fin></iq>',
    );
  }

  Future<void> close() async {
    for (final socket in connections) {
      await socket.close();
    }
    await http.close(force: true);
  }
}

class _Archived {
  _Archived(this.id, this.body, {this.clientId, this.outgoing = false});
  final String id;
  final String body;
  final String? clientId;
  final bool outgoing;
  String xml(String query, String user, {String? from}) {
    final account = '$user@ejabberd.voicehost.io';
    final peer = '208@ejabberd.voicehost.io';
    return '<message xmlns="jabber:client" from="${from ?? account}">'
        '<result xmlns="urn:xmpp:mam:2" queryid="$query" id="$id">'
        '<forwarded xmlns="urn:xmpp:forward:0">'
        '<delay xmlns="urn:xmpp:delay" stamp="2026-10-07T10:00:${(int.tryParse(id) ?? 0).toString().padLeft(2, '0')}Z"/>'
        '<message xmlns="jabber:client" from="${outgoing ? account : peer}" to="${outgoing ? peer : account}" '
        'type="chat" id="${clientId ?? 'message-$id'}"><body>${XmlText(body).toXmlString()}</body>'
        '</message></forwarded></result></message>';
  }
}

class _FailingHistoryRepository extends MemoryChatHistoryRepository {
  bool failWrites = true;
  @override
  Future<void> save(String account, ChatHistorySnapshot snapshot) async {
    if (failWrites) throw StateError('Storage unavailable.');
    await super.save(account, snapshot);
  }
}

void _sendFixture(WebSocket socket, String stanza) {
  // Queued requests can arrive after the peer closes the fixture's sink.
  try {
    socket.add(stanza);
  } on StateError {
    /* Connection already closing. */
  }
}
