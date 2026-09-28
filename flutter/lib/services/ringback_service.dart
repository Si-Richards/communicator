import 'dart:io';

import 'package:flutter/services.dart';

class RingbackService {
  static const MethodChannel _channel = MethodChannel('voicehost/audio');

  Future<void> start() async {
    if (!Platform.isIOS) return;
    try {
      await _channel.invokeMethod<void>('startRingback');
    } catch (_) {}
  }

  Future<void> stop() async {
    if (!Platform.isIOS) return;
    try {
      await _channel.invokeMethod<void>('stopRingback');
    } catch (_) {}
  }
}
