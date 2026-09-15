import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../core/app_config.dart';

class SoftphoneSettings {
  const SoftphoneSettings({
    required this.nickname,
    required this.sipUsername,
    required this.sipPassword,
    required this.sipRealm,
    required this.sipProxy,
    required this.janusUrl,
    required this.janusApiSecret,
    required this.voicemailNumber,
    required this.doNotDisturb,
  });

  final String nickname;
  final String sipUsername;
  final String sipPassword;
  final String sipRealm;
  final String sipProxy;
  final String janusUrl;
  final String janusApiSecret;
  final String voicemailNumber;
  final bool doNotDisturb;
}

class SettingsRepository {
  SettingsRepository({FlutterSecureStorage? secureStorage})
      : _secureStorage = secureStorage ?? const FlutterSecureStorage();

  static const _nicknameKey = 'voicehost.nickname';
  static const _sipUsernameKey = 'voicehost.sip.username';
  static const _sipRealmKey = 'voicehost.sip.realm';
  static const _sipProxyKey = 'voicehost.sip.proxy';
  static const _janusUrlKey = 'voicehost.janus.url';
  static const _voicemailNumberKey = 'voicehost.voicemail.number';
  static const _dndKey = 'voicehost.dnd';
  static const _sipPasswordKey = 'voicehost.sip.password';
  static const _janusSecretKey = 'voicehost.janus.secret';

  final FlutterSecureStorage _secureStorage;

  Future<SoftphoneSettings> load() async {
    final prefs = await SharedPreferences.getInstance();
    final sipPassword = await _secureStorage.read(key: _sipPasswordKey) ?? '';
    final janusSecret = await _secureStorage.read(key: _janusSecretKey) ?? '';

    return SoftphoneSettings(
      nickname: prefs.getString(_nicknameKey) ?? '',
      sipUsername: prefs.getString(_sipUsernameKey) ?? '',
      sipPassword: sipPassword,
      sipRealm: prefs.getString(_sipRealmKey) ?? AppConfig.defaultSipRealm,
      sipProxy: prefs.getString(_sipProxyKey) ?? '',
      janusUrl: prefs.getString(_janusUrlKey) ?? AppConfig.defaultJanusUrl,
      janusApiSecret: janusSecret,
      voicemailNumber: prefs.getString(_voicemailNumberKey) ?? '',
      doNotDisturb: prefs.getBool(_dndKey) ?? false,
    );
  }

  Future<void> save(SoftphoneSettings settings) async {
    final prefs = await SharedPreferences.getInstance();
    await Future.wait([
      prefs.setString(_nicknameKey, settings.nickname),
      prefs.setString(_sipUsernameKey, settings.sipUsername),
      prefs.setString(_sipRealmKey, settings.sipRealm),
      prefs.setString(_sipProxyKey, settings.sipProxy),
      prefs.setString(_janusUrlKey, settings.janusUrl),
      prefs.setString(_voicemailNumberKey, settings.voicemailNumber),
      prefs.setBool(_dndKey, settings.doNotDisturb),
      _secureStorage.write(key: _sipPasswordKey, value: settings.sipPassword),
      _secureStorage.write(
        key: _janusSecretKey,
        value: settings.janusApiSecret,
      ),
    ]);
  }

  Future<void> saveDoNotDisturb(bool enabled) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_dndKey, enabled);
  }
}
