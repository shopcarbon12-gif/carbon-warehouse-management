import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/hardware/rfid_tag_read.dart';
import 'package:carbon_wms/hardware/rfid_vendor_channel.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/scan_sounds.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';

/// Status Change — RFID-only handheld flow.
///
///   Step 1: SCAN  — operator pulls the UHF trigger; every unique EPC
///                   read is resolved against the catalog and dropped
///                   into a vertical list as a container card. Each
///                   card shows the item's SKU + name + color + size
///                   (same shape Count Inventory uses). The EPC string
///                   itself is intentionally hidden — operators
///                   identify items by the matrix metadata, not the
///                   24-hex EPC.
///   Step 2: PICK STATUS — tap any card to drill into status pick for
///                         that single EPC. Commit POSTs bulk-status
///                         for the one EPC, then drops the card from
///                         the list and returns to step 1 so the
///                         operator can keep scanning.
///
/// Why no search box: the prior 3-tab Encode-style design (search,
/// pickEpc, pickStatus) optimized for desktop typing. Operators on the
/// floor never type — they pull the trigger. Removing the search input
/// + catalog grid removed ~600 lines of UI, simplified the trigger
/// discipline (UHF only — 2D doesn't need to fill any text field), and
/// made the pickEpc step redundant (each scanned EPC IS its own row).
class StatusChangeScreen extends StatefulWidget {
  const StatusChangeScreen({super.key});

  @override
  State<StatusChangeScreen> createState() => _StatusChangeScreenState();
}

enum _StatusStep { scan, pickStatus }

class _StatusLabel {
  const _StatusLabel({
    required this.name,
    required this.displayLabel,
    required this.applicable,
    required this.superAdminLocked,
    required this.systemOnly,
  });
  final String name;
  final String displayLabel;
  final bool applicable;
  final bool superAdminLocked;
  final bool systemOnly;
}

/// One scanned EPC + the catalog row it resolved to. Stored in the
/// scan-list so we can render a container card per row and pick a
/// single EPC for status change without round-tripping the catalog
/// again.
class _ScannedEpc {
  const _ScannedEpc({
    required this.epc,
    required this.row,
  });
  final String epc;
  final Map<String, dynamic> row;

  String get sku => row['sku']?.toString() ?? '';
  String get name => row['name']?.toString() ?? '';
  String get color => row['color']?.toString() ?? '';
  String get size => row['size']?.toString() ?? '';
  String get currentStatus => row['status']?.toString() ?? '';
  String get binCode => row['bin_code']?.toString() ?? '';
}

class _StatusChangeScreenState extends State<StatusChangeScreen> {
  // ── flow state ────────────────────────────────────────────────────────
  _StatusStep _step = _StatusStep.scan;

  // Accumulated UHF reads, ordered newest-first so the operator's most
  // recent scan is at the top of the list. Keys deduped on uppercased
  // EPC so a single tag pinged 30× by the radio doesn't spam the list.
  final List<_ScannedEpc> _scanned = [];
  final Set<String> _seenEpcs = {};
  final Set<String> _inFlightEpcs = {}; // suppress race during catalog lookup

  // Selected card → which EPC's status are we about to change?
  _ScannedEpc? _selectedCard;
  String _selectedTargetStatus = '';
  bool _override = false;
  bool _committing = false;

  // ── status-label catalogue (loaded once on entry) ────────────────────
  List<_StatusLabel> _statusLabels = [];
  bool _isSuperAdmin = false;
  bool _labelsLoading = true;
  String? _labelsError;

  // ── trigger / scanner subscriptions ──────────────────────────────────
  StreamSubscription<RfidTagRead>? _uhfSub;
  StreamSubscription<String>? _triggerSub;

  /// Single-pull-toggle scan state. First trigger pull starts inventory,
  /// second pull stops it (no hold-to-scan). Operator-asked behaviour:
  /// status change is a long sweep, not a tap-and-release task.
  bool _scanning = false;

  /// Live antenna power for this screen. Default 10 dBm per spec —
  /// status change is typically up-close work where high power picks up
  /// foreign tags from the rack behind.
  static const int _defaultPowerDbm = 10;
  int _powerDbm = _defaultPowerDbm;

  RfidManager? _rfid;

  @override
  void initState() {
    super.initState();
    unawaited(ScanSounds.instance.init());
    // RFID-only: arm UHF, kill the 2D imager so a stray imager pull
    // can't trigger a screen this flow doesn't expose anymore.
    unawaited(RfidVendorChannel.scannerDisableTriggerRelay());
    unawaited(RfidVendorChannel.close2dBarcode());
    unawaited(RfidVendorChannel.enableRfidFunctionMode());
    unawaited(RfidVendorChannel.setZebraTriggerModeRfid());

    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted) return;
      final rfid = context.read<RfidManager>();
      _rfid = rfid;
      // Route reads through the Geiger sink — the Count session-EPC
      // accumulator must not capture status-change scans.
      rfid.scanContext = 'GEIGER_FIND';
      _uhfSub = rfid.geigerTagReads.listen(_onUhfRead, onError: (_) {});

      // Default power 10 dBm + session override so reapply paths
      // (mobile-sync, scan-context flip) can't quietly snap back to
      // handheld-config power while the operator is mid-sweep.
      await rfid.setSessionPowerOverrideDbm(_powerDbm);
      try {
        await RfidVendorChannel.setAntennaPowerDbm(_powerDbm);
      } catch (_) {}

      // Hardware trigger → single-pull start / second-pull stop.
      _triggerSub = RfidVendorChannel.hardwareTriggerStream().listen((event) {
        if (!mounted) return;
        if (event == 'down') {
          if (_scanning) {
            unawaited(_stopScan());
          } else {
            unawaited(_startScan());
          }
        }
      }, onError: (_) {});

      unawaited(_loadStatusLabels());
    });
  }

  @override
  void dispose() {
    unawaited(_uhfSub?.cancel());
    unawaited(_triggerSub?.cancel());
    // Stop inventory before leaving so a pending UHF stream doesn't
    // bleed reads into the next screen's accumulator.
    unawaited(RfidVendorChannel.stopChainwayInventory());
    unawaited(RfidVendorChannel.stopZebraInventory());
    final rfid = _rfid;
    if (rfid != null) {
      unawaited(rfid.setSessionPowerOverrideDbm(null));
    }
    // Other screens that want a specific mode will re-assert on entry;
    // we just make sure we don't leave the device in a half-state.
    unawaited(RfidVendorChannel.setZebraTriggerModeRfid());
    super.dispose();
  }

  Future<void> _startScan() async {
    if (_scanning) return;
    setState(() => _scanning = true);
    try {
      ScanSounds.instance.play(ScanCue.start);
    } catch (_) {}
    try {
      await RfidVendorChannel.startZebraInventory();
    } catch (_) {}
    try {
      await RfidVendorChannel.startChainwayInventory();
    } catch (_) {}
  }

  Future<void> _stopScan() async {
    if (!_scanning) return;
    setState(() => _scanning = false);
    try {
      ScanSounds.instance.play(ScanCue.stop);
    } catch (_) {}
    try {
      await RfidVendorChannel.stopZebraInventory();
    } catch (_) {}
    try {
      await RfidVendorChannel.stopChainwayInventory();
    } catch (_) {}
  }

  Future<void> _setPower(int dbm) async {
    final clamped = dbm.clamp(1, 30);
    if (clamped == _powerDbm) return;
    setState(() => _powerDbm = clamped);
    final rfid = _rfid;
    if (rfid != null) {
      await rfid.setSessionPowerOverrideDbm(clamped);
    }
    try {
      await RfidVendorChannel.setAntennaPowerDbm(clamped);
    } catch (_) {}
  }

  // ── status-label load ────────────────────────────────────────────────
  Future<void> _loadStatusLabels() async {
    setState(() {
      _labelsLoading = true;
      _labelsError = null;
    });
    try {
      final api = context.read<WmsApiClient>();
      final res = await api.fetchScannerStatusLabels();
      final rows = (res['rows'] as List?) ?? const [];
      final parsed = rows.whereType<Map<String, dynamic>>().map((r) {
        return _StatusLabel(
          name: r['name']?.toString() ?? '',
          displayLabel:
              (r['display_label']?.toString().trim().isNotEmpty ?? false)
                  ? r['display_label'].toString()
                  : (r['name']?.toString() ?? ''),
          applicable: r['applicable'] == true,
          superAdminLocked: r['super_admin_locked'] == true,
          systemOnly: r['is_system_only'] == true,
        );
      }).toList();
      if (!mounted) return;
      setState(() {
        _statusLabels = parsed;
        _isSuperAdmin = res['super_admin'] == true;
        _labelsLoading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _labelsLoading = false;
        _labelsError = 'Status list unavailable: $e';
      });
    }
  }

  // ── UHF input ────────────────────────────────────────────────────────
  void _onUhfRead(RfidTagRead read) {
    if (!mounted) return;
    if (_step == _StatusStep.pickStatus) return; // don't yank state mid-commit
    final epc = read.epcHex24.toUpperCase();
    if (epc.isEmpty) return;
    if (_seenEpcs.contains(epc) || _inFlightEpcs.contains(epc)) return;
    _inFlightEpcs.add(epc);
    unawaited(_resolveAndAppend(epc));
  }

  Future<void> _resolveAndAppend(String epc) async {
    final api = context.read<WmsApiClient>();
    try {
      final row = await api.lookupCatalogByEpc(epc);
      if (!mounted) {
        _inFlightEpcs.remove(epc);
        return;
      }
      _inFlightEpcs.remove(epc);
      if (row == null) {
        ScanSounds.instance.play(ScanCue.error);
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text('EPC not at this location: $epc'),
          duration: const Duration(seconds: 2),
        ));
        return;
      }
      // Catalog rows from lookupCatalogByEpc don't include the EPC
      // itself — we set it explicitly so the status-pick header can
      // render it (still hidden in the card list per spec).
      final stamped = Map<String, dynamic>.from(row)..['epc'] = epc;
      setState(() {
        _seenEpcs.add(epc);
        // Newest scan on top — operator's most recent pull is what
        // they're trying to act on.
        _scanned.insert(0, _ScannedEpc(epc: epc, row: stamped));
      });
      ScanSounds.instance.play(ScanCue.success);
    } catch (e) {
      _inFlightEpcs.remove(epc);
      if (!mounted) return;
      ScanSounds.instance.play(ScanCue.error);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Lookup failed: $e')),
      );
    }
  }

  // ── selection / commit ───────────────────────────────────────────────
  void _selectCard(_ScannedEpc card) {
    setState(() {
      _selectedCard = card;
      _selectedTargetStatus = '';
      _override = false;
      _step = _StatusStep.pickStatus;
    });
  }

  void _stepBack() {
    setState(() {
      _step = _StatusStep.scan;
      _selectedCard = null;
      _selectedTargetStatus = '';
      _override = false;
    });
  }

  Future<void> _commit() async {
    final card = _selectedCard;
    final target = _selectedTargetStatus.trim();
    if (card == null || target.isEmpty) return;
    setState(() => _committing = true);
    try {
      final api = context.read<WmsApiClient>();
      final res = await api.postBulkStatus(
        epcs: [card.epc],
        targetStatus: target,
        override: _override,
      );
      if (!mounted) return;
      final updated = (res['updated'] as num?)?.toInt() ?? 0;
      ScanSounds.instance.play(
          updated > 0 ? ScanCue.success : ScanCue.error);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(updated > 0
            ? 'Status updated → $target'
            : 'No change applied (status may already match)'),
      ));
      // Drop the card we just acted on so the operator's list
      // shrinks as they work through it. Then return to the scan
      // step ready for the next pull.
      setState(() {
        if (updated > 0) {
          _seenEpcs.remove(card.epc);
          _scanned.removeWhere((c) => c.epc == card.epc);
        }
        _step = _StatusStep.scan;
        _selectedCard = null;
        _selectedTargetStatus = '';
        _override = false;
      });
    } catch (e) {
      if (!mounted) return;
      ScanSounds.instance.play(ScanCue.error);
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text('Commit failed: $e')));
    } finally {
      if (mounted) setState(() => _committing = false);
    }
  }

  void _clearScanList() {
    setState(() {
      _scanned.clear();
      _seenEpcs.clear();
      _inFlightEpcs.clear();
    });
  }

  // ── ui ───────────────────────────────────────────────────────────────
  @override
  Widget build(BuildContext context) {
    return CarbonScaffold(
      pageTitle: 'STATUS CHANGE',
      body: SafeArea(
        top: false,
        child: Column(
          children: [
            _StepHeader(
              step: _step,
              count: _scanned.length,
              onBack: _step == _StatusStep.pickStatus ? _stepBack : null,
              onClear:
                  _step == _StatusStep.scan && _scanned.isNotEmpty
                      ? _clearScanList
                      : null,
            ),
            Expanded(
              child: _step == _StatusStep.scan
                  ? _buildScanList()
                  : _buildStatusPick(),
            ),
            _StatusChangePowerSlider(
              powerDbm: _powerDbm,
              scanning: _scanning,
              onChanged: (v) => unawaited(_setPower(v)),
            ),
          ],
        ),
      ),
    );
  }

  // ── scan list step ───────────────────────────────────────────────────
  Widget _buildScanList() {
    if (_scanned.isEmpty) {
      return const _ScanEmptyHint();
    }
    return ListView.separated(
      padding: EdgeInsets.fromLTRB(20.w, 12.h, 20.w, 12.h),
      itemCount: _scanned.length,
      separatorBuilder: (_, __) => SizedBox(height: 8.h),
      itemBuilder: (_, i) {
        final card = _scanned[i];
        return _EpcContainer(
          card: card,
          onTap: () => _selectCard(card),
        );
      },
    );
  }

  // ── status pick step ─────────────────────────────────────────────────
  Widget _buildStatusPick() {
    final card = _selectedCard;
    if (card == null) return const SizedBox.shrink();

    final applicable = _statusLabels.where((s) => s.applicable).toList();
    final unavailable = _statusLabels.where((s) => !s.applicable).toList();

    final canCommit = _selectedTargetStatus.isNotEmpty &&
        _selectedTargetStatus != card.currentStatus &&
        !_committing;

    return Column(
      children: [
        // Selected card preview — same item-detail block, no EPC string,
        // visually marked as the operator's current target.
        Padding(
          padding: EdgeInsets.fromLTRB(20.w, 12.h, 20.w, 0),
          child: _EpcContainer(card: card, onTap: null, highlighted: true),
        ),
        Expanded(
          child: ListView(
            padding: EdgeInsets.fromLTRB(20.w, 12.h, 20.w, 12.h),
            children: [
              Text(
                'CHOOSE NEW STATUS',
                style: GoogleFonts.spaceGrotesk(
                  fontSize: 11.sp,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 1.4,
                  color: const Color(0xFF6D7979),
                ),
              ),
              SizedBox(height: 8.h),
              if (_labelsLoading)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 16),
                  child: Center(child: CircularProgressIndicator()),
                )
              else if (_labelsError != null)
                Text(
                  _labelsError!,
                  style: GoogleFonts.manrope(
                    fontSize: 12.sp,
                    fontWeight: FontWeight.w700,
                    color: const Color(0xFFBF2E2E),
                  ),
                )
              else ...[
                for (final s in applicable)
                  _StatusOptionTile(
                    label: s.displayLabel,
                    value: s.name,
                    selected: _selectedTargetStatus == s.name,
                    disabled: s.name == card.currentStatus,
                    onTap: () =>
                        setState(() => _selectedTargetStatus = s.name),
                  ),
                if (unavailable.isNotEmpty) ...[
                  SizedBox(height: 16.h),
                  Text(
                    'LOCKED · SUPER ADMIN ONLY',
                    style: GoogleFonts.spaceGrotesk(
                      fontSize: 10.sp,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 1.4,
                      color: const Color(0xFF8A9595),
                    ),
                  ),
                  SizedBox(height: 6.h),
                  for (final s in unavailable)
                    _StatusOptionTile(
                      label: s.displayLabel,
                      value: s.name,
                      selected: false,
                      disabled: true,
                      onTap: () {},
                    ),
                ],
              ],
              SizedBox(height: 16.h),
              if (_isSuperAdmin)
                CheckboxListTile(
                  contentPadding: EdgeInsets.zero,
                  controlAffinity: ListTileControlAffinity.leading,
                  title: Text(
                    'Override risky transitions (e.g. sold → in-stock)',
                    style: GoogleFonts.manrope(
                      fontSize: 13.sp,
                      fontWeight: FontWeight.w700,
                      color: AppColors.textMain,
                    ),
                  ),
                  value: _override,
                  onChanged: (v) => setState(() => _override = v ?? false),
                ),
            ],
          ),
        ),
        Padding(
          padding: EdgeInsets.fromLTRB(20.w, 0, 20.w, 16.h),
          child: _CommitButton(
            enabled: canCommit,
            busy: _committing,
            onTap: canCommit ? _commit : null,
          ),
        ),
      ],
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// step header — shows current step label + scan count + clear/back affordance
// ═══════════════════════════════════════════════════════════════════════════

class _StepHeader extends StatelessWidget {
  const _StepHeader({
    required this.step,
    required this.count,
    this.onBack,
    this.onClear,
  });

  final _StatusStep step;
  final int count;
  final VoidCallback? onBack;
  final VoidCallback? onClear;

  String get _label {
    switch (step) {
      case _StatusStep.scan:
        return count == 0
            ? 'PULL TRIGGER TO SCAN'
            : '$count SCANNED · TAP TO CHANGE STATUS';
      case _StatusStep.pickStatus:
        return 'PICK NEW STATUS';
    }
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 36.h,
      padding: EdgeInsets.symmetric(horizontal: 20.w),
      color: const Color(0xFFF0F5F4),
      child: Row(
        children: [
          if (onBack != null)
            GestureDetector(
              onTap: onBack,
              behavior: HitTestBehavior.opaque,
              child: Padding(
                padding: EdgeInsets.only(right: 10.w),
                child: Icon(
                  LucideIcons.chevronLeft,
                  size: 18.sp,
                  color: const Color(0xFF3D4949),
                ),
              ),
            ),
          Expanded(
            child: Text(
              _label,
              style: GoogleFonts.spaceGrotesk(
                fontSize: 11.sp,
                fontWeight: FontWeight.w800,
                letterSpacing: 1.6,
                color: const Color(0xFF3D4949),
              ),
            ),
          ),
          if (onClear != null)
            GestureDetector(
              onTap: onClear,
              behavior: HitTestBehavior.opaque,
              child: Padding(
                padding: EdgeInsets.symmetric(horizontal: 4.w),
                child: Text(
                  'CLEAR',
                  style: GoogleFonts.spaceGrotesk(
                    fontSize: 11.sp,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 1.6,
                    color: const Color(0xFFBF2E2E),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// empty state — operator hasn't pulled the trigger yet
// ═══════════════════════════════════════════════════════════════════════════

class _ScanEmptyHint extends StatelessWidget {
  const _ScanEmptyHint();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: EdgeInsets.all(24.r),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(LucideIcons.scan,
                size: 48.sp, color: const Color(0xFFBCC9C9)),
            SizedBox(height: 12.h),
            Text(
              'PULL TRIGGER TO SCAN',
              textAlign: TextAlign.center,
              style: GoogleFonts.spaceGrotesk(
                fontSize: 13.sp,
                fontWeight: FontWeight.w800,
                letterSpacing: 1.6,
                color: const Color(0xFF5A6464),
              ),
            ),
            SizedBox(height: 6.h),
            Text(
              'Each tag becomes a card.\nTap a card to change its status.',
              textAlign: TextAlign.center,
              style: GoogleFonts.manrope(
                fontSize: 12.sp,
                fontWeight: FontWeight.w600,
                color: const Color(0xFF6D7979),
                height: 1.4,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Per-EPC container card — same shape Count Inventory uses for items.
// Shows SKU + matrix description (name · color · size) + bin + current
// status. EPC string and qty are intentionally NOT displayed: every card
// represents exactly one tag, identified by its catalog metadata.
// ═══════════════════════════════════════════════════════════════════════════

class _EpcContainer extends StatelessWidget {
  const _EpcContainer({
    required this.card,
    required this.onTap,
    this.highlighted = false,
  });

  final _ScannedEpc card;
  final VoidCallback? onTap;
  final bool highlighted;

  @override
  Widget build(BuildContext context) {
    final desc = [
      if (card.name.isNotEmpty) card.name,
      if (card.color.isNotEmpty) card.color,
      if (card.size.isNotEmpty) card.size,
    ].join(' · ');
    final bg = highlighted
        ? AppColors.primary
        : const Color(0xFFECECEC);
    final fgMain = highlighted ? Colors.white : AppColors.textMain;
    final fgMuted = highlighted
        ? Colors.white.withValues(alpha: 0.92)
        : const Color(0xFF3F4A4A);
    final binBg = highlighted
        ? Colors.white.withValues(alpha: 0.18)
        : AppColors.primary;
    final binFg = highlighted ? Colors.white : Colors.white;

    return Material(
      color: bg,
      borderRadius: BorderRadius.zero,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: EdgeInsets.fromLTRB(14.w, 12.h, 12.w, 12.h),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  Expanded(
                    child: Text(
                      card.sku.isEmpty ? 'SKU: —' : 'SKU: ${card.sku}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: GoogleFonts.robotoMono(
                        fontSize: 16.sp,
                        fontWeight: FontWeight.w700,
                        color: fgMain,
                      ),
                    ),
                  ),
                  if (card.binCode.isNotEmpty)
                    Container(
                      padding: EdgeInsets.symmetric(
                          horizontal: 10.w, vertical: 4.h),
                      color: binBg,
                      child: Text(
                        'BIN ${card.binCode}',
                        style: GoogleFonts.spaceGrotesk(
                          fontSize: 11.sp,
                          fontWeight: FontWeight.w800,
                          letterSpacing: 1.0,
                          color: binFg,
                        ),
                      ),
                    ),
                ],
              ),
              if (desc.isNotEmpty) ...[
                SizedBox(height: 4.h),
                Text(
                  desc,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: GoogleFonts.manrope(
                    fontSize: 13.sp,
                    fontWeight: FontWeight.w700,
                    color: fgMain,
                  ),
                ),
              ],
              if (card.currentStatus.isNotEmpty) ...[
                SizedBox(height: 6.h),
                Text(
                  'CURRENT · ${card.currentStatus.toUpperCase()}',
                  style: GoogleFonts.spaceGrotesk(
                    fontSize: 11.sp,
                    fontWeight: FontWeight.w700,
                    letterSpacing: 1.2,
                    color: fgMuted,
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// status option tile — radio-style, with disabled state for current status
// ═══════════════════════════════════════════════════════════════════════════

class _StatusOptionTile extends StatelessWidget {
  const _StatusOptionTile({
    required this.label,
    required this.value,
    required this.selected,
    required this.disabled,
    required this.onTap,
  });

  final String label;
  final String value;
  final bool selected;
  final bool disabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final fg = disabled
        ? const Color(0xFF8A9595)
        : (selected ? Colors.white : AppColors.textMain);
    final bg = disabled
        ? const Color(0xFFEEEEEE)
        : (selected ? AppColors.primary : const Color(0xFFF0F5F4));
    return Padding(
      padding: EdgeInsets.only(bottom: 6.h),
      child: Material(
        color: bg,
        child: InkWell(
          onTap: disabled ? null : onTap,
          child: Padding(
            padding:
                EdgeInsets.symmetric(horizontal: 14.w, vertical: 12.h),
            child: Row(
              children: [
                Icon(
                  selected
                      ? Icons.radio_button_checked
                      : Icons.radio_button_unchecked,
                  size: 18.sp,
                  color: fg,
                ),
                SizedBox(width: 10.w),
                Expanded(
                  child: Text(
                    label,
                    style: GoogleFonts.manrope(
                      fontSize: 14.sp,
                      fontWeight: FontWeight.w800,
                      color: fg,
                    ),
                  ),
                ),
                if (disabled)
                  Text(
                    'CURRENT',
                    style: GoogleFonts.spaceGrotesk(
                      fontSize: 10.sp,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 1.2,
                      color: fg,
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// commit button
// ═══════════════════════════════════════════════════════════════════════════

class _CommitButton extends StatelessWidget {
  const _CommitButton({
    required this.enabled,
    required this.busy,
    required this.onTap,
  });

  final bool enabled;
  final bool busy;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final bg = enabled ? AppColors.primary : const Color(0xFFBCC9C9);
    return GestureDetector(
      onTap: enabled && !busy ? onTap : null,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 150),
        height: 56.h,
        decoration: BoxDecoration(
          color: bg,
          boxShadow: const [
            BoxShadow(
              color: Color(0x24000000),
              blurRadius: 18,
              offset: Offset(0, 8),
            ),
          ],
        ),
        child: Center(
          child: busy
              ? const SizedBox(
                  width: 22,
                  height: 22,
                  child: CircularProgressIndicator(
                    strokeWidth: 2.4,
                    valueColor: AlwaysStoppedAnimation(Colors.white),
                  ),
                )
              : Text(
                  'COMMIT STATUS CHANGE',
                  style: GoogleFonts.manrope(
                    fontSize: 15.sp,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 2.0,
                    color: Colors.white,
                  ),
                ),
        ),
      ),
    );
  }
}

/// Bottom-bar power slider for Status Change. Mirrors the count gear's
/// session-override pattern: drag = immediate radio change, no save
/// button. The "scanning" pill on the left flips so the operator can
/// see at a glance whether the radio is hot.
class _StatusChangePowerSlider extends StatelessWidget {
  const _StatusChangePowerSlider({
    required this.powerDbm,
    required this.scanning,
    required this.onChanged,
  });

  final int powerDbm;
  final bool scanning;
  final ValueChanged<int> onChanged;

  static const int _minDbm = 1;
  static const int _maxDbm = 30;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: const BoxDecoration(
        color: Color(0xFFF0F5F4),
        border: Border(top: BorderSide(color: Color(0xFFCDD7D7), width: 1)),
      ),
      padding: EdgeInsets.fromLTRB(14.w, 8.h, 14.w, 8.h),
      child: Row(
        children: [
          Container(
            padding: EdgeInsets.symmetric(horizontal: 8.w, vertical: 3.h),
            color: scanning
                ? const Color(0x33B23A3A)
                : const Color(0x33334466),
            child: Text(
              scanning ? 'SCANNING' : 'IDLE',
              style: GoogleFonts.spaceGrotesk(
                fontSize: 10.sp,
                fontWeight: FontWeight.w800,
                letterSpacing: 1.4,
                color: scanning
                    ? const Color(0xFFB23A3A)
                    : const Color(0xFF334466),
              ),
            ),
          ),
          SizedBox(width: 10.w),
          Text(
            'PWR',
            style: GoogleFonts.spaceGrotesk(
              fontSize: 10.sp,
              fontWeight: FontWeight.w800,
              letterSpacing: 1.4,
              color: const Color(0xFF6D7979),
            ),
          ),
          SizedBox(width: 6.w),
          Expanded(
            child: SliderTheme(
              data: SliderTheme.of(context).copyWith(
                trackHeight: 3,
                activeTrackColor: AppColors.primary,
                inactiveTrackColor: const Color(0xFFCDD7D7),
                thumbColor: AppColors.primary,
                overlayColor: AppColors.primary.withValues(alpha: 0.10),
                thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 8),
                overlayShape: const RoundSliderOverlayShape(overlayRadius: 16),
              ),
              child: Slider(
                value: powerDbm.toDouble().clamp(
                      _minDbm.toDouble(),
                      _maxDbm.toDouble(),
                    ),
                min: _minDbm.toDouble(),
                max: _maxDbm.toDouble(),
                divisions: _maxDbm - _minDbm,
                onChanged: (v) => onChanged(v.round()),
              ),
            ),
          ),
          SizedBox(width: 8.w),
          SizedBox(
            width: 56.w,
            child: Text(
              '$powerDbm dBm',
              textAlign: TextAlign.right,
              style: GoogleFonts.spaceGrotesk(
                fontSize: 12.sp,
                fontWeight: FontWeight.w800,
                color: AppColors.textMain,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
