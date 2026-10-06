import 'package:dartdap/dartdap.dart';

import '../models/directory_contact.dart';
import '../models/provisioning.dart';

class LdapDirectoryService {
  const LdapDirectoryService();

  static const _numberAttributes = <String>[
    'telephoneNumber',
    'mobile',
    'vhVoIPPhone',
    'vhVoIPExt',
  ];

  Future<List<DirectoryContact>> search(
    LdapDirectoryConfiguration config,
    String query, {
    int limit = 50,
  }) async {
    final clean = query.trim();
    if (!config.configured || clean.isEmpty) return const [];

    final baseDn = config.baseDn!.trim();
    final bindDn = config.bindDn!.trim();
    final password = config.password!;
    final numeric = RegExp(r'^[0-9+*#]+      host: config.host,
      port: config.port,
      ssl: config.tls,
      bindDN: DN(bindDn),
      password: password,
    );

    try {
      await connection.open().timeout(const Duration(seconds: 5));
      await connection.bind().timeout(const Duration(seconds: 5));
      final result = await connection
          .query(
            DN(baseDn),
            searchFilter,
            const [
              'cn',
              'telephoneNumber',
              'mobile',
              'vhVoIPPhone',
              'vhVoIPExt',
            ],
            sizeLimit: limit,
          )
          .timeout(const Duration(seconds: 8));

      final contacts = <DirectoryContact>[];
      await for (final entry in result.stream) {
        final name = _firstValue(entry, 'cn');
        final numbers = <String>[];
        for (final attribute in _numberAttributes) {
          numbers.addAll(_values(entry, attribute));
        }
        final uniqueNumbers = <String>[];
        final seen = <String>{};
        for (final number in numbers) {
          final trimmed = number.trim();
          if (trimmed.isEmpty) continue;
          if (seen.add(trimmed)) uniqueNumbers.add(trimmed);
        }
        if (uniqueNumbers.isEmpty) continue;
        contacts.add(
          DirectoryContact(
            name: name.isNotEmpty ? name : uniqueNumbers.first,
            numbers: uniqueNumbers,
            source: 'LDAP',
          ),
        );
      }

      contacts.sort(
        (a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()),
      );
      return contacts;
    } finally {
      try {
        await connection.close();
      } catch (_) {}
    }
  }

  static String _escapeFilterValue(String value) {
    final buffer = StringBuffer();
    for (final codeUnit in value.codeUnits) {
      switch (codeUnit) {
        case 0x00:
          buffer.write(r'\00');
          break;
        case 0x28:
          buffer.write(r'\28');
          break;
        case 0x29:
          buffer.write(r'\29');
          break;
        case 0x2a:
          buffer.write(r'\2a');
          break;
        case 0x5c:
          buffer.write(r'\5c');
          break;
        default:
          buffer.writeCharCode(codeUnit);
      }
    }
    return buffer.toString();
  }

  static String _firstValue(SearchEntry entry, String attribute) {
    final values = _values(entry, attribute);
    return values.isEmpty ? '' : values.first;
  }

  static List<String> _values(SearchEntry entry, String attribute) {
    for (final item in entry.attributes.entries) {
      if (item.key.toLowerCase() != attribute.toLowerCase()) continue;
      return item.value.values
          .map((value) => value.toString())
          .where((value) => value.trim().isNotEmpty)
          .toList(growable: false);
    }
    return const [];
  }
}
).hasMatch(clean);
    final escaped = _escapeFilterValue(clean);
    final numberMatches = _numberAttributes
        .map((attribute) => '($attribute=$escaped*)')
        .join();
    final searchFilter = numeric
        ? '(|$numberMatches)'
        : '(&(|(sn=$escaped*)(givenName=$escaped*))'
            '(|(telephoneNumber=*)(mobile=*)'
            '(vhVoIPPhone=*)(vhVoIPExt=*)))';

    final connection = LdapConnection(
      host: config.host,
      port: config.port,
      ssl: config.tls,
      bindDN: DN(bindDn),
      password: password,
    );

    try {
      await connection.open().timeout(const Duration(seconds: 5));
      await connection.bind().timeout(const Duration(seconds: 5));
      final result = await connection
          .search(
            DN(baseDn),
            searchFilter,
            const [
              'cn',
              'telephoneNumber',
              'mobile',
              'vhVoIPPhone',
              'vhVoIPExt',
            ],
            sizeLimit: limit,
          )
          .timeout(const Duration(seconds: 8));

      final contacts = <DirectoryContact>[];
      await for (final entry in result.stream) {
        final name = _firstValue(entry, 'cn');
        final numbers = <String>[];
        for (final attribute in _numberAttributes) {
          numbers.addAll(_values(entry, attribute));
        }
        final uniqueNumbers = <String>[];
        final seen = <String>{};
        for (final number in numbers) {
          final trimmed = number.trim();
          if (trimmed.isEmpty) continue;
          if (seen.add(trimmed)) uniqueNumbers.add(trimmed);
        }
        if (uniqueNumbers.isEmpty) continue;
        contacts.add(
          DirectoryContact(
            name: name.isNotEmpty ? name : uniqueNumbers.first,
            numbers: uniqueNumbers,
            source: 'LDAP',
          ),
        );
      }

      contacts.sort(
        (a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()),
      );
      return contacts;
    } finally {
      try {
        await connection.close();
      } catch (_) {}
    }
  }

  static String _firstValue(SearchEntry entry, String attribute) {
    final values = _values(entry, attribute);
    return values.isEmpty ? '' : values.first;
  }

  static List<String> _values(SearchEntry entry, String attribute) {
    for (final item in entry.attributes.entries) {
      if (item.key.toLowerCase() != attribute.toLowerCase()) continue;
      return item.value.values
          .map((value) => value.toString())
          .where((value) => value.trim().isNotEmpty)
          .toList(growable: false);
    }
    return const [];
  }
}
