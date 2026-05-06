import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart' show CarbonScaffold;

/// Per-screen settings for Add-On Count (Q20 lock: vibrate-on-new defaults ON).
class AddOnCountSettingsScreen extends StatefulWidget {
  const AddOnCountSettingsScreen({super.key});

  static const String prefKeyVibrateOnNew = 'add_on_count_vibrate_on_new_v1';
  static const bool defaultVibrateOnNew = true;

  @override
  State<AddOnCountSettingsScreen> createState() => _AddOnCountSettingsScreenState();
}

class _AddOnCountSettingsScreenState extends State<AddOnCountSettingsScreen> {
  bool _vibrateOnNew = AddOnCountSettingsScreen.defaultVibrateOnNew;
  bool _loaded = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final p = await SharedPreferences.getInstance();
    if (!mounted) return;
    setState(() {
      _vibrateOnNew = p.getBool(AddOnCountSettingsScreen.prefKeyVibrateOnNew) ??
          AddOnCountSettingsScreen.defaultVibrateOnNew;
      _loaded = true;
    });
  }

  Future<void> _setVibrate(bool v) async {
    setState(() => _vibrateOnNew = v);
    final p = await SharedPreferences.getInstance();
    await p.setBool(AddOnCountSettingsScreen.prefKeyVibrateOnNew, v);
  }

  @override
  Widget build(BuildContext context) {
    return CarbonScaffold(
      pageTitle: 'add-on settings',
      body: ColoredBox(
        color: Colors.white,
        child: !_loaded
            ? const Center(child: CircularProgressIndicator())
            : ListView(
                padding: EdgeInsets.fromLTRB(20.w, 12.h, 20.w, 24.h),
                children: [
                  SwitchListTile(
                    value: _vibrateOnNew,
                    onChanged: _setVibrate,
                    title: Text(
                      'Vibrate on new EPC',
                      style: GoogleFonts.manrope(
                        fontSize: 14.sp,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    subtitle: Text(
                      'Adds a haptic pulse alongside the success beep',
                      style: GoogleFonts.manrope(
                        fontSize: 11.sp,
                        color: AppColors.textMuted,
                      ),
                    ),
                  ),
                ],
              ),
      ),
    );
  }
}
