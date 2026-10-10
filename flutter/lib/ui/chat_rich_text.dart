import 'package:flutter/material.dart';

import '../models/chat_text_format.dart';

TextStyle chatStyle(TextStyle base, int flags) => base.copyWith(
  fontWeight: flags & ChatTextFormat.bold != 0
      ? FontWeight.bold
      : base.fontWeight,
  fontStyle: flags & ChatTextFormat.italic != 0
      ? FontStyle.italic
      : base.fontStyle,
  decoration: TextDecoration.combine([
    if (flags & ChatTextFormat.underline != 0) TextDecoration.underline,
    if (flags & ChatTextFormat.strike != 0) TextDecoration.lineThrough,
  ]),
);

TextSpan chatSpan(String text, List<ChatTextFormat> runs, TextStyle base) {
  final children = <InlineSpan>[];
  var offset = 0;
  for (final run in runs) {
    if (offset < run.start) {
      children.add(TextSpan(text: text.substring(offset, run.start)));
    }
    children.add(
      TextSpan(
        text: text.substring(run.start, run.end),
        style: chatStyle(base, run.style),
      ),
    );
    offset = run.end;
  }
  if (offset < text.length) {
    children.add(TextSpan(text: text.substring(offset)));
  }
  return TextSpan(style: base, children: children);
}

/// Styles live in the editor; selecting text and pressing a button changes it in place.
class ChatRichTextController extends TextEditingController {
  List<int> _styles = [];
  int _typingStyle = 0;
  bool _explicitTypingStyle = false;

  List<ChatTextFormat> get formatting {
    final runs = <ChatTextFormat>[];
    for (var start = 0; start < _styles.length;) {
      var end = start + 1;
      while (end < _styles.length && _styles[end] == _styles[start]) {
        end++;
      }
      if (_styles[start] != 0) {
        runs.add(ChatTextFormat(start, end, _styles[start]));
      }
      start = end;
    }
    return runs;
  }

  int get activeStyle {
    final selected = selection;
    if (selected.isValid && !selected.isCollapsed) {
      var flags = 15;
      for (
        var i = selected.start;
        i < selected.end && i < _styles.length;
        i++
      ) {
        flags &= _styles[i];
      }
      return flags;
    }
    if (_explicitTypingStyle) return _typingStyle;
    final offset = selected.isValid ? selected.baseOffset : text.length;
    return offset > 0 && offset <= _styles.length ? _styles[offset - 1] : 0;
  }

  void toggle(int flag) {
    final selected = selection;
    final remove = activeStyle & flag != 0;
    if (selected.isValid && !selected.isCollapsed) {
      for (var i = selected.start; i < selected.end; i++) {
        _styles[i] = remove ? _styles[i] & ~flag : _styles[i] | flag;
      }
    } else {
      _typingStyle = remove ? activeStyle & ~flag : activeStyle | flag;
      _explicitTypingStyle = true;
    }
    notifyListeners();
  }

  void clearFormatting() {
    final selected = selection;
    if (selected.isValid && !selected.isCollapsed) {
      for (var i = selected.start; i < selected.end; i++) {
        _styles[i] = 0;
      }
    } else {
      _styles = List.filled(text.length, 0);
    }
    _typingStyle = 0;
    _explicitTypingStyle = true;
    notifyListeners();
  }

  @override
  set value(TextEditingValue next) {
    final previous = value;
    if (previous.text != next.text) {
      var prefix = 0, suffix = 0;
      while (prefix < previous.text.length &&
          prefix < next.text.length &&
          previous.text.codeUnitAt(prefix) == next.text.codeUnitAt(prefix)) {
        prefix++;
      }
      while (suffix < previous.text.length - prefix &&
          suffix < next.text.length - prefix &&
          previous.text.codeUnitAt(previous.text.length - suffix - 1) ==
              next.text.codeUnitAt(next.text.length - suffix - 1)) {
        suffix++;
      }
      final flags = activeStyle;
      _styles = [
        ..._styles.take(prefix),
        ...List.filled(next.text.length - prefix - suffix, flags),
        ..._styles.skip(previous.text.length - suffix),
      ];
      if (next.text.isEmpty) {
        _typingStyle = 0;
        _explicitTypingStyle = false;
      }
    } else if (previous.selection != next.selection) {
      _explicitTypingStyle = false;
    }
    super.value = next;
  }

  @override
  TextSpan buildTextSpan({
    required BuildContext context,
    TextStyle? style,
    required bool withComposing,
  }) {
    final base = style ?? const TextStyle();
    if (!withComposing ||
        !value.isComposingRangeValid ||
        value.composing.isCollapsed) {
      return chatSpan(text, formatting, base);
    }
    // Preserve the platform's IME underline while retaining existing styles.
    final children = <InlineSpan>[];
    for (var start = 0; start < text.length;) {
      int flags(int i) =>
          _styles[i] |
          (i >= value.composing.start && i < value.composing.end
              ? ChatTextFormat.underline
              : 0);
      var end = start + 1;
      while (end < text.length && flags(end) == flags(start)) {
        end++;
      }
      children.add(
        TextSpan(
          text: text.substring(start, end),
          style: chatStyle(base, flags(start)),
        ),
      );
      start = end;
    }
    return TextSpan(style: base, children: children);
  }
}

class ChatFormattingToolbar extends StatelessWidget {
  const ChatFormattingToolbar({
    super.key,
    required this.controller,
    required this.enabled,
  });
  final ChatRichTextController controller;
  final bool enabled;
  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: controller,
    builder: (context, _) => Wrap(
      children: [
        for (final button in [
          (ChatTextFormat.bold, Icons.format_bold, 'Bold'),
          (ChatTextFormat.italic, Icons.format_italic, 'Italic'),
          (ChatTextFormat.underline, Icons.format_underlined, 'Underline'),
          (ChatTextFormat.strike, Icons.format_strikethrough, 'Strikethrough'),
        ])
          IconButton(
            tooltip: button.$3,
            isSelected: controller.activeStyle & button.$1 != 0,
            onPressed: enabled ? () => controller.toggle(button.$1) : null,
            icon: Icon(button.$2),
          ),
        IconButton(
          tooltip: 'Clear formatting',
          onPressed: enabled ? controller.clearFormatting : null,
          icon: const Icon(Icons.format_clear),
        ),
      ],
    ),
  );
}
