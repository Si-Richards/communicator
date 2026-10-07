import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:cryptography/cryptography.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:path_provider/path_provider.dart';

import '../models/chat_message.dart';

class ChatHistorySnapshot {
  ChatHistorySnapshot({
    this.messages = const [],
    this.cursor,
    this.oldest,
    this.hasOlder = false,
  });
  final List<ChatMessage> messages;
  final String? cursor;
  final String? oldest;
  final bool hasOlder;

  Map<String, dynamic> toJson() => {
    'version': 1,
    'messages': messages.map((message) => message.toJson()).toList(),
    'cursor': cursor,
    'oldest': oldest,
    'has_older': hasOlder,
  };

  factory ChatHistorySnapshot.fromJson(Map<String, dynamic> json) {
    if (json['version'] != 1) {
      throw const FormatException('Unknown history format.');
    }
    final messages = json['messages'] as List;
    if (messages.length > 10000) {
      throw const FormatException('History too large.');
    }
    return ChatHistorySnapshot(
      messages: messages
          .map(
            (item) =>
                ChatMessage.fromJson(Map<String, dynamic>.from(item as Map)),
          )
          .toList(),
      cursor: json['cursor'] as String?,
      oldest: json['oldest'] as String?,
      hasOlder: json['has_older'] == true,
    );
  }
}

abstract class ChatHistoryRepository {
  Future<ChatHistorySnapshot> load(String account);
  Future<void> save(String account, ChatHistorySnapshot snapshot);
  Future<void> delete(String account);
}

/// Message bodies never enter preferences or Keychain. Only the encryption key
/// is in secure storage; the account-scoped file uses authenticated encryption.
class EncryptedChatHistoryRepository implements ChatHistoryRepository {
  EncryptedChatHistoryRepository({
    Future<Directory> Function()? directory,
    Future<List<int>> Function()? key,
  }) : _directory = directory ?? getApplicationSupportDirectory,
       _keyProvider = key;

  final Future<Directory> Function() _directory;
  final Future<List<int>> Function()? _keyProvider;
  final _cipher = AesGcm.with256bits();
  final _secure = const FlutterSecureStorage();
  Future<SecretKey>? _key;

  Future<SecretKey> _secretKey() => _key ??= () async {
    if (_keyProvider != null) return SecretKey(await _keyProvider());
    const name = 'voicehost.messaging.history_key.v1';
    final existing = await _secure.read(key: name);
    if (existing != null) return SecretKey(base64Decode(existing));
    final key = await _cipher.newSecretKey();
    await _secure.write(
      key: name,
      value: base64Encode(await key.extractBytes()),
    );
    return key;
  }();

  Future<File> _file(String account) async {
    final root = await _directory();
    final directory = Directory('${root.path}/message-cache');
    await directory.create(recursive: true);
    final digest = sha256.convert(utf8.encode(account));
    return File('${directory.path}/$digest.json');
  }

  @override
  Future<ChatHistorySnapshot> load(String account) async {
    final file = await _file(account);
    if (!await file.exists()) return ChatHistorySnapshot();
    if (await file.length() > 12 * 1024 * 1024) {
      throw const FormatException('History too large.');
    }
    final envelope = jsonDecode(await file.readAsString()) as Map;
    if (envelope['version'] != 1) {
      throw const FormatException('Unknown cipher format.');
    }
    final box = SecretBox(
      base64Decode(envelope['ciphertext'] as String),
      nonce: base64Decode(envelope['nonce'] as String),
      mac: Mac(base64Decode(envelope['mac'] as String)),
    );
    final plain = await _cipher.decrypt(
      box,
      secretKey: await _secretKey(),
      aad: utf8.encode(account),
    );
    return ChatHistorySnapshot.fromJson(
      jsonDecode(utf8.decode(plain)) as Map<String, dynamic>,
    );
  }

  @override
  Future<void> save(String account, ChatHistorySnapshot snapshot) async {
    final bytes = utf8.encode(jsonEncode(snapshot.toJson()));
    if (bytes.length > 8 * 1024 * 1024) {
      throw const FormatException('History too large.');
    }
    final box = await _cipher.encrypt(
      bytes,
      secretKey: await _secretKey(),
      aad: utf8.encode(account),
    );
    final file = await _file(account);
    final pending = File('${file.path}.tmp');
    await pending.writeAsString(
      jsonEncode({
        'version': 1,
        'ciphertext': base64Encode(box.cipherText),
        'nonce': base64Encode(box.nonce),
        'mac': base64Encode(box.mac.bytes),
      }),
      flush: true,
    );
    await pending.rename(file.path);
  }

  @override
  Future<void> delete(String account) async {
    final file = await _file(account);
    for (final target in [file, File('${file.path}.tmp')]) {
      if (await target.exists()) await target.delete();
    }
  }
}

/// Injectable repository for protocol tests without platform plugins.
class MemoryChatHistoryRepository implements ChatHistoryRepository {
  final Map<String, Map<String, dynamic>> _data = {};
  @override
  Future<ChatHistorySnapshot> load(String account) async =>
      _data[account] == null
      ? ChatHistorySnapshot()
      : ChatHistorySnapshot.fromJson(_data[account]!);
  @override
  Future<void> save(String account, ChatHistorySnapshot snapshot) async {
    // Copy mutable delivery statuses as an actual storage backend would.
    _data[account] =
        jsonDecode(jsonEncode(snapshot.toJson())) as Map<String, dynamic>;
  }

  @override
  Future<void> delete(String account) async {
    _data.remove(account);
  }
}
