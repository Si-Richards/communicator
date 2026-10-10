import 'package:xml/xml.dart';

/// Only a provider ID travels over XMPP. Media URLs are resolved by GIPHY.
class ChatGifReference {
  const ChatGifReference(this.id);
  static const namespace = 'urn:voicehost:gif:1';
  final String id;
  static bool validId(Object? value) =>
      value is String && RegExp(r'^[a-zA-Z0-9]{1,128}$').hasMatch(value);
  static ChatGifReference? parse(Object? value) =>
      validId(value) ? ChatGifReference(value as String) : null;
  XmlElement encode() => XmlElement(XmlName('gif'), [
    XmlAttribute(XmlName('xmlns'), namespace),
    XmlAttribute(XmlName('provider'), 'giphy'),
    XmlAttribute(XmlName('id'), id),
  ]);
  static ChatGifReference? decode(XmlElement message) {
    final tags = message.findElements('gif', namespace: namespace).toList();
    if (tags.length != 1 ||
        tags.single.getAttribute('provider') != 'giphy' ||
        tags.single.childElements.isNotEmpty) {
      return null;
    }
    return parse(tags.single.getAttribute('id'));
  }
}
