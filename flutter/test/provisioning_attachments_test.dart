import 'dart:typed_data';
import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:voicehost_softphone/models/chat_attachment.dart';
import 'package:voicehost_softphone/services/provisioning_service.dart';

void main() {
  final bytes = Uint8List.fromList([1, 2, 3]);
  ChatAttachment attachment() => ChatAttachment(
    id: 'a' * 64,
    name: 'file.bin',
    mediaType: 'application/octet-stream',
    size: 3,
    sha256: sha256.convert(bytes).toString(),
  );

  test(
    'download uses fixed provider path, conversation and header credentials',
    () async {
      final service = ProvisioningService(
        baseUrl: 'https://provisioning.example',
        client: MockClient((request) async {
          expect(
            request.url.path,
            '/api/v1/device/messaging/attachments/${'a' * 64}',
          );
          expect(request.url.queryParameters, {
            'peer': '10000*230@ejabberd.voicehost.io',
          });
          expect(request.headers['Authorization'], 'Bearer fixture-token');
          expect(request.followRedirects, isFalse);
          return http.Response.bytes(bytes, 200);
        }),
      );
      addTearDown(service.close);
      expect(
        await service.downloadAttachment(
          accessToken: 'fixture-token',
          peer: '10000*230@ejabberd.voicehost.io',
          attachment: attachment(),
        ),
        bytes,
      );
    },
  );

  for (final bad in [
    <int>[1, 2],
    <int>[1, 2, 4],
    <int>[1, 2, 3, 4],
  ]) {
    test(
      'download rejects truncated, changed or oversized bytes: $bad',
      () async {
        final service = ProvisioningService(
          baseUrl: 'https://provisioning.example',
          client: MockClient((_) async => http.Response.bytes(bad, 200)),
        );
        addTearDown(service.close);
        await expectLater(
          service.downloadAttachment(
            accessToken: 'fixture-token',
            peer: '10000*230@ejabberd.voicehost.io',
            attachment: attachment(),
          ),
          throwsA(isA<ProvisioningException>()),
        );
      },
    );
  }

  test(
    'upload rejects empty or oversized files before making an HTTP request',
    () async {
      var requests = 0;
      final service = ProvisioningService(
        baseUrl: 'https://provisioning.example',
        client: MockClient((_) async {
          requests++;
          return http.Response('{}', 500);
        }),
      );
      addTearDown(service.close);
      for (final value in [
        Uint8List(0),
        Uint8List(ChatAttachment.maxBytes + 1),
      ]) {
        await expectLater(
          service.uploadAttachment(
            accessToken: 'fixture-token',
            peer: '10000*230@ejabberd.voicehost.io',
            name: 'file',
            bytes: value,
          ),
          throwsA(isA<ProvisioningException>()),
        );
      }
      expect(requests, 0);
    },
  );
}
