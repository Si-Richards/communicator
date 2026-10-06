class DirectoryContact {
  const DirectoryContact({
    required this.name,
    required this.numbers,
    required this.source,
  });

  final String name;
  final List<String> numbers;
  final String source;

  String get initials {
    final words = name
        .trim()
        .split(RegExp(r'\s+'))
        .where((word) => word.isNotEmpty)
        .toList(growable: false);
    if (words.isEmpty) return '?';
    if (words.length == 1) return words.first.substring(0, 1).toUpperCase();
    return ('${words.first.substring(0, 1)}'
            '${words.last.substring(0, 1)}')
        .toUpperCase();
  }
}
