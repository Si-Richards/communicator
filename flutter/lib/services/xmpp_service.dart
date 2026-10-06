import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:xml/xml.dart';

import '../models/chat_message.dart';

enum XmppState {
  disconnected,
  connecting,
  authenticating,
  binding,
  online,
  reconnecting,
  paused,
  failed,
}

/// Focused RFC 7395 client for the first foreground messaging milestone.
/// Credentials, messages and diagnostic events are deliberately memory-only.
/// No administrative API, telephony dependency, or startup connection.
class XmppService extends ChangeNotifier {
  XmppService({WebSocketChannel Function(Uri)? channelFactory})
    : _channelFactory =
          channelFactory ??
          ((uri) => WebSocketChannel.connect(uri, protocols: ['xmpp']));

  static const domain = 'ejabberd.voicehost.io';
  static final endpoint = Uri.parse('wss://$domain/websocket');
  static const _framing = 'urn:ietf:params:xml:ns:xmpp-framing';
  static const _sasl = 'urn:ietf:params:xml:ns:xmpp-sasl';
  static const _client = 'jabber:client';
  static const _bind = 'urn:ietf:params:xml:ns:xmpp-bind';
  static const _receipts = 'urn:xmpp:receipts';

  final WebSocketChannel Function(Uri) _channelFactory;
  final List<ChatMessage> _messages = [];
  final List<String> _events = [];
  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _subscription;
  Timer? _deadline;
  Timer? _retry;
  String? _username;
  String? _password;
  String? _account;
  String? _boundJid;
  String? _bindId;
  String? _sessionId;
  bool _needsSession = false;
  bool _authenticated = false;
  bool _wanted = false;
  bool _paused = false;
  bool _disposed = false;
  bool _accessAllowed = true;
  int _generation = 0;
  int _attempts = 0;
  final String _resource =
      'VoiceHost-${defaultTargetPlatform.name}-'
      '${Random.secure().nextInt(0x7fffffff).toRadixString(16)}';
  XmppState _state = XmppState.disconnected;
  String? _error;

  XmppState get state => _state;
  String? get error => _error;
  String? get jid => _boundJid;
  bool get online => state == XmppState.online;
  bool get accessAllowed => _accessAllowed;
  List<ChatMessage> get messages => List.unmodifiable(_messages);
  List<String> get events => List.unmodifiable(_events);

  /// Only VoiceHost test users are accepted here. Production credentials will
  /// be supplied by managed provisioning in a later milestone.
  Future<void> connect({
    required String username,
    required String password,
  }) async {
    if (!_accessAllowed || _disposed) throw StateError('Messaging is locked.');
    final localpart = username.trim().toLowerCase();
    if (!RegExp(r'^[a-zA-Z0-9._-]+$').hasMatch(localpart) ||
        password.isEmpty ||
        password.contains('\u0000')) {
      throw ArgumentError('Enter a username (without @domain) and password.');
    }
    if (_account != localpart) _messages.clear();
    _account = localpart;
    _username = localpart;
    _password = password;
    _wanted = true;
    _attempts = 0;
    if (_paused) {
      _setState(XmppState.paused);
      return;
    }
    await _open();
  }

  Future<void> _open() async {
    _closeTransport();
    final generation = _generation;
    _authenticated = false;
    _boundJid = null;
    _bindId = null;
    _sessionId = null;
    _needsSession = false;
    _error = null;
    _setState(_attempts == 0 ? XmppState.connecting : XmppState.reconnecting);
    WebSocketChannel? channel;
    try {
      channel = _channelFactory(endpoint);
      _channel = channel;
      // Close even a connection that becomes ready after cancellation/timeout.
      unawaited(
        channel.ready.then((_) {
          if (generation != _generation) _ignore(channel!.sink.close());
        }, onError: (Object _) {}),
      );
      await channel.ready.timeout(const Duration(seconds: 15));
      if (_disposed || generation != _generation) return;
      if (channel.protocol != 'xmpp') {
        _fail('Server did not negotiate the xmpp WebSocket subprotocol.');
        return;
      }
      _subscription = channel.stream.listen(
        (data) {
          if (generation == _generation) _receive(data);
        },
        onError: (Object _) {
          if (generation == _generation) _networkLost();
        },
        onDone: () {
          if (generation == _generation) _networkLost();
        },
      );
      _deadline = Timer(const Duration(seconds: 20), () {
        if (generation == _generation) {
          _fail(
            'XMPP login timed out. Check ejabberd logs and test credentials.',
          );
        }
      });
      _sendOpen();
    } catch (_) {
      if (!_disposed && generation == _generation) _networkLost();
    }
  }

  void _sendOpen() => _send(
    _element(
      'open',
      _framing,
      attributes: {'to': domain, 'version': '1.0', 'xml:lang': 'en'},
    ),
  );

  void _receive(dynamic data) {
    try {
      if (data is! String || data.length > 1024 * 1024) {
        _fail('Unsupported XMPP frame.');
        return;
      }
      // RFC 7395 allows several complete XML elements in one text frame.
      final elements = XmlDocumentFragment.parse(
        data,
      ).children.whereType<XmlElement>();
      for (final element in elements) {
        if (_channel == null) break;
        final name = element.name.local;
        final ns = element.namespaceUri;
        if (name == 'open' && ns == _framing) continue;
        if (name == 'features' && ns == 'http://etherx.jabber.org/streams') {
          _features(element);
        } else if (name == 'success' &&
            ns == _sasl &&
            state == XmppState.authenticating) {
          _authenticated = true;
          _setState(XmppState.binding);
          _sendOpen();
        } else if (name == 'failure' && ns == _sasl) {
          _fail(
            'Authentication rejected. Check the ejabberd username and password.',
          );
        } else if (name == 'iq' && ns == _client) {
          _iq(element);
        } else if (name == 'message' && ns == _client && online) {
          _message(element);
        } else if (name == 'close' && ns == _framing) {
          _networkLost();
        } else if (name == 'error' &&
            ns == 'http://etherx.jabber.org/streams') {
          _fail('Server reported an XMPP stream error. Check ejabberd logs.');
        }
      }
    } catch (_) {
      _fail('Invalid XMPP response. Check the server WebSocket configuration.');
    }
  }

  void _features(XmlElement features) {
    if (!_authenticated &&
        (state == XmppState.connecting || state == XmppState.reconnecting)) {
      final mechanisms = features.getElement('mechanisms', namespace: _sasl);
      final supportsPlain =
          mechanisms
              ?.findElements('mechanism', namespace: _sasl)
              .any((element) => element.innerText == 'PLAIN') ??
          false;
      if (!supportsPlain) {
        _fail(
          'Server does not offer SASL PLAIN over WSS. Check its SASL policy.',
        );
        return;
      }
      // SASL PLAIN is only used over certificate-validated WSS. SCRAM server
      // password storage does not require a SCRAM client mechanism.
      _setState(XmppState.authenticating);
      _send(
        _element(
          'auth',
          _sasl,
          attributes: {'mechanism': 'PLAIN'},
          text: base64Encode(utf8.encode('\u0000$_username\u0000$_password')),
        ),
      );
    } else if (_authenticated && _bindId == null) {
      if (features.getElement('bind', namespace: _bind) == null) {
        _fail('Server did not offer XMPP resource binding.');
        return;
      }
      final session = features.getElement(
        'session',
        namespace: 'urn:ietf:params:xml:ns:xmpp-session',
      );
      _needsSession = session != null && session.getElement('optional') == null;
      _bindId = _id();
      _send(
        _element(
          'iq',
          _client,
          attributes: {'type': 'set', 'id': _bindId!},
          children: [
            _element(
              'bind',
              _bind,
              children: [_element('resource', _bind, text: _resource)],
            ),
          ],
        ),
      );
    }
  }

  void _iq(XmlElement iq) {
    final id = iq.getAttribute('id');
    final type = iq.getAttribute('type');
    if (id == _bindId && _bindId != null && state == XmppState.binding) {
      if (type != 'result') {
        _fail('XMPP resource binding was rejected.');
        return;
      }
      final bound = iq
          .getElement('bind', namespace: _bind)
          ?.getElement('jid', namespace: _bind)
          ?.innerText;
      if (bound == null || _bare(bound) != '$_username@$domain') {
        _fail('Server returned an unexpected XMPP identity.');
        return;
      }
      _boundJid = bound;
      if (_needsSession) {
        _sessionId = _id();
        _send(
          _element(
            'iq',
            _client,
            attributes: {'type': 'set', 'id': _sessionId!},
            children: [
              _element('session', 'urn:ietf:params:xml:ns:xmpp-session'),
            ],
          ),
        );
      } else {
        _becomeOnline();
      }
    } else if (id == _sessionId &&
        _sessionId != null &&
        state == XmppState.binding) {
      if (type == 'result') {
        _becomeOnline();
      } else {
        _fail('XMPP session establishment was rejected.');
      }
    } else if (type == 'get' &&
        online &&
        iq.getElement('ping', namespace: 'urn:xmpp:ping') != null &&
        id != null) {
      _send(
        _element(
          'iq',
          _client,
          attributes: {
            'type': 'result',
            'id': id,
            if (iq.getAttribute('from') != null) 'to': iq.getAttribute('from')!,
          },
        ),
      );
    }
  }

  void _becomeOnline() {
    _deadline?.cancel();
    _attempts = 0;
    _send(_element('presence', _client));
    _setState(XmppState.online);
  }

  String recipientJid(String value) {
    final clean = value.trim().toLowerCase();
    final jid = clean.contains('@') ? clean : '$clean@$domain';
    if (!RegExp(r'^[a-zA-Z0-9._-]+@ejabberd\.voicehost\.io$').hasMatch(jid)) {
      throw ArgumentError('Enter a local username or a JID at $domain.');
    }
    return jid;
  }

  void sendMessage({required String recipient, required String body}) {
    if (!online) throw StateError('Messaging is not online.');
    final peer = recipientJid(recipient);
    if (body.trim().isEmpty || body.length > 10000) {
      throw ArgumentError('Enter a message of up to 10,000 characters.');
    }
    final id = _id();
    _send(
      _element(
        'message',
        _client,
        attributes: {'id': id, 'type': 'chat', 'to': peer},
        children: [
          _element('body', _client, text: body),
          _element('request', _receipts),
        ],
      ),
    );
    _messages.add(
      ChatMessage(
        id: id,
        peer: peer,
        body: body,
        outgoing: true,
        timestamp: DateTime.now(),
        status: ChatMessageStatus.sent,
      ),
    );
    _trimMessages();
    _event('Text message sent');
    notifyListeners();
  }

  void _message(XmlElement message) {
    final from = message.getAttribute('from');
    if (from == null) return;
    final peer = _bare(from);
    final id = message.getAttribute('id');
    if (message.getAttribute('type') == 'error') {
      _updateStatus(id, peer, ChatMessageStatus.failed);
      return;
    }
    final receipt = message.getElement('received', namespace: _receipts);
    if (receipt != null) {
      _updateStatus(
        receipt.getAttribute('id'),
        peer,
        ChatMessageStatus.delivered,
      );
    }
    final body = message.getElement('body', namespace: _client)?.innerText;
    if (body == null ||
        body.isEmpty ||
        body.length > 10000 ||
        !['chat', 'normal', null].contains(message.getAttribute('type'))) {
      return;
    }
    if (id != null &&
        message.getElement('request', namespace: _receipts) != null) {
      _send(
        _element(
          'message',
          _client,
          attributes: {'to': from, 'type': 'chat'},
          children: [
            _element('received', _receipts, attributes: {'id': id}),
          ],
        ),
      );
    }
    if (id != null &&
        _messages.any((m) => !m.outgoing && m.id == id && m.peer == peer)) {
      return;
    }
    final delay = message.getElement('delay', namespace: 'urn:xmpp:delay');
    _messages.add(
      ChatMessage(
        id: id ?? _id(),
        peer: peer,
        body: body,
        outgoing: false,
        timestamp:
            DateTime.tryParse(delay?.getAttribute('stamp') ?? '')?.toLocal() ??
            DateTime.now(),
        status: ChatMessageStatus.received,
      ),
    );
    _trimMessages();
    _event('Text message received');
    notifyListeners();
  }

  void _updateStatus(String? id, String peer, ChatMessageStatus status) {
    if (id == null) return;
    for (final message in _messages) {
      if (message.outgoing && message.id == id && message.peer == peer) {
        message.status = status;
        notifyListeners();
        break;
      }
    }
  }

  void _trimMessages() {
    if (_messages.length > 500) {
      _messages.removeRange(0, _messages.length - 500);
    }
  }

  void _networkLost() {
    _closeTransport();
    _boundJid = null;
    if (!_wanted || _paused || _disposed) return;
    if (_attempts >= 5) {
      _fail(
        'Messaging could not reconnect. Check your network, then reconnect.',
      );
      return;
    }
    final seconds = 1 << _attempts++;
    _event('Connection lost; retry in ${seconds}s');
    _setState(XmppState.reconnecting);
    _retry = Timer(Duration(seconds: seconds), () => unawaited(_open()));
  }

  void _fail(String message) {
    _closeTransport();
    _wanted = false;
    _password = null;
    _boundJid = null;
    _error = message;
    _event(message);
    _setState(XmppState.failed);
  }

  void disconnect({bool clearMessages = false}) {
    _wanted = false;
    _closeTransport();
    _username = null;
    _password = null;
    _boundJid = null;
    _error = null;
    if (clearMessages) {
      _messages.clear();
      _events.clear();
      _account = null;
    }
    _setState(XmppState.disconnected);
  }

  void setAccessAllowed(bool allowed) {
    if (_accessAllowed == allowed) return;
    _accessAllowed = allowed;
    if (!allowed) {
      disconnect(clearMessages: true);
    } else if (!_disposed) {
      notifyListeners();
    }
  }

  void pause() {
    _paused = true;
    _closeTransport();
    _boundJid = null;
    if (_wanted) _setState(XmppState.paused);
  }

  void resume() {
    _paused = false;
    if (_wanted && state == XmppState.paused) unawaited(_open());
  }

  void _closeTransport() {
    _generation++;
    _deadline?.cancel();
    _retry?.cancel();
    final subscription = _subscription;
    _subscription = null;
    if (subscription != null) _ignore(subscription.cancel());
    final channel = _channel;
    _channel = null;
    if (channel != null) _ignore(channel.sink.close());
  }

  static void _ignore(Future<dynamic> future) {
    unawaited(future.then<void>((_) {}, onError: (Object _) {}));
  }

  void _send(XmlElement element) => _channel!.sink.add(element.toXmlString());
  static String _bare(String jid) => jid.split('/').first;
  static String _id() =>
      'vh-${DateTime.now().microsecondsSinceEpoch}-'
      '${Random.secure().nextInt(0x7fffffff).toRadixString(16)}';

  static XmlElement _element(
    String name,
    String namespace, {
    Map<String, String> attributes = const {},
    String? text,
    List<XmlElement> children = const [],
  }) => XmlElement(
    XmlName(name),
    [
      XmlAttribute(XmlName('xmlns'), namespace),
      for (final entry in attributes.entries)
        XmlAttribute(XmlName.fromString(entry.key), entry.value),
    ],
    [if (text != null) XmlText(text), ...children],
  );

  void _event(String text) {
    // Fixed summaries only: never log XML, auth payloads, JIDs, or message bodies.
    _events.add('${DateTime.now().toIso8601String()} $text');
    if (_events.length > 60) _events.removeAt(0);
  }

  void _setState(XmppState value) {
    if (_disposed) return;
    _state = value;
    _event('Messaging ${value.name}');
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _wanted = false;
    _password = null;
    _messages.clear();
    _closeTransport();
    super.dispose();
  }
}
