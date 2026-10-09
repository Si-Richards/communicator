class MessagingRoomMember {
  const MessagingRoomMember({
    required this.jid,
    required this.name,
    required this.extension,
    required this.role,
  });
  final String jid, name, extension, role;
  String get label =>
      name.isEmpty || name == extension ? extension : '$name · $extension';
}

/// Membership comes from the authenticated provisioning API, never room XML.
class MessagingRoom {
  const MessagingRoom({
    required this.jid,
    required this.name,
    required this.revision,
    required this.members,
  });
  final String jid, name;
  final int revision;
  final List<MessagingRoomMember> members;
  String get id => jid.split('@').first;
  String roleFor(String? jid) =>
      members.where((m) => m.jid == jid).firstOrNull?.role ?? '';
  static bool validJid(String jid, String host) =>
      RegExp(r'^vh-[a-f0-9]{32}$').hasMatch(jid.split('@').first) &&
      jid.split('@').length == 2 &&
      jid.split('@').last == 'rooms.$host';
  static List<MessagingRoom> parseList(
    Map<String, dynamic> json,
    String owner,
  ) {
    final match = RegExp(
      r'^([0-9]+)\*([0-9]{3,5})@([a-z0-9.-]+)$',
    ).firstMatch(owner);
    final rows = json['rooms'];
    if (match == null || rows is! List || rows.length > 256) {
      throw const FormatException('Invalid room list');
    }
    final rooms = <MessagingRoom>[];
    final seen = <String>{};
    for (final row in rows) {
      if (row is! Map ||
          row['jid'] is! String ||
          !validJid(row['jid'], match.group(3)!) ||
          !seen.add(row['jid']) ||
          row['name'] is! String ||
          (row['name'] as String).trim().isEmpty ||
          (row['name'] as String).length > 240 ||
          row['revision'] is! int ||
          row['revision'] < 1 ||
          row['members'] is! List ||
          (row['members'] as List).isEmpty ||
          (row['members'] as List).length > 100) {
        throw const FormatException('Invalid room list');
      }
      final members = <MessagingRoomMember>[];
      final identities = <String>{};
      for (final member in row['members']) {
        if (member is! Map ||
            member['jid'] is! String ||
            member['extension'] is! String ||
            !RegExp(r'^[0-9]{3,5}$').hasMatch(member['extension']) ||
            member['jid'] !=
                '${match.group(1)}*${member['extension']}@${match.group(3)}' ||
            !identities.add(member['jid']) ||
            member['name'] is! String ||
            !['owner', 'admin', 'member'].contains(member['role'])) {
          throw const FormatException('Invalid room member');
        }
        members.add(
          MessagingRoomMember(
            jid: member['jid'],
            name: member['name'],
            extension: member['extension'],
            role: member['role'],
          ),
        );
      }
      if (!identities.contains(owner) ||
          !members.any((m) => m.role == 'owner')) {
        throw const FormatException('Invalid room membership');
      }
      rooms.add(
        MessagingRoom(
          jid: row['jid'],
          name: row['name'],
          revision: row['revision'],
          members: List.unmodifiable(members),
        ),
      );
    }
    return List.unmodifiable(rooms);
  }
}
