enum CallDirection { incoming, outgoing }

enum CallResult { completed, missed, declined, failed, cancelled }

class CallRecord {
  CallRecord({
    String? id,
    required this.direction,
    required this.number,
    this.displayName,
    required this.startedAt,
    required this.durationSeconds,
    required this.result,
  }) : id = id ?? '${startedAt.microsecondsSinceEpoch}-${number.hashCode}';

  final String id;
  final CallDirection direction;
  final String number;
  final String? displayName;
  final DateTime startedAt;
  final int durationSeconds;
  final CallResult result;

  String get durationText {
    final minutes = durationSeconds ~/ 60;
    final seconds = durationSeconds % 60;
    return '$minutes:${seconds.toString().padLeft(2, '0')}';
  }

  String get resultText => switch (result) {
        CallResult.completed =>
          direction == CallDirection.incoming ? 'Incoming' : 'Outgoing',
        CallResult.missed => 'Missed',
        CallResult.declined => 'Declined',
        CallResult.failed => 'Failed',
        CallResult.cancelled => 'Cancelled',
      };

  Map<String, dynamic> toJson() => {
        'id': id,
        'direction': direction.name,
        'number': number,
        'displayName': displayName,
        'startedAt': startedAt.toIso8601String(),
        'durationSeconds': durationSeconds,
        'result': result.name,
      };

  factory CallRecord.fromJson(Map<String, dynamic> json) => CallRecord(
        id: json['id'] as String?,
        direction: CallDirection.values.byName(json['direction'] as String),
        number: json['number'] as String,
        displayName: json['displayName'] as String?,
        startedAt: DateTime.parse(json['startedAt'] as String),
        durationSeconds: (json['durationSeconds'] as num?)?.toInt() ?? 0,
        result: CallResult.values.byName(json['result'] as String),
      );
}
