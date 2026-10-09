import 'package:voicehost_softphone/models/messaging_room.dart';
import 'package:voicehost_softphone/models/provisioning.dart';
import 'package:voicehost_softphone/models/chat_message.dart';

void main() {
  const owner = '10000*213@ejabberd.voicehost.io';
  final room = 'vh-${'a' * 32}@rooms.ejabberd.voicehost.io';
  Map<String, dynamic> member(String extension, String role) => {
    'jid': '10000*$extension@ejabberd.voicehost.io',
    'name': 'User $extension',
    'extension': extension,
    'role': role,
  };
  final json = {
    'rooms': [
      {
        'jid': room,
        'name': 'Team',
        'revision': 1,
        'members': [member('213', 'owner'), member('230', 'member')],
      },
    ],
  };
  final parsed = MessagingRoom.parseList(json, owner).single;
  assert(parsed.roleFor(owner) == 'owner');
  assert(parsed.members.last.label == 'User 230 · 230');
  assert(
    MessagingNotification.fromJson({
          'type': 'messaging',
          'owner_jid': owner,
          'peer_jid': room,
          'event_id': 'b' * 64,
        }) !=
        null,
  );
  assert(
    MessagingNotification.fromJson({
          'type': 'messaging',
          'owner_jid': owner,
          'peer_jid': room.replaceFirst('rooms.ejabberd', 'rooms.other'),
          'event_id': 'b' * 64,
        }) ==
        null,
  );
  var denied = 0;
  for (final bad in [
    {
      ...json,
      'rooms': [
        {
          'jid': room,
          'name': 'Team',
          'revision': 1,
          'members': [member('230', 'owner')],
        },
      ],
    },
    {
      ...json,
      'rooms': [
        {
          'jid': room,
          'name': 'Team',
          'revision': 1,
          'members': [member('213', 'member')],
        },
      ],
    },
    {
      ...json,
      'rooms': [
        {
          'jid': room,
          'name': 'Team',
          'revision': 1,
          'members': [
            member('213', 'owner'),
            {
              ...member('230', 'member'),
              'jid': '20000*230@ejabberd.voicehost.io',
            },
          ],
        },
      ],
    },
    {
      ...json,
      'rooms': [
        {
          'jid': 'room@conference.ejabberd.voicehost.io',
          'name': 'Team',
          'revision': 1,
          'members': [member('213', 'owner')],
        },
      ],
    },
  ]) {
    try {
      MessagingRoom.parseList(bad, owner);
    } on FormatException {
      denied++;
    }
  }
  assert(denied == 4);
  final message = ChatMessage(
    id: 'msg',
    peer: room,
    body: 'Hi',
    outgoing: true,
    timestamp: DateTime.utc(2026),
    status: ChatMessageStatus.delivered,
    senderJid: owner,
    readBy: {'10000*230@ejabberd.voicehost.io'},
  );
  final restored = ChatMessage.fromJson(message.toJson());
  assert(restored.senderJid == owner);
  assert(restored.readBy.length == 1);
  assert(restored.key == '$owner|msg');
}
