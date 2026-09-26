class ProvisioningConfiguration {
  const ProvisioningConfiguration({
    required this.version,
    required this.connectionStrategy,
    required this.telephonyMode,
    required this.features,
    required this.policy,
    this.displayName,
    this.deviceState,
    this.randyUrl,
    this.janusUrl,
    this.extension,
    this.sipUsername,
    this.sipPassword,
    this.sipRealm,
    this.sipProxy,
  });

  final int version;
  final String connectionStrategy;
  final String telephonyMode;
  final String? displayName;
  final String? deviceState;
  final String? randyUrl;
  final String? janusUrl;
  final String? extension;
  final String? sipUsername;
  final String? sipPassword;
  final String? sipRealm;
  final String? sipProxy;
  final Map<String, bool> features;
  final Map<String, dynamic> policy;

  factory ProvisioningConfiguration.fromJson(
    Map<String, dynamic> json, {
    int? fallbackVersion,
  }) {
    final device = _map(json['device']);
    final services = _map(json['services']);
    final telephony = _map(json['telephony']);
    final sip = _map(telephony['sip']);
    final rawFeatures = _map(json['features']);
    final rawPolicy = _map(json['policy']);

    return ProvisioningConfiguration(
      version: _int(json['version']) ?? fallbackVersion ?? 0,
      connectionStrategy:
          json['connection_strategy']?.toString() ?? 'managed_mobile',
      telephonyMode: telephony['mode']?.toString() ?? 'randy_managed',
      displayName: device['display_name']?.toString() ??
          json['display_name']?.toString(),
      deviceState: device['state']?.toString(),
      randyUrl: services['randy_url']?.toString(),
      janusUrl: telephony['janus_url']?.toString() ??
          services['janus_url']?.toString(),
      extension: telephony['extension']?.toString(),
      sipUsername: sip['username']?.toString(),
      sipPassword: sip['password']?.toString(),
      sipRealm: sip['realm']?.toString(),
      sipProxy: sip['proxy']?.toString(),
      features: {
        for (final entry in rawFeatures.entries)
          if (entry.value is bool) entry.key: entry.value as bool,
      },
      policy: Map<String, dynamic>.from(rawPolicy),
    );
  }

  Map<String, dynamic> toJson() => {
        'version': version,
        'connection_strategy': connectionStrategy,
        'device': {
          if (displayName != null) 'display_name': displayName,
          if (deviceState != null) 'state': deviceState,
        },
        'services': {
          if (randyUrl != null) 'randy_url': randyUrl,
          if (janusUrl != null) 'janus_url': janusUrl,
        },
        'telephony': {
          'mode': telephonyMode,
          if (extension != null) 'extension': extension,
          if (janusUrl != null) 'janus_url': janusUrl,
          if (sipUsername != null ||
              sipPassword != null ||
              sipRealm != null ||
              sipProxy != null)
            'sip': {
              if (sipUsername != null) 'username': sipUsername,
              if (sipPassword != null) 'password': sipPassword,
              if (sipRealm != null) 'realm': sipRealm,
              if (sipProxy != null) 'proxy': sipProxy,
            },
        },
        'features': features,
        'policy': policy,
      };

  static Map<String, dynamic> _map(dynamic value) {
    if (value is Map) return Map<String, dynamic>.from(value);
    return const <String, dynamic>{};
  }

  static int? _int(dynamic value) {
    if (value is int) return value;
    return int.tryParse(value?.toString() ?? '');
  }
}

class ProvisionedDeviceState {
  const ProvisionedDeviceState({
    required this.deviceId,
    required this.accessToken,
    required this.refreshToken,
    required this.accessTokenExpiresAt,
    required this.configurationVersion,
    required this.deviceState,
    this.configuration,
  });

  final String deviceId;
  final String accessToken;
  final String refreshToken;
  final DateTime accessTokenExpiresAt;
  final int configurationVersion;
  final String deviceState;
  final ProvisioningConfiguration? configuration;

  bool get accessTokenExpiring =>
      accessTokenExpiresAt.isBefore(DateTime.now().toUtc().add(
            const Duration(seconds: 30),
          ));

  ProvisionedDeviceState copyWith({
    String? accessToken,
    String? refreshToken,
    DateTime? accessTokenExpiresAt,
    int? configurationVersion,
    String? deviceState,
    ProvisioningConfiguration? configuration,
  }) =>
      ProvisionedDeviceState(
        deviceId: deviceId,
        accessToken: accessToken ?? this.accessToken,
        refreshToken: refreshToken ?? this.refreshToken,
        accessTokenExpiresAt:
            accessTokenExpiresAt ?? this.accessTokenExpiresAt,
        configurationVersion:
            configurationVersion ?? this.configurationVersion,
        deviceState: deviceState ?? this.deviceState,
        configuration: configuration ?? this.configuration,
      );

  Map<String, dynamic> toJson() => {
        'device_id': deviceId,
        'access_token': accessToken,
        'refresh_token': refreshToken,
        'access_token_expires_at': accessTokenExpiresAt.toIso8601String(),
        'configuration_version': configurationVersion,
        'device_state': deviceState,
        if (configuration != null) 'configuration': configuration!.toJson(),
      };

  factory ProvisionedDeviceState.fromJson(Map<String, dynamic> json) {
    final configuration = json['configuration'];
    return ProvisionedDeviceState(
      deviceId: json['device_id']?.toString() ?? '',
      accessToken: json['access_token']?.toString() ?? '',
      refreshToken: json['refresh_token']?.toString() ?? '',
      accessTokenExpiresAt: DateTime.tryParse(
            json['access_token_expires_at']?.toString() ?? '',
          )?.toUtc() ??
          DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
      configurationVersion:
          int.tryParse(json['configuration_version']?.toString() ?? '') ?? 0,
      deviceState: json['device_state']?.toString() ?? 'active',
      configuration: configuration is Map
          ? ProvisioningConfiguration.fromJson(
              Map<String, dynamic>.from(configuration),
            )
          : null,
    );
  }
}

class ActivationResult {
  const ActivationResult({
    required this.deviceId,
    required this.accessToken,
    required this.refreshToken,
    required this.expiresIn,
    required this.configurationVersion,
    required this.configuration,
  });

  final String deviceId;
  final String accessToken;
  final String refreshToken;
  final int expiresIn;
  final int configurationVersion;
  final ProvisioningConfiguration configuration;
}

class TokenRefreshResult {
  const TokenRefreshResult({
    required this.accessToken,
    required this.refreshToken,
    required this.expiresIn,
  });

  final String accessToken;
  final String refreshToken;
  final int expiresIn;
}

class DeviceCheckInResult {
  const DeviceCheckInResult({
    required this.state,
    required this.configurationVersion,
    required this.configurationChanged,
    required this.forceUpdate,
    this.minimumAppBuild,
    this.actions = const [],
  });

  final String state;
  final int configurationVersion;
  final bool configurationChanged;
  final int? minimumAppBuild;
  final bool forceUpdate;
  final List<String> actions;
}
