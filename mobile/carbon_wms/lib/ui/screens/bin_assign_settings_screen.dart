import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:carbon_wms/theme/app_theme.dart';

const Color _surface    = Color(0xFFFFFFFF);
const Color _surfaceLow = Color(0xFFF3F3F4);

/// Bin Assign–specific settings: scanner source, manual mode.
class BinAssignSettingsScreen extends StatefulWidget {
  const BinAssignSettingsScreen({super.key});

  @override
  State<BinAssignSettingsScreen> createState() => _BinAssignSettingsScreenState();
}

class _BinAssignSettingsScreenState extends State<BinAssignSettingsScreen> {
  // Scanner source: 'hardware' | 'camera' | 'manual'
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

  Future<void> _setScannerSource(String v) async {
    final p = await SharedPreferences.getInstance();
    await p.setString('wms_scanner_source_v1', v);
    if (!mounted) return;
    setState(() => _scannerSource = v);
  }

  Future<void> _setManualMode(bool v) async {
    final p = await SharedPreferences.getInstance();
    await p.setBool('bin_assign_manual_mode', v);
    if (!mounted) return;
    setState(() => _manualMode = v);
  }

  @override
  Widget build(BuildContext context) {
    final isDark    = Theme.of(context).brightness == Brightness.dark;
    final bg        = isDark ? const Color(0xFF111A1A) : _surface;
    final bgLow     = isDark ? const Color(0xFF1C2828) : _surfaceLow;
    final mainColor = isDark ? const Color(0xFFE0ECEC) : AppColors.textMain;
    final muted     = isDark ? const Color(0xFF7A9090) : AppColors.textMuted;

    return Scaffold(
      backgroundColor: bg,
      appBar: AppBar(
        backgroundColor: bg,
        elevation: 0,
        surfaceTintColor: Colors.transparent,
        leading: IconButton(
          icon: Icon(Icons.arrow_back, color: mainColor),
          onPressed: () => Navigator.pop(context),
        ),
        title: Text(
          'BIN ASSIGN SETTINGS',
          style: GoogleFonts.manrope(
            fontSize: 15, fontWeight: FontWeight.w800,
            letterSpacing: 0.5, color: mainColor),
        ),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          _SectionHeader(label: 'SCANNER INPUT', muted: muted),
          const SizedBox(height: 8),

          // Hardware wedge
          _OptionTile(
            bgLow: bgLow,
            mainColor: mainColor,
            muted: muted,
            icon: Icons.rss_feed,
            title: 'Hardware / Wedge Scanner',
            subtitle: 'Bluetooth or USB barcode gun sends keystrokes',
            selected: _scannerSource == 'hardware',
            onTap: () => _setScannerSource('hardware'),
          ),
          const SizedBox(height: 8),

          // Camera
          _OptionTile(
            bgLow: bgLow,
            mainColor: mainColor,
            muted: muted,
            icon: Icons.photo_camera_outlined,
            title: 'Camera Scanner',
            subtitle: 'Use device camera to scan barcodes',
            selected: _scannerSource == 'camera',
            onTap: () => _setScannerSource('camera'),
          ),
          const SizedBox(height: 8),

          // Manual / keyboard
          _OptionTile(
            bgLow: bgLow,
            mainColor: mainColor,
            muted: muted,
            icon: Icons.keyboard_outlined,
            title: 'Manual Entry',
            subtitle: 'Type barcodes using on-screen keyboard',
            selected: _scannerSource == 'manual',
            onTap: () => _setScannerSource('manual'),
          ),

          const SizedBox(height: 24),
          _SectionHeader(label: 'BEHAVIOUR', muted: muted),
          const SizedBox(height: 8),

          // Manual mode toggle
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
            decoration: BoxDecoration(
              color: bgLow,
              borderRadius: BorderRadius.circular(8),
            ),
            child: SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: Text(
                'Manual Mode',
                style: GoogleFonts.manrope(
                  fontSize: 14, fontWeight: FontWeight.w700, color: mainColor),
              ),
              subtitle: Text(
                'Confirm each scan before processing',
                style: GoogleFonts.manrope(fontSize: 12, color: muted),
              ),
              value: _manualMode,
              activeThumbColor: AppColors.primary,
              onChanged: _setManualMode,
            ),
          ),

          const SizedBox(height: 32),
          Center(
            child: Text(
              'Settings apply immediately and persist across sessions.',
              textAlign: TextAlign.center,
              style: GoogleFonts.manrope(fontSize: 11, color: muted),
            ),
          ),
        ],
      ),
    );
  }
}

class _SectionHeader extends StatelessWidget {
  const _SectionHeader({required this.label, required this.muted});
  final String label;
  final Color  muted;

  @override
  Widget build(BuildContext context) {
    return Text(
      label,
      style: GoogleFonts.spaceGrotesk(
        fontSize: 11, fontWeight: FontWeight.w700,
        letterSpacing: 2.0, color: muted),
    );
  }
}

class _OptionTile extends StatelessWidget {
  const _OptionTile({
    required this.bgLow,
    required this.mainColor,
    required this.muted,
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.selected,
    required this.onTap,
  });

  final Color    bgLow;
  final Color    mainColor;
  final Color    muted;
  final IconData icon;
  final String   title;
  final String   subtitle;
  final bool     selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        decoration: BoxDecoration(
          color: bgLow,
          borderRadius: BorderRadius.circular(8),
          border: selected
              ? Border.all(color: AppColors.primary, width: 2)
              : null,
        ),
        child: Row(
          children: [
            Icon(icon,
              color: selected ? AppColors.primary : muted, size: 22),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title,
                    style: GoogleFonts.manrope(
                      fontSize: 14, fontWeight: FontWeight.w700,
                      color: selected ? AppColors.primary : mainColor)),
                  const SizedBox(height: 2),
                  Text(subtitle,
                    style: GoogleFonts.manrope(fontSize: 12, color: muted)),
                ],
              ),
            ),
            if (selected)
              const Icon(Icons.check_circle, color: AppColors.primary, size: 20),
          ],
        ),
      ),
    );
  }
}
