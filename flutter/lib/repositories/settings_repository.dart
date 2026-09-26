import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../core/app_config.dart';

enum ConfigurationSource {
  manual,
  provisioning,
}

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
    required this.configurationSource,
    required this.provisioningUrl,
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
  final ConfigurationSource configurationSource;
  final String provisioningUrl;
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
  static const _configurationSourceKey = 'voicehost.configuration.source';
  static const _provisioningUrlKey = 'voicehost.provisioning.url';

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
      configurationSource: ConfigurationSource.values.firstWhere(
        (value) =>
            value.name ==
            (prefs.getString(_configurationSourceKey) ??
                ConfigurationSource.manual.name),
        orElse: () => ConfigurationSource.manual,
      ),
      provisioningUrl:
          prefs.getString(_provisioningUrlKey) ?? AppConfig.provisioningUrl,
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
      prefs.setString(
        _configurationSourceKey,
        settings.configurationSource.name,
      ),
      prefs.setString(_provisioningUrlKey, settings.provisioningUrl),
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
