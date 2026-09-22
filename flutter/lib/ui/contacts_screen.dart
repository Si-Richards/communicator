import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../controllers/phone_controller.dart';

class ContactsScreen extends StatefulWidget {
  const ContactsScreen({
    super.key,
    required this.controller,
    required this.onGoToPhone,
  });

  final PhoneController controller;
  final VoidCallback onGoToPhone;

  @override
  State<ContactsScreen> createState() => _ContactsScreenState();
}

class _ContactsScreenState extends State<ContactsScreen> {
  static const MethodChannel _contactsChannel =
      MethodChannel('voicehost/contacts');

  final TextEditingController _search = TextEditingController();
  List<_DeviceContact> _contacts = const [];
  bool _loading = true;
  bool _permissionDenied = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _search.addListener(_searchChanged);
    _loadContacts();
  }

  @override
  void dispose() {
    _search
      ..removeListener(_searchChanged)
      ..dispose();
    super.dispose();
  }

  void _searchChanged() => setState(() {});

  Future<void> _loadContacts() async {
    setState(() {
      _loading = true;
      _permissionDenied = false;
      _error = null;
    });

    try {
      final raw =
          await _contactsChannel.invokeMethod<List<dynamic>>('getContacts') ??
              const <dynamic>[];

      final contacts = raw
          .whereType<Map>()
          .map((item) {
            final map = Map<String, dynamic>.from(item);
            final numbers = (map['numbers'] as List<dynamic>? ?? const [])
                .map((value) => value.toString())
                .where((value) => value.trim().isNotEmpty)
                .toList(growable: false);
            return _DeviceContact(
              name: map['name']?.toString().trim().isNotEmpty == true
                  ? map['name'].toString().trim()
                  : numbers.firstOrNull ?? 'Unknown',
              numbers: numbers,
            );
          })
          .where((contact) => contact.numbers.isNotEmpty)
          .toList(growable: false)
        ..sort(
          (a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()),
        );

      if (!mounted) return;
      setState(() {
        _contacts = contacts;
        _loading = false;
      });
    } on PlatformException catch (error) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _permissionDenied = error.code == 'CONTACTS_DENIED';
        _error = _permissionDenied ? null : error.message;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = error.toString();
      });
    }
  }

  List<_DeviceContact> get _filteredContacts {
    final query = _search.text.trim().toLowerCase();
    if (query.isEmpty) return _contacts;
    return _contacts
        .where(
          (contact) =>
              contact.name.toLowerCase().contains(query) ||
              contact.numbers.any((number) => number.toLowerCase().contains(query)),
        )
        .toList(growable: false);
  }

  Future<void> _openSettings() async {
    try {
      await _contactsChannel.invokeMethod<void>('openSettings');
    } catch (_) {}
  }

  void _selectNumber(String number) {
    final dialValue = number.replaceAll(RegExp(r'[^0-9+*#]'), '');
    if (dialValue.isEmpty) return;
    widget.controller.setDialledNumber(dialValue);
    widget.onGoToPhone();
  }

  Future<void> _openContact(_DeviceContact contact) async {
    if (contact.numbers.length == 1) {
      _selectNumber(contact.numbers.first);
      return;
    }

    final selected = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      builder: (context) {
        return SafeArea(
          child: ListView(
            shrinkWrap: true,
            padding: const EdgeInsets.only(bottom: 12),
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 4, 20, 10),
                child: Text(
                  contact.name,
                  style: Theme.of(context).textTheme.titleLarge,
                ),
              ),
              for (final number in contact.numbers)
                ListTile(
                  leading: const Icon(Icons.phone_outlined),
                  title: Text(number),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => Navigator.of(context).pop(number),
                ),
            ],
          ),
        );
      },
    );

    if (selected != null) _selectNumber(selected);
  }

  @override
  Widget build(BuildContext context) {
    final contacts = _filteredContacts;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Contacts'),
        actions: [
          IconButton(
            tooltip: 'Refresh contacts',
            onPressed: _loading ? null : _loadContacts,
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 10),
              child: TextField(
                controller: _search,
                textInputAction: TextInputAction.search,
                decoration: InputDecoration(
                  hintText: 'Search contacts or numbers',
                  prefixIcon: const Icon(Icons.search),
                  suffixIcon: _search.text.isEmpty
                      ? null
                      : IconButton(
                          tooltip: 'Clear search',
                          onPressed: _search.clear,
                          icon: const Icon(Icons.close),
                        ),
                  filled: true,
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(16),
                    borderSide: BorderSide.none,
                  ),
                ),
              ),
            ),
            Expanded(
              child: _loading
                  ? const Center(child: CircularProgressIndicator())
                  : _permissionDenied
                      ? _PermissionDenied(onOpenSettings: _openSettings)
                      : _error != null
                          ? _ContactsError(
                              message: _error!,
                              onRetry: _loadContacts,
                            )
                          : contacts.isEmpty
                              ? const _EmptyContacts()
                              : ListView.separated(
                                  padding: const EdgeInsets.fromLTRB(
                                    12,
                                    4,
                                    12,
                                    24,
                                  ),
                                  itemCount: contacts.length,
                                  separatorBuilder: (_, __) =>
                                      const Divider(height: 1),
                                  itemBuilder: (context, index) {
                                    final contact = contacts[index];
                                    return ListTile(
                                      leading: CircleAvatar(
                                        child: Text(contact.initials),
                                      ),
                                      title: Text(contact.name),
                                      subtitle: Text(
                                        contact.numbers.length == 1
                                            ? contact.numbers.first
                                            : '${contact.numbers.first} · '
                                                '${contact.numbers.length} numbers',
                                      ),
                                      trailing:
                                          const Icon(Icons.phone_outlined),
                                      onTap: () => _openContact(contact),
                                    );
                                  },
                                ),
            ),
          ],
        ),
      ),
    );
  }
}

class _DeviceContact {
  const _DeviceContact({required this.name, required this.numbers});

  final String name;
  final List<String> numbers;

  String get initials {
    final words = name
        .trim()
        .split(RegExp(r'\s+'))
        .where((word) => word.isNotEmpty)
        .toList(growable: false);
    if (words.isEmpty) return '?';
    if (words.length == 1) return words.first.substring(0, 1).toUpperCase();
    return '${words.first.substring(0, 1)}'
            '${words.last.substring(0, 1)}'
        .toUpperCase();
  }
}

class _PermissionDenied extends StatelessWidget {
  const _PermissionDenied({required this.onOpenSettings});

  final Future<void> Function() onOpenSettings;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.contacts_outlined, size: 52),
            const SizedBox(height: 16),
            Text(
              'Contacts access is off',
              style: Theme.of(context).textTheme.titleLarge,
            ),
            const SizedBox(height: 8),
            const Text(
              'Allow VoiceHost to access your contacts to search and dial '
              'numbers from the app.',
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 18),
            FilledButton.icon(
              onPressed: () => onOpenSettings(),
              icon: const Icon(Icons.settings),
              label: const Text('Open iOS Settings'),
            ),
          ],
        ),
      ),
    );
  }
}

class _ContactsError extends StatelessWidget {
  const _ContactsError({required this.message, required this.onRetry});

  final String message;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline, size: 48),
            const SizedBox(height: 12),
            Text(
              'Unable to load contacts',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 8),
            Text(message, textAlign: TextAlign.center),
            const SizedBox(height: 16),
            OutlinedButton.icon(
              onPressed: () => onRetry(),
              icon: const Icon(Icons.refresh),
              label: const Text('Try again'),
            ),
          ],
        ),
      ),
    );
  }
}

class _EmptyContacts extends StatelessWidget {
  const _EmptyContacts();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.person_search_outlined, size: 52),
            const SizedBox(height: 14),
            Text(
              'No contacts found',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 6),
            const Text(
              'Contacts with telephone numbers will appear here.',
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }
}

extension<T> on List<T> {
  T? get firstOrNull => isEmpty ? null : first;
}
