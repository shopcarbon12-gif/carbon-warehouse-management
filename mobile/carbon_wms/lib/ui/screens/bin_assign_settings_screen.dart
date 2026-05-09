import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:carbon_wms/services/bin_assign_session.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart' show CarbonScaffold;

/// Pref keys that legitimately persist across cold starts — the camera
/// toggle is a hardware preference (default ON for plain Android, OFF on
/// rugged RFID handhelds), and the scanner-source key is read from
/// fast_putaway_screen to decide which input method is active.
const _kCameraEnabled = 'bin_assign_camera_enabled';
const _kScannerSource = 'wms_scanner_source_v1';

/// Settings for the Bin Assign screen. Manual-mode flags live in
/// [BinAssignSession] (in-memory, resets on app kill).
class BinAssignSettingsScreen extends StatefulWidget {
  const BinAssignSettingsScreen({super.key});

  @override
  State<BinAssignSettingsScreen> createState() => _BinAssignSettingsScreenState();
}

class _BinAssignSettingsScreenState extends State<BinAssignSettingsScreen> {
  bool _manualMode = false;
  bool _manualBin = false;
  bool _manualAddItem = false;
  bool _externalScanner = false;
  bool _cameraEnabled = true;

  @override
  void initState() {
    super.initState();
    _loadFromSession();
    _loadCameraPref();
  }

  void _loadFromSession() {
    _manualMode = BinAssignSession.manualModeEnabled;
    _manualBin = BinAssignSession.manualBin;
    _manualAddItem = BinAssignSession.manualAddItem;
    _externalScanner = BinAssignSession.externalScanner;
  }

  Future<void> _loadCameraPref() async {
    final p = await SharedPreferences.getInstance();
    if (!mounted) return;
    setState(() {
      _cameraEnabled = p.getBool(_kCameraEnabled) ?? true;
    });
  }

  Future<void> _saveCamera(bool value) async {
    final p = await SharedPreferences.getInstance();
    await p.setBool(_kCameraEnabled, value);
  }

  Future<void> _saveScannerSource(String value) async {
    final p = await SharedPreferences.getInstance();
    await p.setString(_kScannerSource, value);
  }

  void _setManualMode(bool v) {
    BinAssignSession.setManualMode(v);
    setState(() {
      _manualMode = BinAssignSession.manualModeEnabled;
      _manualBin = BinAssignSession.manualBin;
      _manualAddItem = BinAssignSession.manualAddItem;
      _externalScanner = BinAssignSession.externalScanner;
    });
    unawaited(_saveScannerSource(v ? 'manual' : 'hardware'));
  }

  void _setManualBin(bool v) {
    BinAssignSession.setManualBin(v);
    setState(() => _manualBin = v);
  }

  void _setManualAddItem(bool v) {
    BinAssignSession.setManualAddItem(v);
    setState(() => _manualAddItem = v);
  }

  void _setExternalScanner(bool v) {
    BinAssignSession.setExternalScanner(v);
    setState(() => _externalScanner = v);
    if (v) {
      unawaited(_saveScannerSource('hardware'));
    }
  }

  void _setCameraEnabled(bool v) {
    setState(() => _cameraEnabled = v);
    unawaited(_saveCamera(v));
    if (v) {
      unawaited(_saveScannerSource('camera'));
    } else {
      unawaited(_saveScannerSource(_externalScanner ? 'hardware' : 'manual'));
    }
  }

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final cardColor = isDark ? const Color(0xFF1C2828) : Colors.white;
    final mutedColor = isDark ? const Color(0xFF7A9090) : AppColors.textMuted;
    final mainColor = isDark ? const Color(0xFFE0ECEC) : AppColors.textMain;
    final divColor = isDark ? Colors.white12 : Colors.black.withValues(alpha: 0.07);

    // Title flips with the toggle: "Enable …" when off, "Disable …" when
    // on. Flipping the title (and not just the switch) makes the action
    // unambiguous — the operator was confused by a static "Enable" label
    // sitting next to an already-on switch.
    final manualToggleTitle =
        _manualMode ? 'Disable Manual Mode' : 'Enable Manual Mode';
    final manualToggleSubtitle = _manualMode
        ? 'Manual mode is active for this session — turning off resets the bin assign screen.'
        : 'Enter bin codes and SKUs manually instead of via scanner.';

    return CarbonScaffold(
      body: ListView(
        padding: EdgeInsets.fromLTRB(16.w, 20.h, 16.w, 40.h),
        children: [
          // ── MANUAL MODE ─────────────────────────────────────────────────
          _SectionLabel('Manual Mode', mutedColor),
          SizedBox(height: 8.h),
          _Card(
            color: cardColor,
            child: Column(
              children: [
                SwitchListTile(
                  contentPadding:
                      EdgeInsets.symmetric(horizontal: 16.w, vertical: 4.h),
                  title: Text(
                    manualToggleTitle,
                    style: GoogleFonts.manrope(
                      fontSize: 14.sp,
                      fontWeight: FontWeight.w700,
                      color: mainColor,
                    ),
                  ),
                  subtitle: Text(
                    manualToggleSubtitle,
                    style: TextStyle(color: mutedColor, fontSize: 12.sp),
                  ),
                  value: _manualMode,
                  activeThumbColor: AppColors.primary,
                  onChanged: _setManualMode,
                ),
                if (_manualMode) ...[
                  Divider(height: 1.h, color: divColor),

                  // ── Bin Location checkbox ─────────────────────────────
                  CheckboxListTile(
                    contentPadding:
                        EdgeInsets.symmetric(horizontal: 16.w, vertical: 2.h),
                    title: Text(
                      'Bin Location',
                      style: GoogleFonts.manrope(
                        fontSize: 14.sp,
                        fontWeight: FontWeight.w600,
                        color: mainColor,
                      ),
                    ),
                    subtitle: Text(
                      'Type bin code manually. A verify button will appear in the bin box.',
                      style: TextStyle(color: mutedColor, fontSize: 12.sp),
                    ),
                    value: _manualBin,
                    activeColor: AppColors.primary,
                    onChanged: (v) => _setManualBin(v ?? false),
                  ),

                  Divider(height: 1.h, color: divColor),

                  // ── Enable Add Item checkbox ──────────────────────────
                  CheckboxListTile(
                    contentPadding:
                        EdgeInsets.symmetric(horizontal: 16.w, vertical: 2.h),
                    title: Text(
                      'Enable Add Item',
                      style: GoogleFonts.manrope(
                        fontSize: 14.sp,
                        fontWeight: FontWeight.w600,
                        color: mainColor,
                      ),
                    ),
                    subtitle: Text(
                      'Type SKU to search. Full SKU → assign. '
                      'Base+Color → assign. Base only → pick colors. '
                      'Partial/name → catalog search.',
                      style: TextStyle(color: mutedColor, fontSize: 12.sp),
                    ),
                    value: _manualAddItem,
                    activeColor: AppColors.primary,
                    onChanged: (v) => _setManualAddItem(v ?? false),
                  ),

                  Divider(height: 1.h, color: divColor),

                  // ── External Scanner toggle ───────────────────────────
                  SwitchListTile(
                    contentPadding:
                        EdgeInsets.symmetric(horizontal: 16.w, vertical: 4.h),
                    title: Text(
                      'External Scanner',
                      style: GoogleFonts.manrope(
                        fontSize: 14.sp,
                        fontWeight: FontWeight.w600,
                        color: mainColor,
                      ),
                    ),
                    subtitle: Text(
                      'Bluetooth 2D scanner (keyboard mode). Auto-jumps from bin → item after each scan.',
                      style: TextStyle(color: mutedColor, fontSize: 12.sp),
                    ),
                    value: _externalScanner,
                    activeThumbColor: AppColors.primary,
                    onChanged: _setExternalScanner,
                  ),
                ],
              ],
            ),
          ),

          SizedBox(height: 24.h),

          // ── CAMERA ──────────────────────────────────────────────────────
          _SectionLabel('Camera', mutedColor),
          SizedBox(height: 8.h),
          _Card(
            color: cardColor,
            child: SwitchListTile(
              contentPadding:
                  EdgeInsets.symmetric(horizontal: 16.w, vertical: 4.h),
              title: Text(
                'Enable Camera',
                style: GoogleFonts.manrope(
                  fontSize: 14.sp,
                  fontWeight: FontWeight.w700,
                  color: mainColor,
                ),
              ),
              subtitle: Text(
                'Scan 2D barcodes (bin & items) using phone camera. '
                'Default OFF on RFID devices, ON for regular Android.',
                style: TextStyle(color: mutedColor, fontSize: 12.sp),
              ),
              value: _cameraEnabled,
              activeThumbColor: AppColors.primary,
              onChanged: _setCameraEnabled,
            ),
          ),

          SizedBox(height: 32.h),
        ],
      ),
    );
  }
}

// ── Supporting widgets ──────────────────────────────────────────────────────

class _SectionLabel extends StatelessWidget {
  const _SectionLabel(this.text, this.color);
  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Text(
      text.toUpperCase(),
      style: GoogleFonts.spaceGrotesk(
        fontSize: 11.sp,
        fontWeight: FontWeight.w700,
        letterSpacing: 2.0,
        color: color,
      ),
    );
  }
}

class _Card extends StatelessWidget {
  const _Card({required this.color, required this.child});
  final Color color;
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
