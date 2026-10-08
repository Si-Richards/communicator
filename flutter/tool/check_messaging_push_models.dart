// Run with: dart --enable-asserts tool/check_messaging_push_models.dart
import '../lib/models/provisioning.dart';

void main() {
  final id = List.filled(64, 'a').join();
  const owner = '00100*01234@ejabberd.voicehost.io';
  final subscription = {
    'enabled': true,
    'owner_jid': owner,
    'jid': 'ejabberd.voicehost.io',
    'node': 'vh-$id',
  };
  assert(MessagingPushSubscription.fromJson(subscription)!.ownerJid == owner);
  assert(MessagingPushSubscription.fromJson({'enabled': false}) == null);
  for (final change in [
    {'jid': 'push.foreign.example'},
    {'node': 'not-a-provisioned-node'},
    {'owner_jid': '00100*01234t@ejabberd.voicehost.io'},
  ]) {
    var rejected = false;
    try {
      MessagingPushSubscription.fromJson({...subscription, ...change});
    } on FormatException {
      rejected = true;
    }
    assert(rejected);
  }
  final message = {
    'type': 'messaging',
    'owner_jid': owner,
    'peer_jid': '00100*230@ejabberd.voicehost.io',
    'event_id': id,
  };
  assert(
    MessagingNotification.fromJson(message)!.peerJid == message['peer_jid'],
  );
  for (final change in [
    {'type': 'voicemail'},
    {'peer_jid': owner},
    {'event_id': 'invalid'},
    {'peer_jid': '100*230@ejabberd.voicehost.io'},
    {'peer_jid': '00100*230@foreign.example'},
    {'peer_jid': '00100*230t@ejabberd.voicehost.io'},
    {'peer_jid': '00100*23@ejabberd.voicehost.io'},
    {'peer_jid': '00100*123456@ejabberd.voicehost.io'},
  ]) {
    assert(MessagingNotification.fromJson({...message, ...change}) == null);
  }
  print('Messaging push model checks passed.');
}
