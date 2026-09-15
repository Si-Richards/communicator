class SipAccount {
  const SipAccount({
    required this.username,
    required this.password,
    required this.realm,
    this.proxy,
    this.displayName,
  });

  final String username;
  final String password;
  final String realm;
  final String? proxy;
  final String? displayName;

  String get sipUri => 'sip:$username@$realm';
}
