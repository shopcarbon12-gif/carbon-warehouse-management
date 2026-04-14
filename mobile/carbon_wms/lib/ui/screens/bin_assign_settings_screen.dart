import 'dart:async';

import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:carbon_wms/theme/app_theme.dart';

/// Settings for the Bin Assign screen.
/// Persists _manualMode and _scannerSource to SharedPreferences.
class BinAssignSettingsScreen extends StatefulWidget {
  const BinAssignSettingsScreen({super.key});

  @override
  State<BinAssignSettingsScreen> createState() => _BinAssignSettingsScreenState();
}

class _BinAssignSettingsScreenState extends State<BinAssignSettingsScreen> {
  String _scannerSource = 'hardware';
  bool   _manualMode    = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final p = await SharedPreferences.getInstance();
    if (!mounted) return;
    setState(() {
      _scannerSource = p.getString('wms_scanner_source_v1') ?? 'hardware';
      _manualMode    = p.getBool('bin_assign_manual_mode') ?? false;
    });
  }

  Future<void> _setScannerSource(String value) async {
    final p = await SharedPreferences.getInstance();
    await p.setString('wms_scanner_source_v1', value);
    if (!mounted) return;
    setState(() => _scannerSource = value);
  }

  Future<void> _setManualMode(bool value) async {
    final p = await SharedPreferences.getInstance();
    await p.setBool('bin_assign_manual_mode', value);
    if (!mounted) return;
    setState(() => _manualMode = value);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(
          'BIN ASSIGN SETTINGS',
          style: GoogleFonts.manrope(
            fontSize: 13,
            fontWeight: FontWeight.w700,
            letterSpacing: 0.6,
          ),
        ),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text(
            'SCANNER SOURCE',
            style: GoogleFonts.spaceGrotesk(
              fontSize: 11,
              fontWeight: FontWeight.w700,
              letterSpacing: 2.0,
              color: AppColors.textMuted,
            ),
          ),
          const SizedBox(height: 8),
          RadioGroup<String>(
            groupValue: _scannerSource,
            onChanged: (v) { if (v != null) unawaited(_setScannerSource(v)); },
            child: Column(
              children: [
                RadioListTile<String>(
                  title: const Text('Hardware trigger / wedge'),
                  value: 'hardware',
                ),
                RadioListTile<String>(
                  title: const Text('Camera'),
                  value: 'camera',
                ),
              ],
            ),
          ),
          const Divider(height: 32),
          SwitchListTile(
            title: const Text('Manual entry mode'),
            subtitle: const Text('Type bin / SKU manually instead of scanning'),
            value: _manualMode,
            onChanged: (v) => unawaited(_setManualMode(v)),
          ),
        ],
      ),
    );
  }
}
