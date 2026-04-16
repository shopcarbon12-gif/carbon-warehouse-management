import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/hardware/rfid_manager.dart';

/// Captures rugged "keyboard wedge" scans globally and forwards EPC-like payloads to [RfidManager].
///
/// Some scanner services inject scans as keyboard input instead of broadcast intents.
/// This bridge listens to hardware key events and feeds the same RFID pipeline.
class KeyboardWedgeBridge extends StatefulWidget {
  const KeyboardWedgeBridge({super.key, required this.child});

  final Widget child;

  @override
  State<KeyboardWedgeBridge> createState() => _KeyboardWedgeBridgeState();
}

class _KeyboardWedgeBridgeState extends State<KeyboardWedgeBridge> {
  final StringBuffer _buffer = StringBuffer();
  Timer? _flushTimer;

  static final RegExp _printable = RegExp(r'^[ -~]$');

  @override
  void initState() {
    super.initState();
    HardwareKeyboard.instance.addHandler(_onHardwareKey);
  }

  @override
  void dispose() {
    HardwareKeyboard.instance.removeHandler(_onHardwareKey);
    _flushTimer?.cancel();
    super.dispose();
  }

  bool _onHardwareKey(KeyEvent event) {
    if (event is! KeyDownEvent) return false;
    if (_isTextInputFocused()) return false;

    if (event.logicalKey == LogicalKeyboardKey.enter) {
      _flushBuffer();
      return false;
    }

    final c = event.character;
    if (c == null || c.isEmpty) return false;
    if (!_printable.hasMatch(c)) return false;

    _buffer.write(c.toUpperCase());
    _flushTimer?.cancel();
    _flushTimer = Timer(const Duration(milliseconds: 140), _flushBuffer);
    return false;
  }

  bool _isTextInputFocused() {
    final ctx = FocusManager.instance.primaryFocus?.context;
    if (ctx == null) return false;
    return ctx.widget is EditableText;
  }

  void _flushBuffer() {
    _flushTimer?.cancel();
    final raw = _buffer.toString().trim();
    _buffer.clear();
    if (raw.isEmpty) return;
    if (!mounted) return;
    context.read<RfidManager>().addSimulatedEpc(raw);
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
