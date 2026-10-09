class MessagingContact {
  const MessagingContact({
    required this.jid,
    required this.extension,
    required this.name,
  });
  final String jid;
  final String extension;
  final String name;
  String get label =>
      name.isEmpty || name == extension ? extension : '$name · $extension';
}
