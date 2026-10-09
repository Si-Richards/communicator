import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:voicehost_softphone/models/provisioning.dart';
import 'package:voicehost_softphone/services/provisioning_service.dart';

void main() {
  final node = 'vh-${List.filled(64, 'a').join()}';
  const owner = '10000*213@ejabberd.voicehost.io';
  final subscription = {
    'enabled': true,
    'owner_jid': owner,
    'jid': 'ejabberd.voicehost.io',
    'node': node,
  };

  test('registration uses the device bearer and carries no client-assigned identity', () async {
    final requests = <http.Request>[];
    final service = ProvisioningService(
      baseUrl: 'https://provisioning.example',
      client: MockClient((request) async {
        requests.add(request);
        return request.method == 'DELETE'
            ? http.Response('', 204)
            : http.Response(jsonEncode(subscription), 200);
      }),
    );
    addTearDown(service.close);
    final result = await service.registerMessagingPush(
      accessToken: 'device-credential',
      token: 'device-token',
      environment: 'sandbox',
    );
    expect(result!.node, node);
    expect(result.ownerJid, owner);
    expect(requests.single.method, 'PUT');
    expect(requests.single.url.path, '/api/v1/device/messaging/push');
    expect(
      requests.single.headers['Authorization'],
      'Bearer device-credential',
    );
    expect(jsonDecode(requests.single.body), {
      'token': 'device-token',
      'environment': 'sandbox',
    });
    await service.removeMessagingPush(accessToken: 'device-credential');
    expect(requests.last.method, 'DELETE');
    expect(requests.last.headers['Authorization'], 'Bearer device-credential');
  });

  test('disabled notifications do not create a subscription', () async {
    final service = ProvisioningService(
      baseUrl: 'https://provisioning.example/api/v1',
      client: MockClient((_) async => http.Response('{"enabled":false}', 200)),
    );
    addTearDown(service.close);
    expect(
      await service.registerMessagingPush(
        accessToken: 'a',
        token: 't',
        environment: 'sandbox',
      ),
      isNull,
    );
  });

  test('a foreign service cannot become the push destination', () {
    expect(
      () => MessagingPushSubscription.fromJson({
        ...subscription,
        'jid': 'push.foreign.example',
      }),
      throwsFormatException,
    );
  });

  test('malformed and cross-account notification taps are rejected', () {
    final payload = {
      'type': 'messaging',
      'owner_jid': owner,
      'peer_jid': '10000*230@ejabberd.voicehost.io',
      'event_id': List.filled(64, 'b').join(),
    };
    expect(
      MessagingNotification.fromJson(payload)!.peerJid,
      payload['peer_jid'],
    );
    for (final replacement in [
      {'peer_jid': '20000*230@ejabberd.voicehost.io'},
      {'owner_jid': '10000*213t@ejabberd.voicehost.io'},
      {'peer_jid': '10000*230@foreign.example'},
      {'peer_jid': owner},
      {'event_id': 'bad-id'},
      {'type': 'voicemail'},
    ]) {
      expect(
        MessagingNotification.fromJson({...payload, ...replacement}),
        isNull,
      );
    }
  });
}
