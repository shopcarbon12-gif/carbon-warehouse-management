import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/hardware/rfid_vendor_channel.dart';
import 'package:carbon_wms/theme/app_theme.dart';

/// NEAR / MEDIUM / FAR — the scan range of Zone Management, also used by
/// Bulk Geiger, Cloud + Geiger, Add-On Count and Add-On Catalog (owner,
/// 2026-10-16: "exactly how scanning should be … in each screen").
///
/// The RFD8500 reports a signal strength (RSSI) per read but can't filter on
/// it or read near tags first, so the app does: NEAR / MEDIUM only take a tag
/// once it is read at or above the minimum signal (close, in front of the
/// antenna); FAR takes everything. A too-weak read is ignored, not used up —
/// the same tag counts the moment it is read strong enough. With a gate on,
/// quiet mode is off, so a far tag read once must answer again when the
/// operator walks up to it.
enum ScanRange { near, medium, far }

/// One screen's range choice and its two minimum signals, remembered on the
/// phone under [prefPrefix] — each screen keeps its own.
class ScanRangeSetting {
  ScanRangeSetting(this.prefPrefix);

  final String prefPrefix;

  static const Map<ScanRange, int> defaultGate = {ScanRange.near: -55, ScanRange.medium: -65};

  ScanRange range = ScanRange.far;
  final Map<ScanRange, int> gate = Map.of(defaultGate);

  /// Weakest signal (dBm) a tag may be read at to count; null on FAR.
  int? get minRssi => range == ScanRange.far ? null : gate[range];

  /// Gen2 quiet mode (a read tag stays silent while powered) — FAR only.
  bool get quietMode => range == ScanRange.far;

  /// True when this read is close enough. Readers that report no RSSI are
  /// never gated.
  bool passes(int? rssi) {
    final g = minRssi;
    return g == null || rssi == null || rssi >= g;
  }

  Future<void> load() async {
    try {
      final p = await SharedPreferences.getInstance();
      final r = p.getString('${prefPrefix}_range');
      range = ScanRange.values.firstWhere((v) => v.name == r, orElse: () => ScanRange.far);
      gate[ScanRange.near] = p.getInt('${prefPrefix}_gate_near') ?? defaultGate[ScanRange.near]!;
      gate[ScanRange.medium] = p.getInt('${prefPrefix}_gate_medium') ?? defaultGate[ScanRange.medium]!;
    } catch (_) {}
  }

  Future<void> save() async {
    try {
      final p = await SharedPreferences.getInstance();
      await p.setString('${prefPrefix}_range', range.name);
      await p.setInt('${prefPrefix}_gate_near', gate[ScanRange.near]!);
      await p.setInt('${prefPrefix}_gate_medium', gate[ScanRange.medium]!);
    } catch (_) {}
  }
}

/// A screen's own transmit power: starts at the sled's maximum, changes from
/// the screen's slider, and is held as the session override so a settings
/// sync can't put the global power back mid-scan.
class ScanPower {
  int minDbm = 1;
  int maxDbm = 30;
  int dbm = 30;
  Timer? _applyTimer;

  /// Reads the sled's real power range and starts at its maximum.
  Future<void> loadRange() async {
    final r = await RfidVendorChannel.getPowerRangeDbm();
    if (r == null) return;
    minDbm = r.minDbm;
    maxDbm = r.maxDbm;
    dbm = r.maxDbm;
  }

  Future<void> apply(RfidManager? rfid) async {
    await rfid?.setSessionPowerOverrideDbm(dbm);
    try {
      await RfidVendorChannel.setAntennaPowerDbm(dbm);
    } catch (_) {}
  }

  /// Slider drag: false when unchanged. The radio gets the value after a
  /// short pause — one config write per drag, not one per pixel.
  bool set(int value, RfidManager? rfid) {
    final v = value.clamp(minDbm, maxDbm);
    if (v == dbm) return false;
    dbm = v;
    _applyTimer?.cancel();
    _applyTimer = Timer(const Duration(milliseconds: 180), () => unawaited(apply(rfid)));
    return true;
  }

  void dispose() => _applyTimer?.cancel();
}

class ScanRangeButtons extends StatelessWidget {
  const ScanRangeButtons({super.key, required this.value, required this.onChanged});

  final ScanRange value;
  final ValueChanged<ScanRange> onChanged;

  @override
  Widget build(BuildContext context) {
    return SegmentedButton<ScanRange>(
      showSelectedIcon: false,
      segments: const [
        ButtonSegment(value: ScanRange.near, label: Text('NEAR')),
        ButtonSegment(value: ScanRange.medium, label: Text('MED')),
        ButtonSegment(value: ScanRange.far, label: Text('FAR')),
      ],
      selected: {value},
      onSelectionChanged: (s) => onChanged(s.first),
    );
  }
}

class ScanPowerRow extends StatelessWidget {
  const ScanPowerRow({super.key, required this.power, required this.onChanged});

  final ScanPower power;
  final ValueChanged<int> onChanged;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Text('Power', style: TextStyle(fontSize: 12.sp, color: AppColors.textMuted)),
        Expanded(
          child: Slider(
            value: power.dbm.toDouble().clamp(power.minDbm.toDouble(), power.maxDbm.toDouble()),
            min: power.minDbm.toDouble(),
            max: power.maxDbm.toDouble(),
            divisions: (power.maxDbm - power.minDbm).clamp(1, 40),
            label: '${power.dbm} dBm',
            onChanged: (v) => onChanged(v.round()),
          ),
        ),
        Text('${power.dbm} dBm', style: GoogleFonts.spaceGrotesk(fontSize: 12.5.sp, fontWeight: FontWeight.w700)),
      ],
    );
  }
}

/// The NEAR / MED minimum-signal slider (hidden on FAR by the callers).
class ScanMinSignalRow extends StatelessWidget {
  const ScanMinSignalRow({super.key, required this.setting, required this.onChanged, required this.onChangeEnd});

  final ScanRangeSetting setting;
  final ValueChanged<int> onChanged;
  final VoidCallback onChangeEnd;

  @override
  Widget build(BuildContext context) {
    final v = setting.gate[setting.range] ?? ScanRangeSetting.defaultGate[ScanRange.medium]!;
    return Row(
      children: [
        Text('Min signal', style: TextStyle(fontSize: 12.sp, color: AppColors.textMuted)),
        Expanded(
          child: Slider(
            value: v.toDouble().clamp(-85.0, -30.0),
            min: -85,
            max: -30,
            divisions: 55,
            label: '$v dBm',
            onChanged: (x) => onChanged(x.round()),
            onChangeEnd: (_) => onChangeEnd(),
          ),
        ),
        Text('$v dBm', style: GoogleFonts.spaceGrotesk(fontSize: 12.5.sp, fontWeight: FontWeight.w700)),
      ],
    );
  }
}

/// Range buttons, the screen's power slider (when it has none of its own) and
/// the minimum signal on NEAR / MED — Zone Management's controls as one block.
class ScanRangePanel extends StatelessWidget {
  const ScanRangePanel({
    super.key,
    required this.setting,
    required this.onRangeChanged,
    required this.onGateChanged,
    this.power,
    this.onPowerChanged,
  });

  final ScanRangeSetting setting;
  final ValueChanged<ScanRange> onRangeChanged;

  /// Live drag of the minimum signal; the setting is saved when the drag ends.
  final ValueChanged<int> onGateChanged;
  final ScanPower? power;
  final ValueChanged<int>? onPowerChanged;

  @override
  Widget build(BuildContext context) {
    final p = power;
    final onPower = onPowerChanged;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ScanRangeButtons(value: setting.range, onChanged: onRangeChanged),
        if (p != null && onPower != null) ScanPowerRow(power: p, onChanged: onPower),
        if (setting.range != ScanRange.far)
          ScanMinSignalRow(
            setting: setting,
            onChanged: onGateChanged,
            onChangeEnd: () => unawaited(setting.save()),
          ),
      ],
    );
  }
}
