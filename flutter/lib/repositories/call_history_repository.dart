import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import '../models/call_record.dart';

class CallHistoryRepository {
  static const _historyKey = 'voicehost.callHistory.v1';
  static const maximumRecords = 500;

  Future<List<CallRecord>> load() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_historyKey);
    if (raw == null || raw.isEmpty) return [];

    try {
      final list = jsonDecode(raw) as List<dynamic>;
      return list
          .map((item) => CallRecord.fromJson(
                Map<String, dynamic>.from(item as Map),
              ))
          .toList();
    } catch (_) {
      return [];
    }
  }

  Future<void> save(List<CallRecord> records) async {
    final prefs = await SharedPreferences.getInstance();
    final trimmed = records.take(maximumRecords).toList();
    await prefs.setString(
      _historyKey,
      jsonEncode(trimmed.map((record) => record.toJson()).toList()),
    );
  }
}
