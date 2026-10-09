import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:xml/xml.dart';

import '../models/chat_message.dart';
import '../models/chat_attachment.dart';
import '../models/messaging_contact.dart';
import '../models/messaging_room.dart';
import '../models/messaging_presence.dart';
import '../models/provisioning.dart';
import 'chat_history_repository.dart';

part 'xmpp_rooms.dart';

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

/// RFC 7395 client with account-scoped encrypted history and XEP-0313 recovery.
class XmppService extends ChangeNotifier {
  XmppService({
    WebSocketChannel Function(Uri)? channelFactory,
    ChatHistoryRepository? historyRepository,
    Duration typingPause = const Duration(seconds: 5),
    Duration typingExpiry = const Duration(seconds: 45),
  }) : _history = historyRepository ?? EncryptedChatHistoryRepository(),
       _typingPause = typingPause,
       _typingExpiry = typingExpiry,
       _channelFactory =
           channelFactory ??
           ((uri) => WebSocketChannel.connect(uri, protocols: ['xmpp']));

  static const domain = 'ejabberd.voicehost.io';
  static final endpoint = Uri.parse('wss://$domain/websocket');
  static const _framing = 'urn:ietf:params:xml:ns:xmpp-framing';
  static const _sasl = 'urn:ietf:params:xml:ns:xmpp-sasl';
  static const _client = 'jabber:client';
  static const _bind = 'urn:ietf:params:xml:ns:xmpp-bind';
  static const _receipts = 'urn:xmpp:receipts';
  static const _markers = 'urn:xmpp:chat-markers:0';
  static const _chatStates = 'http://jabber.org/protocol/chatstates';
  static const _carbons = 'urn:xmpp:carbons:2';
  static const _forward = 'urn:xmpp:forward:0';
  static const _mam = 'urn:xmpp:mam:2';
  static const _rsm = 'http://jabber.org/protocol/rsm';
  static const _sid = 'urn:xmpp:sid:0';
  static const _disco = 'http://jabber.org/protocol/disco#info';
  static const _roster = 'jabber:iq:roster';
  Future<List<MessagingRoom>> Function()? roomLoader;
  final Map<String, MessagingRoom> _rooms = {};
  final Set<String> _joinedRooms = {},
      _roomHistoryBusy = {},
      _roomHasOlder = {};
  final Map<String, String> _roomOldest = {},
      _roomLatest = {},
      _roomHistoryErrors = {},
      _roomArchiveQueries = {},
      _roomReadAnchors = {};
  final Map<String, int> _roomArchiveCounts = {};
  Timer? _roomTimer;
  bool _roomsBusy = false;
  String? _roomsError;
  String? get roomsError => _roomsError;
  bool get roomsBusy => _roomsBusy;

  // Room extension methods cannot invoke ChangeNotifier's protected method.
  void _notifyRoomListeners() {
    if (!_disposed) notifyListeners();
  }
  final ChatHistoryRepository _history;
  Future<void> _storageQueue = Future.value();
  final Map<String, Completer<XmlElement>> _pendingIq = {};
  final Map<String, String> _pendingIqFrom = {};
  final Map<String, List<ChatMessage>> _archiveResults = {};
  final Map<String, List<ChatMessageUpdate>> _archiveUpdates = {};
  final List<ChatMessageUpdate> _recoveredUpdates = [];
  final Map<String, Map<String, MessagingPresence>> _presence = {};
  final Set<String> _knownPresence = {};
  final Set<String> _chatStatePeers = {};
  final Set<String> _discoveredPeers = {};
  final Map<String, String> _typingResources = {};
  final Map<String, Timer> _typingTimers = {};
  final Map<String, String> _sentChatStates = {};
  final Duration _typingPause;
  final Duration _typingExpiry;
  Timer? _typingIdle;
  String? _typingPeer;
  bool _foreground = true;
  bool _shareTyping = true;
  bool _shareReadReceipts = true;
  MessagingPresence _ownPresence = MessagingPresence.available;
  bool get shareTyping => _shareTyping;
  bool get shareReadReceipts => _shareReadReceipts;
  MessagingPresence get ownPresence => _ownPresence;

  MessagingPresence presenceFor(String jid) {
    final peer = _canonicalPeer(jid);
    if (!online ||
        (!_knownPresence.contains(peer) &&
            !_directory.any((c) => c.jid == peer))) {
      return MessagingPresence.unknown;
    }
    return aggregatePresence(_presence[peer]?.values ?? const []);
  }

  bool isTyping(String jid) =>
      online && _typingResources.containsValue(_canonicalPeer(jid));

  void setActivitySharing({bool? typing, bool? readReceipts}) {
    if (!_accessAllowed || _disposed) return;
    if (typing == false && _typingPeer != null) {
      stopTyping(_typingPeer!);
    }
    _shareTyping = typing ?? _shareTyping;
    _shareReadReceipts = readReceipts ?? _shareReadReceipts;
    unawaited(_persist());
    notifyListeners();
  }

  void setPresence(MessagingPresence presence) {
    if (!_accessAllowed ||
        _disposed ||
        ![
          MessagingPresence.available,
          MessagingPresence.away,
          MessagingPresence.busy,
        ].contains(presence)) {
      return;
    }
    _ownPresence = presence;
    if (online) _sendPresence();
    unawaited(_persist());
    notifyListeners();
  }

  void _sendPresence({bool unavailable = false}) => _send(
    _element(
      'presence',
      _client,
      attributes: unavailable ? {'type': 'unavailable'} : const {},
      children: [
        if (!unavailable && _ownPresence != MessagingPresence.available)
          _element(
            'show',
            _client,
            text: _ownPresence == MessagingPresence.busy ? 'dnd' : 'away',
          ),
      ],
    ),
  );

  void _presenceMessage(XmlElement stanza) {
    final from = stanza.getAttribute('from');
    if (from == null) return;
    final peer = _canonicalPeer(from);
    try {
      recipientJid(peer);
    } on ArgumentError {
      return;
    }
    if (peer == _account) return;
    final type = stanza.getAttribute('type');
    if (type != null && type != 'unavailable') return;
    if (!_knownPresence.contains(peer) && _knownPresence.length >= 2000) return;
    _knownPresence.add(peer);
    final resources = _presence.putIfAbsent(peer, () => {});
    if (type == 'unavailable') {
      if (from.contains('/')) {
        resources.remove(from);
        _clearTypingResource(from);
      } else {
        resources.clear();
        for (final resource
            in _typingResources.entries
                .where((e) => e.value == peer)
                .map((e) => e.key)
                .toList()) {
          _clearTypingResource(resource);
        }
      }
    } else {
      if (resources.length >= 32 && !resources.containsKey(from)) return;
      resources[from] = switch (stanza
          .getElement('show', namespace: _client)
          ?.innerText) {
        'away' || 'xa' => MessagingPresence.away,
        'dnd' => MessagingPresence.busy,
        _ => MessagingPresence.available,
      };
    }
    notifyListeners();
  }

  /// Stop exposing activity as soon as the app loses foreground focus, even
  /// during the inactive interval before iOS suspends the socket.
  void setForeground(bool foreground) {
    _foreground = foreground;
    if (!foreground && _typingPeer != null) stopTyping(_typingPeer!);
  }

  void prepareConversation(String value) {
    if (!online || !_accessAllowed) return;
    final peer = recipientJid(value);
    if (isRoom(peer)) {
      _chatStatePeers.add(peer);
      return;
    }
    if (peer == _account || !_discoveredPeers.add(peer)) return;
    unawaited(_discoverPeer(peer));
  }

  Future<void> _discoverPeer(String peer) async {
    final generation = _generation;
    try {
      final id = _id();
      final response = await _query(
        id,
        _element(
          'iq',
          _client,
          attributes: {'id': id, 'type': 'get', 'to': peer},
          children: [_element('query', _disco)],
        ),
        expectedFrom: peer,
      );
      if (generation != _generation ||
          response.getAttribute('type') != 'result') {
        return;
      }
      if (response
              .getElement('query', namespace: _disco)
              ?.findElements('feature', namespace: _disco)
              .any((f) => f.getAttribute('var') == _chatStates) ??
          false) {
        _chatStatePeers.add(peer);
      }
    } catch (_) {
      /* Old clients can continue plain text conversations. */
    }
  }

  void updateTyping(String value, {required bool composing}) {
    if (!online || !_foreground || !_shareTyping || !_accessAllowed) return;
    final peer = recipientJid(value);
    if (!_chatStatePeers.contains(peer)) {
      prepareConversation(peer);
      return;
    }
    if (_typingPeer != null && _typingPeer != peer) stopTyping(_typingPeer!);
    _typingIdle?.cancel();
    _typingPeer = peer;
    _sendChatState(peer, composing ? 'composing' : 'active');
    if (composing) {
      _typingIdle = Timer(_typingPause, () {
        if (online && _typingPeer == peer) _sendChatState(peer, 'paused');
      });
    }
  }

  void stopTyping(String value) {
    final peer = _canonicalPeer(value);
    if (_typingPeer == peer) {
      _typingIdle?.cancel();
      _typingPeer = null;
      if (online && _shareTyping) _sendChatState(peer, 'inactive');
    }
  }

  void _sendChatState(String peer, String state) {
    if (_sentChatStates[peer] == state) return;
    _sentChatStates[peer] = state;
    _send(
      _element(
        'message',
        _client,
        attributes: {'to': peer, 'type': isRoom(peer) ? 'groupchat' : 'chat'},
        children: [_element(state, _chatStates)],
      ),
    );
  }

  void _clearTypingResource(String resource) {
    _typingTimers.remove(resource)?.cancel();
    _typingResources.remove(resource);
  }

  void _receiveChatState(XmlElement message, String peer) {
    final resource = message.getAttribute('from')!;
    final states = message.childElements.where(
      (e) => e.namespaceUri == _chatStates,
    );
    final state = states.length == 1 ? states.single.name.local : null;
    if (['active', 'composing', 'paused', 'inactive', 'gone'].contains(state)) {
      _chatStatePeers.add(peer);
      _clearTypingResource(resource);
      if (state == 'composing' && _typingResources.length < 2000) {
        _typingResources[resource] = peer;
        _typingTimers[resource] = Timer(_typingExpiry, () {
          _clearTypingResource(resource);
          if (!_disposed) notifyListeners();
        });
      }
      notifyListeners();
    } else if (message.getElement('body', namespace: _client) != null) {
      _clearTypingResource(resource);
    }
  }

  /// The UI supplies the latest message actually visible on the current route.
  /// Push receipt, archive loading and background activity never call this.
  void markConversationDisplayed(String value, String id) {
    if (!online || !_foreground || !_accessAllowed) return;
    final peer = recipientJid(value);
    final message = _messages
        .where((m) => !m.outgoing && m.peer == peer && m.key == id)
        .firstOrNull;
    if (message == null || message.displayed) return;
    if (isRoom(peer)) {
      _markRoomDisplayed(peer, message);
      return;
    }
    _applyDisplayed(peer, id, outgoing: false);
    _rememberUpdate(
      ChatMessageUpdate(peer, id, outgoing: false, displayed: true),
    );
    if (_shareReadReceipts && message.markable) {
      _send(
        _element(
          'message',
          _client,
          attributes: {'to': peer, 'type': isRoom(peer) ? 'groupchat' : 'chat'},
          children: [
            _element('displayed', _markers, attributes: {'id': id}),
            _element('store', 'urn:xmpp:hints'),
          ],
        ),
      );
    }
    unawaited(_persist());
    notifyListeners();
  }

  bool _applyDisplayed(String peer, String id, {required bool outgoing}) {
    final anchor = _messages.indexWhere(
      (m) => m.peer == peer && m.id == id && m.outgoing == outgoing,
    );
    if (anchor < 0) return false;
    for (var i = 0; i <= anchor; i++) {
      final message = _messages[i];
      if (message.peer != peer || message.outgoing != outgoing) continue;
      if (outgoing) {
        message.advanceStatus(ChatMessageStatus.read);
      } else {
        message.displayed = true;
      }
    }
    return true;
  }

  void _rememberUpdate(ChatMessageUpdate update) {
    if (_recoveredUpdates.any(
      (u) =>
          u.peer == update.peer &&
          u.id == update.id &&
          u.outgoing == update.outgoing &&
          u.displayed == update.displayed,
    )) {
      return;
    }
    _recoveredUpdates.add(update);
    if (_recoveredUpdates.length > 500) _recoveredUpdates.removeAt(0);
  }

  void _reapplyUpdates() {
    _recoveredUpdates.removeWhere((update) {
      if (update.displayed) {
        _applyDisplayed(update.peer, update.id, outgoing: update.outgoing);
        return false; // Retain the watermark for older pages and reconnect.
      }
      final message = _messages
          .where(
            (m) => m.outgoing && m.peer == update.peer && m.id == update.id,
          )
          .firstOrNull;
      if (message == null) return false;
      message.advanceStatus(ChatMessageStatus.delivered);
      return true;
    });
  }

  String _domain = domain;
  Uri _endpoint = endpoint;
  String? _lastStorageAccount;
  String? _cursor;
  String? _oldest;
  bool _hasOlder = false;
  bool _historyBusy = false;
  bool _archiveSupported = false;
  bool _storageReady = false;
  bool _managedEnabled = false;
  String? _historyError;
  MessagingConfiguration? _managed;
  int _accountGeneration = 0;
  final List<MessagingContact> _directory = [];
  bool _directoryBusy = false;
  String? _directoryError;
  List<MessagingContact> get directory => List.unmodifiable(_directory);
  bool get directoryBusy => _directoryBusy;
  String? get directoryError => _directoryError;
  String? get accountNumber {
    final parts = (_account ?? _managed?.jid ?? '').split('@').first.split('*');
    return parts.length == 2 && parts.every((p) => p.isNotEmpty)
        ? parts.first
        : null;
  }

  String extensionFor(String jid) {
    final contact = _directory
        .where((c) => c.jid == _canonicalPeer(jid))
        .firstOrNull;
    if (contact != null) return contact.extension;
    final local = _bare(jid).split('@').first;
    return local.contains('*') ? local.split('*').last : local;
  }

  String contactLabel(String jid) =>
      _rooms[jid]?.name ??
      _rooms.values
          .expand((r) => r.members)
          .where((m) => m.jid == jid)
          .firstOrNull
          ?.label ??
      _directory
          .where((c) => c.jid == _canonicalPeer(jid))
          .firstOrNull
          ?.label ??
      extensionFor(jid);

  bool get managedEnabled => _managedEnabled;
  bool get historyBusy => _historyBusy;
  bool get hasOlder => _hasOlder;
  String? get historyError => _historyError;

  void configureManaged(MessagingConfiguration? configuration) {
    _managedEnabled = configuration?.enabled ?? false;
    final previous = _managed;
    _managed = configuration;
    if (!_accessAllowed) return;
    if (configuration == null || !configuration.enabled) {
      if (previous?.enabled == true) disconnect(clearMessages: true);
      return;
    }
    if (!configuration.ready) {
      disconnect(clearMessages: true);
      _error =
          'Your messaging account is being prepared. Refresh provisioning shortly.';
      _setState(XmppState.disconnected);
      return;
    }
    if (!configuration.configured) {
      disconnect(clearMessages: true);
      _error =
          'Messaging configuration is incomplete. Contact your administrator.';
      _setState(XmppState.failed);
      return;
    }
    if (previous?.jid == configuration.jid &&
        previous?.password == configuration.password &&
        previous?.websocket == configuration.websocket &&
        (_wanted ||
            state == XmppState.failed ||
            state == XmppState.connecting)) {
      return;
    }
    unawaited(
      _connectAccount(
        configuration.jid,
        configuration.password,
        Uri.parse(configuration.websocket),
      ),
    );
  }

  Future<void> reconnect() async {
    final configuration = _managed;
    if (!_accessAllowed ||
        configuration == null ||
        !configuration.configured ||
        !configuration.ready) {
      return;
    }
    await _connectAccount(
      configuration.jid,
      configuration.password,
      Uri.parse(configuration.websocket),
    );
  }

  final WebSocketChannel Function(Uri) _channelFactory;
  final List<ChatMessage> _messages = [];
  final Set<String> _migratedHistoryAccounts = {};
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
  String? get account => _account;
  bool get online => state == XmppState.online;
  bool get accessAllowed => _accessAllowed;
  List<ChatMessage> get messages => List.unmodifiable(
    _messages.where(
      (m) => !m.peer.contains('@rooms.') || _rooms.containsKey(m.peer),
    ),
  );
  List<String> get events => List.unmodifiable(_events);

  /// Only VoiceHost test users are accepted here. Production credentials will
  /// be supplied by managed provisioning in a later milestone.
  Future<void> connect({
    required String username,
    required String password,
  }) async {
    if (!_accessAllowed || _disposed) throw StateError('Messaging is locked.');
    if (_managedEnabled) {
      throw StateError('Messaging account is managed by provisioning.');
    }
    final localpart = username.trim().toLowerCase();
    if (!RegExp(r'^[a-zA-Z0-9._+*\-]+$').hasMatch(localpart) ||
        password.isEmpty ||
        password.contains('\u0000')) {
      throw ArgumentError('Enter a username (without @domain) and password.');
    }
    await _connectAccount('$localpart@$domain', password, endpoint);
  }

  Future<void> _connectAccount(
    String account,
    String password,
    Uri endpoint,
  ) async {
    if (!_accessAllowed || _disposed) return;
    _wanted = false;
    _closeTransport();
    final accountGeneration = ++_accountGeneration;
    _messages.clear();
    _rooms.clear();
    _roomOldest.clear();
    _roomLatest.clear();
    _roomHasOlder.clear();
    _roomReadAnchors.clear();
    _roomHistoryErrors.clear();
    _migratedHistoryAccounts.clear();
    _directory.clear();
    _directoryError = null;
    _storageReady = false;
    _historyError = null;
    _cursor = null;
    _oldest = null;
    _hasOlder = false;
    _recoveredUpdates.clear();
    _shareTyping = true;
    _shareReadReceipts = true;
    _ownPresence = MessagingPresence.available;
    _account = account;
    _domain = account.split('@').last;
    _endpoint = endpoint;
    _lastStorageAccount = _storageAccount;
    final storageAccount = _storageAccount!;
    _username = account.split('@').first;
    _password = password;
    _setState(XmppState.connecting);
    try {
      await _storageQueue;
      final snapshot = await _history.load(storageAccount);
      if (_disposed || accountGeneration != _accountGeneration) return;
      void mergeHistory(ChatHistorySnapshot history) {
        for (final message in history.messages) {
          try {
            final peer = MessagingRoom.validJid(message.peer, _domain)
                ? message.peer
                : recipientJid(message.peer);
            if (_messages.any(
              (m) =>
                  m.id == message.id &&
                  m.peer == peer &&
                  m.senderJid == message.senderJid &&
                  m.outgoing == message.outgoing &&
                  m.body == message.body,
            )) {
              continue;
            }
            _messages.add(
              ChatMessage.fromJson({...message.toJson(), 'peer': peer}),
            );
          } on ArgumentError {
            // A historical conversation can never escape the current tenant.
          }
        }
      }

      mergeHistory(snapshot);
      _shareTyping = snapshot.shareTyping;
      _shareReadReceipts = snapshot.shareReadReceipts;
      _ownPresence = snapshot.presence;
      for (final update in snapshot.statusUpdates) {
        try {
          recipientJid(update.peer);
          _rememberUpdate(update);
        } on ArgumentError {
          /* Ignore metadata outside this account. */
        }
      }
      _migratedHistoryAccounts.addAll(snapshot.migratedAccounts);
      _cursor = snapshot.cursor;
      _oldest = snapshot.oldest;
      _hasOlder = snapshot.hasOlder;
      var migrated = false;
      for (final previous in _managed?.previousJids ?? const <String>[]) {
        if (previous == account ||
            _canonicalPeer(previous) != account ||
            !_isCanonicalAccount) {
          continue;
        }
        final previousStorage = '$previous|$endpoint';
        if (_migratedHistoryAccounts.contains(previousStorage)) continue;
        try {
          final history = await _history.load(previousStorage);
          if (_disposed || accountGeneration != _accountGeneration) return;
          mergeHistory(history);
          _migratedHistoryAccounts.add(previousStorage);
          migrated = true;
        } catch (_) {
          _historyError =
              'Some earlier saved history could not be opened. Archive recovery will still be attempted.';
        }
      }
      _messages.sort((a, b) => a.timestamp.compareTo(b.timestamp));
      _reapplyUpdates();
      if (migrated) {
        // Cursors belonged to separate archives; recover the canonical archive.
        _cursor = null;
        _oldest = null;
        _hasOlder = true;
      }
      _storageReady = true;
      if (migrated) await _persist(requireSuccess: true);
    } catch (_) {
      if (_disposed || accountGeneration != _accountGeneration) return;
      // Do not overwrite an unreadable cache with an empty history.
      _historyError =
          'Saved history could not be opened. Archive recovery will still be attempted.';
    }
    if (!_accessAllowed ||
        _disposed ||
        accountGeneration != _accountGeneration) {
      return;
    }
    _wanted = true;
    _attempts = 0;
    if (_paused) {
      _setState(XmppState.paused);
      return;
    }
    await _open();
  }

  String? get _storageAccount =>
      _account == null ? null : '$_account|$_endpoint';

  Future<void> flushHistory() => _storageQueue;

  Future<void> _persist({bool requireSuccess = false}) {
    final account = _storageAccount;
    if (!_storageReady || account == null) {
      return requireSuccess
          ? Future.error(StateError('History unavailable.'))
          : Future.value();
    }
    var start = _messages.length > 2000 ? _messages.length - 2000 : 0;
    var bytes = 0;
    for (var index = _messages.length - 1; index >= start; index--) {
      bytes += utf8.encode(_messages[index].body).length + 1024;
      if (bytes > 4 * 1024 * 1024) {
        start = index + 1;
        break;
      }
    }
    final recent = _messages.sublist(start);
    final clipped = recent.length < _messages.length;
    final snapshot = ChatHistorySnapshot.fromJson(
      ChatHistorySnapshot(
        messages: recent,
        cursor: _cursor,
        oldest: clipped
            ? recent.where((m) => m.archiveId != null).firstOrNull?.archiveId
            : _oldest,
        hasOlder: _hasOlder || clipped,
        migratedAccounts: _migratedHistoryAccounts.toList(),
        shareTyping: _shareTyping,
        shareReadReceipts: _shareReadReceipts,
        presence: _ownPresence,
        statusUpdates: _recoveredUpdates.toList(),
      ).toJson(),
    );
    final operation = _storageQueue.then(
      (_) => _history.save(account, snapshot),
    );
    final accountGeneration = _accountGeneration;
    _storageQueue = operation.catchError((Object _) {
      if (!_disposed && accountGeneration == _accountGeneration) {
        _historyError =
            'History could not be saved on this device. Please try again.';
        notifyListeners();
      }
    });
    return requireSuccess ? operation : _storageQueue;
  }

  Future<void> forgetHistory() async {
    final account = _storageAccount ?? _lastStorageAccount;
    final aliases = Set<String>.from(_migratedHistoryAccounts);
    for (final previous in _managed?.previousJids ?? const <String>[]) {
      if (_isCanonicalAccount &&
          _canonicalPeer(previous) == _account &&
          previous != _account) {
        aliases.add('$previous|$_endpoint');
      }
    }
    _migratedHistoryAccounts.clear();
    _lastStorageAccount = null;
    disconnect(clearMessages: true);
    if (account == null) return;
    final operation = _storageQueue.then((_) async {
      await _history.delete(account);
      for (final alias in aliases) {
        await _history.delete(alias);
      }
    });
    _storageQueue = operation.catchError((Object _) {
      if (!_disposed) {
        _historyError = 'Saved history could not be removed from this device.';
        notifyListeners();
      }
    });
    await _storageQueue;
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
      channel = _channelFactory(_endpoint);
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
      attributes: {'to': _domain, 'version': '1.0', 'xml:lang': 'en'},
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
        } else if (name == 'presence' && ns == _client && online) {
          _presenceMessage(element);
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
    final from = iq.getAttribute('from');
    if (id != null && _pendingIq.containsKey(id)) {
      final expected = _pendingIqFrom[id];
      if (expected != null) {
        if (from == null || _bare(from) != expected) return;
      } else if (from != null && _bare(from) != _account && from != _domain) {
        return;
      }
      if (type == 'result' || type == 'error') {
        _pendingIq.remove(id)!.complete(iq);
      }
      return;
    }
    if (id == _bindId && _bindId != null && state == XmppState.binding) {
      if (type != 'result') {
        _fail('XMPP resource binding was rejected.');
        return;
      }
      final bound = iq
          .getElement('bind', namespace: _bind)
          ?.getElement('jid', namespace: _bind)
          ?.innerText;
      if (bound == null || _bare(bound) != _account) {
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
        id != null &&
        iq.getElement('query', namespace: _disco) != null &&
        from != null) {
      try {
        recipientJid(_bare(from));
      } on ArgumentError {
        return;
      }
      _send(
        _element(
          'iq',
          _client,
          attributes: {'id': id, 'type': 'result', 'to': from},
          children: [
            _element(
              'query',
              _disco,
              children: [
                for (final feature in [
                  _chatStates,
                  _markers,
                  _receipts,
                  ChatAttachment.namespace,
                ])
                  _element('feature', _disco, attributes: {'var': feature}),
              ],
            ),
          ],
        ),
      );
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

  MessagingPushSubscription? _pushSubscription;
  String? _enabledPushNode;
  String? _pushError;
  bool _pushBusy = false;
  String get notificationStatus =>
      _pushError ??
      (_enabledPushNode != null
          ? 'Notifications registered'
          : _pushSubscription == null
          ? 'Notifications not configured'
          : 'Notifications awaiting registration');

  void configurePush(MessagingPushSubscription? subscription) {
    if (subscription != null && subscription.ownerJid != _managed?.jid) {
      return;
    }
    if (_pushSubscription?.node == subscription?.node) {
      if (online && _enabledPushNode == null) {
        unawaited(_syncPush());
      }
      return;
    }
    final previous = _pushSubscription;
    _pushSubscription = subscription;
    if (online) {
      unawaited(_syncPush(previous: previous));
    }
  }

  Future<void> _syncPush({MessagingPushSubscription? previous}) async {
    if (!online || _pushBusy) {
      return;
    }
    final generation = _generation;
    final subscription = _pushSubscription;
    _pushBusy = true;
    try {
      if (previous != null &&
          previous.ownerJid == _account &&
          previous.node != subscription?.node) {
        final id = _id();
        await _query(
          id,
          _element(
            'iq',
            _client,
            attributes: {'id': id, 'type': 'set', 'to': _account!},
            children: [
              _element(
                'disable',
                'urn:xmpp:push:0',
                attributes: {'jid': previous.jid, 'node': previous.node},
              ),
            ],
          ),
        );
      }
      if (generation != _generation) {
        return;
      }
      if (subscription == null ||
          subscription.ownerJid != _account ||
          !_accessAllowed) {
        _enabledPushNode = null;
        return;
      }
      final id = _id();
      final response = await _query(
        id,
        _element(
          'iq',
          _client,
          attributes: {'id': id, 'type': 'set', 'to': _account!},
          children: [
            _element(
              'enable',
              'urn:xmpp:push:0',
              attributes: {'jid': subscription.jid, 'node': subscription.node},
            ),
          ],
        ),
      );
      if (generation != _generation || subscription != _pushSubscription) {
        return;
      }
      if (response.getAttribute('type') != 'result') {
        throw StateError('Push registration rejected.');
      }
      _enabledPushNode = subscription.node;
      _pushError = null;
    } catch (_) {
      if (generation == _generation) {
        _pushError =
            'Messaging notification registration failed; reconnect to retry.';
      }
    } finally {
      _pushBusy = false;
      if (!_disposed) {
        if (generation == _generation) {
          notifyListeners();
        }
        if (online &&
            (generation != _generation || subscription != _pushSubscription)) {
          unawaited(_syncPush(previous: subscription));
        }
      }
    }
  }

  void _becomeOnline() {
    _deadline?.cancel();
    _attempts = 0;
    _sendPresence();
    _setState(XmppState.online);
    unawaited(_enableCarbons());
    unawaited(_recoverHistory());
    if (accountNumber != null) unawaited(refreshDirectory());
    unawaited(_syncPush());
    unawaited(refreshRooms());
    _roomTimer?.cancel();
    _roomTimer = Timer.periodic(const Duration(seconds: 30), (_) {
      if (_foreground && online) unawaited(refreshRooms());
    });
  }

  Future<void> _enableCarbons() async {
    final generation = _generation;
    try {
      final id = _id();
      final response = await _query(
        id,
        _element(
          'iq',
          _client,
          attributes: {'id': id, 'type': 'set', 'to': _account!},
          children: [_element('enable', _carbons)],
        ),
      );
      if (generation == _generation &&
          response.getAttribute('type') != 'result') {
        _event('Live device synchronization unavailable');
      }
    } catch (_) {
      if (generation == _generation) {
        _event('Live device synchronization unavailable');
      }
    }
  }

  String recipientJid(String value) {
    final clean = value.trim().toLowerCase();
    if (_rooms.containsKey(clean) &&
        _rooms[clean]!.roleFor(_account).isNotEmpty) {
      return clean;
    }
    final number = accountNumber;
    if (number != null && !clean.contains('@') && !clean.contains('*')) {
      final matches = _directory.where((c) => c.extension == clean).toList();
      if (matches.length == 1) return matches.single.jid;
      if (matches.length > 1) {
        throw ArgumentError('Choose a user from the directory.');
      }
    }
    final local = number != null && !clean.contains('@') && !clean.contains('*')
        ? '$number*$clean'
        : clean;
    final jid = local.contains('@') ? local : '$local@$_domain';
    if (!RegExp(r'^[a-z0-9._+*\-]+$').hasMatch(jid.split('@').first) ||
        jid.split('@').length != 2 ||
        jid.split('@').last != _domain) {
      throw ArgumentError('Enter a local username or a JID at $_domain.');
    }
    if (number != null) {
      final parts = jid.split('@').first.split('*');
      if (parts.length != 2 || parts.first != number || parts.last.isEmpty) {
        throw ArgumentError('Choose an extension in your account.');
      }
    } else if (_managedEnabled) {
      throw ArgumentError('Your messaging account needs an account number.');
    }
    final canonical = _canonicalPeer(jid);
    if (_isCanonicalAccount &&
        !RegExp(r'^[0-9]+\*[0-9]{3,5}@').hasMatch(canonical)) {
      throw ArgumentError('Enter an extension of 3–5 digits in your account.');
    }
    return canonical;
  }

  bool get _isCanonicalAccount =>
      _managedEnabled &&
      RegExp(r'^[0-9]+\*[0-9]{3,5}@').hasMatch(_account ?? '');

  String _canonicalPeer(String value) {
    final bare = _bare(value).toLowerCase();
    if (!_isCanonicalAccount) return bare;
    final parts = bare.split('@');
    if (parts.length != 2 || parts.last != _domain) return bare;
    final match = RegExp(
      r'^([0-9]+)\*([0-9]{3,5})[a-z]*$',
    ).firstMatch(parts.first);
    if (match == null || match.group(1) != accountNumber) return bare;
    return '${match.group(1)}*${match.group(2)}@$_domain';
  }

  Future<void> refreshDirectory() async {
    if (!online || _directoryBusy || accountNumber == null) return;
    final generation = _generation;
    _directoryBusy = true;
    _directoryError = null;
    notifyListeners();
    try {
      final id = _id();
      final response = await _query(
        id,
        _element(
          'iq',
          _client,
          attributes: {'id': id, 'type': 'get', 'to': _account!},
          children: [_element('query', _roster)],
        ),
      );
      if (generation != _generation) return;
      final query = response.getElement('query', namespace: _roster);
      if (response.getAttribute('type') != 'result' || query == null) {
        throw StateError('Directory unavailable');
      }
      final contacts = <String, MessagingContact>{};
      for (final item in query.findElements('item', namespace: _roster)) {
        final raw = item.getAttribute('jid');
        if (raw == null || item.getAttribute('subscription') == 'remove') {
          continue;
        }
        try {
          final peer = recipientJid(raw);
          if (peer == _account || raw.contains('/')) continue;
          final aliases = item
              .findElements('group', namespace: _roster)
              .map((g) => g.innerText)
              .where((g) => g.startsWith('VoiceHost extension:'));
          final address = _isCanonicalAccount || aliases.isEmpty
              ? extensionFor(peer)
              : aliases.first.substring('VoiceHost extension:'.length);
          if (!RegExp(r'^[a-z0-9._+\-]{1,80}$').hasMatch(address)) continue;
          contacts[peer] = MessagingContact(
            jid: peer,
            extension: address,
            name: item.getAttribute('name') ?? '',
          );
        } on ArgumentError {
          continue;
        }
      }
      _directory
        ..clear()
        ..addAll(contacts.values);
      _directory.sort((a, b) => a.extension.compareTo(b.extension));
      // A membership update can arrive after our initial presence broadcast.
      // Refresh each permitted contact's current resources without requiring
      // either phone to reconnect. The server still enforces tenant policy.
      for (final contact in _directory) {
        _send(
          _element(
            'presence',
            _client,
            attributes: {'type': 'probe', 'to': contact.jid},
          ),
        );
      }
    } catch (_) {
      if (generation == _generation) {
        _directory.clear();
        _directoryError =
            'The account directory could not be loaded. Tap Refresh to retry.';
      }
    } finally {
      if (generation == _generation && !_disposed) {
        _directoryBusy = false;
        notifyListeners();
      }
    }
  }

  void sendMessage({
    required String recipient,
    required String body,
    ChatAttachment? attachment,
  }) {
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
        attributes: {
          'id': id,
          'type': isRoom(peer) ? 'groupchat' : 'chat',
          'to': peer,
        },
        children: [
          _element('body', _client, text: body),
          if (attachment != null)
            _element(
              'attachment',
              ChatAttachment.namespace,
              attributes: {
                'id': attachment.id,
                'name': attachment.name,
                'media-type': attachment.mediaType,
                'size': attachment.size.toString(),
                'sha256': attachment.sha256,
              },
            ),
          if (!isRoom(peer)) _element('request', _receipts),
          _element('markable', _markers),
          if (_shareTyping) _element('active', _chatStates),
          _element('origin-id', _sid, attributes: {'id': id}),
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
        attachment: attachment,
        senderJid: isRoom(peer) ? _account : null,
      ),
    );
    if (_shareTyping) _sentChatStates[peer] = 'active';
    if (_typingPeer == peer) {
      _typingIdle?.cancel();
      _typingPeer = null;
    }
    _trimMessages();
    unawaited(_persist());
    _event('Text message sent');
    notifyListeners();
  }

  ChatAttachment? _attachment(XmlElement message) {
    final elements = message
        .findElements('attachment', namespace: ChatAttachment.namespace)
        .toList();
    if (elements.length != 1) return null;
    final element = elements.single;
    return ChatAttachment.tryFromJson({
      'id': element.getAttribute('id'),
      'name': element.getAttribute('name'),
      'media_type': element.getAttribute('media-type'),
      'size': int.tryParse(element.getAttribute('size') ?? ''),
      'sha256': element.getAttribute('sha256'),
    });
  }

  void _message(XmlElement message) {
    final result = message.getElement('result', namespace: _mam);
    if (result != null) {
      _archiveMessage(message, result);
      return;
    }
    if (_roomEnvelope(message)) return;
    final carbon = message.childElements
        .where(
          (e) =>
              e.namespaceUri == _carbons &&
              ['sent', 'received'].contains(e.name.local),
        )
        .toList();
    if (carbon.isNotEmpty) {
      // Only the server-generated wrapper from our exact bare JID is trusted.
      // A contact cannot forge a forwarded message or read another peer's chat.
      if (message.getAttribute('from') != _account || carbon.length != 1) {
        return;
      }
      final forwarded = carbon.single.getElement(
        'forwarded',
        namespace: _forward,
      );
      final inner = forwarded?.getElement('message', namespace: _client);
      if (inner == null ||
          inner.childElements.any((e) => e.namespaceUri == _carbons)) {
        return;
      }
      final outgoing = carbon.single.name.local == 'sent';
      if (_bare(inner.getAttribute(outgoing ? 'from' : 'to') ?? '') !=
          _account) {
        return;
      }
      _liveMessage(inner, outgoing: outgoing, carbon: true);
      return;
    }
    _liveMessage(message);
  }

  void _liveMessage(
    XmlElement message, {
    bool outgoing = false,
    bool carbon = false,
  }) {
    if (![
      'chat',
      'normal',
      null,
      'error',
    ].contains(message.getAttribute('type'))) {
      return;
    }
    final from = message.getAttribute('from');
    if (from == null) return;
    final peer = _canonicalPeer(
      outgoing ? message.getAttribute('to') ?? '' : from,
    );
    try {
      recipientJid(peer);
    } catch (_) {
      return;
    }
    final id = outgoing
        ? message
                  .getElement('origin-id', namespace: _sid)
                  ?.getAttribute('id') ??
              message.getAttribute('id')
        : message.getAttribute('id');
    if (message.getAttribute('type') == 'error') {
      _updateStatus(id, peer, ChatMessageStatus.failed);
      return;
    }
    final receipt = message.getElement('received', namespace: _receipts);
    if (receipt != null && !outgoing) {
      _updateStatus(
        receipt.getAttribute('id'),
        peer,
        ChatMessageStatus.delivered,
      );
    }
    final displayed = message
        .getElement('displayed', namespace: _markers)
        ?.getAttribute('id');
    if (displayed != null &&
        _applyDisplayed(peer, displayed, outgoing: !outgoing)) {
      _rememberUpdate(
        ChatMessageUpdate(
          peer,
          displayed,
          outgoing: !outgoing,
          displayed: true,
        ),
      );
      unawaited(_persist());
      notifyListeners();
    }
    if (!outgoing && message.getAttribute('type') != 'error') {
      _receiveChatState(message, peer);
    }
    final body = message.getElement('body', namespace: _client)?.innerText;
    if (body == null ||
        body.isEmpty ||
        body.length > 10000 ||
        !['chat', 'normal', null].contains(message.getAttribute('type'))) {
      return;
    }
    if (!outgoing &&
        !carbon &&
        id != null &&
        message.getElement('request', namespace: _receipts) != null) {
      _send(
        _element(
          'message',
          _client,
          attributes: {'to': from, 'type': 'chat'},
          children: [
            _element('received', _receipts, attributes: {'id': id}),
            _element('store', 'urn:xmpp:hints'),
          ],
        ),
      );
    }
    if (id != null &&
        _messages.any(
          (m) =>
              m.outgoing == outgoing &&
              m.id == id &&
              m.peer == peer &&
              m.body == body,
        )) {
      return;
    }
    final delay = message.getElement('delay', namespace: 'urn:xmpp:delay');
    _messages.add(
      ChatMessage(
        id: id ?? _id(),
        peer: peer,
        body: body,
        outgoing: outgoing,
        timestamp:
            DateTime.tryParse(delay?.getAttribute('stamp') ?? '')?.toLocal() ??
            DateTime.now(),
        status: outgoing ? ChatMessageStatus.sent : ChatMessageStatus.received,
        archiveId: _trustedArchiveId(message),
        attachment: _attachment(message),
        markable:
            !outgoing &&
            id != null &&
            message.getElement('markable', namespace: _markers) != null,
      ),
    );
    _trimMessages();
    unawaited(_persist());
    _event(
      outgoing
          ? 'Message synchronized from another device'
          : 'Text message received',
    );
    notifyListeners();
  }

  void _updateStatus(String? id, String peer, ChatMessageStatus status) {
    if (id == null) return;
    for (final message in _messages) {
      if (message.outgoing && message.id == id && message.peer == peer) {
        if (!message.advanceStatus(status)) return;
        unawaited(_persist());
        notifyListeners();
        break;
      }
    }
  }

  void _trimMessages() {
    _messages.sort((a, b) => a.timestamp.compareTo(b.timestamp));
    // Keep a bounded recent cache; older history can be loaded from MAM.
    if (_messages.length > 2000) {
      _messages.removeRange(0, _messages.length - 2000);
      _hasOlder = true;
      _oldest = _messages
          .where((m) => m.archiveId != null)
          .firstOrNull
          ?.archiveId;
    }
  }

  String? _trustedArchiveId(XmlElement message) {
    if (!_archiveSupported) return null;
    for (final stanza in message.findElements('stanza-id', namespace: _sid)) {
      if (stanza.getAttribute('by') == _account) {
        return stanza.getAttribute('id');
      }
    }
    return null;
  }

  Future<XmlElement> _query(
    String id,
    XmlElement stanza, {
    String? expectedFrom,
  }) async {
    final completer = Completer<XmlElement>();
    _pendingIq[id] = completer;
    if (expectedFrom != null) _pendingIqFrom[id] = expectedFrom;
    _send(stanza);
    try {
      return await completer.future.timeout(const Duration(seconds: 15));
    } finally {
      _pendingIq.remove(id);
      _pendingIqFrom.remove(id);
    }
  }

  Future<void> _recoverHistory() async {
    final generation = _generation;
    _historyBusy = true;
    _archiveSupported = false;
    notifyListeners();
    try {
      final id = _id();
      final response = await _query(
        id,
        _element(
          'iq',
          _client,
          attributes: {'id': id, 'type': 'get', 'to': _account!},
          children: [_element('query', _disco)],
        ),
      );
      if (generation != _generation) return;
      _archiveSupported =
          response.getAttribute('type') == 'result' &&
          (response
                  .getElement('query', namespace: _disco)
                  ?.findElements('feature', namespace: _disco)
                  .any((f) => f.getAttribute('var') == _mam) ??
              false);
      if (!_archiveSupported) {
        _historyError =
            'Server archive is unavailable. Only saved messages are shown.';
        return;
      }
      if (_cursor == null) {
        await _archivePage(before: '');
      } else {
        try {
          await _catchUp();
        } on _ArchiveCursorExpired {
          // Retention/reconfigured archive: recover its recent page without
          // discarding the local cache. Old gaps may no longer exist on server.
          _cursor = null;
          await _archivePage(before: '');
          _historyError =
              'The archive cursor expired. Recent available history was recovered.';
        }
      }
    } catch (_) {
      if (generation == _generation) {
        _historyError ??= 'Archive recovery did not finish. Tap Retry history.';
      }
    } finally {
      if (generation == _generation && !_disposed) {
        _historyBusy = false;
        notifyListeners();
      }
    }
  }

  Future<void> retryHistory() async {
    if (!online || _historyBusy) return;
    if (_storageReady) _historyError = null;
    await _recoverHistory();
  }

  Future<void> _catchUp() async {
    for (var page = 0; page < 50; page++) {
      if (await _archivePage(after: _cursor)) return;
    }
    throw StateError('Archive catch-up limit reached.');
  }

  Future<void> loadOlder() async {
    if (!online ||
        _historyBusy ||
        !_archiveSupported ||
        !_hasOlder ||
        _oldest == null) {
      return;
    }
    final generation = _generation;
    _historyBusy = true;
    notifyListeners();
    try {
      await _archivePage(before: _oldest);
    } catch (_) {
      if (generation == _generation) {
        _historyError = 'Older history could not be loaded. Try again.';
      }
    } finally {
      if (generation == _generation && !_disposed) {
        _historyBusy = false;
        notifyListeners();
      }
    }
  }

  Future<bool> _archivePage({String? before, String? after}) async {
    final generation = _generation;
    final id = _id();
    final queryId = _id();
    final results = <ChatMessage>[];
    final updates = <ChatMessageUpdate>[];
    _archiveResults[queryId] = results;
    _archiveUpdates[queryId] = updates;
    try {
      final response = await _query(
        id,
        _element(
          'iq',
          _client,
          attributes: {'id': id, 'type': 'set', 'to': _account!},
          children: [
            _element(
              'query',
              _mam,
              attributes: {'queryid': queryId},
              children: [
                _element(
                  'x',
                  'jabber:x:data',
                  attributes: {'type': 'submit'},
                  children: [
                    _element(
                      'field',
                      'jabber:x:data',
                      attributes: {'var': 'FORM_TYPE', 'type': 'hidden'},
                      children: [
                        _element('value', 'jabber:x:data', text: _mam),
                      ],
                    ),
                  ],
                ),
                _element(
                  'set',
                  _rsm,
                  children: [
                    _element('max', _rsm, text: '100'),
                    if (before != null) _element('before', _rsm, text: before),
                    if (after != null) _element('after', _rsm, text: after),
                  ],
                ),
              ],
            ),
          ],
        ),
      );
      if (generation != _generation) throw StateError('Archive cancelled.');
      if (response.getAttribute('type') == 'error') {
        if (response
                .getElement('error', namespace: _client)
                ?.getElement(
                  'item-not-found',
                  namespace: 'urn:ietf:params:xml:ns:xmpp-stanzas',
                ) !=
            null) {
          throw _ArchiveCursorExpired();
        }
        throw StateError('Archive request rejected.');
      }
      final fin = response.getElement('fin', namespace: _mam);
      if (fin == null) throw StateError('Missing archive completion.');
      final complete = ['true', '1'].contains(fin.getAttribute('complete'));
      final set = fin.getElement('set', namespace: _rsm);
      final first = set?.getElement('first', namespace: _rsm)?.innerText;
      final last = set?.getElement('last', namespace: _rsm)?.innerText;
      if ((!complete || results.isNotEmpty || updates.isNotEmpty) &&
          (first == null || first.isEmpty || last == null || last.isEmpty)) {
        throw StateError('Missing archive cursors.');
      }
      if (after != null && !complete && last == after) {
        throw StateError('Archive did not advance.');
      }
      for (final message in results) {
        final existing = _messages
            .where(
              (m) =>
                  (m.archiveId != null && m.archiveId == message.archiveId) ||
                  (m.id == message.id &&
                      m.peer == message.peer &&
                      m.outgoing == message.outgoing &&
                      m.body == message.body),
            )
            .firstOrNull;
        if (existing == null) {
          _messages.add(message);
        } else {
          existing.archiveId = message.archiveId;
          existing.markable = existing.markable || message.markable;
        }
      }
      _messages.sort((a, b) => a.timestamp.compareTo(b.timestamp));
      for (final update in updates) {
        _rememberUpdate(update);
      }
      _reapplyUpdates();
      final oldCursor = _cursor;
      final oldOldest = _oldest;
      final oldHasOlder = _hasOlder;
      if (before != null) {
        if (first != null && first.isNotEmpty) _oldest = first;
        _hasOlder = !complete;
        if (before.isEmpty && last != null && last.isNotEmpty) _cursor = last;
      } else if (last != null && last.isNotEmpty) {
        _cursor = last;
      }
      _messages.sort((a, b) => a.timestamp.compareTo(b.timestamp));
      // Older pages are visible for this session. The persistent cache holds
      // the newest 2,000 messages and its own oldest available archive cursor.
      try {
        await _persist(requireSuccess: true);
      } catch (_) {
        if (generation == _generation) {
          _cursor = oldCursor;
          _oldest = oldOldest;
          _hasOlder = oldHasOlder;
        }
        rethrow;
      }
      if (generation != _generation) throw StateError('Archive cancelled.');
      notifyListeners();
      return complete;
    } finally {
      _archiveResults.remove(queryId);
      _archiveUpdates.remove(queryId);
    }
  }

  void _archiveMessage(XmlElement wrapper, XmlElement result) {
    final room = _roomArchiveQueries[result.getAttribute('queryid')];
    if (room != null) {
      _roomArchive(wrapper, result, room);
      return;
    }
    final from = wrapper.getAttribute('from');
    if (from != null && _bare(from) != _account) return;
    final results = _archiveResults[result.getAttribute('queryid')];
    final updates = _archiveUpdates[result.getAttribute('queryid')];
    final archiveId = result.getAttribute('id');
    if (results == null ||
        updates == null ||
        results.length + updates.length >= 100 ||
        archiveId == null ||
        archiveId.isEmpty) {
      return;
    }
    final forwarded = result.getElement('forwarded', namespace: _forward);
    final message = forwarded?.getElement('message', namespace: _client);
    final stamp = forwarded
        ?.getElement('delay', namespace: 'urn:xmpp:delay')
        ?.getAttribute('stamp');
    final timestamp = DateTime.tryParse(stamp ?? '');
    if (message == null ||
        timestamp == null ||
        !['chat', 'normal', null].contains(message.getAttribute('type'))) {
      return;
    }
    final sender = _canonicalPeer(message.getAttribute('from') ?? '');
    final recipient = _canonicalPeer(message.getAttribute('to') ?? '');
    final outgoing = sender == _account;
    if (!outgoing && recipient != _account) return;
    final peer = outgoing ? recipient : sender;
    try {
      recipientJid(peer);
    } catch (_) {
      return;
    }
    final displayed = message
        .getElement('displayed', namespace: _markers)
        ?.getAttribute('id');
    if (displayed != null && displayed.isNotEmpty) {
      updates.add(
        ChatMessageUpdate(
          peer,
          displayed,
          outgoing: !outgoing,
          displayed: true,
        ),
      );
    }
    final receipt = message
        .getElement('received', namespace: _receipts)
        ?.getAttribute('id');
    if (!outgoing && receipt != null && receipt.isNotEmpty) {
      updates.add(ChatMessageUpdate(peer, receipt, outgoing: true));
    }
    final body = message.getElement('body', namespace: _client)?.innerText;
    if (body == null || body.isEmpty || body.length > 10000) return;
    final origin = outgoing
        ? message.getElement('origin-id', namespace: _sid)?.getAttribute('id')
        : null;
    results.add(
      ChatMessage(
        id: origin ?? message.getAttribute('id') ?? 'archive-$archiveId',
        peer: peer,
        body: body,
        outgoing: outgoing,
        timestamp: timestamp.toLocal(),
        status: outgoing ? ChatMessageStatus.sent : ChatMessageStatus.received,
        archiveId: archiveId,
        attachment: _attachment(message),
        markable:
            !outgoing &&
            message.getAttribute('id') != null &&
            message.getElement('markable', namespace: _markers) != null,
      ),
    );
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
    _accountGeneration++;
    _closeTransport();
    _username = null;
    _password = null;
    _boundJid = null;
    _error = null;
    if (clearMessages) {
      _messages.clear();
      _rooms.clear();
      _roomOldest.clear();
      _roomLatest.clear();
      _roomHasOlder.clear();
      _roomReadAnchors.clear();
      _roomHistoryErrors.clear();
      _directory.clear();
      _directoryError = null;
      _events.clear();
      _account = null;
      _storageReady = false;
      _cursor = null;
      _oldest = null;
      _hasOlder = false;
    }
    _setState(XmppState.disconnected);
  }

  void setAccessAllowed(bool allowed) {
    if (_accessAllowed == allowed) return;
    _accessAllowed = allowed;
    if (!allowed) {
      _managed = null;
      disconnect(clearMessages: true);
    } else if (!_disposed) {
      notifyListeners();
    }
  }

  void pause() {
    setForeground(false);
    if (online) _sendPresence(unavailable: true);
    _paused = true;
    _closeTransport();
    _boundJid = null;
    if (_wanted) _setState(XmppState.paused);
  }

  void resume() {
    setForeground(true);
    _paused = false;
    if (_wanted && state == XmppState.paused) unawaited(_open());
  }

  void _closeTransport() {
    _roomTimer?.cancel();
    _joinedRooms.clear();
    _roomsBusy = false;
    _roomHistoryBusy.clear();
    _roomArchiveQueries.clear();
    _roomArchiveCounts.clear();
    _typingIdle?.cancel();
    _typingPeer = null;
    for (final timer in _typingTimers.values) {
      timer.cancel();
    }
    _typingTimers.clear();
    _typingResources.clear();
    _sentChatStates.clear();
    _chatStatePeers.clear();
    _discoveredPeers.clear();
    _presence.clear();
    _knownPresence.clear();
    _enabledPushNode = null;
    _generation++;
    _directoryBusy = false;
    _historyBusy = false;
    for (final pending in _pendingIq.values) {
      pending.completeError(StateError('Connection closed.'));
    }
    _pendingIq.clear();
    _pendingIqFrom.clear();
    _archiveResults.clear();
    _archiveUpdates.clear();
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
    _accountGeneration++;
    _wanted = false;
    _password = null;
    _messages.clear();
    _rooms.clear();
    _roomOldest.clear();
    _roomLatest.clear();
    _roomHasOlder.clear();
    _roomReadAnchors.clear();
    _roomHistoryErrors.clear();
    _closeTransport();
    super.dispose();
  }
}

class _ArchiveCursorExpired implements Exception {}
