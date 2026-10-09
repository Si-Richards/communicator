import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:voicehost_softphone/models/messaging_room.dart';
import 'package:voicehost_softphone/services/provisioning_service.dart';

void main() {
  const owner = '10000*213@ejabberd.voicehost.io';
  final id = 'vh-${'a' * 32}';
  Map<String, dynamic> payload() => {
    'rooms': [
      {
        'jid': '$id@rooms.ejabberd.voicehost.io',
        'name': 'Team',
        'revision': 3,
        'members': [
          {'jid': owner, 'name': 'Simon', 'extension': '213', 'role': 'owner'},
          {
            'jid': '10000*230@ejabberd.voicehost.io',
            'name': 'Connor',
            'extension': '230',
            'role': 'member',
          },
        ],
      },
    ],
  };
  test(
    'room management binds header credential and validates returned membership',
    () async {
      final service = ProvisioningService(
        baseUrl: 'https://provisioning.example',
        client: MockClient((request) async {
          expect(request.url.path, '/api/v1/device/messaging/rooms/$id');
          expect(request.method, 'POST');
          expect(request.headers['Authorization'], 'Bearer fixture');
          expect(jsonDecode(request.body), {
            'action': 'add',
            'target': '10000*230@ejabberd.voicehost.io',
            'revision': 2,
          });
          return http.Response(jsonEncode(payload()), 200);
        }),
      );
      addTearDown(service.close);
      final room = (await service.messagingRooms(
        accessToken: 'fixture',
        owner: owner,
        id: id,
        change: {
          'action': 'add',
          'target': '10000*230@ejabberd.voicehost.io',
          'revision': 2,
        },
      )).single;
      expect(room.revision, 3);
      expect(room.roleFor(owner), 'owner');
      expect(room.members.last.label, 'Connor · 230');
    },
  );
  test(
    'server revision conflicts remain visible for refresh and retry',
    () async {
      final service = ProvisioningService(
        baseUrl: 'https://provisioning.example',
        client: MockClient(
          (_) async => http.Response(
            '{"error":{"code":"room_unavailable","message":"The room has changed."}}',
            409,
          ),
        ),
      );
      addTearDown(service.close);
      await expectLater(
        service.messagingRooms(
          accessToken: 'fixture',
          owner: owner,
          id: id,
          change: {'action': 'leave', 'revision': 1},
        ),
        throwsA(isA<ProvisioningException>()),
      );
    },
  );
  test('directory response cannot confer membership from another account', () {
    final data = payload();
    final rows = data['rooms'] as List;
    final members = rows.first['members'] as List;
    members.last['jid'] = '20000*230@ejabberd.voicehost.io';
    expect(() => MessagingRoom.parseList(data, owner), throwsFormatException);
  });
}
