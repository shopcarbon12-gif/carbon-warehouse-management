import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:flutter/services.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/handheld_device_identity.dart';
import 'package:carbon_wms/services/login_credentials_store.dart';
import 'package:carbon_wms/services/mobile_permissions.dart';
import 'package:carbon_wms/services/mobile_settings_repository.dart';
import 'package:carbon_wms/services/scan_sounds.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart' show CarbonScaffold;


/// Server URL, identity, OTA check, biometric, sound, and scanner source preferences.
class HandheldSettingsScreen extends StatefulWidget {
  const HandheldSettingsScreen({super.key});

  @override
  State<HandheldSettingsScreen> createState() => _HandheldSettingsScreenState();
}

class _HandheldSettingsScreenState extends State<HandheldSettingsScreen> {
  static const MethodChannel _device = MethodChannel('carbon_wms/rfid');
  // ── OTA ───────────────────────────────────────────────────────────────────
  bool _busy = false;
  String? _lastStatus;

  // ── Biometric ─────────────────────────────────────────────────────────────
  bool _bioReloading   = true;
  bool _bioEligible    = false;
  bool _bioEnrolled    = false;
  bool _offerAfterSignIn = false;

  // ── Sound ─────────────────────────────────────────────────────────────────
  static const _keySoundEnabled = 'wms_sound_tag_read_v1';
  static const _keyVolume       = 'wms_tag_read_volume_v1';
  bool   _soundEnabled = true;
  double _volume       = 1.0; // 0.0 – 1.0

  // ── Scanner source ────────────────────────────────────────────────────────
  static const _keyScannerSource = 'wms_scanner_source_v1';
  // 'hardware' | 'camera'
  String _scannerSource = 'hardware';

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      await _reloadBiometricSection();
      await _loadLocalPrefs();
    });
  }

  @override
  void dispose() {
    super.dispose();
  }

  Future<void> _loadLocalPrefs() async {
    final p = await SharedPreferences.getInstance();
    if (!mounted) return;
    setState(() {
      _soundEnabled  = p.getBool(_keySoundEnabled)  ?? true;
      _volume        = p.getDouble(_keyVolume)       ?? 1.0;
      _scannerSource = p.getString(_keyScannerSource) ?? 'hardware';
    });
    if (!p.containsKey(_keySoundEnabled)) {
      await p.setBool(_keySoundEnabled, true);
    }
    if (!p.containsKey(_keyVolume)) {
      await p.setDouble(_keyVolume, 1.0);
    }
    await _pushVolumeToNative(_soundEnabled ? _volume : 0.0);
  }

  Future<void> _pushVolumeToNative(double v) async {
    await ScanSounds.instance.setUserVolume(v);
  }

  Future<void> _setSoundEnabled(bool v) async {
    setState(() => _soundEnabled = v);
    final p = await SharedPreferences.getInstance();
    await p.setBool(_keySoundEnabled, v);
    // When sound is muted, push 0 so the per-tag beep is silent regardless
    // of where the slider sits; restore the slider value when re-enabled.
    await _pushVolumeToNative(v ? _volume : 0.0);
  }

  Future<void> _setVolume(double v) async {
    setState(() => _volume = v);
    final p = await SharedPreferences.getInstance();
    await p.setDouble(_keyVolume, v);
    if (_soundEnabled) {
      await _pushVolumeToNative(v);
    }
  }

  Future<void> _setScannerSource(String src) async {
    setState(() => _scannerSource = src);
    final p = await SharedPreferences.getInstance();
    await p.setString(_keyScannerSource, src);
  }

  Future<void> _openScannerSettings() async {
    try {
      final ok = await _device.invokeMethod<bool>('device.openScannerSettings');
      if (!mounted) return;
      if (ok == true) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Scanner settings app was not found on this device.')),
      );
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Unable to open scanner settings.')),
      );
    }
  }

  Future<void> _openAndroidAppSettings() async {
    try {
      await _device.invokeMethod<void>('device.openAndroidAppSettings');
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Unable to open Android app settings.')),
      );
    }
  }

  Future<void> _refreshHardwareStatus() async {
    final rfid = context.read<RfidManager>();
    await rfid.autoDetectHardware();
    await rfid.reapplyHandheldHardwareSettings();
    await _reloadBiometricSection();
    await _loadLocalPrefs();
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Hardware settings refreshed.')),
    );
  }

  // ── Biometric ─────────────────────────────────────────────────────────────

  Future<void> _reloadBiometricSection() async {
    setState(() => _bioReloading = true);
    final eligible = await LoginCredentialsStore.canUseBiometricPasswordVault();
    final enrolled = await LoginCredentialsStore.hasVaultedCredentials();
    final offer    = await LoginCredentialsStore.getOfferBiometricSetupAfterSignIn();
    if (!mounted) return;
    setState(() {
      _bioEligible       = eligible;
      _bioEnrolled       = enrolled;
      _offerAfterSignIn  = offer;
      _bioReloading      = false;
    });
  }

  bool get _biometricSwitchValue => _bioEnrolled || _offerAfterSignIn;

  Future<void> _onBiometricSwitch(bool v) async {
    if (!v) {
      await LoginCredentialsStore.setBiometricLoginEnabled(false);
      await LoginCredentialsStore.setOfferBiometricSetupAfterSignIn(false);
      await LoginCredentialsStore.setBiometricEnrollmentPromptSkipped(false);
    } else {
      await LoginCredentialsStore.setOfferBiometricSetupAfterSignIn(true);
      if (await LoginCredentialsStore.hasVaultedCredentials()) {
        await LoginCredentialsStore.setBiometricLoginEnabled(true);
      }
    }
    if (mounted) await _reloadBiometricSection();
  }

  // ── OTA ───────────────────────────────────────────────────────────────────

  Future<void> _checkOta() async {
    if (!mounted) return;
    setState(() { _busy = true; _lastStatus = null; });
    try {
      final api  = context.read<WmsApiClient>();
      final info = await PackageInfo.fromPlatform();
      final aid  = await HandheldDeviceIdentity.primaryDeviceIdForServer();
      final st   = await api.fetchMobileStatus(
        version:   info.version,
        androidId: aid.isEmpty || aid == 'HANDHELD_OFFLINE' ? null : aid,
      );
      final authorized = st['authorized'] == true;
      final url    = (st['downloadUrl']    as String?)?.trim();
      final latest = (st['latestVersion']  as String?)?.trim();
      final update = st['updateAvailable'] == true;
      if (!mounted) return;
      setState(() {
        _busy = false;
        _lastStatus = [
          'authorized: $authorized',
          if (latest != null && latest.isNotEmpty)
            'server label: $latest'
          else
            "server label: (none — no release row for this device's tenant; upload in WMS → Mobile OTA)",
          if (url != null && url.isNotEmpty) 'download: $url' else 'download: (none)',
          'update flag: $update',
        ].join('\n');
      });
    } catch (e) {
      if (mounted) setState(() { _busy = false; _lastStatus = 'Error: $e'; });
    }
  }

  // ── Build ─────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    final perms = context.read<MobilePermissions>();
    final canSetAntennaPower =
        perms.canDo(ScreenIds.handheldSettings, 'set_antenna_power');
    final canSetScannerSource =
        perms.canDo(ScreenIds.handheldSettings, 'set_scanner_source');
    final canToggleBiometric =
        perms.canDo(ScreenIds.handheldSettings, 'toggle_biometric');
    final isDark      = Theme.of(context).brightness == Brightness.dark;
    final cardColor   = isDark ? const Color(0xFF1C2828) : Colors.white;
    final mutedColor  = isDark ? const Color(0xFF7A9090) : AppColors.textMuted;
    final mainColor   = isDark ? const Color(0xFFE0ECEC) : AppColors.textMain;
    final divColor    = isDark ? Colors.white12 : Colors.black.withValues(alpha: 0.07);

    return CarbonScaffold(
      pageTitle: 'SETTINGS',
      body: ListView(
        padding: EdgeInsets.fromLTRB(16.w, 20.h, 16.w, 40.h),
        children: [

          // ── APP VERSION + OTA ────────────────────────────────────────────
          _Label('App', mutedColor),
          SizedBox(height: 8.h),
          _Card(
            color: cardColor,
            child: FutureBuilder<PackageInfo>(
              future: PackageInfo.fromPlatform(),
              builder: (context, snap) {
                final p = snap.data;
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Padding(
                      padding: EdgeInsets.fromLTRB(16.w, 16.h, 16.w, 0.h),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.end,
                        children: [
                          Text(
                            p == null ? '…' : p.version,
                            style: GoogleFonts.spaceGrotesk(
                              fontSize: 32.sp,
                              fontWeight: FontWeight.w700,
                              color: AppColors.primary,
                              letterSpacing: 0.5,
                            ),
                          ),
                          SizedBox(width: 10.w),
                          Padding(
                            padding: EdgeInsets.only(bottom: 5.h),
                            child: Text(
                              p == null ? '' : 'build ${p.buildNumber}',
                              style: GoogleFonts.spaceGrotesk(
                                fontSize: 13.sp,
                                fontWeight: FontWeight.w600,
                                color: mutedColor,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                    Divider(height: 24.h, color: divColor),
                    Material(
                      color: Colors.transparent,
                      child: InkWell(
                        onTap: _busy
                            ? null
                            : _lastStatus != null
                                ? () => setState(() => _lastStatus = null)
                                : _checkOta,
                        child: Padding(
                          padding: EdgeInsets.fromLTRB(16.w, 0.h, 16.w, 16.h),
                          child: Row(
                            children: [
                              _busy
                                  ? SizedBox(width: 20.w, height: 20.h,
                                      child: const CircularProgressIndicator(strokeWidth: 2, color: AppColors.primary))
                                  : Icon(Icons.system_update_alt, color: AppColors.primary, size: 20.sp),
                              SizedBox(width: 12.w),
                              Expanded(
                                child: Text(
                                  _busy ? 'Checking…' : _lastStatus != null ? 'Tap to clear result' : 'Check OTA / Authorization',
                                  style: GoogleFonts.manrope(
                                    fontSize: 14.sp,
                                    fontWeight: FontWeight.w700,
                                    color: mainColor,
                                  ),
                                ),
                              ),
                              Icon(Icons.chevron_right, color: mutedColor, size: 20.sp),
                            ],
                          ),
                        ),
                      ),
                    ),
                    if (_lastStatus != null)
                      Padding(
                        padding: EdgeInsets.fromLTRB(16.w, 0.h, 16.w, 16.h),
                        child: SelectableText(
                          _lastStatus!,
                          style: TextStyle(color: mutedColor, fontFamily: 'monospace', fontSize: 11.sp, height: 1.5.h),
                        ),
                      ),
                  ],
                );
              },
            ),
          ),

          SizedBox(height: 24.h),

          // ── RFID ANTENNA POWER ───────────────────────────────────────────
          _Label('RFID', mutedColor),
          SizedBox(height: 8.h),
          _Card(
            color: cardColor,
            child: Consumer2<MobileSettingsRepository, RfidManager>(
              builder: (ctx, settings, rfid, _) {
                final power = settings.config.transferOutAntennaPower;
                final hwLinked = rfid.isHardwareLinked;
                return Padding(
                  padding: EdgeInsets.fromLTRB(16.w, 16.h, 16.w, 12.h),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Text('Antenna Power',
                            style: GoogleFonts.manrope(fontSize: 14.sp, fontWeight: FontWeight.w700,
                              color: hwLinked ? mainColor : mutedColor)),
                          Text(
                            hwLinked ? '$power dBm' : 'N/A',
                            style: GoogleFonts.spaceGrotesk(fontSize: 20.sp, fontWeight: FontWeight.w800,
                              color: hwLinked ? AppColors.primary : mutedColor),
                          ),
                        ],
                      ),
                      SizedBox(height: 4.h),
                      if (hwLinked && canSetAntennaPower) ...[
                        Slider(
                          value: power.toDouble(),
                          min: 0, max: 30, divisions: 30,
                          activeColor: AppColors.primary,
                          label: '$power dBm',
                          onChanged: (v) => settings.setGlobalAntennaPower(v.round()),
                        ),
                        Text('Applies to transfer-in and transfer-out scans.',
                          style: TextStyle(color: mutedColor, fontSize: 12.sp, height: 1.4.h)),
                      ] else if (hwLinked) ...[
                        Text('Antenna power is managed by an administrator.',
                          style: TextStyle(color: mutedColor, fontSize: 12.sp, height: 1.4.h,
                            fontStyle: FontStyle.italic)),
                      ] else
                        Text('No RFID hardware detected on this device.',
                          style: TextStyle(color: mutedColor, fontSize: 12.sp, height: 1.4.h,
                            fontStyle: FontStyle.italic)),
                    ],
                  ),
                );
              },
            ),
          ),

          SizedBox(height: 24.h),

          // ── BARCODE / DEVICE SCANNER ────────────────────────────────────
          _Label('Barcode / Scanner', mutedColor),
          SizedBox(height: 8.h),
          _Card(
            color: cardColor,
            child: Column(
              children: [
                _ScannerSourceTile(
                  icon: Icons.qr_code_scanner,
                  title: 'Hardware scanner',
                  subtitle: 'Use side trigger / native scanner service.',
                  value: 'hardware',
                  groupValue: _scannerSource,
                  mainColor: mainColor,
                  mutedColor: mutedColor,
                  onChanged: canSetScannerSource ? _setScannerSource : null,
                ),
                Divider(height: 1.h, color: divColor),
                _ScannerSourceTile(
                  icon: Icons.camera_alt_outlined,
                  title: 'Camera scanner',
                  subtitle: 'Use the in-app camera scanner flow.',
                  value: 'camera',
                  groupValue: _scannerSource,
                  mainColor: mainColor,
                  mutedColor: mutedColor,
                  onChanged: canSetScannerSource ? _setScannerSource : null,
                ),
                Divider(height: 1.h, color: divColor),
                ListTile(
                  leading: const Icon(Icons.tune, color: AppColors.primary),
                  title: Text(
                    'Open Device Scanner Settings',
                    style: GoogleFonts.manrope(
                      fontSize: 14.sp,
                      fontWeight: FontWeight.w700,
                      color: mainColor,
                    ),
                  ),
                  subtitle: Text(
                    'Configure scanner output mode, suffix, and trigger behavior.',
                    style: TextStyle(color: mutedColor, fontSize: 12.sp),
                  ),
                  trailing: Icon(Icons.open_in_new, color: mutedColor, size: 18.sp),
                  onTap: _openScannerSettings,
                ),
                Divider(height: 1.h, color: divColor),
                ListTile(
                  leading: const Icon(Icons.refresh, color: AppColors.primary),
                  title: Text(
                    'Refresh Settings / Permissions',
                    style: GoogleFonts.manrope(
                      fontSize: 14.sp,
                      fontWeight: FontWeight.w700,
                      color: mainColor,
                    ),
                  ),
                  subtitle: Text(
                    'Re-check hardware bridge and reload scanner preferences.',
                    style: TextStyle(color: mutedColor, fontSize: 12.sp),
                  ),
                  trailing: Icon(Icons.chevron_right, color: mutedColor, size: 20.sp),
                  onTap: _refreshHardwareStatus,
                ),
                Divider(height: 1.h, color: divColor),
                ListTile(
                  leading: const Icon(Icons.settings_applications, color: AppColors.primary),
                  title: Text(
                    'Open Android App Permissions',
                    style: GoogleFonts.manrope(
                      fontSize: 14.sp,
                      fontWeight: FontWeight.w700,
                      color: mainColor,
                    ),
                  ),
                  subtitle: Text(
                    'Open system permissions for CarbonWMS.',
                    style: TextStyle(color: mutedColor, fontSize: 12.sp),
                  ),
                  trailing: Icon(Icons.chevron_right, color: mutedColor, size: 20.sp),
                  onTap: _openAndroidAppSettings,
                ),
              ],
            ),
          ),

          SizedBox(height: 24.h),

          // ── SOUND ────────────────────────────────────────────────────────
          _Label('Sound', mutedColor),
          SizedBox(height: 8.h),
          _Card(
            color: cardColor,
            child: Column(
              children: [
                SwitchListTile(
                  contentPadding: EdgeInsets.symmetric(horizontal: 16.w, vertical: 4.h),
                  title: Text('Sound while reading tags',
                    style: GoogleFonts.manrope(fontSize: 14.sp, fontWeight: FontWeight.w700, color: mainColor)),
                  value: _soundEnabled,
                  activeThumbColor: AppColors.primary,
                  onChanged: _setSoundEnabled,
                ),
                if (_soundEnabled) ...[
                  Divider(height: 1.h, color: divColor),
                  Padding(
                    padding: EdgeInsets.fromLTRB(16.w, 8.h, 16.w, 12.h),
                    child: Row(
                      children: [
                        Text('MUTE',
                          style: GoogleFonts.spaceGrotesk(fontSize: 11.sp, fontWeight: FontWeight.w700,
                            letterSpacing: 1.4, color: mutedColor)),
                        Expanded(
                          child: Slider(
                            value: _volume, min: 0, max: 1, divisions: 10,
                            activeColor: AppColors.primary,
                            label: '${(_volume * 100).round()}%',
                            onChanged: _setVolume,
                          ),
                        ),
                        Text('${(_volume * 100).round()}%',
                          style: GoogleFonts.spaceGrotesk(fontSize: 13.sp, fontWeight: FontWeight.w700,
                            color: AppColors.primary)),
                      ],
                    ),
                  ),
                ],
              ],
            ),
          ),

          SizedBox(height: 24.h),

          // ── BIOMETRIC ────────────────────────────────────────────────────
          if (canToggleBiometric) ...[
            _Label('Biometric Sign-in', mutedColor),
            SizedBox(height: 8.h),
            if (_bioReloading)
              Center(child: Padding(
                padding: EdgeInsets.all(16.r),
                child: const CircularProgressIndicator(strokeWidth: 2),
              ))
            else if (!_bioEligible)
              Padding(
                padding: EdgeInsets.only(left: 4.w),
                child: Text(
                  'Not available on this device.',
                  style: TextStyle(color: mutedColor, fontSize: 13.sp, height: 1.35.h),
                ),
              )
            else
              _Card(
                color: cardColor,
                child: SwitchListTile(
                  contentPadding: EdgeInsets.symmetric(horizontal: 16.w, vertical: 4.h),
                  title: Text('Fingerprint or face sign-in',
                    style: GoogleFonts.manrope(fontSize: 14.sp, fontWeight: FontWeight.w700, color: mainColor)),
                  subtitle: Text(
                    _bioEnrolled
                        ? 'Enabled. Turn off to clear saved session token.'
                        : _offerAfterSignIn
                            ? 'You will be prompted after next password sign-in.'
                            : 'Turn on to enable setup prompt after sign-in.',
                    style: TextStyle(color: mutedColor, fontSize: 12.sp, height: 1.35.h),
                  ),
                  value: _biometricSwitchValue,
                  activeThumbColor: AppColors.primary,
                  onChanged: _onBiometricSwitch,
                ),
              ),
          ],

          SizedBox(height: 32.h),
        ],
      ),
    );
  }
}

// ── Supporting widgets ────────────────────────────────────────────────────────

class _Label extends StatelessWidget {
  const _Label(this.text, this.color);
  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Text(
      text.toUpperCase(),
      style: GoogleFonts.spaceGrotesk(
        color: color,
        fontWeight: FontWeight.w700,
        fontSize: 11.sp,
        letterSpacing: 2.0,
      ),
    );
  }
}

class _Card extends StatelessWidget {
  const _Card({required this.child, required this.color});
  final Widget child;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(4.r),
      ),
      clipBehavior: Clip.hardEdge,
      child: child,
    );
  }
}

class _ScannerSourceTile extends StatelessWidget {
  const _ScannerSourceTile({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.value,
    required this.groupValue,
    required this.mainColor,
    required this.mutedColor,
    required this.onChanged,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final String value;
  final String groupValue;
  final Color mainColor;
  final Color mutedColor;
  final ValueChanged<String>? onChanged;

  @override
  Widget build(BuildContext context) {
    final selected = value == groupValue;
    final cb = onChanged;
    return InkWell(
      onTap: cb == null ? null : () => cb(value),
      child: Padding(
        padding: EdgeInsets.symmetric(horizontal: 16.w, vertical: 14.h),
        child: Row(
          children: [
            Icon(icon, color: selected ? AppColors.primary : mutedColor, size: 22.sp),
            SizedBox(width: 14.w),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: TextStyle(
                    color: mainColor, fontWeight: FontWeight.w600, fontSize: 14.sp)),
                  SizedBox(height: 2.h),
                  Text(subtitle, style: TextStyle(
                    color: mutedColor, fontSize: 12.sp)),
                ],
              ),
            ),
            Container(
              width: 22.w,
              height: 22.h,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                border: Border.all(
                  color: selected ? AppColors.primary : Colors.grey,
                  width: 2.w,
                ),
                color: selected ? AppColors.primary : Colors.transparent,
              ),
              child: selected
                  ? Icon(Icons.check, size: 14.sp, color: Colors.white)
                  : null,
            ),
          ],
        ),
      ),
    );
  }
}
