/// Only an opaque first-party identifier goes over XMPP, never a URL or token.
class ChatAttachment {
  ChatAttachment({
    required this.id,
    required this.name,
    required this.mediaType,
    required this.size,
    required this.sha256,
  }) {
    if (!_hex.hasMatch(id) ||
        !_hex.hasMatch(sha256) ||
        name.isEmpty ||
        name.length > 160 ||
        name.contains(RegExp(r'[\x00-\x1f\x7f/\\]')) ||
        size < 1 ||
        size > maxBytes ||
        !_types.contains(mediaType)) {
      throw const FormatException('Invalid attachment metadata.');
    }
  }
  static const maxBytes = 10 * 1024 * 1024;
  static const namespace = 'urn:voicehost:messaging:attachment:1';
  static final _hex = RegExp(r'^[a-f0-9]{64}$');
  static const _types = {
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'application/octet-stream',
  };
  final String id;
  final String name;
  final String mediaType;
  final int size;
  final String sha256;
  bool get isImage => mediaType.startsWith('image/');
  String get summary => '${isImage ? 'Photo' : 'File'}: $name';
  String get sizeLabel => size < 1024 * 1024
      ? '${(size / 1024).ceil()} KB'
      : '${(size / (1024 * 1024)).toStringAsFixed(1)} MB';
  Map<String, dynamic> toJson() => {
    'id': id,
    'name': name,
    'media_type': mediaType,
    'size': size,
    'sha256': sha256,
  };
  factory ChatAttachment.fromJson(Map<String, dynamic> json) => ChatAttachment(
    id: json['id'] as String,
    name: json['name'] as String,
    mediaType: json['media_type'] as String,
    size: json['size'] as int,
    sha256: json['sha256'] as String,
  );
  static ChatAttachment? tryFromJson(Object? value) {
    if (value is! Map) return null;
    try {
      return ChatAttachment.fromJson(Map<String, dynamic>.from(value));
    } catch (_) {
      return null;
    }
  }
}
