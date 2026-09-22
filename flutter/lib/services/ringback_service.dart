import 'dart:io';

import 'package:flutter/services.dart';

class RingbackService {
  static const MethodChannel _channel = MethodChannel('voicehost/audio');

  bool _playing = false;

  Future<void> start() async {
    if (_playing || !Platform.isIOS) return;
    _playing = true;
    try {
      await _channel.invokeMethod<void>('startRingback');
    } catch (_) {
      _playing = false;
    }
  }

  Future<void> stop() async {
    if (!_playing || !Platform.isIOS) return;
    _playing = false;
    try {
      await _channel.invokeMethod<void>('stopRingback');
    } catch (_) {}
  }
}
