import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:web_socket_channel/io.dart';
import 'package:xml/xml.dart';
import 'package:voicehost_softphone/models/chat_message.dart';
import 'package:voicehost_softphone/services/xmpp_service.dart';

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

  XmppService client() {
    final service = XmppService(
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
      final stanza = XmlDocument.parse(data as String).rootElement;
      received.add(stanza);
      switch (stanza.name.local) {
        case 'open':
          socket.add(
            '<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" '
            'from="ejabberd.voicehost.io" version="1.0"/>',
          );
          socket.add(
            '<stream:features xmlns:stream="http://etherx.jabber.org/streams">'
            '${authenticated ? '<bind xmlns="urn:ietf:params:xml:ns:xmpp-bind"/>'
                      '${requireSession ? '<session xmlns="urn:ietf:params:xml:ns:xmpp-session"/>' : ''}' : '<mechanisms xmlns="urn:ietf:params:xml:ns:xmpp-sasl"><mechanism>PLAIN</mechanism></mechanisms>'}'
            '</stream:features>',
          );
        case 'auth':
          user = utf8.decode(base64Decode(stanza.innerText)).split('\u0000')[1];
          if (rejectAuth) {
            socket.add(
              '<failure xmlns="urn:ietf:params:xml:ns:xmpp-sasl"><not-authorized/></failure>',
            );
          } else {
            authenticated = true;
            authenticatedUsers.add(user);
            socket.add('<success xmlns="urn:ietf:params:xml:ns:xmpp-sasl"/>');
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
            socket.add(
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
            socket.add(
              '<iq xmlns="jabber:client" type="result" id="${stanza.getAttribute('id')}"/>',
            );
          }
        case 'message':
          final recipient = stanza.getAttribute('to')!.split('@').first;
          stanza.setAttribute('from', '$user@ejabberd.voicehost.io/fixture');
          users[recipient]?.add(stanza.toXmlString());
      }
    });
  }

  Future<void> close() async {
    for (final socket in connections) {
      await socket.close();
    }
    await http.close(force: true);
  }
}
