import 'dart:async';

import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart' show CarbonScaffold;

/// Pref keys
const _kManualMode      = 'bin_assign_manual_mode';
const _kManualBin       = 'bin_assign_manual_bin';
const _kManualAddItem   = 'bin_assign_manual_add_item';
const _kExternalScanner = 'bin_assign_external_scanner';
const _kCameraEnabled   = 'bin_assign_camera_enabled';
const _kScannerSource   = 'wms_scanner_source_v1';

/// Settings for the Bin Assign screen.
class BinAssignSettingsScreen extends StatefulWidget {
  const BinAssignSettingsScreen({super.key});

  @override
  State<BinAssignSettingsScreen> createState() => _BinAssignSettingsScreenState();
}

class _BinAssignSettingsScreenState extends State<BinAssignSettingsScreen> {
  bool _manualMode      = false;
  bool _manualBin       = false;
  bool _manualAddItem   = false;
  bool _externalScanner = false;
  bool _cameraEnabled   = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final p = await SharedPreferences.getInstance();
    if (!mounted) return;
    setState(() {
      _manualMode      = p.getBool(_kManualMode)      ?? false;
      _manualBin       = p.getBool(_kManualBin)        ?? false;
      _manualAddItem   = p.getBool(_kManualAddItem)    ?? false;
      _externalScanner = p.getBool(_kExternalScanner)  ?? false;
      _cameraEnabled   = p.getBool(_kCameraEnabled)    ?? true;
    });
  }

  Future<void> _save(String key, bool value) async {
    final p = await SharedPreferences.getInstance();
    await p.setBool(key, value);
  }

  Future<void> _saveScannerSource(String value) async {
    final p = await SharedPreferences.getInstance();
    await p.setString(_kScannerSource, value);
  }

  void _setManualMode(bool v) {
    setState(() => _manualMode = v);
    unawaited(_save(_kManualMode, v));
    if (v) {
      // When manual mode is on, scanner source is 'manual'
      unawaited(_saveScannerSource('manual'));
    } else {
      // Reset sub-options
      setState(() {
        _manualBin       = false;
        _manualAddItem   = false;
        _externalScanner = false;
      });
      unawaited(_save(_kManualBin, false));
      unawaited(_save(_kManualAddItem, false));
      unawaited(_save(_kExternalScanner, false));
      unawaited(_saveScannerSource('hardware'));
    }
  }

  void _setManualBin(bool v) {
    setState(() => _manualBin = v);
    unawaited(_save(_kManualBin, v));
  }

  void _setManualAddItem(bool v) {
    setState(() => _manualAddItem = v);
    unawaited(_save(_kManualAddItem, v));
  }

  void _setExternalScanner(bool v) {
    setState(() => _externalScanner = v);
    unawaited(_save(_kExternalScanner, v));
    if (v) {
      unawaited(_saveScannerSource('hardware'));
    }
  }

  void _setCameraEnabled(bool v) {
    setState(() => _cameraEnabled = v);
    unawaited(_save(_kCameraEnabled, v));
    if (v) {
      unawaited(_saveScannerSource('camera'));
    } else {
      unawaited(_saveScannerSource(_externalScanner ? 'hardware' : 'manual'));
    }
  }

  @override
  Widget build(BuildContext context) {
    final isDark     = Theme.of(context).brightness == Brightness.dark;
    final cardColor  = isDark ? const Color(0xFF1C2828) : Colors.white;
    final mutedColor = isDark ? const Color(0xFF7A9090) : AppColors.textMuted;
    final mainColor  = isDark ? const Color(0xFFE0ECEC) : AppColors.textMain;
    final divColor   = isDark ? Colors.white12 : Colors.black.withValues(alpha: 0.07);

    return CarbonScaffold(
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 20, 16, 40),
        children: [
          // ── MANUAL MODE ─────────────────────────────────────────────────
          _SectionLabel('Manual Mode', mutedColor),
          const SizedBox(height: 8),
          _Card(
            color: cardColor,
            child: Column(
              children: [
                SwitchListTile(
                  contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
                  title: Text('Enable Manual Mode',
                    style: GoogleFonts.manrope(fontSize: 14, fontWeight: FontWeight.w700, color: mainColor)),
                  subtitle: Text('Enter bin codes and SKUs manually',
                    style: TextStyle(color: mutedColor, fontSize: 12)),
                  value: _manualMode,
                  activeThumbColor: AppColors.primary,
                  onChanged: _setManualMode,
                ),
                if (_manualMode) ...[
                  Divider(height: 1, color: divColor),

                  // ── Bin Location checkbox ─────────────────────────────
                  CheckboxListTile(
                    contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 2),
                    title: Text('Bin Location',
                      style: GoogleFonts.manrope(fontSize: 14, fontWeight: FontWeight.w600, color: mainColor)),
                    subtitle: Text('Type bin code manually. A verify button will appear in the bin box.',
                      style: TextStyle(color: mutedColor, fontSize: 12)),
                    value: _manualBin,
                    activeColor: AppColors.primary,
                    onChanged: (v) => _setManualBin(v ?? false),
                  ),

                  Divider(height: 1, color: divColor),

                  // ── Enable Add Item checkbox ──────────────────────────
                  CheckboxListTile(
                    contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 2),
                    title: Text('Enable Add Item',
                      style: GoogleFonts.manrope(fontSize: 14, fontWeight: FontWeight.w600, color: mainColor)),
                    subtitle: Text(
                      'Type SKU to search. Full SKU → assign. '
                      'Base+Color → assign. Base only → pick colors. '
                      'Partial/name → catalog search.',
                      style: TextStyle(color: mutedColor, fontSize: 12)),
                    value: _manualAddItem,
                    activeColor: AppColors.primary,
                    onChanged: (v) => _setManualAddItem(v ?? false),
                  ),

                  Divider(height: 1, color: divColor),

                  // ── External Scanner toggle ───────────────────────────
                  SwitchListTile(
                    contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
                    title: Text('External Scanner',
                      style: GoogleFonts.manrope(fontSize: 14, fontWeight: FontWeight.w600, color: mainColor)),
                    subtitle: Text('Bluetooth 2D scanner (keyboard mode). Auto-jumps from bin → item after each scan.',
                      style: TextStyle(color: mutedColor, fontSize: 12)),
                    value: _externalScanner,
                    activeThumbColor: AppColors.primary,
                    onChanged: _setExternalScanner,
                  ),
                ],
              ],
            ),
          ),

          const SizedBox(height: 24),

          // ── CAMERA ──────────────────────────────────────────────────────
          _SectionLabel('Camera', mutedColor),
          const SizedBox(height: 8),
          _Card(
            color: cardColor,
            child: SwitchListTile(
              contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
              title: Text('Enable Camera',
                style: GoogleFonts.manrope(fontSize: 14, fontWeight: FontWeight.w700, color: mainColor)),
              subtitle: Text(
                'Scan 2D barcodes (bin & items) using phone camera. '
                'Default OFF on RFID devices, ON for regular Android.',
                style: TextStyle(color: mutedColor, fontSize: 12)),
              value: _cameraEnabled,
              activeThumbColor: AppColors.primary,
              onChanged: _setCameraEnabled,
            ),
          ),

          const SizedBox(height: 32),
        ],
      ),
    );
  }
}

// ── Supporting widgets ──────────────────────────────────────────────────────

class _SectionLabel extends StatelessWidget {
  const _SectionLabel(this.text, this.color);
  final String text;
  final Color  color;

  @override
  Widget build(BuildContext context) {
    return Text(
      text.toUpperCase(),
      style: GoogleFonts.spaceGrotesk(
        fontSize: 11,
        fontWeight: FontWeight.w700,
        letterSpacing: 2.0,
        color: color,
      ),
    );
  }
}

class _Card extends StatelessWidget {
  const _Card({required this.color, required this.child});
  final Color  color;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.zero,
      ),
      child: child,
    );
  }
}
