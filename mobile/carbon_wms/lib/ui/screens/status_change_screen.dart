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
import 'package:carbon_wms/services/handheld_device_identity.dart';
import 'package:carbon_wms/services/scan_sounds.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/screens/status_pick_screen.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';

/// Status Change — RFID-only handheld flow.
///
/// Operator pulls the UHF trigger; every unique EPC that passes the Carbon
/// formula (regardless of which location it lives at) is dropped into a
/// vertical list as a container card. Each card shows SKU + name +
/// color/size + the EPC's CURRENT status as a coloured badge. The card
/// itself toggles between a "header view" and "EPC visible" view — there's
/// no longer a per-card status picker. The operator hits CONTINUE at the
/// bottom to advance the whole batch to [StatusPickScreen] where they pick
/// one target status and COMMIT it for every EPC in the batch.
///
/// Left edge of every card is a tall red trash slot — tapping it removes
/// that row (it does NOT change the radio, drop the EPC from the radio's
/// internal de-dupe, or hit the network).
class StatusChangeScreen extends StatefulWidget {
  const StatusChangeScreen({super.key, this.cloudGeigerResolveEpc});

  /// When opened from Cloud + Geiger → Take an Action, this is the EPC
  /// that was sent to the handheld. After a successful commit that
  /// included this EPC we POST `/api/handheld/epc-queue` to mark the
  /// drop as resolved so the row disappears across every device on
  /// the next poll. Null on the dashboard Status tile entry path.
  final String? cloudGeigerResolveEpc;

  @override
  State<StatusChangeScreen> createState() => _StatusChangeScreenState();
}

/// One scanned EPC + its tenant-scoped catalog enrichment.
class _ScannedEpc {
  _ScannedEpc({
    required this.epc,
    this.sku,
    this.productName,
    this.color,
    this.size,
    this.status,
  });

  final String epc;
  final String? sku;
  final String? productName;
  final String? color;
  final String? size;
  String? status;
  bool expanded = false;
}

class _StatusChangeScreenState extends State<StatusChangeScreen> {
  // ── scan ledger ──────────────────────────────────────────────────────
  final List<_ScannedEpc> _scanned = [];
  final Set<String> _seenEpcs = {};
  final Set<String> _inFlightEpcs = {};

  // ── status-label catalogue (loaded once on entry) ────────────────────
  List<StatusOption> _statusOptions = [];
  bool _isSuperAdmin = false;
  String? _labelsError;

  // ── trigger / radio ──────────────────────────────────────────────────
  StreamSubscription<RfidTagRead>? _uhfSub;
  // Raw vendor tag stream — the RfidManager geiger path silently drops reads
  // when the manager's active-driver state is out of sync with the sled (seen
  // after the encode screens drive the radio via RfidVendorChannel directly).
  // Listening here guarantees reads reach _onUhfRead regardless of manager
  // state; _onUhfRead dedupes so the overlap with the geiger sub is harmless.
  StreamSubscription<RfidTagRead>? _directSub;
  StreamSubscription<String>? _triggerSub;
  bool _scanning = false;

  /// Slider bounds. Filled from `RfidVendorChannel.getPowerRangeDbm` on
  /// entry so RFD8500 (min ~5 dBm) and C72E (5..23) can't be set below
  /// the radio's real floor — pre-fix the slider always rendered 1..30
  /// and the radio silently lifted impossible values. Defaults match the
  /// previous slider until the native callback lands.
  int _minDbm = 1;
  int _maxDbm = 30;
  int _powerDbm = 10;

  RfidManager? _rfid;

  @override
  void initState() {
    super.initState();
    unawaited(ScanSounds.instance.init());
    // Silence the native per-tag read beep — it sounds like a continuous
    // "searching nearby" tone while the trigger is held. Status Change only
    // needs the start/stop cues; restored on dispose for other screens.
    unawaited(ScanSounds.instance.setTagBeepSuppressed(true));
    unawaited(RfidVendorChannel.scannerDisableTriggerRelay());
    unawaited(RfidVendorChannel.close2dBarcode());
    unawaited(RfidVendorChannel.enableRfidFunctionMode());
    unawaited(RfidVendorChannel.setZebraTriggerModeRfid());

    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted) return;
      final rfid = context.read<RfidManager>();
      _rfid = rfid;
      // Route reads through the geiger sink so the Count session-EPC
      // accumulator doesn't capture status-change scans.
      rfid.scanContext = 'GEIGER_FIND';
      _uhfSub = rfid.geigerTagReads.listen(_onUhfRead, onError: (_) {});
      // Also listen to the raw vendor stream so reads land even if the
      // manager's geiger path is out of sync (see field comment).
      _directSub = RfidVendorChannel.tagReadStream().listen(_onUhfRead, onError: (_) {});

      await _hydrateSliderRange();
      await rfid.setSessionPowerOverrideDbm(_powerDbm);
      try {
        await RfidVendorChannel.setAntennaPowerDbm(_powerDbm);
      } catch (_) {}

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
    unawaited(_directSub?.cancel());
    unawaited(_triggerSub?.cancel());
    unawaited(RfidVendorChannel.stopChainwayInventory());
    unawaited(RfidVendorChannel.stopZebraInventory());
    final rfid = _rfid;
    if (rfid != null) {
      unawaited(rfid.setSessionPowerOverrideDbm(null));
    }
    unawaited(RfidVendorChannel.setZebraTriggerModeRfid());
    unawaited(ScanSounds.instance.setTagBeepSuppressed(false));
    super.dispose();
  }

  /// Read the active radio's achievable power range and clamp the slider
  /// to it. RFD8500 typically reports 5..30 dBm; C72E is 5..23. The slider
  /// keeps the operator inside what the radio can actually honour.
  Future<void> _hydrateSliderRange() async {
    final range = await RfidVendorChannel.getPowerRangeDbm();
    if (!mounted || range == null) return;
    setState(() {
      _minDbm = range.minDbm;
      _maxDbm = range.maxDbm;
      _powerDbm = _powerDbm.clamp(_minDbm, _maxDbm);
    });
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
    // Start via the manager path too — this is what actually feeds reads to
    // the RfidManager streams and keeps its driver state consistent. Without
    // it the trigger started the radio but no reads arrived.
    try {
      await _rfid?.startLocateScanning();
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
    try {
      await _rfid?.stopLocateScanning();
    } catch (_) {}
  }

  Future<void> _setPower(int dbm) async {
    final clamped = dbm.clamp(_minDbm, _maxDbm);
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
    try {
      final api = context.read<WmsApiClient>();
      final res = await api.fetchScannerStatusLabels();
      final rows = (res['rows'] as List?) ?? const [];
      final opts = <StatusOption>[];
      for (final raw in rows) {
        if (raw is! Map<String, dynamic>) continue;
        if (raw['applicable'] != true) continue;
        final name = raw['name']?.toString() ?? '';
        if (name.isEmpty) continue;
        final wms = _wmsValueForLabelName(name);
        if (wms == null) continue; // unknown label — skip rather than ship a bad commit
        // Operator request: the Status screen offers TAG KILLED in place of
        // PENDING VISIBILITY. Remap that option (value + label) and de-dup so
        // we never show a second TAG KILLED if the server already lists one.
        var effWms = wms;
        var effDisplay = (raw['display_label']?.toString().trim().isNotEmpty ?? false)
            ? raw['display_label'].toString()
            : name;
        if (wms == 'pending_visibility') {
          effWms = 'tag_killed';
          effDisplay = 'Tag Killed';
        }
        if (opts.any((o) => o.wmsValue == effWms)) continue;
        opts.add(StatusOption(
          labelName: name,
          displayLabel: effDisplay,
          wmsValue: effWms,
        ));
      }
      if (!mounted) return;
      setState(() {
        _statusOptions = opts;
        _isSuperAdmin = res['super_admin'] == true;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _labelsError = 'Status list unavailable: $e');
    }
  }

  // ── UHF input ────────────────────────────────────────────────────────
  void _onUhfRead(RfidTagRead read) {
    if (!mounted) return;
    final epc = read.epcHex24.toUpperCase();
    if (epc.isEmpty) return;
    if (_seenEpcs.contains(epc) || _inFlightEpcs.contains(epc)) return;
    _inFlightEpcs.add(epc);
    unawaited(_resolveAndAppend(epc));
  }

  /// Resolve the EPC against the tenant-scoped handheld lookup. Carbon
  /// formula validation lives server-side; if `valid` is false we drop
  /// the read silently (formula failures aren't user-actionable here).
  /// Items rows are tenant-scoped — multiple locations of this tenant
  /// share the EPC space — so the lookup is NOT location-gated. The
  /// commit at the end goes through `/api/inventory/bulk-status` which
  /// is session-location-scoped; off-location EPCs commit-as-no-op
  /// (`updated=0`) and the snackbar surfaces that.
  Future<void> _resolveAndAppend(String epc) async {
    final api = context.read<WmsApiClient>();
    try {
      final rows = await api.lookupEpcs([epc]);
      if (!mounted) {
        _inFlightEpcs.remove(epc);
        return;
      }
      _inFlightEpcs.remove(epc);
      Map<String, dynamic>? row;
      for (final r in rows) {
        final e = (r['epcHex'] as String?)?.toUpperCase();
        if (e == epc) {
          row = r;
          break;
        }
      }
      if (row == null || row['valid'] != true) {
        // Formula failed (wrong prefix / non-hex / wrong length) or
        // server returned no row. Silent skip — the operator can keep
        // scanning; no error sound and no toast spam.
        return;
      }
      setState(() {
        _seenEpcs.add(epc);
        _scanned.insert(
          0,
          _ScannedEpc(
            epc: epc,
            sku: _str(row?['sku']),
            productName: _str(row?['productName']),
            color: _str(row?['color']),
            size: _str(row?['size']),
            status: _str(row?['status']),
          ),
        );
      });
      // No `ScanCue.success` here — the native per-tag beep fires from
      // the vendor controller's emitTag path and is the only audible cue
      // we want on a successful add. Operator asked for a single beep
      // per scan, not a beep + a separate "success" jingle.
    } catch (e) {
      _inFlightEpcs.remove(epc);
      if (!mounted) return;
      ScanSounds.instance.play(ScanCue.error);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Lookup failed: $e')),
      );
    }
  }

  static String? _str(Object? v) {
    if (v == null) return null;
    final s = v.toString().trim();
    return s.isEmpty ? null : s;
  }

  void _removeRow(_ScannedEpc card) {
    setState(() {
      _scanned.removeWhere((c) => c.epc == card.epc);
      _seenEpcs.remove(card.epc);
    });
  }

  void _toggleExpand(_ScannedEpc card) {
    setState(() {
      card.expanded = !card.expanded;
    });
  }

  Future<void> _continue() async {
    if (_scanned.isEmpty) return;
    if (_labelsError != null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(_labelsError!)),
      );
      return;
    }
    if (_statusOptions.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Status list still loading…')),
      );
      return;
    }
    if (_scanning) {
      await _stopScan();
    }
    if (!mounted) return;
    final epcs = _scanned.map((e) => e.epc).toList(growable: false);
    // Resolve-source EPC for the Cloud + Geiger auto-dismiss path.
    // Empty string sentinel keeps the closure null-clean; we only
    // dismiss when both (a) the operator entered from Cloud + Geiger
    // (resolveEpc non-empty) AND (b) the dropped EPC is in the
    // committed batch.
    final resolveEpc =
        widget.cloudGeigerResolveEpc?.trim().toUpperCase() ?? '';
    final committedSource =
        resolveEpc.isNotEmpty && epcs.contains(resolveEpc);
    await Navigator.of(context).push<void>(
      MaterialPageRoute(
        builder: (_) => StatusPickScreen(
          epcs: epcs,
          statusOptions: _statusOptions,
          isSuperAdmin: _isSuperAdmin,
          onCommitted: (updated) {
            if (!mounted || updated <= 0) return;
            setState(() {
              _scanned.clear();
              _seenEpcs.clear();
            });
            if (committedSource) {
              unawaited(_dismissCloudGeiger(resolveEpc));
            }
          },
        ),
      ),
    );
  }

  Future<void> _dismissCloudGeiger(String epc) async {
    try {
      final api = context.read<WmsApiClient>();
      final deviceId =
          await HandheldDeviceIdentity.primaryDeviceIdForServer();
      await api.dismissEpcQueueItems(deviceId: deviceId, epcs: [epc]);
    } catch (_) {
      /* best-effort — slide-delete still works on the cloud screen */
    }
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
              count: _scanned.length,
              onClear: _scanned.isNotEmpty
                  ? () => setState(() {
                        _scanned.clear();
                        _seenEpcs.clear();
                      })
                  : null,
            ),
            Expanded(
              child: _scanned.isEmpty
                  ? const _ScanEmptyHint()
                  : ListView.separated(
                      padding:
                          EdgeInsets.fromLTRB(20.w, 12.h, 20.w, 12.h),
                      itemCount: _scanned.length,
                      separatorBuilder: (_, __) => SizedBox(height: 8.h),
                      itemBuilder: (_, i) {
                        final card = _scanned[i];
                        return _EpcContainer(
                          card: card,
                          onTap: () => _toggleExpand(card),
                          onRemove: () => _removeRow(card),
                        );
                      },
                    ),
            ),
            Padding(
              padding: EdgeInsets.fromLTRB(20.w, 8.h, 20.w, 8.h),
              child: _ContinueButton(
                enabled: _scanned.isNotEmpty && _statusOptions.isNotEmpty,
                onTap: _continue,
              ),
            ),
            _StatusChangePowerSlider(
              powerDbm: _powerDbm,
              minDbm: _minDbm,
              maxDbm: _maxDbm,
              scanning: _scanning,
              onChanged: (v) => unawaited(_setPower(v)),
            ),
          ],
        ),
      ),
    );
  }
}

/// Map `status_labels.name` → `items.status` (the WMS canonical form the
/// bulk-status endpoint allow-lists). Returns null when the label name
/// isn't one we know how to commit so the picker can hide it instead of
/// shipping a guaranteed-400.
String? _wmsValueForLabelName(String labelName) {
  switch (labelName.toUpperCase()) {
    case 'LIVE':
      return 'in-stock';
    case 'RETURN':
      return 'return';
    case 'DAMAGED':
      return 'damaged';
    case 'SOLD':
      return 'sold';
    case 'STOLEN':
      return 'stolen';
    case 'TAG KILLED':
      return 'tag_killed';
    case 'PENDING VISIBILITY':
      return 'pending_visibility';
    case 'IN TRANSIT':
      return 'in-transit';
    case 'PENDING TRANSACTION':
      return 'pending_transaction';
    default:
      return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// step header
// ═══════════════════════════════════════════════════════════════════════════

class _StepHeader extends StatelessWidget {
  const _StepHeader({required this.count, this.onClear});

  final int count;
  final VoidCallback? onClear;

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 36.h,
      padding: EdgeInsets.symmetric(horizontal: 20.w),
      color: const Color(0xFFF0F5F4),
      child: Row(
        children: [
          Expanded(
            child: Text(
              count == 0
                  ? 'PULL TRIGGER TO SCAN'
                  : '$count SCANNED · TAP A CARD TO REVEAL EPC',
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
// empty state
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
              'Any EPC that passes the Carbon formula will land here.\nTap CONTINUE when you have your batch.',
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
// per-EPC card — trash on the left, content on the right
// ═══════════════════════════════════════════════════════════════════════════

const Color _kTrashRed = Color(0xFFBF2E2E);
const Color _kCardGrey = Color(0xFFECECEC);

class _EpcContainer extends StatelessWidget {
  const _EpcContainer({
    required this.card,
    required this.onTap,
    required this.onRemove,
  });

  final _ScannedEpc card;
  final VoidCallback onTap;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final desc = [
      if ((card.productName ?? '').isNotEmpty) card.productName!,
      if ((card.color ?? '').isNotEmpty) card.color!,
      if ((card.size ?? '').isNotEmpty) card.size!,
    ].join(' · ');

    return Container(
      color: _kCardGrey,
      child: IntrinsicHeight(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Left trash slot — fixed 56dp wide so glove-touch lands.
            GestureDetector(
              onTap: onRemove,
              behavior: HitTestBehavior.opaque,
              child: Container(
                width: 56,
                color: _kTrashRed,
                alignment: Alignment.center,
                child: Icon(LucideIcons.trash2,
                    color: Colors.white, size: 22.sp),
              ),
            ),
            Expanded(
              child: GestureDetector(
                onTap: onTap,
                behavior: HitTestBehavior.opaque,
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
                              (card.sku ?? '').isEmpty
                                  ? 'SKU: —'
                                  : 'SKU: ${card.sku}',
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: GoogleFonts.robotoMono(
                                fontSize: 16.sp,
                                fontWeight: FontWeight.w700,
                                color: AppColors.textMain,
                              ),
                            ),
                          ),
                          if ((card.status ?? '').isNotEmpty) ...[
                            SizedBox(width: 8.w),
                            _StatusBadge(wmsStatus: card.status!),
                          ],
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
                            color: AppColors.textMain,
                          ),
                        ),
                      ],
                      if (card.expanded) ...[
                        SizedBox(height: 8.h),
                        Container(
                          padding: EdgeInsets.symmetric(
                              horizontal: 10.w, vertical: 6.h),
                          color: const Color(0xFFE2E7E7),
                          child: Text(
                            card.epc,
                            style: GoogleFonts.robotoMono(
                              fontSize: 11.sp,
                              fontWeight: FontWeight.w700,
                              color: const Color(0xFF3D4949),
                              letterSpacing: 0.4,
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Coloured chip mirroring the WMS status palette. Falls back to a slate
/// grey for unrecognised values so a server-side rename doesn't crash the
/// list.
class _StatusBadge extends StatelessWidget {
  const _StatusBadge({required this.wmsStatus});
  final String wmsStatus;

  @override
  Widget build(BuildContext context) {
    final v = wmsStatus.trim().toLowerCase();
    final bg = switch (v) {
      'in-stock' => const Color(0xFF1B7D7D),
      'return' => const Color(0xFF4C4FA1),
      'damaged' => const Color(0xFFBF2E2E),
      'sold' => const Color(0xFF3F4A4A),
      'stolen' => const Color(0xFF2A2A2A),
      'tag_killed' => const Color(0xFF3F4A4A),
      'in-transit' => const Color(0xFF4A6478),
      'pending_visibility' => const Color(0xFF6A7A7A),
      'pending_transaction' => const Color(0xFF6A7A7A),
      _ => const Color(0xFF6A7A7A),
    };
    final display = switch (v) {
      'in-stock' => 'LIVE',
      'tag_killed' => 'TAG KILLED',
      'in-transit' => 'IN TRANSIT',
      'pending_visibility' => 'PENDING',
      'pending_transaction' => 'PENDING TX',
      _ => v.toUpperCase(),
    };
    return Container(
      padding: EdgeInsets.symmetric(horizontal: 8.w, vertical: 3.h),
      color: bg,
      child: Text(
        display,
        style: GoogleFonts.spaceGrotesk(
          fontSize: 10.sp,
          fontWeight: FontWeight.w900,
          letterSpacing: 1.0,
          color: Colors.white,
        ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// continue button
// ═══════════════════════════════════════════════════════════════════════════

class _ContinueButton extends StatelessWidget {
  const _ContinueButton({required this.enabled, required this.onTap});
  final bool enabled;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final bg = enabled ? AppColors.primary : const Color(0xFFBCC9C9);
    return GestureDetector(
      onTap: enabled ? onTap : null,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 140),
        height: 52.h,
        color: bg,
        alignment: Alignment.center,
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text(
              'CONTINUE',
              style: GoogleFonts.spaceGrotesk(
                fontSize: 14.sp,
                fontWeight: FontWeight.w900,
                letterSpacing: 2.4,
                color: Colors.white,
              ),
            ),
            SizedBox(width: 8.w),
            Icon(LucideIcons.chevronRight,
                color: Colors.white, size: 18.sp),
          ],
        ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// power slider — bounds set from native getPowerRangeDbm so the operator
// can't drag below the radio's real floor (RFD8500 ≈ 5 dBm, C72E 5..23)
// ═══════════════════════════════════════════════════════════════════════════

class _StatusChangePowerSlider extends StatelessWidget {
  const _StatusChangePowerSlider({
    required this.powerDbm,
    required this.minDbm,
    required this.maxDbm,
    required this.scanning,
    required this.onChanged,
  });

  final int powerDbm;
  final int minDbm;
  final int maxDbm;
  final bool scanning;
  final ValueChanged<int> onChanged;

  @override
  Widget build(BuildContext context) {
    final lo = minDbm.toDouble();
    final hi = maxDbm.toDouble();
    final value = powerDbm.toDouble().clamp(lo, hi);
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
                value: value,
                min: lo,
                max: hi,
                divisions: (maxDbm - minDbm).clamp(1, 60),
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
