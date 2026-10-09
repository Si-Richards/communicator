import 'dart:typed_data';

import '../models/chat_attachment.dart';

/// Keep picker streams bounded before any file enters application memory.
Future<Uint8List> readAttachmentBytes(Stream<List<int>> stream) async {
  final bytes = BytesBuilder(copy: false);
  await for (final chunk in stream.timeout(const Duration(seconds: 30))) {
    if (bytes.length + chunk.length > ChatAttachment.maxBytes) {
      throw ArgumentError('Attachments must be no larger than 10 MB.');
    }
    bytes.add(chunk);
  }
  if (bytes.isEmpty) throw ArgumentError('This file is empty.');
  return bytes.takeBytes();
}
