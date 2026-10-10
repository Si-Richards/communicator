import 'package:xml/xml.dart';

/// A deliberately small XHTML-IM subset, rendered as native text, never HTML.
class ChatTextFormat {
  const ChatTextFormat(this.start, this.end, this.style);
  static const bold = 1, italic = 2, underline = 4, strike = 8;
  static const htmlNamespace = 'http://jabber.org/protocol/xhtml-im';
  static const xhtmlNamespace = 'http://www.w3.org/1999/xhtml';
  final int start, end, style;
  Map<String, dynamic> toJson() => {'start': start, 'end': end, 'style': style};

  static List<ChatTextFormat> parse(Object? value, String body) {
    if (value is! List || value.length > 1000) return const [];
    final runs = <ChatTextFormat>[];
    var previous = 0;
    for (final item in value) {
      if (item is! Map) return const [];
      final start = item['start'], end = item['end'], style = item['style'];
      if (start is! int ||
          end is! int ||
          style is! int ||
          start < previous ||
          end <= start ||
          end > body.length ||
          style < 1 ||
          style > 15) {
        return const [];
      }
      runs.add(ChatTextFormat(start, end, style));
      previous = end;
    }
    return runs;
  }

  static String css(int flags) => [
    if (flags & bold != 0) 'font-weight: bold',
    if (flags & italic != 0) 'font-style: italic',
    if (flags & (underline | strike) != 0)
      'text-decoration: ${[if (flags & underline != 0) 'underline', if (flags & strike != 0) 'line-through'].join(' ')}',
  ].join('; ');

  static XmlElement? encode(String body, List<ChatTextFormat> runs) {
    if (runs.isEmpty) return null;
    final valid = parse(runs.map((r) => r.toJson()).toList(), body);
    if (valid.length != runs.length) {
      throw ArgumentError('Invalid text formatting.');
    }
    final nodes = <XmlNode>[];
    var offset = 0;
    for (final run in runs) {
      if (offset < run.start) {
        nodes.add(XmlText(body.substring(offset, run.start)));
      }
      nodes.add(
        XmlElement(
          XmlName('span'),
          [XmlAttribute(XmlName('style'), css(run.style))],
          [XmlText(body.substring(run.start, run.end))],
        ),
      );
      offset = run.end;
    }
    if (offset < body.length) nodes.add(XmlText(body.substring(offset)));
    return XmlElement(
      XmlName('html'),
      [XmlAttribute(XmlName('xmlns'), htmlNamespace)],
      [
        XmlElement(
          XmlName('body'),
          [XmlAttribute(XmlName('xmlns'), xhtmlNamespace)],
          [XmlElement(XmlName('p'), [], nodes)],
        ),
      ],
    );
  }

  static List<ChatTextFormat> decode(XmlElement message, String body) {
    final html = message
        .findElements('html', namespace: htmlNamespace)
        .toList();
    if (html.length != 1 || html.single.toXmlString().length > 100000) {
      return const [];
    }
    final root = html.single.getElement('body', namespace: xhtmlNamespace);
    if (root == null) return const [];
    final text = StringBuffer();
    final runs = <ChatTextFormat>[];
    var count = 0;
    void visit(XmlNode node, int flags, int depth) {
      if (++count > 3000 || depth > 12) throw const FormatException();
      if (node is XmlText) {
        final start = text.length;
        text.write(node.value);
        if (text.length > 10000) throw const FormatException();
        if (flags != 0 && text.length > start) {
          runs.add(ChatTextFormat(start, text.length, flags));
        }
      } else if (node is XmlElement) {
        if (node.namespaceUri != xhtmlNamespace) throw const FormatException();
        flags |= switch (node.name.local) {
          'strong' => bold,
          'em' => italic,
          'body' || 'p' || 'span' => 0,
          'br' => 0,
          _ => throw const FormatException(),
        };
        final styles = node.getAttribute('style') ?? '';
        for (final rule in styles.split(';')) {
          final pair = rule
              .split(':')
              .map((s) => s.trim().toLowerCase())
              .toList();
          if (pair.length != 2) continue;
          if (pair[0] == 'font-weight' && pair[1] == 'bold') flags |= bold;
          if (pair[0] == 'font-style' && pair[1] == 'italic') flags |= italic;
          if (pair[0] == 'text-decoration') {
            if (pair[1].split(' ').contains('underline')) flags |= underline;
            if (pair[1].split(' ').contains('line-through')) flags |= strike;
          }
        }
        if (node.name.local == 'br') {
          visit(XmlText('\n'), flags, depth + 1);
        } else {
          for (final child in node.children) {
            visit(child, flags, depth + 1);
          }
        }
      }
    }

    try {
      visit(root, 0, 0);
      // The plain body is authoritative. Never show substituted text or load URLs.
      return text.toString() == body && runs.length <= 1000 ? runs : const [];
    } on FormatException {
      return const [];
    }
  }
}
