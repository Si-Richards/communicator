part of 'xmpp_service.dart';

extension XmppReactions on XmppService {
  String? _reactionTarget(ChatMessage message) =>
      isRoom(message.peer) ? message.archiveId : message.id;

  bool canReact(ChatMessage message) {
    final target = _reactionTarget(message);
    return online &&
        accessAllowed &&
        _messages.contains(message) &&
        target != null &&
        target.isNotEmpty &&
        target.length <= 256 &&
        (isRoom(message.peer)
            ? _rooms.containsKey(message.peer)
            : _messages
                      .where((m) => m.peer == message.peer && m.id == target)
                      .length ==
                  1);
  }

  Map<String, List<String>> reactionsFor(ChatMessage message) {
    final target = _reactionTarget(message);
    if (target == null) return const {};
    // Ambiguous direct-chat IDs must never attach to the wrong message.
    if (!isRoom(message.peer) &&
        _messages
                .where((m) => m.peer == message.peer && m.id == target)
                .length !=
            1) {
      return const {};
    }
    return {
      for (final r in _reactions.values)
        if (r.peer == message.peer && r.target == target && r.emojis.isNotEmpty)
          r.actor: List.unmodifiable(r.emojis),
    };
  }

  void toggleReaction(ChatMessage message, String emoji) {
    if (!canReact(message) || !ChatReaction.choices.contains(emoji)) {
      throw StateError('This message is not ready for reactions.');
    }
    final peer = recipientJid(message.peer), target = _reactionTarget(message)!;
    final current = reactionsFor(message)[_account] ?? const <String>[];
    final emojis = current.toSet();
    if (!emojis.remove(emoji)) emojis.add(emoji);
    final update = ChatReaction(
      peer: peer,
      target: target,
      actor: _account!,
      emojis: emojis.toList(),
      timestamp: DateTime.now().toUtc(),
    );
    final id = XmppService._id();
    _send(
      XmppService._element(
        'message',
        XmppService._client,
        attributes: {
          'id': id,
          'to': peer,
          'type': isRoom(peer) ? 'groupchat' : 'chat',
        },
        children: [
          XmppService._element(
            'reactions',
            ChatReaction.namespace,
            attributes: {'id': target},
            children: [
              for (final e in emojis)
                XmppService._element(
                  'reaction',
                  ChatReaction.namespace,
                  text: e,
                ),
            ],
          ),
          XmppService._element('store', 'urn:xmpp:hints'),
        ],
      ),
    );
    // Room reactions are displayed only after the service echoes them.
    if (!isRoom(peer)) {
      _pendingReactions[id] = (update, _reactions[update.key]);
      if (_pendingReactions.length > 100) {
        _pendingReactions.remove(_pendingReactions.keys.first);
      }
      _rememberReaction(update);
      unawaited(_persist());
      _notifyRoomListeners();
    }
  }

  ChatReaction? _parseReaction(
    XmlElement message,
    String peer,
    String actor,
    DateTime timestamp,
  ) {
    final elements = message
        .findElements('reactions', namespace: ChatReaction.namespace)
        .toList();
    if (elements.length != 1 || elements.single.childElements.length > 12) {
      return null;
    }
    final e = elements.single;
    if (e.childElements.any(
      (r) =>
          r.name.local != 'reaction' ||
          r.namespaceUri != ChatReaction.namespace ||
          r.childElements.isNotEmpty,
    )) {
      return null;
    }
    return ChatReaction.parse({
      'peer': peer,
      'target': e.getAttribute('id'),
      'actor': actor,
      'emojis': e.childElements.map((r) => r.innerText).toList(),
      'timestamp': timestamp.toUtc().toIso8601String(),
    });
  }

  bool _receiveReaction(
    XmlElement message,
    String peer,
    String actor, {
    DateTime? timestamp,
  }) {
    if (message.getElement('reactions', namespace: ChatReaction.namespace) ==
        null) {
      return false;
    }
    final update = _parseReaction(
      message,
      peer,
      actor,
      timestamp ??
          DateTime.tryParse(
            message
                    .getElement('delay', namespace: 'urn:xmpp:delay')
                    ?.getAttribute('stamp') ??
                '',
          ) ??
          DateTime.now(),
    );
    if (update != null) {
      _rememberReaction(update);
      if (timestamp == null) {
        unawaited(_persist());
        _notifyRoomListeners();
      }
    }
    return true;
  }

  void _rememberReaction(ChatReaction update) {
    final previous = _reactions[update.key];
    if (previous != null && !update.timestamp.isAfter(previous.timestamp)) {
      return;
    }
    _reactions.remove(update.key);
    _reactions[update.key] = update;
    // Keep removals too: an older archive page must not resurrect a reaction.
    if (_reactions.length > 1000) _reactions.remove(_reactions.keys.first);
  }

  void _rejectReaction(String? id, String peer) {
    final pending = _pendingReactions[id];
    if (pending == null || pending.$1.peer != peer) return;
    _pendingReactions.remove(id);
    if (!identical(_reactions[pending.$1.key], pending.$1)) return;
    _reactions.remove(pending.$1.key);
    if (pending.$2 != null) _reactions[pending.$1.key] = pending.$2!;
    _event('Message reaction rejected');
    unawaited(_persist());
    _notifyRoomListeners();
  }
}
