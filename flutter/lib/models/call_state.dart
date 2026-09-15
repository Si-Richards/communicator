enum CallPhase {
  idle,
  outgoing,
  ringing,
  incoming,
  earlyMedia,
  connected,
  held,
  ended,
}

class PhoneCallState {
  const PhoneCallState({
    required this.phase,
    this.number,
    this.displayName,
    this.reason,
  });

  const PhoneCallState.idle() : this(phase: CallPhase.idle);

  final CallPhase phase;
  final String? number;
  final String? displayName;
  final String? reason;

  bool get isInCall => switch (phase) {
        CallPhase.outgoing ||
        CallPhase.ringing ||
        CallPhase.incoming ||
        CallPhase.earlyMedia ||
        CallPhase.connected ||
        CallPhase.held => true,
        _ => false,
      };

  bool get isConnected =>
      phase == CallPhase.connected || phase == CallPhase.held;
}
