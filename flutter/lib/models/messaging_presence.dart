/// Messaging availability, independent of SIP registration and call DND.
enum MessagingPresence { unknown, offline, available, away, busy }

extension MessagingPresenceLabel on MessagingPresence {
  String get label => switch (this) {
    MessagingPresence.unknown => 'Status unavailable',
    MessagingPresence.offline => 'Offline',
    MessagingPresence.available => 'Available',
    MessagingPresence.away => 'Away',
    MessagingPresence.busy => 'Busy',
  };
}

/// One unavailable device must not make another connected device disappear.
MessagingPresence aggregatePresence(Iterable<MessagingPresence> resources) {
  final states = resources.toSet();
  for (final state in [
    MessagingPresence.available,
    MessagingPresence.busy,
    MessagingPresence.away,
  ]) {
    if (states.contains(state)) return state;
  }
  return MessagingPresence.offline;
}
