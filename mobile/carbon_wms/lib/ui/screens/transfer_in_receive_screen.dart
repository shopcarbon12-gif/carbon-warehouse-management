import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/hardware/rfid_tag_read.dart';
import 'package:carbon_wms/hardware/rfid_vendor_channel.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/scan_sounds.dart';
import 'package:carbon_wms/services/transfer_slip_printer.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';

/// Transfer In — receive workspace. The operator scans EPCs at the
/// destination; each scan is matched against the slip's expected manifest.
/// Three buckets:
///   - FOUND     — expected EPC seen in this session
///   - MISSING   — expected EPC not yet seen
///   - UNEXPECTED — scanned EPC not on the slip (foreign tag picked up by
///     the radio in the same field; can be ignored or resolved separately)
///
/// Commit sends only the FOUND list to /api/operations/transfers/receive.
/// Server flips them to in-stock and reports the new state
/// (received | partially_received) — partial means some were missing.
class TransferInReceiveScreen extends StatefulWidget {
  const TransferInReceiveScreen({
    super.key,
    required this.transferId,
    required this.slipNumber,
    required this.sourceCode,
    required this.sourceName,
  });

  final String transferId;
  final int? slipNumber;
  final String sourceCode;
  final String sourceName;

  @override
  State<TransferInReceiveScreen> createState() =>
      _TransferInReceiveScreenState();
}

class _TransferInReceiveScreenState extends State<TransferInReceiveScreen> {
  static const Color _accent = Color(0xFF1B7F4F);
  static const Color _amber = Color(0xFFB87A00);
  static const Color _missing = Color(0xFFB23A3A);
  static const String _powerPrefsKey = 'transfer_in_power_dbm_v1';

  /// Per-screen power persisted across sessions; mirrors the count gear
  /// pattern. Default 27 dBm (matches the cloud TRANSFER profile midpoint).
  int _powerDbm = 27;

  StreamSubscription<RfidTagRead>? _tagSub;
  StreamSubscription<String>? _barcodeSub;
  StreamSubscription<String>? _triggerSub;

  /// Slip detail from `/api/operations/transfers/<id>`. The `rfid` field
  /// is a list of `{epc, sku, name, color, size, received}` rows.
  Map<String, dynamic>? _detail;
  bool _loading = false;
  String? _error;

  /// EPCs already received before this session (from the server's
  /// `received: true` flag on the detail row). They count as already-found
  /// without needing a re-scan.
  final Set<String> _alreadyReceived = <String>{};

  /// EPCs scanned in this session.
  final Set<String> _scanned = <String>{};

  /// Set of expected EPCs (in-transit, awaiting receipt).
  final Set<String> _expected = <String>{};

  /// EPCs that ARRIVED in a non-live status (damaged / tag_killed / …). They
  /// are NOT in-transit, so they're flagged for inspect-before-close: the
  /// operator sets each one's final status before the slip can commit.
  final Set<String> _nonLive = <String>{};

  /// epc → status the operator set during inspection (defaults to the status
  /// it arrived in). Sent to the server as the `statuses` overrides.
  final Map<String, String> _nonLiveStatus = {};

  /// Pending MANUAL lines (non-RFID, qty-based) awaiting receipt — each is an
  /// inventory_adjustments row with state='in-transit'. Manual-only transfers
  /// have nothing to scan; the operator confirms these by tapping.
  List<Map<String, dynamic>> _manualLines = [];

  /// adjustment_id → received qty set via the line's stepper (0..line qty).
  /// > 0 means the line is confirmed and settles on commit.
  final Map<String, int> _manualReceivedQty = {};

  /// Set once a commit fully closes the slip — drives the "received" done card.
  bool _done = false;
  int _doneRfid = 0;
  int _doneManual = 0;

  bool _scanning = false;
  bool _committing = false;
  String? _commitMsg;

  RfidManager? _rfid;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      await _loadPower();
      await _loadDetail();
      await _initScanner();
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _rfid ??= context.read<RfidManager>();
  }

  @override
  void dispose() {
    _tagSub?.cancel();
    _barcodeSub?.cancel();
    _triggerSub?.cancel();
    final r = _rfid;
    if (r != null) {
      unawaited(r.pauseScanning());
      unawaited(r.setSessionPowerOverrideDbm(null));
    }
    // Reopen the 2D imager for the next screen (matches Count / Fast Putaway).
    // RFID screens re-arm their own mode on entry; this only helps a
    // barcode-first screen that lands next.
    unawaited(RfidVendorChannel.open2dBarcode());
    super.dispose();
  }

  Future<void> _loadPower() async {
    final prefs = await SharedPreferences.getInstance();
    final v = prefs.getInt(_powerPrefsKey);
    if (v != null && mounted) {
      setState(() => _powerDbm = v.clamp(0, 30));
    }
  }

  Future<void> _savePower() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setInt(_powerPrefsKey, _powerDbm);
  }

  Future<void> _loadDetail() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final j = await context
          .read<WmsApiClient>()
          .fetchTransferDetail(widget.transferId);
      if (!mounted) return;
      _expected.clear();
      _alreadyReceived.clear();
      _nonLive.clear();
      _nonLiveStatus.clear();
      _manualReceivedQty.clear();
      // Manual (non-RFID) lines still awaiting receipt = destination-side
      // adjustments with state 'in-transit'. Settled ones are already received.
      final manual = j['manual'];
      _manualLines = manual is List
          ? manual
              .whereType<Map>()
              .where((m) => (m['state'] ?? '') == 'in-transit')
              .map((m) => Map<String, dynamic>.from(m))
              .toList()
          : <Map<String, dynamic>>[];
      final rfid = j['rfid'];
      if (rfid is List) {
        for (final r in rfid) {
          if (r is Map) {
            final epc = (r['epc'] ?? '').toString().toUpperCase();
            if (epc.isEmpty) continue;
            final received = r['received'] == true;
            final arrivedNonLive = r['arrived_non_live'] == true;
            if (received) {
              _alreadyReceived.add(epc);
            } else if (arrivedNonLive) {
              // Not in-transit — shipped in a non-live status. Flagged for
              // inspect-before-close; default the choice to how it arrived.
              _nonLive.add(epc);
              _nonLiveStatus[epc] = (r['status'] ?? 'damaged').toString();
            } else {
              _expected.add(epc);
            }
          }
        }
      }
      setState(() => _detail = j);
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _initScanner() async {
    if (!mounted) return;
    final rfid = context.read<RfidManager>();
    rfid.scanContext = 'TRANSFER_IN';
    // Per-screen power authority — same fix as Count: set the override
    // BEFORE any reapply so the radio honours the gear value, not the
    // handheld-config TRANSFER_IN power.
    await rfid.setSessionPowerOverrideDbm(_powerDbm);
    try {
      await RfidVendorChannel.scannerDisableTriggerRelay();
      await RfidVendorChannel.close2dBarcode();
      await RfidVendorChannel.enableRfidFunctionMode();
      await RfidVendorChannel.setZebraTriggerModeRfid();
      await RfidVendorChannel.setAntennaPowerDbm(_powerDbm);
    } catch (_) {
      /* optional */
    }

    await _tagSub?.cancel();
    _tagSub = RfidVendorChannel.tagReadStream().listen(
      _onTagRead,
      onError: (_) {},
    );
    await _barcodeSub?.cancel();
    _barcodeSub = RfidVendorChannel.hardwareBarcodeStream().listen((raw) {
      final epc = _extract24Hex(raw);
      if (epc != null) _ingestEpc(epc);
    }, onError: (_) {});
    await _triggerSub?.cancel();
    _triggerSub = RfidVendorChannel.hardwareTriggerStream().listen((event) {
      if (event == 'down') {
        if (_scanning) {
          unawaited(_stopScan());
        } else {
          unawaited(_startScan());
        }
      }
    }, onError: (_) {});
  }

  void _onTagRead(RfidTagRead read) {
    if (!_scanning) return;
    final epc = read.epcHex24.toUpperCase();
    if (epc.isEmpty) return;
    _ingestEpc(epc);
  }

  String? _extract24Hex(String raw) {
    final s = raw.toUpperCase().replaceAll(RegExp(r'\s+'), '');
    final m = RegExp(r'([0-9A-F]{24})').firstMatch(s);
    return m?.group(1);
  }

  void _ingestEpc(String epc) {
    if (_scanned.contains(epc)) return;
    setState(() => _scanned.add(epc));
    try {
      ScanSounds.instance.play(ScanCue.success);
    } catch (_) {}
  }

  Future<void> _startScan() async {
    if (_scanning) return;
    setState(() => _scanning = true);
    try {
      ScanSounds.instance.play(ScanCue.start);
    } catch (_) {}
    try {
      await RfidVendorChannel.startZebraInventory();
    } catch (_) {
      /* optional */
    }
    try {
      await RfidVendorChannel.startChainwayInventory();
    } catch (_) {
      /* optional */
    }
  }

  Future<void> _stopScan() async {
    if (!_scanning) return;
    setState(() => _scanning = false);
    try {
      ScanSounds.instance.play(ScanCue.stop);
    } catch (_) {}
    try {
      await RfidVendorChannel.stopZebraInventory();
    } catch (_) {
      /* optional */
    }
    try {
      await RfidVendorChannel.stopChainwayInventory();
    } catch (_) {
      /* optional */
    }
  }

  Future<void> _printSlip() async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      final html = await context
          .read<WmsApiClient>()
          .fetchTransferSlipHtml(widget.transferId);
      await TransferSlipPrinter.printSlip(
        html: html,
        docName: 'Transfer Slip ${widget.slipNumber ?? ''}'.trim(),
      );
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text('Print failed: $e')));
    }
  }

  Future<void> _openGear() async {
    final next = await Navigator.of(context).push<int>(
      MaterialPageRoute<int>(
        builder: (_) => _ReceiveGearScreen(initial: _powerDbm),
      ),
    );
    if (next == null || !mounted) return;
    setState(() => _powerDbm = next);
    final rfid = context.read<RfidManager>();
    await _savePower();
    if (!mounted) return;
    await rfid.setSessionPowerOverrideDbm(_powerDbm);
    await RfidVendorChannel.setAntennaPowerDbm(_powerDbm);
  }

  /// Compute the three live buckets from current state.
  ({Set<String> found, Set<String> missing, Set<String> unexpected})
      _buckets() {
    final found = <String>{};
    final missing = <String>{};
    final unexpected = <String>{};
    for (final epc in _expected) {
      if (_scanned.contains(epc)) {
        found.add(epc);
      } else {
        missing.add(epc);
      }
    }
    for (final epc in _scanned) {
      if (!_expected.contains(epc) && !_alreadyReceived.contains(epc)) {
        unexpected.add(epc);
      }
    }
    return (found: found, missing: missing, unexpected: unexpected);
  }

  Future<void> _commit() async {
    if (_committing) return;
    final b = _buckets();
    // Manual lines with a received qty > 0 are confirmed (settle on commit);
    // any line not fully received still counts as pending.
    final confirmedManual = _manualLines
        .where((m) =>
            (_manualReceivedQty[m['adjustment_id']?.toString()] ?? 0) > 0)
        .map((m) => m['adjustment_id']?.toString() ?? '')
        .where((s) => s.isNotEmpty)
        .toList();
    final manualMissing = _manualLines.where((m) {
      final adjId = m['adjustment_id']?.toString() ?? '';
      final lineQty = (m['qty'] as num?)?.toInt() ?? 0;
      return (_manualReceivedQty[adjId] ?? 0) < lineQty;
    }).length;
    if (b.found.isEmpty && _nonLive.isEmpty && confirmedManual.isEmpty) {
      setState(() => _commitMsg =
          'NOTHING TO RECEIVE — SCAN AN EPC OR CONFIRM A MANUAL LINE');
      return;
    }
    // Capture the api ref *before* any await so the analyzer doesn't flag
    // a context-across-async-gap below. Dialog + commit are async.
    final api = context.read<WmsApiClient>();

    // Inspect-before-close: any item that arrived non-live must have its
    // final status confirmed by the operator before the slip can commit.
    if (_nonLive.isNotEmpty) {
      final result = await Navigator.of(context).push<Map<String, String>>(
        MaterialPageRoute<Map<String, String>>(
          builder: (_) => _InspectArrivalsScreen(
            epcs: _nonLive.toList(),
            initial: Map<String, String>.from(_nonLiveStatus),
            detail: _detail,
          ),
        ),
      );
      if (result == null || !mounted) return; // operator backed out
      _nonLiveStatus
        ..clear()
        ..addAll(result);
    }

    final partialWarning = b.missing.isNotEmpty || manualMissing > 0;
    if (partialWarning) {
      final go = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          shape: const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
          backgroundColor: Colors.white,
          title: Text(
            'COMMIT PARTIAL?',
            style: GoogleFonts.spaceGrotesk(
              fontWeight: FontWeight.w800,
              letterSpacing: 1.4,
            ),
          ),
          content: Text(
            '${b.found.length + confirmedManual.length} confirmed, '
            '${b.missing.length + manualMissing} still pending.\n'
            'Slip will be marked PARTIAL. You can return later to receive the rest.',
            style: GoogleFonts.manrope(fontSize: 13.sp),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(false),
              child: const Text('CANCEL'),
            ),
            FilledButton(
              style: FilledButton.styleFrom(backgroundColor: _amber),
              onPressed: () => Navigator.of(ctx).pop(true),
              child: const Text('COMMIT PARTIAL'),
            ),
          ],
        ),
      );
      if (go != true) return;
    }
    setState(() {
      _committing = true;
      _commitMsg = null;
    });
    try {
      // Stop scanning explicitly — the operator's commit is the antennas-off
      // signal. We don't auto-pause on idle.
      if (_scanning) await _stopScan();
      final statuses = _nonLiveStatus.entries
          .map((e) => {'epc': e.key, 'status': e.value})
          .toList();
      final r = await api.commitTransferReceive(
        transferId: widget.transferId,
        epcs: b.found.toList(),
        statuses: statuses,
        manualAdjustmentIds: confirmedManual,
      );
      if (!mounted) return;
      final newState = (r['state'] ?? 'received').toString();
      final got = (r['rfidReceived'] as num?)?.toInt() ?? 0;
      final man = (r['manualReceived'] as num?)?.toInt() ?? 0;
      setState(() {
        _commitMsg = newState == 'received'
            ? 'RECEIVED — SLIP CLOSED'
            : 'PARTIAL — $got RFID · $man manual received';
        if (newState == 'received') {
          _done = true;
          _doneRfid = got;
          _doneManual = man;
        }
      });
      // Re-pull detail so already_received reflects new server state.
      await _loadDetail();
      // Drop the scanned set: a fresh scan-pass after a partial commit
      // should start clean; previously-found EPCs now show as alreadyReceived.
      if (mounted) setState(() => _scanned.clear());
    } catch (e) {
      if (mounted) setState(() => _commitMsg = 'COMMIT FAILED — $e');
    } finally {
      if (mounted) setState(() => _committing = false);
    }
  }

  // ── receive-list model ────────────────────────────────────────────────────
  /// RFID items grouped by SKU. Each group reports received-vs-total so the row
  /// can show "N/N" and the right status dot (all / partial / none).
  List<_SkuGroup> _rfidGroups() {
    final rfid = (_detail?['rfid'] as List?) ?? const [];
    final order = <String>[];
    final map = <String, _SkuGroup>{};
    for (final r in rfid) {
      if (r is! Map) continue;
      final epc = (r['epc'] ?? '').toString().toUpperCase();
      if (epc.isEmpty) continue;
      final sku = (r['sku'] ?? '').toString();
      final key = sku.isNotEmpty ? sku : epc;
      final g = map.putIfAbsent(key, () {
        order.add(key);
        return _SkuGroup(
          sku: sku.isNotEmpty ? sku : epc,
          desc: [r['name'], r['color'], r['size']]
              .map((e) => (e ?? '').toString().trim())
              .where((e) => e.isNotEmpty)
              .join(' · ')
              .toUpperCase(),
        );
      });
      g.total += 1;
      if (r['received'] == true || _scanned.contains(epc)) g.received += 1;
    }
    return [for (final k in order) map[k]!];
  }

  /// Headline counts for the three tiles (RFID EPCs + manual qty combined).
  ({int received, int missing, int expected}) _counts() {
    var expected = 0, received = 0;
    for (final g in _rfidGroups()) {
      expected += g.total;
      received += g.received;
    }
    for (final m in _manualLines) {
      final q = (m['qty'] as num?)?.toInt() ?? 0;
      expected += q;
      received += (_manualReceivedQty[m['adjustment_id']?.toString()] ?? 0)
          .clamp(0, q)
          .toInt();
    }
    final missing = (expected - received).clamp(0, expected).toInt();
    return (received: received, missing: missing, expected: expected);
  }

  /// Frame 5 — the active receiving screen: tiles → list → legend → status line.
  Widget _receivingBody() {
    final c = _counts();
    final groups = _rfidGroups();
    return Column(
      children: [
        _ReceiveTiles(
            received: c.received, missing: c.missing, expected: c.expected),
        Expanded(
          child: ListView(
            padding: EdgeInsets.fromLTRB(12.w, 12.h, 12.w, 16.h),
            children: [
              for (final g in groups) _SkuGroupRow(group: g),
              for (final m in _manualLines)
                _ManualStepperRow(
                  line: m,
                  received:
                      _manualReceivedQty[m['adjustment_id']?.toString()] ?? 0,
                  onChange: (v) {
                    final adjId = m['adjustment_id']?.toString() ?? '';
                    final q = (m['qty'] as num?)?.toInt() ?? 0;
                    setState(() =>
                        _manualReceivedQty[adjId] = v.clamp(0, q).toInt());
                  },
                ),
              if (groups.isEmpty && _manualLines.isEmpty)
                Padding(
                  padding: EdgeInsets.all(28.w),
                  child: Center(
                    child: Text('Nothing on this slip.',
                        style: GoogleFonts.manrope(
                            fontSize: 14.sp, color: const Color(0xFF6D7979))),
                  ),
                ),
            ],
          ),
        ),
        const _Legend(),
        Container(
          width: double.infinity,
          color: const Color(0xFFEFF2F2),
          padding: EdgeInsets.symmetric(horizontal: 16.w, vertical: 9.h),
          child: Text(
            _commitMsg ?? 'TRIGGER TO CONFIRM RFID    ·    ± MANUAL QTY',
            style: GoogleFonts.spaceGrotesk(
              fontSize: 10.5.sp,
              fontWeight: FontWeight.w800,
              letterSpacing: 0.8,
              color: _commitMsg != null ? _accent : const Color(0xFF6D7979),
            ),
          ),
        ),
      ],
    );
  }

  /// Frame 8 — the received confirmation: done band + received rows w/ badges.
  Widget _receivedDoneBody() {
    return Column(
      children: [
        Container(
          width: double.infinity,
          color: const Color(0x1A1B7F4F),
          padding: EdgeInsets.fromLTRB(16.w, 18.h, 16.w, 18.h),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(children: [
                Icon(LucideIcons.checkCircle2, size: 20.sp, color: _accent),
                SizedBox(width: 8.w),
                Text('RECEIVED  ·  IN STOCK',
                    style: GoogleFonts.spaceGrotesk(
                        fontSize: 16.sp,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 1.0,
                        color: _accent)),
              ]),
              SizedBox(height: 5.h),
              Text(
                '$_doneRfid RFID${_doneManual > 0 ? "  ·  $_doneManual manual" : ""}  ·  slip #${widget.slipNumber ?? "—"} fully received',
                style: GoogleFonts.manrope(
                    fontSize: 13.sp, color: const Color(0xFF3F4A4A)),
              ),
            ],
          ),
        ),
        Expanded(
          child: ListView(
            padding: EdgeInsets.fromLTRB(12.w, 12.h, 12.w, 16.h),
            children: [
              for (final g in _rfidGroups())
                _DoneRow(sku: g.sku, desc: g.desc, badge: 'RFID'),
              for (final m in _manualLines)
                _DoneRow(
                  sku: (m['sku'] ?? '').toString(),
                  desc: [m['name'], m['color'], m['size']]
                      .map((e) => (e ?? '').toString().trim())
                      .where((e) => e.isNotEmpty)
                      .join(' · ')
                      .toUpperCase(),
                  badge: 'MANUAL',
                ),
            ],
          ),
        ),
      ],
    );
  }

  /// Frame 8 bottom bar: NEW RECEIVE (→ Transfer In list) · DONE (→ dashboard).
  Widget _doneBottomBar() {
    return SafeArea(
      top: false,
      child: Container(
        color: Colors.white,
        padding: EdgeInsets.fromLTRB(16.w, 12.h, 16.w, 14.h),
        child: Row(
          children: [
            Expanded(
              child: SizedBox(
                height: 56.h,
                child: OutlinedButton(
                  onPressed: () => Navigator.of(context).pop(),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: _accent,
                    side: const BorderSide(color: _accent, width: 2),
                    shape: const RoundedRectangleBorder(
                        borderRadius: BorderRadius.zero),
                    textStyle: GoogleFonts.spaceGrotesk(
                        fontSize: 13.sp,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 1.4),
                  ),
                  child: const Text('NEW RECEIVE'),
                ),
              ),
            ),
            SizedBox(width: 10.w),
            Expanded(
              flex: 2,
              child: SizedBox(
                height: 56.h,
                child: FilledButton(
                  onPressed: () =>
                      Navigator.of(context).popUntil((r) => r.isFirst),
                  style: FilledButton.styleFrom(
                    backgroundColor: _accent,
                    foregroundColor: Colors.white,
                    shape: const RoundedRectangleBorder(
                        borderRadius: BorderRadius.zero),
                    textStyle: GoogleFonts.spaceGrotesk(
                        fontSize: 13.sp,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 1.8),
                  ),
                  child: const Text('DONE'),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return CarbonScaffold(
      pageTitle: 'RECEIVE  ·  #${widget.slipNumber ?? "—"}',
      actions: [
        IconButton(
          tooltip: 'Print slip',
          onPressed: _printSlip,
          icon: Icon(LucideIcons.printer, size: 22.sp, color: _accent),
        ),
        if (!_done)
          IconButton(
            tooltip: 'Receive settings',
            onPressed: _openGear,
            icon: Icon(LucideIcons.settings, size: 22.sp, color: _accent),
          ),
      ],
      bottomBar: _done
          ? _doneBottomBar()
          : SafeArea(
              top: false,
              child: Container(
                color: Colors.white,
                padding: EdgeInsets.fromLTRB(16.w, 12.h, 16.w, 14.h),
                child: Row(
                  children: [
                    Expanded(
                      child: SizedBox(
                        height: 56.h,
                        child: OutlinedButton.icon(
                          onPressed: _scanning ? _stopScan : _startScan,
                          style: OutlinedButton.styleFrom(
                            foregroundColor: _scanning ? _missing : _accent,
                            side: BorderSide(
                                color: _scanning ? _missing : _accent,
                                width: 2.w),
                            shape: const RoundedRectangleBorder(
                                borderRadius: BorderRadius.zero),
                            textStyle: GoogleFonts.spaceGrotesk(
                              fontSize: 13.sp,
                              fontWeight: FontWeight.w800,
                              letterSpacing: 1.6,
                            ),
                          ),
                          icon: Icon(
                            _scanning ? LucideIcons.square : LucideIcons.play,
                            size: 20.sp,
                          ),
                          label: Text(_scanning ? 'STOP' : 'START'),
                        ),
                      ),
                    ),
                    SizedBox(width: 10.w),
                    Expanded(
                      flex: 2,
                      child: SizedBox(
                        height: 56.h,
                        child: FilledButton.icon(
                          onPressed: _committing ? null : _commit,
                          style: FilledButton.styleFrom(
                            backgroundColor: _accent,
                            foregroundColor: Colors.white,
                            shape: const RoundedRectangleBorder(
                                borderRadius: BorderRadius.zero),
                            textStyle: GoogleFonts.spaceGrotesk(
                              fontSize: 13.sp,
                              fontWeight: FontWeight.w800,
                              letterSpacing: 1.8,
                            ),
                          ),
                          icon: _committing
                              ? SizedBox(
                                  width: 20.w,
                                  height: 20.h,
                                  child: const CircularProgressIndicator(
                                    strokeWidth: 2,
                                    color: Colors.white,
                                  ),
                                )
                              : Icon(LucideIcons.checkCircle2, size: 20.sp),
                          label: Text(_committing ? 'COMMITTING…' : 'RECEIVE'),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
      body: ColoredBox(
        color: const Color(0xFFF5F5F5),
        child: _loading && _detail == null
            ? const Center(child: CircularProgressIndicator(color: _accent))
            : _error != null
                ? Center(
                    child: Padding(
                      padding: EdgeInsets.all(24.w),
                      child: Text(
                        'ERROR\n$_error',
                        textAlign: TextAlign.center,
                        style: GoogleFonts.spaceGrotesk(
                          fontWeight: FontWeight.w700,
                          color: _missing,
                        ),
                      ),
                    ),
                  )
                : (_done ? _receivedDoneBody() : _receivingBody()),
      ),
    );
  }
}

/// A SKU group on the receive list: how many of its EPCs are received vs total.
class _SkuGroup {
  _SkuGroup({required this.sku, required this.desc});
  final String sku;
  final String desc;
  int total = 0;
  int received = 0;
}

/// Frame 5 KPI tiles: received · missing · expected, each with a faint
/// watermark glyph (mirrors the re-encode header tiles).
class _ReceiveTiles extends StatelessWidget {
  const _ReceiveTiles({
    required this.received,
    required this.missing,
    required this.expected,
  });
  final int received;
  final int missing;
  final int expected;

  @override
  Widget build(BuildContext context) {
    return Container(
      color: Colors.white,
      padding: EdgeInsets.fromLTRB(12.w, 12.h, 12.w, 12.h),
      child: Row(
        children: [
          _Tile(
            label: 'RECEIVED',
            value: received,
            color: const Color(0xFF1B7F4F),
            bg: const Color(0x141B7F4F),
            border: const Color(0x331B7F4F),
            watermark: const Color(0x1A1B7F4F),
            icon: LucideIcons.checkCircle2,
          ),
          SizedBox(width: 10.w),
          _Tile(
            label: 'MISSING',
            value: missing,
            color: const Color(0xFFB23A3A),
            bg: const Color(0x14B23A3A),
            border: const Color(0x33B23A3A),
            watermark: const Color(0x1AB23A3A),
            icon: LucideIcons.alertCircle,
          ),
          SizedBox(width: 10.w),
          _Tile(
            label: 'EXPECTED',
            value: expected,
            color: const Color(0xFF3F4A4A),
            bg: const Color(0xFFF1F4F4),
            border: const Color(0xFFD7DEDE),
            watermark: const Color(0x143F4A4A),
            icon: LucideIcons.package,
          ),
        ],
      ),
    );
  }
}

class _Tile extends StatelessWidget {
  const _Tile({
    required this.label,
    required this.value,
    required this.color,
    required this.bg,
    required this.border,
    required this.watermark,
    required this.icon,
  });
  final String label;
  final int value;
  final Color color;
  final Color bg;
  final Color border;
  final Color watermark;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: Container(
        height: 92.h,
        decoration: BoxDecoration(
          color: bg,
          borderRadius: BorderRadius.circular(10.r),
          border: Border.all(color: border),
        ),
        clipBehavior: Clip.hardEdge,
        child: Stack(
          children: [
            Positioned(
              right: -6.w,
              bottom: -10.h,
              child: Icon(icon, size: 58.sp, color: watermark),
            ),
            Padding(
              padding: EdgeInsets.fromLTRB(12.w, 11.h, 12.w, 11.h),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(
                    label,
                    style: GoogleFonts.spaceGrotesk(
                      fontSize: 10.5.sp,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 1.0,
                      color: color,
                    ),
                  ),
                  Text(
                    '$value',
                    style: GoogleFonts.spaceGrotesk(
                      fontSize: 30.sp,
                      fontWeight: FontWeight.w800,
                      height: 1.0,
                      color: color,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Frame 5 RFID row: status dot + SKU/desc + "received/total" qty.
class _SkuGroupRow extends StatelessWidget {
  const _SkuGroupRow({required this.group});
  final _SkuGroup group;

  @override
  Widget build(BuildContext context) {
    final all = group.total > 0 && group.received >= group.total;
    final none = group.received == 0;
    final dot = all
        ? const Color(0xFF1B7F4F)
        : none
            ? const Color(0xFFB23A3A)
            : const Color(0xFFB87A00);
    return Container(
      margin: EdgeInsets.only(bottom: 10.h),
      padding: EdgeInsets.fromLTRB(14.w, 14.h, 14.w, 14.h),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(10.r),
        border: Border.all(color: const Color(0xFFE2E8E8)),
      ),
      child: Row(
        children: [
          Container(
            width: 12.w,
            height: 12.w,
            decoration: BoxDecoration(color: dot, shape: BoxShape.circle),
          ),
          SizedBox(width: 13.w),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  group.sku,
                  style: GoogleFonts.spaceGrotesk(
                    fontSize: 16.sp,
                    fontWeight: FontWeight.w800,
                    color: const Color(0xFF171D1D),
                  ),
                ),
                if (group.desc.isNotEmpty) ...[
                  SizedBox(height: 3.h),
                  Text(
                    group.desc,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: GoogleFonts.manrope(
                      fontSize: 13.sp,
                      fontWeight: FontWeight.w600,
                      color: const Color(0xFF3F4A4A),
                    ),
                  ),
                ],
              ],
            ),
          ),
          SizedBox(width: 10.w),
          Text(
            '${group.received}/${group.total}',
            style: GoogleFonts.robotoMono(
              fontSize: 17.sp,
              fontWeight: FontWeight.w700,
              color: dot,
            ),
          ),
        ],
      ),
    );
  }
}

/// Frame 5 manual row: status dot + SKU + MANUAL badge + −/N/+ stepper.
class _ManualStepperRow extends StatelessWidget {
  const _ManualStepperRow({
    required this.line,
    required this.received,
    required this.onChange,
  });
  final Map line;
  final int received;
  final ValueChanged<int> onChange;

  @override
  Widget build(BuildContext context) {
    final qty = (line['qty'] as num?)?.toInt() ?? 0;
    final sku = (line['sku'] ?? '').toString();
    final desc = [line['name'], line['color'], line['size']]
        .map((e) => (e ?? '').toString().trim())
        .where((e) => e.isNotEmpty)
        .join(' · ')
        .toUpperCase();
    final all = qty > 0 && received >= qty;
    final none = received == 0;
    final dot = all
        ? const Color(0xFF1B7F4F)
        : none
            ? const Color(0xFFB23A3A)
            : const Color(0xFFB87A00);
    return Container(
      margin: EdgeInsets.only(bottom: 10.h),
      padding: EdgeInsets.fromLTRB(14.w, 10.h, 10.w, 10.h),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(10.r),
        border: Border.all(color: const Color(0xFFE2E8E8)),
      ),
      child: Row(
        children: [
          Container(
            width: 12.w,
            height: 12.w,
            decoration: BoxDecoration(color: dot, shape: BoxShape.circle),
          ),
          SizedBox(width: 13.w),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Flexible(
                      child: Text(
                        sku.isEmpty ? '—' : sku,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: GoogleFonts.spaceGrotesk(
                          fontSize: 16.sp,
                          fontWeight: FontWeight.w800,
                          color: const Color(0xFF171D1D),
                        ),
                      ),
                    ),
                    SizedBox(width: 8.w),
                    Container(
                      padding:
                          EdgeInsets.symmetric(horizontal: 6.w, vertical: 2.h),
                      decoration: BoxDecoration(
                        color: const Color(0xFFF1F4F4),
                        borderRadius: BorderRadius.circular(4.r),
                      ),
                      child: Text(
                        'MANUAL',
                        style: GoogleFonts.spaceGrotesk(
                          fontSize: 9.sp,
                          fontWeight: FontWeight.w800,
                          letterSpacing: 0.8,
                          color: const Color(0xFF6D7979),
                        ),
                      ),
                    ),
                  ],
                ),
                if (desc.isNotEmpty) ...[
                  SizedBox(height: 3.h),
                  Text(
                    desc,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: GoogleFonts.manrope(
                      fontSize: 13.sp,
                      fontWeight: FontWeight.w600,
                      color: const Color(0xFF3F4A4A),
                    ),
                  ),
                ],
              ],
            ),
          ),
          SizedBox(width: 8.w),
          _StepBtn(
            icon: LucideIcons.minus,
            onTap: received > 0 ? () => onChange(received - 1) : null,
          ),
          SizedBox(width: 8.w),
          SizedBox(
            width: 30.w,
            child: Text(
              '$received',
              textAlign: TextAlign.center,
              style: GoogleFonts.robotoMono(
                fontSize: 17.sp,
                fontWeight: FontWeight.w700,
                color: dot,
              ),
            ),
          ),
          SizedBox(width: 8.w),
          _StepBtn(
            icon: LucideIcons.plus,
            onTap: received < qty ? () => onChange(received + 1) : null,
          ),
        ],
      ),
    );
  }
}

class _StepBtn extends StatelessWidget {
  const _StepBtn({required this.icon, required this.onTap});
  final IconData icon;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final on = onTap != null;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(8.r),
      child: Container(
        width: 38.w,
        height: 38.w,
        decoration: BoxDecoration(
          color: on ? const Color(0xFFEFF5F3) : const Color(0xFFF4F6F6),
          borderRadius: BorderRadius.circular(8.r),
          border: Border.all(
              color: on ? const Color(0xFF1B7F4F) : const Color(0xFFD7DEDE)),
        ),
        child: Icon(icon,
            size: 20.sp,
            color: on ? const Color(0xFF1B7F4F) : const Color(0xFFC2CCCC)),
      ),
    );
  }
}

/// Frame 8 received row: green check + SKU/desc + RFID|MANUAL badge.
class _DoneRow extends StatelessWidget {
  const _DoneRow({required this.sku, required this.desc, required this.badge});
  final String sku;
  final String desc;
  final String badge;

  @override
  Widget build(BuildContext context) {
    final manual = badge == 'MANUAL';
    return Container(
      margin: EdgeInsets.only(bottom: 10.h),
      padding: EdgeInsets.fromLTRB(14.w, 14.h, 14.w, 14.h),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(10.r),
        border: Border.all(color: const Color(0xFFE2E8E8)),
      ),
      child: Row(
        children: [
          Icon(LucideIcons.checkCircle2,
              size: 18.sp, color: const Color(0xFF1B7F4F)),
          SizedBox(width: 12.w),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  sku.isEmpty ? '—' : sku,
                  style: GoogleFonts.spaceGrotesk(
                    fontSize: 16.sp,
                    fontWeight: FontWeight.w800,
                    color: const Color(0xFF171D1D),
                  ),
                ),
                if (desc.isNotEmpty) ...[
                  SizedBox(height: 3.h),
                  Text(
                    desc,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: GoogleFonts.manrope(
                      fontSize: 13.sp,
                      fontWeight: FontWeight.w600,
                      color: const Color(0xFF3F4A4A),
                    ),
                  ),
                ],
              ],
            ),
          ),
          SizedBox(width: 10.w),
          Container(
            padding: EdgeInsets.symmetric(horizontal: 8.w, vertical: 4.h),
            decoration: BoxDecoration(
              color: manual ? const Color(0xFFF1F4F4) : const Color(0x141B7F4F),
              borderRadius: BorderRadius.circular(5.r),
            ),
            child: Text(
              badge,
              style: GoogleFonts.spaceGrotesk(
                fontSize: 10.sp,
                fontWeight: FontWeight.w800,
                letterSpacing: 0.8,
                color:
                    manual ? const Color(0xFF6D7979) : const Color(0xFF1B7F4F),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Frame 5 legend strip: all-found · partial · none.
class _Legend extends StatelessWidget {
  const _Legend();

  @override
  Widget build(BuildContext context) {
    Widget item(Color c, String t) => Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 9.w,
              height: 9.w,
              decoration: BoxDecoration(color: c, shape: BoxShape.circle),
            ),
            SizedBox(width: 6.w),
            Text(
              t,
              style: GoogleFonts.spaceGrotesk(
                fontSize: 10.sp,
                fontWeight: FontWeight.w700,
                letterSpacing: 0.5,
                color: const Color(0xFF6D7979),
              ),
            ),
          ],
        );
    return Container(
      width: double.infinity,
      color: Colors.white,
      padding: EdgeInsets.symmetric(horizontal: 16.w, vertical: 9.h),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceAround,
        children: [
          item(const Color(0xFF1B7F4F), 'ALL FOUND'),
          item(const Color(0xFFB87A00), 'PARTIAL'),
          item(const Color(0xFFB23A3A), 'NONE'),
        ],
      ),
    );
  }
}

/// Inspect-before-close — the flagged-arrivals screen (mockup frame 7). Lists
/// every item that arrived in a non-live status with a dropdown so the operator
/// sets each one's final status after inspection. Returns the epc→status map on
/// confirm, or null if the operator backs out.
class _InspectArrivalsScreen extends StatefulWidget {
  const _InspectArrivalsScreen({
    required this.epcs,
    required this.initial,
    required this.detail,
  });

  final List<String> epcs;
  final Map<String, String> initial;
  final Map<String, dynamic>? detail;

  @override
  State<_InspectArrivalsScreen> createState() => _InspectArrivalsScreenState();
}

class _InspectArrivalsScreenState extends State<_InspectArrivalsScreen> {
  static const Color _accent = Color(0xFF1B7F4F);
  static const Color _transit = Color(0xFFB87A00);

  // value → label for the status dropdown.
  static const List<MapEntry<String, String>> _options = [
    MapEntry('in-stock', 'LIVE'),
    MapEntry('damaged', 'DAMAGED'),
    MapEntry('tag_killed', 'TAG KILLED'),
    MapEntry('sold', 'SOLD'),
    MapEntry('stolen', 'STOLEN'),
  ];

  late final Map<String, String> _choice;

  @override
  void initState() {
    super.initState();
    _choice = Map<String, String>.from(widget.initial);
    for (final e in widget.epcs) {
      _choice.putIfAbsent(e, () => 'damaged');
      // Normalise any status that isn't a selectable option to 'damaged'.
      if (!_options.any((o) => o.key == _choice[e])) _choice[e] = 'damaged';
    }
  }

  Map<String, dynamic>? _row(String epc) {
    final rfid = (widget.detail?['rfid'] as List?) ?? const [];
    for (final r in rfid) {
      if (r is Map && (r['epc']?.toString().toUpperCase() ?? '') == epc) {
        return Map<String, dynamic>.from(r);
      }
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    return CarbonScaffold(
      pageTitle: 'INSPECT  ·  ${widget.epcs.length} FLAGGED',
      bottomBar: SafeArea(
        top: false,
        child: Container(
          color: Colors.white,
          padding: EdgeInsets.fromLTRB(16.w, 12.h, 16.w, 14.h),
          child: SizedBox(
            width: double.infinity,
            height: 56.h,
            child: FilledButton.icon(
              onPressed: () => Navigator.of(context).pop(_choice),
              style: FilledButton.styleFrom(
                backgroundColor: _accent,
                foregroundColor: Colors.white,
                shape: const RoundedRectangleBorder(
                    borderRadius: BorderRadius.zero),
                textStyle: GoogleFonts.spaceGrotesk(
                    fontSize: 14.sp,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 1.8),
              ),
              icon: Icon(LucideIcons.checkCircle2, size: 20.sp),
              label: const Text('SET STATUSES · CONTINUE'),
            ),
          ),
        ),
      ),
      body: ColoredBox(
        color: Colors.white,
        child: Column(
          children: [
            Container(
              width: double.infinity,
              color: _transit.withValues(alpha: 0.12),
              padding: EdgeInsets.fromLTRB(16.w, 12.h, 16.w, 12.h),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('⚠ ${widget.epcs.length} ITEMS ARRIVED NON-LIVE',
                      style: GoogleFonts.spaceGrotesk(
                          fontSize: 12.sp,
                          fontWeight: FontWeight.w800,
                          letterSpacing: .5,
                          color: const Color(0xFF8A4E12))),
                  SizedBox(height: 4.h),
                  Text(
                    'These were sent in a non-live status. Inspect each, set its '
                    'final status, then continue to commit.',
                    style: GoogleFonts.manrope(
                        fontSize: 12.sp, color: const Color(0xFF5A6464)),
                  ),
                ],
              ),
            ),
            Expanded(
              child: ListView.builder(
                padding: EdgeInsets.only(bottom: 16.h),
                itemCount: widget.epcs.length,
                itemBuilder: (_, i) {
                  final epc = widget.epcs[i];
                  final row = _row(epc);
                  final sku = row?['sku']?.toString();
                  final name = row?['name']?.toString();
                  final color = row?['color']?.toString();
                  final size = row?['size']?.toString();
                  return Container(
                    decoration: const BoxDecoration(
                      border:
                          Border(bottom: BorderSide(color: Color(0xFFEFF2F2))),
                    ),
                    padding: EdgeInsets.fromLTRB(16.w, 10.h, 12.w, 10.h),
                    child: Row(
                      children: [
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(sku?.isNotEmpty == true ? sku! : epc,
                                  style: GoogleFonts.robotoMono(
                                      fontSize: 13.sp,
                                      fontWeight: FontWeight.w700,
                                      color: AppColors.textMain)),
                              if (name != null && name.isNotEmpty)
                                Text(
                                  [
                                    name,
                                    if (color != null && color.isNotEmpty)
                                      color,
                                    if (size != null && size.isNotEmpty) size,
                                  ].join(' · '),
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: GoogleFonts.manrope(
                                      fontSize: 12.sp,
                                      color: const Color(0xFF6D7979)),
                                ),
                            ],
                          ),
                        ),
                        SizedBox(width: 10.w),
                        Container(
                          padding: EdgeInsets.symmetric(horizontal: 10.w),
                          decoration: BoxDecoration(
                            border: Border.all(color: const Color(0xFFBCC9C9)),
                          ),
                          child: DropdownButtonHideUnderline(
                            child: DropdownButton<String>(
                              value: _choice[epc],
                              isDense: true,
                              items: [
                                for (final o in _options)
                                  DropdownMenuItem<String>(
                                    value: o.key,
                                    child: Text(o.value,
                                        style: GoogleFonts.spaceGrotesk(
                                            fontSize: 12.sp,
                                            fontWeight: FontWeight.w800,
                                            color: o.key == 'in-stock'
                                                ? _accent
                                                : AppColors.textMain)),
                                  ),
                              ],
                              onChanged: (v) {
                                if (v != null) setState(() => _choice[epc] = v);
                              },
                            ),
                          ),
                        ),
                      ],
                    ),
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Receive gear — single slider for antenna power. Mirrors the count
/// gear pattern but scoped to the Transfer In session.
class _ReceiveGearScreen extends StatefulWidget {
  const _ReceiveGearScreen({required this.initial});
  final int initial;

  @override
  State<_ReceiveGearScreen> createState() => _ReceiveGearScreenState();
}

class _ReceiveGearScreenState extends State<_ReceiveGearScreen> {
  static const Color _primary = Color(0xFF1B7F4F);
  late int _power;
  Timer? _liveApply;

  @override
  void initState() {
    super.initState();
    _power = widget.initial;
  }

  @override
  void dispose() {
    _liveApply?.cancel();
    super.dispose();
  }

  void _scheduleLiveApply() {
    _liveApply?.cancel();
    _liveApply = Timer(const Duration(milliseconds: 180), () async {
      if (!mounted) return;
      // Live-preview via the manager so the operator hears density change
      // before saving. Override survives reapplyHandheldHardwareSettings.
      final rfid = context.read<RfidManager>();
      await rfid.setSessionPowerOverrideDbm(_power);
      try {
        await RfidVendorChannel.setAntennaPowerDbm(_power);
      } catch (_) {}
      if (mounted) setState(() {});
    });
  }

  @override
  Widget build(BuildContext context) {
    return CarbonScaffold(
      pageTitle: 'receive settings',
      bottomBar: SafeArea(
        top: false,
        child: Container(
          color: Colors.white,
          padding: EdgeInsets.fromLTRB(24.w, 12.h, 24.w, 14.h),
          child: SizedBox(
            width: double.infinity,
            height: 56.h,
            child: FilledButton.icon(
              onPressed: () => Navigator.of(context).pop(_power),
              style: FilledButton.styleFrom(
                backgroundColor: _primary,
                foregroundColor: Colors.white,
                shape: const RoundedRectangleBorder(
                    borderRadius: BorderRadius.zero),
                textStyle: GoogleFonts.spaceGrotesk(
                  fontSize: 14.sp,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 2,
                ),
              ),
              icon: Icon(Icons.save_outlined, size: 22.sp),
              label: const Text('SAVE'),
            ),
          ),
        ),
      ),
      body: ColoredBox(
        color: Colors.white,
        child: ListView(
          padding: EdgeInsets.fromLTRB(24.w, 32.h, 24.w, 24.h),
          children: [
            Text(
              'ANTENNA POWER',
              style: GoogleFonts.spaceGrotesk(
                fontSize: 11.sp,
                fontWeight: FontWeight.w800,
                letterSpacing: 1.6,
                color: const Color(0xFF6D7979),
              ),
            ),
            SizedBox(height: 6.h),
            Text(
              '$_power dBm',
              style: GoogleFonts.spaceGrotesk(
                fontSize: 36.sp,
                fontWeight: FontWeight.w800,
                color: AppColors.textMain,
              ),
            ),
            SizedBox(height: 12.h),
            Slider(
              value: _power.toDouble(),
              min: 5,
              max: 30,
              divisions: 25,
              activeColor: _primary,
              inactiveColor: _primary.withValues(alpha: 0.18),
              onChanged: (v) {
                setState(() => _power = v.round());
                _scheduleLiveApply();
              },
            ),
            SizedBox(height: 8.h),
            Text(
              'Lower power keeps reads close to the trolley you\'re unpacking — '
              'good for narrow aisles. Higher power picks up more tags but may '
              'pull in foreign EPCs from neighbouring lanes (they\'ll show up '
              'in UNEXPECTED).',
              style: GoogleFonts.manrope(
                fontSize: 12.sp,
                fontWeight: FontWeight.w500,
                color: const Color(0xFF5A6464),
                height: 1.5,
              ),
            ),
            if (kDebugMode) ...[
              SizedBox(height: 24.h),
              Text(
                'debug: power applied live as you drag; saved on tap.',
                style: GoogleFonts.manrope(
                  fontSize: 10.sp,
                  color: const Color(0xFF6D7979),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
