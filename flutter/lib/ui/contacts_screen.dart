import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../controllers/phone_controller.dart';
import '../controllers/provisioning_controller.dart';
import '../models/directory_contact.dart';
import '../services/ldap_directory_service.dart';

class ContactsScreen extends StatefulWidget {
  const ContactsScreen({
    super.key,
    required this.controller,
    required this.provisioning,
    required this.onGoToPhone,
  });

  final PhoneController controller;
  final ProvisioningController provisioning;
  final VoidCallback onGoToPhone;

  @override
  State<ContactsScreen> createState() => _ContactsScreenState();
}

enum _ContactScope { all, personal, company }

class _ContactsScreenState extends State<ContactsScreen>
    with WidgetsBindingObserver {
  static const MethodChannel _contactsChannel =
      MethodChannel('voicehost/contacts');

  final TextEditingController _search = TextEditingController();
  final LdapDirectoryService _ldap = const LdapDirectoryService();

  List<DirectoryContact> _deviceContacts = const [];
  List<DirectoryContact> _ldapContacts = const [];
  Timer? _ldapDebounce;
  int _ldapSearchGeneration = 0;
  bool _loadingDevice = true;
  bool _ldapSearching = false;
  bool _permissionDenied = false;
  String? _deviceError;
  String? _ldapError;
  _ContactScope _scope = _ContactScope.all;

  bool get _ldapConfigured =>
      widget.provisioning.configuration?.ldapDirectory?.configured == true;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    widget.provisioning.addListener(_provisioningChanged);
    _search.addListener(_searchChanged);
    _loadContacts();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    widget.provisioning.removeListener(_provisioningChanged);
    _ldapDebounce?.cancel();
    _search
      ..removeListener(_searchChanged)
      ..dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && _permissionDenied) {
      _loadContacts();
    }
  }

  void _provisioningChanged() {
    if (!mounted) return;
    if (!_ldapConfigured) {
      _ldapDebounce?.cancel();
      _ldapSearchGeneration++;
      setState(() {
        _ldapContacts = const [];
        _ldapSearching = false;
        _ldapError = null;
      });
      return;
    }
    _scheduleLdapSearch();
  }

  void _searchChanged() {
    setState(() {});
    _scheduleLdapSearch();
  }

  void _scheduleLdapSearch() {
    _ldapDebounce?.cancel();
    final query = _search.text.trim();
    if (!_ldapConfigured || query.isEmpty || _scope == _ContactScope.personal) {
      _ldapSearchGeneration++;
      if (mounted) {
        setState(() {
          _ldapContacts = const [];
          _ldapSearching = false;
          _ldapError = null;
        });
      }
      return;
    }
    _ldapDebounce = Timer(
      const Duration(milliseconds: 300),
      () => unawaited(_searchLdap(query)),
    );
  }

  Future<void> _searchLdap(String query) async {
    final config = widget.provisioning.configuration?.ldapDirectory;
    if (config == null || !config.configured) return;

    final generation = ++_ldapSearchGeneration;
    setState(() {
      _ldapSearching = true;
      _ldapError = null;
    });

    try {
      final results = await _ldap.search(config, query);
      if (!mounted || generation != _ldapSearchGeneration) return;
      setState(() {
        _ldapContacts = results;
        _ldapSearching = false;
      });
    } catch (error) {
      if (!mounted || generation != _ldapSearchGeneration) return;
      setState(() {
        _ldapContacts = const [];
        _ldapSearching = false;
        _ldapError = 'Directory search unavailable: $error';
      });
    }
  }

  Future<void> _loadContacts() async {
    setState(() {
      _loadingDevice = true;
      _permissionDenied = false;
      _deviceError = null;
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
            return DirectoryContact(
              name: map['name']?.toString().trim().isNotEmpty == true
                  ? map['name'].toString().trim()
                  : numbers.firstOrNull ?? 'Unknown',
              numbers: numbers,
              source: 'Personal',
            );
          })
          .where((contact) => contact.numbers.isNotEmpty)
          .toList(growable: false)
        ..sort(
          (a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()),
        );

      if (!mounted) return;
      setState(() {
        _deviceContacts = contacts;
        _loadingDevice = false;
      });
    } on MissingPluginException {
      if (!mounted) return;
      setState(() {
        _loadingDevice = false;
        _deviceError =
            'The native contacts bridge is not available in this installed '
            'build. Install the latest Softphone build and try again.';
      });
    } on PlatformException catch (error) {
      if (!mounted) return;
      setState(() {
        _loadingDevice = false;
        _permissionDenied = error.code == 'CONTACTS_DENIED';
        _deviceError = _permissionDenied ? null : error.message;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _loadingDevice = false;
        _deviceError = error.toString();
      });
    }
  }

  List<DirectoryContact> get _visibleContacts {
    final query = _search.text.trim().toLowerCase();
    final local = query.isEmpty
        ? _deviceContacts
        : _deviceContacts
            .where(
              (contact) =>
                  contact.name.toLowerCase().contains(query) ||
                  contact.numbers.any(
                    (number) => number.toLowerCase().contains(query),
                  ),
            )
            .toList(growable: false);

    final merged = <DirectoryContact>[
      if (_scope != _ContactScope.company) ...local,
      if (_scope != _ContactScope.personal && query.isNotEmpty)
        ..._ldapContacts,
    ];
    merged.sort(
      (a, b) {
        final byName = a.name.toLowerCase().compareTo(b.name.toLowerCase());
        if (byName != 0) return byName;
        return a.source.compareTo(b.source);
      },
    );
    return merged;
  }

  int get _visiblePersonalCount =>
      _visibleContacts.where((contact) => contact.source == 'Personal').length;

  int get _visibleCompanyCount => _visibleContacts
      .where((contact) => contact.source == 'Company Directory')
      .length;

  void _setScope(_ContactScope scope) {
    if (_scope == scope) return;
    setState(() => _scope = scope);
    _scheduleLdapSearch();
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

  Future<void> _openContact(DirectoryContact contact) async {
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
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      contact.name,
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                    Text(
                      contact.source,
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ],
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
    final contacts = _visibleContacts;
    final query = _search.text.trim();

    Widget content;
    if (_permissionDenied && !_ldapConfigured) {
      content = _PermissionDenied(onOpenSettings: _openSettings);
    } else if (_deviceError != null && !_ldapConfigured) {
      content = _ContactsError(
        message: _deviceError!,
        onRetry: _loadContacts,
      );
    } else if (_loadingDevice && contacts.isEmpty && query.isEmpty) {
      content = const Center(child: CircularProgressIndicator());
    } else if (contacts.isEmpty && !_ldapSearching) {
      content = _EmptyContacts(
        ldapConfigured: _ldapConfigured,
        searching: query.isNotEmpty,
      );
    } else {
      content = ListView.separated(
        padding: const EdgeInsets.fromLTRB(12, 4, 12, 24),
        itemCount: contacts.length,
        separatorBuilder: (_, _) => const Divider(height: 1),
        itemBuilder: (context, index) {
          final contact = contacts[index];
          final numberText = contact.numbers.length == 1
              ? contact.numbers.first
              : '${contact.numbers.first} · ${contact.numbers.length} numbers';
          return ListTile(
            leading: contact.source == 'Company Directory'
                ? const CircleAvatar(
                    child: Icon(Icons.corporate_fare_outlined, size: 20),
                  )
                : CircleAvatar(child: Text(contact.initials)),
            title: Text(contact.name),
            subtitle: Text('${contact.source} · $numberText'),
            trailing: const Icon(Icons.phone_outlined),
            onTap: () => _openContact(contact),
          );
        },
      );
    }

    return Scaffold(
      appBar: AppBar(
        title: const Text('Contacts'),
        actions: [
          IconButton(
            tooltip: 'Refresh contacts',
            onPressed: _loadingDevice
                ? null
                : () {
                    unawaited(_loadContacts());
                    _scheduleLdapSearch();
                  },
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: SafeArea(
        child: Column(
          children: [
            if (_ldapConfigured)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
                child: Row(
                  children: [
                    Expanded(
                      child: SingleChildScrollView(
                        scrollDirection: Axis.horizontal,
                        child: Row(
                          children: [
                            ChoiceChip(
                              label: const Text('All'),
                              selected: _scope == _ContactScope.all,
                              onSelected: (_) => _setScope(_ContactScope.all),
                            ),
                            const SizedBox(width: 8),
                            ChoiceChip(
                              label: const Text('Personal'),
                              selected: _scope == _ContactScope.personal,
                              onSelected: (_) =>
                                  _setScope(_ContactScope.personal),
                            ),
                            const SizedBox(width: 8),
                            ChoiceChip(
                              label: const Text('Company'),
                              selected: _scope == _ContactScope.company,
                              onSelected: (_) =>
                                  _setScope(_ContactScope.company),
                            ),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Tooltip(
                      message: 'LDAP directory connection',
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(
                            Icons.check_circle_outline,
                            size: 16,
                            color: Theme.of(context).colorScheme.secondary,
                          ),
                          const SizedBox(width: 4),
                          Text(
                            'Connected',
                            style: Theme.of(context).textTheme.bodySmall,
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 10),
              child: TextField(
                controller: _search,
                textInputAction: TextInputAction.search,
                decoration: InputDecoration(
                  hintText: _ldapConfigured
                      ? 'Search names, extensions or numbers'
                      : 'Search contacts or numbers',
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
            if (_ldapConfigured && query.isNotEmpty && !_ldapSearching)
              Padding(
                padding: const EdgeInsets.fromLTRB(18, 0, 18, 8),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: Text(
                    '$_visiblePersonalCount personal · '
                    '$_visibleCompanyCount company directory results',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ),
              ),
            if (_permissionDenied && _ldapConfigured)
              MaterialBanner(
                content: const Text(
                  'Device Contacts access is off. Company directory search is still available.',
                ),
                actions: [
                  TextButton(
                    onPressed: _openSettings,
                    child: const Text('Settings'),
                  ),
                ],
              ),
            if (_ldapSearching)
              const LinearProgressIndicator(minHeight: 2),
            if (_ldapError != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: Text(
                    _ldapError!,
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.error,
                      fontSize: 12,
                    ),
                  ),
                ),
              ),
            Expanded(child: content),
          ],
        ),
      ),
    );
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
              'Allow Softphone to access your contacts to search and dial '
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
  const _EmptyContacts({
    required this.ldapConfigured,
    required this.searching,
  });

  final bool ldapConfigured;
  final bool searching;

  @override
  Widget build(BuildContext context) {
    final message = ldapConfigured && !searching
        ? 'Search your personal contacts and company directory by name, '
            'extension or telephone number.'
        : 'No contacts matched your search.';
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
            Text(message, textAlign: TextAlign.center),
          ],
        ),
      ),
    );
  }
}

extension<T> on List<T> {
  T? get firstOrNull => isEmpty ? null : first;
}
