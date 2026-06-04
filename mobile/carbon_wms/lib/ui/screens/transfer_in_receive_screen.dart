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
    if (b.found.isEmpty && _nonLive.isEmpty) {
      setState(() => _commitMsg = 'NOTHING TO RECEIVE — SCAN AT LEAST ONE EPC');
      return;
    }
    // Capture the api ref *before* any await so the analyzer doesn't flag
    // a context-across-async-gap below. Dialog + commit are async.
    final api = context.read<WmsApiClient>();

    // Inspect-before-close: any item that arrived non-live must have its
    // final status confirmed by the operator before the slip can commit.
    if (_nonLive.isNotEmpty) {
      final result =
          await Navigator.of(context).push<Map<String, String>>(
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

    final partialWarning = b.missing.isNotEmpty;
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
            '${b.found.length} found, ${b.missing.length} still missing.\n'
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
      );
      if (!mounted) return;
      final newState = (r['state'] ?? 'received').toString();
      final got = r['rfidReceived'];
      setState(() {
        _commitMsg = newState == 'received'
            ? 'RECEIVED $got — SLIP CLOSED'
            : 'PARTIAL — $got received, ${b.missing.length} missing';
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

  @override
  Widget build(BuildContext context) {
    final b = _buckets();
    final foundN = b.found.length + _alreadyReceived.length;
    final expectedTotal = _expected.length + _alreadyReceived.length;

    return CarbonScaffold(
      pageTitle: 'RECEIVE  ·  #${widget.slipNumber ?? "—"}',
      actions: [
        IconButton(
          tooltip: 'Print slip',
          onPressed: _printSlip,
          icon: Icon(LucideIcons.printer, size: 22.sp, color: _accent),
        ),
        IconButton(
          tooltip: 'Receive settings',
          onPressed: _openGear,
          icon: Icon(LucideIcons.settings, size: 22.sp, color: _accent),
        ),
      ],
      bottomBar: SafeArea(
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
                          color: _scanning ? _missing : _accent, width: 2.w),
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
                    label: Text(_committing ? 'COMMITTING…' : 'COMMIT RECEIVE'),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
      body: ColoredBox(
        color: Colors.white,
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
                : Column(
                    children: [
                      _Header(
                        sourceCode: widget.sourceCode,
                        sourceName: widget.sourceName,
                        powerDbm: _powerDbm,
                        scanning: _scanning,
                        commitMsg: _commitMsg,
                        nonLive: _nonLive.length,
                      ),
                      _BucketBar(
                        found: foundN,
                        expected: expectedTotal,
                        missing: b.missing.length,
                        unexpected: b.unexpected.length,
                      ),
                      Expanded(
                        child: _BucketLists(
                          alreadyReceived: _alreadyReceived,
                          found: b.found,
                          missing: b.missing,
                          unexpected: b.unexpected,
                          detail: _detail,
                        ),
                      ),
                    ],
                  ),
      ),
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({
    required this.sourceCode,
    required this.sourceName,
    required this.powerDbm,
    required this.scanning,
    required this.commitMsg,
    required this.nonLive,
  });

  final String sourceCode;
  final String sourceName;
  final int powerDbm;
  final bool scanning;
  final String? commitMsg;
  final int nonLive;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      color: const Color(0xFFF5F8F8),
      padding: EdgeInsets.fromLTRB(16.w, 12.h, 16.w, 12.h),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(LucideIcons.arrowDownToLine,
                  size: 18.sp, color: const Color(0xFF1B7F4F)),
              SizedBox(width: 8.w),
              Text(
                'FROM  $sourceCode${sourceName.isNotEmpty ? "  ·  $sourceName" : ""}',
                style: GoogleFonts.spaceGrotesk(
                  fontSize: 12.sp,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 1.4,
                  color: AppColors.textMain,
                ),
              ),
              const Spacer(),
              Container(
                padding: EdgeInsets.symmetric(horizontal: 8.w, vertical: 3.h),
                color: scanning
                    ? const Color(0x33B23A3A)
                    : const Color(0x331B7F4F),
                child: Text(
                  scanning ? 'SCANNING' : 'IDLE',
                  style: GoogleFonts.spaceGrotesk(
                    fontSize: 10.sp,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 1.6,
                    color: scanning
                        ? const Color(0xFFB23A3A)
                        : const Color(0xFF1B7F4F),
                  ),
                ),
              ),
            ],
          ),
          SizedBox(height: 6.h),
          Row(
            children: [
              Text(
                'POWER ${powerDbm}dBm',
                style: GoogleFonts.spaceGrotesk(
                  fontSize: 10.sp,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 1.2,
                  color: const Color(0xFF6D7979),
                ),
              ),
              if (commitMsg != null) ...[
                SizedBox(width: 14.w),
                Expanded(
                  child: Text(
                    commitMsg!,
                    style: GoogleFonts.spaceGrotesk(
                      fontSize: 11.sp,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 1.2,
                      color: const Color(0xFF1B7F4F),
                    ),
                  ),
                ),
              ],
            ],
          ),
          if (nonLive > 0) ...[
            SizedBox(height: 6.h),
            Container(
              padding: EdgeInsets.symmetric(horizontal: 8.w, vertical: 4.h),
              color: const Color(0x33B87A00),
              child: Text(
                '⚠ $nonLive ARRIVED NON-LIVE — SET STATUS ON COMMIT',
                style: GoogleFonts.spaceGrotesk(
                  fontSize: 10.sp,
                  fontWeight: FontWeight.w800,
                  letterSpacing: .8,
                  color: const Color(0xFF8A4E12),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _BucketBar extends StatelessWidget {
  const _BucketBar({
    required this.found,
    required this.expected,
    required this.missing,
    required this.unexpected,
  });

  final int found;
  final int expected;
  final int missing;
  final int unexpected;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: const BoxDecoration(
        border: Border(
          bottom: BorderSide(color: Color(0xFFE5E9E9), width: 1),
        ),
      ),
      padding: EdgeInsets.fromLTRB(16.w, 12.h, 16.w, 12.h),
      child: Row(
        children: [
          _Pill(
            label: 'FOUND',
            value: '$found / $expected',
            color: const Color(0xFF1B7F4F),
          ),
          SizedBox(width: 8.w),
          _Pill(
            label: 'MISSING',
            value: '$missing',
            color: missing == 0
                ? const Color(0xFF6D7979)
                : const Color(0xFFB23A3A),
          ),
          SizedBox(width: 8.w),
          _Pill(
            label: 'UNEXPECTED',
            value: '$unexpected',
            color: unexpected == 0
                ? const Color(0xFF6D7979)
                : const Color(0xFFB87A00),
          ),
        ],
      ),
    );
  }
}

class _Pill extends StatelessWidget {
  const _Pill({required this.label, required this.value, required this.color});

  final String label;
  final String value;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: Container(
        padding: EdgeInsets.symmetric(vertical: 8.h),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.10),
          border: Border.all(color: color.withValues(alpha: 0.40)),
        ),
        child: Column(
          children: [
            Text(
              label,
              style: GoogleFonts.spaceGrotesk(
                fontSize: 9.sp,
                fontWeight: FontWeight.w800,
                letterSpacing: 1.4,
                color: color,
              ),
            ),
            SizedBox(height: 2.h),
            Text(
              value,
              style: GoogleFonts.spaceGrotesk(
                fontSize: 16.sp,
                fontWeight: FontWeight.w800,
                color: color,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _BucketLists extends StatelessWidget {
  const _BucketLists({
    required this.alreadyReceived,
    required this.found,
    required this.missing,
    required this.unexpected,
    required this.detail,
  });

  final Set<String> alreadyReceived;
  final Set<String> found;
  final Set<String> missing;
  final Set<String> unexpected;
  final Map<String, dynamic>? detail;

  @override
  Widget build(BuildContext context) {
    final rfid = (detail?['rfid'] as List?) ?? const [];
    Map<String, dynamic>? lookupRow(String epc) {
      for (final r in rfid) {
        if (r is Map && (r['epc']?.toString().toUpperCase() ?? '') == epc) {
          return Map<String, dynamic>.from(r);
        }
      }
      return null;
    }

    return ListView(
      padding: EdgeInsets.fromLTRB(0, 0, 0, 16.h),
      children: [
        if (missing.isNotEmpty)
          _Section(
            label: 'MISSING — ${missing.length}',
            color: const Color(0xFFB23A3A),
            children: missing
                .toList()
                .map((e) => _EpcRow(
                      epc: e,
                      row: lookupRow(e),
                      tone: _Tone.missing,
                    ))
                .toList(),
          ),
        if (unexpected.isNotEmpty)
          _Section(
            label: 'UNEXPECTED — ${unexpected.length}',
            color: const Color(0xFFB87A00),
            children: unexpected
                .toList()
                .map((e) => _EpcRow(epc: e, row: null, tone: _Tone.unexpected))
                .toList(),
          ),
        if (found.isNotEmpty)
          _Section(
            label: 'FOUND THIS SESSION — ${found.length}',
            color: const Color(0xFF1B7F4F),
            children: found
                .toList()
                .map((e) => _EpcRow(
                      epc: e,
                      row: lookupRow(e),
                      tone: _Tone.found,
                    ))
                .toList(),
          ),
        if (alreadyReceived.isNotEmpty)
          _Section(
            label: 'PREVIOUSLY RECEIVED — ${alreadyReceived.length}',
            color: const Color(0xFF6D7979),
            children: alreadyReceived
                .toList()
                .map((e) => _EpcRow(
                      epc: e,
                      row: lookupRow(e),
                      tone: _Tone.previously,
                    ))
                .toList(),
          ),
      ],
    );
  }
}

enum _Tone { found, missing, unexpected, previously }

class _Section extends StatelessWidget {
  const _Section({
    required this.label,
    required this.color,
    required this.children,
  });

  final String label;
  final Color color;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          color: color.withValues(alpha: 0.06),
          padding: EdgeInsets.fromLTRB(16.w, 8.h, 16.w, 8.h),
          child: Text(
            label,
            style: GoogleFonts.spaceGrotesk(
              fontSize: 10.sp,
              fontWeight: FontWeight.w800,
              letterSpacing: 1.6,
              color: color,
            ),
          ),
        ),
        ...children,
      ],
    );
  }
}

class _EpcRow extends StatelessWidget {
  const _EpcRow({required this.epc, required this.row, required this.tone});

  final String epc;
  final Map<String, dynamic>? row;
  final _Tone tone;

  @override
  Widget build(BuildContext context) {
    final sku = row?['sku']?.toString();
    final name = row?['name']?.toString();
    final size = row?['size']?.toString();
    final color = row?['color']?.toString();
    final accent = switch (tone) {
      _Tone.found => const Color(0xFF1B7F4F),
      _Tone.missing => const Color(0xFFB23A3A),
      _Tone.unexpected => const Color(0xFFB87A00),
      _Tone.previously => const Color(0xFF6D7979),
    };
    final trailing = switch (tone) {
      _Tone.found => LucideIcons.check,
      _Tone.missing => LucideIcons.minus,
      _Tone.unexpected => LucideIcons.alertTriangle,
      _Tone.previously => LucideIcons.clock,
    };

    return Container(
      decoration: const BoxDecoration(
        border: Border(
          bottom: BorderSide(color: Color(0xFFEFF2F2), width: 1),
        ),
      ),
      padding: EdgeInsets.fromLTRB(16.w, 8.h, 12.w, 8.h),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  epc,
                  style: GoogleFonts.firaCode(
                    fontSize: 11.sp,
                    color: AppColors.textMain,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                if (sku != null && sku.isNotEmpty) ...[
                  SizedBox(height: 2.h),
                  Text(
                    [
                      sku,
                      if (color != null && color.isNotEmpty) color,
                      if (size != null && size.isNotEmpty) size,
                    ].join(' · '),
                    style: GoogleFonts.manrope(
                      fontSize: 11.sp,
                      color: const Color(0xFF6D7979),
                    ),
                  ),
                ],
                if (name != null && name.isNotEmpty)
                  Text(
                    name,
                    style: GoogleFonts.manrope(
                      fontSize: 11.sp,
                      color: const Color(0xFF11181C),
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
              ],
            ),
          ),
          Icon(trailing, size: 18.sp, color: accent),
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
                      border: Border(
                          bottom: BorderSide(color: Color(0xFFEFF2F2))),
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
                            border:
                                Border.all(color: const Color(0xFFBCC9C9)),
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
