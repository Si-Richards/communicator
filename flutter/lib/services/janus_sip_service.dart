import '../core/app_config.dart';
import '../models/sip_account.dart';
import 'janus_client.dart';

class JanusSipService {
  JanusSipService(this._janus);

  final JanusClient _janus;

  Future<void> register(SipAccount account) async {
    final body = <String, dynamic>{
      'request': 'register',
      'username': account.sipUri,
      'authuser': account.username,
      'secret': account.password,
      'user_agent': AppConfig.userAgent,
    };
    if (account.displayName?.trim().isNotEmpty == true) {
      body['display_name'] = account.displayName!.trim();
    }
    if (account.proxy?.trim().isNotEmpty == true) {
      final proxy = account.proxy!.trim();
      body['proxy'] = proxy.startsWith('sip:') || proxy.startsWith('sips:')
          ? proxy
          : 'sip:$proxy';
    }
    await _janus.sendPlugin(body: body);
  }

  Future<void> unregister() =>
      _janus.sendPlugin(body: const {'request': 'unregister'});

  Future<void> call({
    required String number,
    required String realm,
    required String offerSdp,
  }) {
    final uri = number.startsWith('sip:') ? number : 'sip:$number@$realm';
    return _janus.sendPlugin(
      body: {'request': 'call', 'uri': uri},
      jsep: {'type': 'offer', 'sdp': offerSdp, 'trickle': true},
    );
  }

  Future<void> accept(String answerSdp) => _janus.sendPlugin(
        body: const {'request': 'accept'},
        jsep: {'type': 'answer', 'sdp': answerSdp, 'trickle': true},
      );

  Future<void> decline({int code = 486}) =>
      _janus.sendPlugin(body: {'request': 'decline', 'code': code});

  Future<void> hangup() =>
      _janus.sendPlugin(body: const {'request': 'hangup'});

  Future<void> hold() => _janus.sendPlugin(
        body: const {'request': 'hold', 'direction': 'sendonly'},
      );

  Future<void> unhold() =>
      _janus.sendPlugin(body: const {'request': 'unhold'});

  Future<void> sendDtmf(String digit, {int duration = 160}) =>
      _janus.sendPlugin(body: {
        'request': 'dtmf_info',
        'digit': digit,
        'duration': duration,
      });

  Future<void> subscribeMessageSummary() => _janus.sendPlugin(body: const {
        'request': 'subscribe',
        'event': 'message-summary',
        'accept': 'application/simple-message-summary',
        'subscribe_ttl': 3600,
      });
}
