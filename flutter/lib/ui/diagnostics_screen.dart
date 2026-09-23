import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../controllers/phone_controller.dart';
import '../services/mobile_call_coordinator.dart';

class DiagnosticsScreen extends StatefulWidget {
  const DiagnosticsScreen({
    super.key,
    required this.controller,
    required this.mobileCalls,
  });

  final PhoneController controller;
  final MobileCallCoordinator mobileCalls;

  @override
  State<DiagnosticsScreen> createState() => _DiagnosticsScreenState();
}

class _DiagnosticsScreenState extends State<DiagnosticsScreen> {
  static const MethodChannel _appChannel = MethodChannel('voicehost/app');

  List<String> _nativeLogs = const [];
  bool _loadingNative = false;
  bool _testingPush = false;
  String _version = 'Unknown';
  String _build = 'Unknown';

  @override
  void initState() {
    super.initState();
    unawaited(_refreshNative());
  }

  Future<void> _refreshNative() async {
    if (_loadingNative) return;
    setState(() => _loadingNative = true);
    try {
      final results = await Future.wait<dynamic>([
        _appChannel.invokeMethod<dynamic>('getBuildInfo'),
        _appChannel.invokeMethod<List<dynamic>>('getNativeLogs'),
      ]);
      final info = results[0];
      final logs = results[1] as List<dynamic>? ?? const <dynamic>[];
      if (!mounted) return;
      setState(() {
        if (info is Map) {
          _version = info['version']?.toString() ?? 'Unknown';
          _build = info['build']?.toString() ?? 'Unknown';
        }
        _nativeLogs = logs.map((item) => item.toString()).toList(growable: false);
      });
    } on MissingPluginException {
      if (!mounted) return;
      setState(() {
        _nativeLogs = const ['Native diagnostics bridge is unavailable in this build.'];
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _nativeLogs = ['Unable to read native diagnostics: $error'];
      });
    } finally {
      if (mounted) setState(() => _loadingNative = false);
    }
  }

  List<String> get _combinedLogs {
    final logs = <String>{
      ..._nativeLogs,
      ...widget.mobileCalls.diagnosticLogs,
    }.toList(growable: false);
    logs.sort((a, b) => b.compareTo(a));
    return logs;
  }

  Future<void> _testPush() async {
    if (_testingPush) return;
    setState(() => _testingPush = true);
    try {
      final environment = await widget.mobileCalls.sendTestPush();
      if (!mounted) return;
      final suffix = environment.isEmpty ? '' : ' via $environment APNs';
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            'Test push sent$suffix. A VoiceHost Push Test call should appear.',
          ),
        ),
      );
      await Future<void>.delayed(const Duration(milliseconds: 700));
      await _refreshNative();
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Push test failed: $error')),
      );
    } finally {
      if (mounted) setState(() => _testingPush = false);
    }
  }

  Future<void> _copyLogs() async {
    final text = _combinedLogs.join('\n');
    await Clipboard.setData(ClipboardData(text: text));
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Diagnostics copied')),
    );
  }

  Future<void> _clearLogs() async {
    widget.mobileCalls.clearDiagnosticLogs();
    try {
      await _appChannel.invokeMethod<void>('clearNativeLogs');
    } catch (_) {}
    await _refreshNative();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: Listenable.merge([widget.controller, widget.mobileCalls]),
      builder: (context, _) {
        final mobile = widget.mobileCalls;
        final logs = _combinedLogs;
        return Scaffold(
          appBar: AppBar(
            title: const Text('Diagnostics'),
            actions: [
              IconButton(
                tooltip: 'Refresh',
                onPressed: _loadingNative ? null : _refreshNative,
                icon: const Icon(Icons.refresh),
              ),
            ],
          ),
          body: ListView(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 28),
            children: [
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Status',
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      const SizedBox(height: 12),
                      _StatusRow(
                        label: 'Build',
                        value: '$_version ($_build)',
                      ),
                      _StatusRow(
                        label: 'PushKit token',
                        value: mobile.hasPushToken ? 'Available' : 'Waiting',
                      ),
                      _StatusRow(
                        label: 'Mobile gateway',
                        value: mobile.gatewayProvisioned
                            ? 'Provisioned'
                            : 'Not provisioned',
                      ),
                      _StatusRow(
                        label: 'Active gateway calls',
                        value: '${mobile.gatewayCallCount}',
                      ),
                      _StatusRow(
                        label: 'Direct SIP',
                        value: widget.controller.registrationStatus,
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 10),
              FilledButton.icon(
                onPressed: !_testingPush &&
                        mobile.gatewayProvisioned &&
                        mobile.hasPushToken
                    ? _testPush
                    : null,
                icon: _testingPush
                    ? const SizedBox.square(
                        dimension: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.notifications_active_outlined),
                label: const Text('Send Test VoIP Push'),
              ),
              const SizedBox(height: 6),
              Text(
                'The test uses Randy and APNs exactly like an incoming mobile '
                'call. No token, password, SDP or ICE data is shown here.',
                style: Theme.of(context).textTheme.bodySmall,
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 18),
              Row(
                children: [
                  Text(
                    'Recent logs',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const Spacer(),
                  IconButton(
                    tooltip: 'Copy logs',
                    onPressed: logs.isEmpty ? null : _copyLogs,
                    icon: const Icon(Icons.copy_outlined),
                  ),
                  IconButton(
                    tooltip: 'Clear logs',
                    onPressed: _clearLogs,
                    icon: const Icon(Icons.delete_outline),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              if (_loadingNative && logs.isEmpty)
                const Center(
                  child: Padding(
                    padding: EdgeInsets.all(24),
                    child: CircularProgressIndicator(),
                  ),
                )
              else if (logs.isEmpty)
                const Card(
                  child: Padding(
                    padding: EdgeInsets.all(18),
                    child: Text('No diagnostics have been recorded yet.'),
                  ),
                )
              else
                Card(
                  clipBehavior: Clip.antiAlias,
                  child: SelectionArea(
                    child: ListView.separated(
                      shrinkWrap: true,
                      physics: const NeverScrollableScrollPhysics(),
                      itemCount: logs.length,
                      separatorBuilder: (_, _) => const Divider(height: 1),
                      itemBuilder: (context, index) {
                        return Padding(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 14,
                            vertical: 10,
                          ),
                          child: Text(
                            logs[index],
                            style: Theme.of(context).textTheme.bodySmall?.copyWith(
                                  fontFamily: 'monospace',
                                ),
                          ),
                        );
                      },
                    ),
                  ),
                ),
            ],
          ),
        );
      },
    );
  }
}

class _StatusRow extends StatelessWidget {
  const _StatusRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          Expanded(child: Text(label)),
          const SizedBox(width: 12),
          Flexible(
            child: Text(
              value,
              textAlign: TextAlign.right,
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
          ),
        ],
      ),
    );
  }
}
