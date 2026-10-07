class ProvisioningConfiguration {
  const ProvisioningConfiguration({
    required this.version,
    required this.connectionStrategy,
    required this.telephonyMode,
    required this.features,
    required this.policy,
    this.displayName,
    this.brandingName,
    this.deviceState,
    this.randyUrl,
    this.janusUrl,
    this.janusApiSecret,
    this.extension,
    this.sipUsername,
    this.sipPassword,
    this.sipRealm,
    this.sipProxy,
    this.ldapDirectory,
    this.messaging,
  });

  final int version;
  final String connectionStrategy;
  final String telephonyMode;
  final String? displayName;
  final String? brandingName;
  final String? deviceState;
  final String? randyUrl;
  final String? janusUrl;
  final String? janusApiSecret;
  final String? extension;
  final String? sipUsername;
  final String? sipPassword;
  final String? sipRealm;
  final String? sipProxy;
  final LdapDirectoryConfiguration? ldapDirectory;
  final MessagingConfiguration? messaging;
  final Map<String, bool> features;
  final Map<String, dynamic> policy;

  PbxFeatureConfiguration get pbxFeatures =>
      PbxFeatureConfiguration.fromConfiguration(this);

  factory ProvisioningConfiguration.fromJson(
    Map<String, dynamic> json, {
    int? fallbackVersion,
  }) {
    final device = _map(json['device']);
    final branding = _map(json['branding']);
    final services = _map(json['services']);
    final telephony = _map(json['telephony']);
    final sip = _map(telephony['sip']);
    final rawFeatures = _map(json['features']);
    final rawPolicy = _map(json['policy']);
    final directory = _map(json['directory']);
    final ldap = _map(directory['ldap']);

    return ProvisioningConfiguration(
      version: _int(json['version']) ?? fallbackVersion ?? 0,
      connectionStrategy:
          json['connection_strategy']?.toString() ?? 'managed_mobile',
      telephonyMode: telephony['mode']?.toString() ?? 'randy_managed',
      displayName:
          device['display_name']?.toString() ??
          json['display_name']?.toString(),
      brandingName: branding['name']?.toString(),
      deviceState: device['state']?.toString(),
      randyUrl: services['randy_url']?.toString(),
      janusUrl:
          telephony['janus_url']?.toString() ??
          services['janus_url']?.toString(),
      janusApiSecret: telephony['janus_api_secret']?.toString(),
      extension: telephony['extension']?.toString(),
      sipUsername: sip['username']?.toString(),
      sipPassword: sip['password']?.toString(),
      sipRealm: sip['realm']?.toString(),
      sipProxy: sip['proxy']?.toString(),
      ldapDirectory: ldap.isEmpty
          ? null
          : LdapDirectoryConfiguration.fromJson(ldap),
      messaging: json['messaging'] is Map
          ? MessagingConfiguration.fromJson(_map(json['messaging']))
          : null,
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
    if (brandingName != null) 'branding': {'name': brandingName},
    'services': {
      if (randyUrl != null) 'randy_url': randyUrl,
      if (janusUrl != null) 'janus_url': janusUrl,
    },
    'telephony': {
      'mode': telephonyMode,
      if (extension != null) 'extension': extension,
      if (janusUrl != null) 'janus_url': janusUrl,
      if (janusApiSecret != null) 'janus_api_secret': janusApiSecret,
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
    if (ldapDirectory != null) 'directory': {'ldap': ldapDirectory!.toJson()},
    if (messaging != null) 'messaging': messaging!.toJson(),
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

class LdapDirectoryConfiguration {
  const LdapDirectoryConfiguration({
    required this.enabled,
    required this.host,
    required this.port,
    required this.tls,
    required this.initialQuery,
    required this.sortMode,
    required this.nameFilter,
    required this.numberFilter,
    required this.nameAttributes,
    required this.numberAttributes,
    required this.displayName,
    this.ou,
    this.uid,
    this.baseDn,
    this.bindDn,
    this.password,
  });

  final bool enabled;
  final String host;
  final int port;
  final bool tls;
  final bool initialQuery;
  final String sortMode;
  final String nameFilter;
  final String numberFilter;
  final List<String> nameAttributes;
  final List<String> numberAttributes;
  final String displayName;
  final String? ou;
  final String? uid;
  final String? baseDn;
  final String? bindDn;
  final String? password;

  bool get configured =>
      enabled &&
      host.trim().isNotEmpty &&
      (baseDn?.trim().isNotEmpty ?? false) &&
      (bindDn?.trim().isNotEmpty ?? false) &&
      (password?.isNotEmpty ?? false);

  factory LdapDirectoryConfiguration.fromJson(Map<String, dynamic> json) {
    List<String> strings(dynamic value) => value is List
        ? value.map((item) => item.toString()).toList(growable: false)
        : const <String>[];

    return LdapDirectoryConfiguration(
      enabled: json['enabled'] == true,
      host: json['host']?.toString() ?? '',
      port: int.tryParse(json['port']?.toString() ?? '') ?? 389,
      tls: json['tls'] == true,
      initialQuery: json['initial_query'] == true,
      sortMode: json['sort_mode']?.toString() ?? 'client',
      nameFilter: json['name_filter']?.toString() ?? '',
      numberFilter: json['number_filter']?.toString() ?? '',
      nameAttributes: strings(json['name_attributes']),
      numberAttributes: strings(json['number_attributes']),
      displayName: json['display_name']?.toString() ?? '%cn',
      ou: json['ou']?.toString(),
      uid: json['uid']?.toString(),
      baseDn: json['base_dn']?.toString(),
      bindDn: json['bind_dn']?.toString(),
      password: json['password']?.toString(),
    );
  }

  Map<String, dynamic> toJson() => {
    'enabled': enabled,
    'host': host,
    'port': port,
    'tls': tls,
    'initial_query': initialQuery,
    'sort_mode': sortMode,
    'name_filter': nameFilter,
    'number_filter': numberFilter,
    'name_attributes': nameAttributes,
    'number_attributes': numberAttributes,
    'display_name': displayName,
    if (ou != null) 'ou': ou,
    if (uid != null) 'uid': uid,
    if (baseDn != null) 'base_dn': baseDn,
    if (bindDn != null) 'bind_dn': bindDn,
    if (password != null) 'password': password,
  };
}

class PbxFeatureConfiguration {
  const PbxFeatureConfiguration({
    this.callParking = true,
    this.recordingControl = true,
    this.pickup = true,
    this.callGroups = true,
    this.queues = true,
    this.monitoring = true,
    this.parkCode = '1900',
    this.recordingMuteSequence = '#1',
    this.recordingUnmuteSequence = '#2',
    this.pickupGroupPrefix = '*0#',
    this.pickupExtensionPrefix = '**',
    this.callGroupPrefix = '*',
    this.callGroupSuffix = '*',
    this.queueLoginPrefix = '120*',
    this.queueLogoutPrefix = '121*',
    this.monitorCode = '154',
  });

  final bool callParking;
  final bool recordingControl;
  final bool pickup;
  final bool callGroups;
  final bool queues;
  final bool monitoring;

  final String parkCode;
  final String recordingMuteSequence;
  final String recordingUnmuteSequence;
  final String pickupGroupPrefix;
  final String pickupExtensionPrefix;
  final String callGroupPrefix;
  final String callGroupSuffix;
  final String queueLoginPrefix;
  final String queueLogoutPrefix;
  final String monitorCode;

  factory PbxFeatureConfiguration.fromConfiguration(
    ProvisioningConfiguration config,
  ) {
    final raw = _map(config.policy['pbx_features']);

    bool enabled(String key, bool fallback) {
      final configured = config.features[key];
      if (configured != null) return configured;
      final value = raw[key];
      return value is bool ? value : fallback;
    }

    String code(String key, String fallback) {
      final value = raw[key]?.toString().trim() ?? '';
      return value.isEmpty ? fallback : value;
    }

    return PbxFeatureConfiguration(
      callParking: enabled('call_parking', true),
      recordingControl: enabled('recording_control', true),
      pickup: enabled('call_pickup', true),
      callGroups: enabled('call_groups', true),
      queues: enabled('dynamic_queues', true),
      monitoring: enabled('call_monitoring', true),
      parkCode: code('park_code', '1900'),
      recordingMuteSequence: code('recording_mute_sequence', '#1'),
      recordingUnmuteSequence: code('recording_unmute_sequence', '#2'),
      pickupGroupPrefix: code('pickup_group_prefix', '*0#'),
      pickupExtensionPrefix: code('pickup_extension_prefix', '**'),
      callGroupPrefix: code('call_group_prefix', '*'),
      callGroupSuffix: code('call_group_suffix', '*'),
      queueLoginPrefix: code('queue_login_prefix', '120*'),
      queueLogoutPrefix: code('queue_logout_prefix', '121*'),
      monitorCode: code('monitor_code', '154'),
    );
  }

  static Map<String, dynamic> _map(dynamic value) {
    if (value is Map) return Map<String, dynamic>.from(value);
    return const <String, dynamic>{};
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

  bool get accessTokenExpiring => accessTokenExpiresAt.isBefore(
    DateTime.now().toUtc().add(const Duration(seconds: 30)),
  );

  ProvisionedDeviceState copyWith({
    String? accessToken,
    String? refreshToken,
    DateTime? accessTokenExpiresAt,
    int? configurationVersion,
    String? deviceState,
    ProvisioningConfiguration? configuration,
  }) => ProvisionedDeviceState(
    deviceId: deviceId,
    accessToken: accessToken ?? this.accessToken,
    refreshToken: refreshToken ?? this.refreshToken,
    accessTokenExpiresAt: accessTokenExpiresAt ?? this.accessTokenExpiresAt,
    configurationVersion: configurationVersion ?? this.configurationVersion,
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
      accessTokenExpiresAt:
          DateTime.tryParse(
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

class MessagingConfiguration {
  const MessagingConfiguration({
    required this.enabled,
    required this.jid,
    required this.password,
    required this.websocket,
    this.ready = true,
  });
  final bool enabled;
  final String jid;
  final String password;
  final String websocket;
  final bool ready;

  bool get configured {
    final uri = Uri.tryParse(websocket);
    return enabled &&
        RegExp(r'^[a-z0-9._+*\-]+@[a-z0-9][a-z0-9.-]*$').hasMatch(jid) &&
        password.isNotEmpty &&
        !password.contains('\u0000') &&
        uri != null &&
        uri.scheme == 'wss' &&
        uri.host.isNotEmpty &&
        uri.userInfo.isEmpty &&
        !uri.hasQuery &&
        !uri.hasFragment;
  }

  factory MessagingConfiguration.fromJson(Map<String, dynamic> json) =>
      MessagingConfiguration(
        enabled: json['enabled'] == true,
        ready: json['ready'] != false,
        jid: (json['jid']?.toString() ?? '').trim().toLowerCase(),
        password: json['password']?.toString() ?? '',
        websocket:
            json['websocket']?.toString() ??
            'wss://ejabberd.voicehost.io/websocket',
      );

  Map<String, dynamic> toJson() => {
    'enabled': enabled,
    if (enabled) 'ready': ready,
    if (enabled) 'jid': jid,
    if (enabled) 'password': password,
    if (enabled) 'websocket': websocket,
  };
}
