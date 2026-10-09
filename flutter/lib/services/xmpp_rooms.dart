part of 'xmpp_service.dart';

extension MessagingRooms on XmppService {
  List<MessagingRoom> get rooms => List.unmodifiable(_rooms.values);
  MessagingRoom? roomFor(String peer) => _rooms[peer];
  bool isRoom(String peer) => _rooms.containsKey(peer);
  int unreadFor(String peer) => messages
      .where((m) => m.peer == peer && !m.outgoing && !m.displayed)
      .length;
  bool roomHistoryBusy(String peer) => _roomHistoryBusy.contains(peer);
  bool roomHasOlder(String peer) => _roomHasOlder.contains(peer);
  String? roomHistoryError(String peer) => _roomHistoryErrors[peer];
  String roomTypingLabel(String peer) {
    final labels = _typingResources.entries
        .where((e) => e.value == peer)
        .map((e) => _roomSender(e.key))
        .whereType<String>()
        .map(contactLabel)
        .toSet();
    return labels.isEmpty
        ? '${_rooms[peer]?.members.length ?? 0} members'
        : '${labels.take(3).join(', ')} typing…';
  }

  Future<void> refreshRooms() async {
    if (_roomsBusy ||
        roomLoader == null ||
        !online ||
        !_accessAllowed ||
        !_isCanonicalAccount) {
      return;
    }
    final generation = _generation;
    _roomsBusy = true;
    try {
      final result = await roomLoader!();
      if (generation != _generation || !online || !_accessAllowed) return;
      replaceRooms(result);
      _roomsError = null;
    } catch (_) {
      if (generation == _generation) {
        _roomsError = 'Rooms could not be refreshed. Try again.';
      }
    } finally {
      if (generation == _generation) {
        _roomsBusy = false;
        if (!_disposed) _notifyRoomListeners();
      }
    }
  }

  void replaceRooms(List<MessagingRoom> rooms) {
    if (!_accessAllowed || _account == null) return;
    if (rooms.any(
      (r) =>
          !MessagingRoom.validJid(r.jid, _domain) ||
          r.roleFor(_account).isEmpty ||
          r.members.any(
            (m) => m.jid != '$accountNumber*${m.extension}@$_domain',
          ),
    )) {
      throw const FormatException('Room belongs to another account');
    }
    final previous = Map<String, MessagingRoom>.of(_rooms);
    final next = {for (final room in rooms) room.jid: room};
    for (final peer
        in _rooms.keys.where((p) => !next.containsKey(p)).toList()) {
      if (online && _joinedRooms.contains(peer)) {
        _joinRoom(peer, unavailable: true);
      }
      _joinedRooms.remove(peer);
      _roomOldest.remove(peer);
      _roomLatest.remove(peer);
      _roomHasOlder.remove(peer);
      _messages.removeWhere((m) => m.peer == peer);
      for (final resource
          in _typingResources.entries
              .where((e) => e.value == peer)
              .map((e) => e.key)
              .toList()) {
        _clearTypingResource(resource);
      }
    }
    _rooms.clear();
    _rooms.addAll(next);
    // The first authoritative response also purges cached rooms we no longer belong to.
    _messages.removeWhere(
      (m) => m.peer.contains('@rooms.') && !_rooms.containsKey(m.peer),
    );
    for (final room in rooms) {
      _chatStatePeers.add(room.jid);
      if (online && _joinedRooms.add(room.jid)) {
        _joinRoom(room.jid);
        unawaited(loadRoomHistory(room.jid));
      } else if (online && previous[room.jid]?.revision != room.revision) {
        // Recover messages from newly invited senders dropped before refresh.
        unawaited(loadRoomHistory(room.jid));
      }
    }
    unawaited(_persist());
    _notifyRoomListeners();
  }

  void _joinRoom(String peer, {bool unavailable = false}) {
    _send(
      XmppService._element(
        'presence',
        XmppService._client,
        attributes: {
          'to': '$peer/${extensionFor(_account!)}',
          if (unavailable) 'type': 'unavailable',
        },
        children: [
          if (!unavailable)
            XmppService._element(
              'x',
              'http://jabber.org/protocol/muc',
              children: [
                XmppService._element(
                  'history',
                  'http://jabber.org/protocol/muc',
                  attributes: {'maxstanzas': '0'},
                ),
              ],
            ),
        ],
      ),
    );
  }

  String? _roomSender(String from) {
    final parts = from.split('/');
    if (parts.length != 2 ||
        !_rooms.containsKey(parts.first) ||
        !RegExp(r'^[0-9]{3,5}$').hasMatch(parts.last)) {
      return null;
    }
    return '$accountNumber*${parts.last}@$_domain';
  }

  bool _roomEnvelope(XmlElement message) {
    if (message.getAttribute('type') == 'groupchat') {
      _roomMessage(message);
      return true;
    }
    final event = message.getElement(
      'event',
      namespace: 'http://jabber.org/protocol/pubsub#event',
    );
    if (event == null) return false;
    final room = message.getAttribute('from');
    final items = event.getElement(
      'items',
      namespace: 'http://jabber.org/protocol/pubsub#event',
    );
    if (room == null ||
        !_rooms.containsKey(room) ||
        XmppService._bare(message.getAttribute('to') ?? '') != _account ||
        items?.getAttribute('node') != 'urn:xmpp:mucsub:nodes:messages') {
      return true;
    }
    final entries = items!
        .findElements(
          'item',
          namespace: 'http://jabber.org/protocol/pubsub#event',
        )
        .toList();
    if (entries.length != 1) return true;
    final inner = entries.single.getElement(
      'message',
      namespace: XmppService._client,
    );
    if (inner != null &&
        XmppService._bare(inner.getAttribute('from') ?? '') == room &&
        XmppService._bare(inner.getAttribute('to') ?? '') == _account &&
        inner.getAttribute('type') == 'groupchat') {
      _roomMessage(inner);
    }
    return true;
  }

  void _roomMessage(
    XmlElement message, {
    String? archiveId,
    DateTime? timestamp,
    String? expectedRoom,
  }) {
    final from = message.getAttribute('from') ?? '';
    final peer = XmppService._bare(from);
    final sender = _roomSender(from);
    final to = XmppService._bare(message.getAttribute('to') ?? '');
    if (sender == null ||
        message.getAttribute('type') != 'groupchat' ||
        (expectedRoom != null && expectedRoom != peer) ||
        (to.isNotEmpty && to != _account && to != peer)) {
      return;
    }
    final outgoing = sender == _account;
    // Historical senders may have left. Live traffic must be from a current member.
    if (timestamp == null &&
        !_rooms[peer]!.members.any((m) => m.jid == sender)) {
      return;
    }
    if (timestamp == null && !outgoing) _receiveChatState(message, peer);
    final displayed = message
        .getElement('displayed', namespace: XmppService._markers)
        ?.getAttribute('id');
    if (displayed != null && displayed.length <= 256) {
      final key = '$peer\u0000$sender';
      _roomReadAnchors[key] = displayed;
      _applyRoomReaders(peer);
      if (timestamp == null) {
        unawaited(_persist());
        _notifyRoomListeners();
      }
    }
    final body = message
        .getElement('body', namespace: XmppService._client)
        ?.innerText;
    if (body == null || body.isEmpty || body.length > 10000) return;
    final sids = message
        .findElements('stanza-id', namespace: XmppService._sid)
        .where((e) => e.getAttribute('by') == peer)
        .toList();
    archiveId ??= sids.length == 1 ? sids.single.getAttribute('id') : null;
    final id =
        message
            .getElement('origin-id', namespace: XmppService._sid)
            ?.getAttribute('id') ??
        message.getAttribute('id') ??
        'archive-$archiveId';
    final existing = _messages
        .where(
          (m) =>
              m.peer == peer &&
              ((archiveId != null && m.archiveId == archiveId) ||
                  (m.id == id &&
                      (m.senderJid ?? (m.outgoing ? _account : null)) ==
                          sender)),
        )
        .firstOrNull;
    if (existing != null) {
      existing.archiveId ??= archiveId;
      if (outgoing) existing.advanceStatus(ChatMessageStatus.delivered);
    } else {
      _messages.add(
        ChatMessage(
          id: id,
          peer: peer,
          senderJid: sender,
          body: body,
          outgoing: outgoing,
          timestamp:
              timestamp?.toLocal() ??
              DateTime.tryParse(
                message
                        .getElement('delay', namespace: 'urn:xmpp:delay')
                        ?.getAttribute('stamp') ??
                    '',
              )?.toLocal() ??
              DateTime.now(),
          status: outgoing
              ? ChatMessageStatus.delivered
              : ChatMessageStatus.received,
          archiveId: archiveId,
          markable: archiveId != null,
          attachment: _attachment(message),
        ),
      );
    }
    _messages.sort((a, b) => a.timestamp.compareTo(b.timestamp));
    _applyRoomReaders(peer);
    if (timestamp == null) {
      _trimMessages();
      unawaited(_persist());
      _notifyRoomListeners();
    }
  }

  void _applyRoomReaders(String peer) {
    final rows = _messages.where((m) => m.peer == peer).toList();
    for (final entry in _roomReadAnchors.entries.where(
      (e) => e.key.startsWith('$peer\u0000'),
    )) {
      final reader = entry.key.split('\u0000').last;
      final anchor = rows.indexWhere((m) => m.archiveId == entry.value);
      if (anchor < 0) continue;
      for (final m in rows.take(anchor + 1)) {
        if (reader == _account) {
          if (!m.outgoing) m.displayed = true;
        } else if (reader != m.senderJid) {
          m.readBy.add(reader);
        }
      }
    }
  }

  void _markRoomDisplayed(String peer, ChatMessage message) {
    if (message.archiveId == null) return;
    _roomReadAnchors['$peer\u0000$_account'] = message.archiveId!;
    _applyRoomReaders(peer);
    if (_shareReadReceipts) {
      _send(
        XmppService._element(
          'message',
          XmppService._client,
          attributes: {'to': peer, 'type': 'groupchat'},
          children: [
            XmppService._element(
              'displayed',
              XmppService._markers,
              attributes: {'id': message.archiveId!},
            ),
            XmppService._element('store', 'urn:xmpp:hints'),
          ],
        ),
      );
    }
    unawaited(_persist());
    _notifyRoomListeners();
  }

  void _roomArchive(XmlElement wrapper, XmlElement result, String peer) {
    if (wrapper.getAttribute('from') != peer ||
        _roomArchiveCounts[result.getAttribute('queryid')]! >= 100) {
      return;
    }
    _roomArchiveCounts[result.getAttribute('queryid')!] =
        _roomArchiveCounts[result.getAttribute('queryid')]! + 1;
    final forwarded = result.getElement(
      'forwarded',
      namespace: XmppService._forward,
    );
    final message = forwarded?.getElement(
      'message',
      namespace: XmppService._client,
    );
    final stamp = DateTime.tryParse(
      forwarded
              ?.getElement('delay', namespace: 'urn:xmpp:delay')
              ?.getAttribute('stamp') ??
          '',
    );
    if (message != null &&
        stamp != null &&
        result.getAttribute('id')?.isNotEmpty == true) {
      _roomMessage(
        message,
        archiveId: result.getAttribute('id'),
        timestamp: stamp,
        expectedRoom: peer,
      );
    }
  }

  Future<void> loadRoomHistory(String peer, {bool older = false}) async {
    if (!online || !_rooms.containsKey(peer) || !_roomHistoryBusy.add(peer)) {
      return;
    }
    final generation = _generation;
    _roomHistoryErrors.remove(peer);
    _notifyRoomListeners();
    try {
      // On reconnect, page forward from the last completed query. First load and
      // explicit older loads page backwards. Cursors commit only after success.
      var after = older ? null : _roomLatest[peer];
      final before = older ? _roomOldest[peer] : (after == null ? '' : null);
      for (var page = 0; page < 50; page++) {
        final id = XmppService._id(), queryId = XmppService._id();
        _roomArchiveQueries[queryId] = peer;
        _roomArchiveCounts[queryId] = 0;
        try {
          final response = await _query(
            id,
            XmppService._element(
              'iq',
              XmppService._client,
              attributes: {'id': id, 'type': 'set', 'to': peer},
              children: [
                XmppService._element(
                  'query',
                  XmppService._mam,
                  attributes: {'queryid': queryId},
                  children: [
                    XmppService._element(
                      'x',
                      'jabber:x:data',
                      attributes: {'type': 'submit'},
                      children: [
                        XmppService._element(
                          'field',
                          'jabber:x:data',
                          attributes: {'var': 'FORM_TYPE', 'type': 'hidden'},
                          children: [
                            XmppService._element(
                              'value',
                              'jabber:x:data',
                              text: XmppService._mam,
                            ),
                          ],
                        ),
                      ],
                    ),
                    XmppService._element(
                      'set',
                      XmppService._rsm,
                      children: [
                        XmppService._element(
                          'max',
                          XmppService._rsm,
                          text: '100',
                        ),
                        if (before != null)
                          XmppService._element(
                            'before',
                            XmppService._rsm,
                            text: before,
                          ),
                        if (after != null)
                          XmppService._element(
                            'after',
                            XmppService._rsm,
                            text: after,
                          ),
                      ],
                    ),
                  ],
                ),
              ],
            ),
            expectedFrom: peer,
          );
          if (generation != _generation || !_rooms.containsKey(peer)) return;
          final fin = response.getElement('fin', namespace: XmppService._mam);
          if (response.getAttribute('type') != 'result' || fin == null) {
            if (response
                    .getElement('error', namespace: XmppService._client)
                    ?.getElement(
                      'item-not-found',
                      namespace: 'urn:ietf:params:xml:ns:xmpp-stanzas',
                    ) !=
                null) {
              _roomLatest.remove(peer);
              _roomOldest.remove(peer);
              _roomHasOlder.remove(peer);
            }
            throw StateError('Room archive unavailable');
          }
          final set = fin.getElement('set', namespace: XmppService._rsm);
          final first = set
              ?.getElement('first', namespace: XmppService._rsm)
              ?.innerText;
          final last = set
              ?.getElement('last', namespace: XmppService._rsm)
              ?.innerText;
          final complete = ['true', '1'].contains(fin.getAttribute('complete'));
          if ((!complete || _roomArchiveCounts[queryId]! > 0) &&
              (first == null ||
                  first.isEmpty ||
                  last == null ||
                  last.isEmpty)) {
            throw StateError('Missing room cursors');
          }
          if (before != null) {
            if (first?.isNotEmpty == true) _roomOldest[peer] = first!;
            if (complete) {
              _roomHasOlder.remove(peer);
            } else {
              _roomHasOlder.add(peer);
            }
            if (!older && last?.isNotEmpty == true) _roomLatest[peer] = last!;
          } else if (last?.isNotEmpty == true) {
            if (!complete && last == after) {
              throw StateError('Room cursor did not advance');
            }
            _roomLatest[peer] = last!;
          }
          _applyRoomReaders(peer);
          await _persist();
          if (before != null || complete) return;
          after = last;
        } finally {
          _roomArchiveQueries.remove(queryId);
          _roomArchiveCounts.remove(queryId);
        }
      }
      throw StateError('Room catch-up limit reached');
    } catch (_) {
      if (generation == _generation) {
        _roomHistoryErrors[peer] =
            'Room history could not be loaded. Tap Retry.';
      }
    } finally {
      if (generation == _generation) {
        _roomHistoryBusy.remove(peer);
        if (!_disposed) _notifyRoomListeners();
      }
    }
  }
}
