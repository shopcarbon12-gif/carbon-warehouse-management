import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/hardware/rfid_tag_read.dart';
import 'package:carbon_wms/hardware/rfid_vendor_channel.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/lan_zpl_printer.dart';
import 'package:carbon_wms/services/mobile_settings_repository.dart';
import 'package:carbon_wms/services/scan_sounds.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/screens/inventory_catalog_screen.dart' show CatalogRowCard;
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';
import 'package:carbon_wms/ui/widgets/rfid_power_slider.dart';

/// Handheld Encode & Print — 3-step commissioning flow:
///
///   Step 1 (SKU):   pull the trigger → 2D imager fires → the scanned barcode
///                   (UPC/SKU) resolves the target SKU. Manual type-to-search
///                   is the fallback. Picking a SKU → Step 2 (scanner → RFID).
///   Step 2 (Encode): the radio scans CONTINUOUSLY (power-controlled by the
///                   bottom slider so only the nearest tag is in range). The
///                   nearest EPC shows live; pull the trigger (or tap Encode)
///                   to commit — mint a fresh EPC, write the chip, and
///                   re-read-verify (writeEpcTag returns true only when the
///                   chip reads back the new EPC).
///   Step 3 (Print): only on a verified write, print the non-RFID label to the
///                   Zebra .220 (192.168.1.220) over raw TCP 9100.
class EncodeAndPrintScreen extends StatefulWidget {
  const EncodeAndPrintScreen({super.key});

  static const String routeName = '/encode-and-print';

  @override
  State<EncodeAndPrintScreen> createState() => _EncodeAndPrintScreenState();
}

enum _Step { sku, encode, printing, done, error }

const Color _danger = Color(0xFFDC2626);

class _EncodeAndPrintScreenState extends State<EncodeAndPrintScreen> {
  static const Duration _searchDebounce = Duration(milliseconds: 300);
  static const int _minQueryLen = 2;

  RfidManager? _rfid;
  StreamSubscription<String>? _barcodeSub;
  StreamSubscription<RfidTagRead>? _tagSub;
  StreamSubscription<String>? _triggerSub;
  final ScanSounds _sounds = ScanSounds.instance;

  // SKU search
  final TextEditingController _searchCtrl = TextEditingController();
  Timer? _debounce;
  String _query = '';
  bool _searchLoading = false;
  String? _searchError;
  List<Map<String, dynamic>> _results = [];
  Map<String, dynamic>? _selectedSku;

  // flow
  _Step _step = _Step.sku;
  bool _busy = false;
  bool _scanning = false;
  int _powerDbm = 30;

  // live nearest tag (Step 2)
  String? _nearestEpc;
  int? _nearestRssi;

  String? _newEpc;
  String _statusMsg = 'Pull the trigger to scan a barcode — or type to search.';
  String? _errMsg;

  // Decoded info for the live nearest tag (formula lookup).
  Map<String, dynamic>? _nearestInfo;
  String? _infoEpc;
  Timer? _lookupTimer;

  // Post-encode status (operator picks; default unknown).
  static const _statusOptions = <(String, String)>[
    ('unknown', 'UNKNOWN'),
    ('in-stock', 'LIVE'),
    ('tag_killed', 'TAG KILLED'),
  ];
  String _doneStatus = 'unknown';
  bool _statusSaved = true;
  bool _savingStatus = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted) return;
      context.read<RfidManager>().scanContext = 'RE_ENCODE';
      _powerDbm = context.read<MobileSettingsRepository>().config.transferOutAntennaPower;
      unawaited(_sounds.init());
      _wireStreams();
      await _armBarcodeMode();
      if (mounted) setState(() {});
    });
  }

  void _wireStreams() {
    // Barcode (2D) — only while picking a SKU.
    _barcodeSub?.cancel();
    _barcodeSub = RfidVendorChannel.hardwareBarcodeStream().listen((raw) {
      if (!mounted || _step != _Step.sku) return;
      final code = raw.trim();
      if (code.isEmpty) return;
      if (RegExp(r'^[0-9A-F]{24}$').hasMatch(code.toUpperCase())) return; // ignore EPC reads
      _onBarcode(code);
    }, onError: (_) {});

    // RFID reads — captured live while Step 2 is scanning.
    _tagSub?.cancel();
    _tagSub = RfidVendorChannel.tagReadStream().listen((read) {
      if (_step != _Step.encode || !_scanning || _busy) return;
      final epc = read.epcHex24;
      if (epc.length != 24) return;
      final rssi = read.rssi;
      final stronger =
          _nearestEpc == null || (rssi != null && (_nearestRssi == null || rssi > _nearestRssi!));
      if (stronger && mounted) {
        setState(() {
          _nearestEpc = epc.toUpperCase();
          if (rssi != null) _nearestRssi = rssi;
        });
        _scheduleNearestLookup();
      }
    }, onError: (_) {});

    // Trigger — commits the encode in Step 2.
    _triggerSub?.cancel();
    _triggerSub = RfidVendorChannel.hardwareTriggerStream().listen((event) {
      if (event == 'down' && _step == _Step.encode && !_busy) {
        unawaited(_runEncode());
      }
    }, onError: (_) {});
  }

  Future<void> _armBarcodeMode() async {
    await RfidVendorChannel.open2dBarcode();
    await RfidVendorChannel.scannerEnableTriggerRelay();
    await RfidVendorChannel.setZebraTriggerMode2D();
    // Let the native 2D scan beep be the (regular) feedback in Step 1.
    unawaited(_sounds.setTagBeepSuppressed(false));
  }

  Future<void> _armRfidMode() async {
    // Read settings before any await — no BuildContext across async gaps.
    _powerDbm = context.read<MobileSettingsRepository>().config.transferOutAntennaPower;
    await RfidVendorChannel.scannerDisableTriggerRelay();
    await RfidVendorChannel.close2dBarcode();
    await RfidVendorChannel.enableRfidFunctionMode();
    await RfidVendorChannel.setZebraTriggerModeRfid();
    // Silence the per-tag native beep during continuous scan — we only beep
    // on a verified write.
    unawaited(_sounds.setTagBeepSuppressed(true));
    await RfidVendorChannel.setAntennaPowerDbm(_powerDbm);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _rfid ??= context.read<RfidManager>();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _lookupTimer?.cancel();
    _searchCtrl.dispose();
    unawaited(_barcodeSub?.cancel());
    unawaited(_tagSub?.cancel());
    unawaited(_triggerSub?.cancel());
    unawaited(_rfid?.stopLocateScanning());
    _sounds.stopAll();
    unawaited(_sounds.setTagBeepSuppressed(false));
    // Restore RFID-trigger mode for the next screen.
    unawaited(RfidVendorChannel.scannerDisableTriggerRelay());
    unawaited(RfidVendorChannel.close2dBarcode());
    unawaited(RfidVendorChannel.enableRfidFunctionMode());
    unawaited(RfidVendorChannel.setZebraTriggerModeRfid());
    super.dispose();
  }

  // ── Step 1: SKU selection (barcode + manual) ────────────────────────────
  Future<void> _onBarcode(String code) async {
    _searchCtrl.text = code;
    _searchCtrl.selection = TextSelection.collapsed(offset: code.length);
    setState(() {
      _query = code;
      _searchLoading = true;
      _searchError = null;
      _results = [];
    });
    try {
      final rows = await _search(code);
      if (!mounted || _step != _Step.sku) return;
      final exact = rows.firstWhere(
        (r) => _digits(r['upc']) == _digits(code) || '${r['sku']}'.toUpperCase() == code.toUpperCase(),
        orElse: () => <String, dynamic>{},
      );
      if (exact.isNotEmpty) {
        await _pickSku(exact);
      } else if (rows.length == 1) {
        await _pickSku(rows.first);
      } else {
        setState(() {
          _results = rows;
          _searchLoading = false;
          if (rows.isEmpty) _searchError = 'No match for "$code" — type to search.';
        });
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _searchLoading = false;
        _searchError = 'Lookup failed: $e';
      });
    }
  }

  void _onSearchChanged(String value) {
    _debounce?.cancel();
    final trimmed = value.trim();
    if (trimmed.length < _minQueryLen) {
      if (_results.isNotEmpty || _query.isNotEmpty) {
        setState(() {
          _query = '';
          _results = [];
          _searchError = null;
        });
      }
      return;
    }
    _debounce = Timer(_searchDebounce, () async {
      if (!mounted || trimmed == _query) return;
      setState(() {
        _query = trimmed;
        _searchLoading = true;
        _searchError = null;
        _results = [];
      });
      try {
        final rows = await _search(trimmed);
        if (!mounted) return;
        setState(() {
          _results = rows;
          _searchLoading = false;
        });
      } catch (e) {
        if (!mounted) return;
        setState(() {
          _searchLoading = false;
          _searchError = 'Search failed: $e';
        });
      }
    });
  }

  Future<List<Map<String, dynamic>>> _search(String q) async {
    final res = await context.read<WmsApiClient>().fetchCatalogGrid(q: q, page: 1, limit: 100);
    return (res['rows'] as List?)?.whereType<Map<String, dynamic>>().toList() ?? [];
  }

  String _digits(dynamic v) => (v?.toString() ?? '').replaceAll(RegExp(r'[^0-9]'), '');

  Future<void> _pickSku(Map<String, dynamic> row) async {
    setState(() {
      _selectedSku = row;
      _results = [];
      _query = '';
      _searchCtrl.clear();
      _searchError = null;
    });
    // No success chime — the native 2D scan beep already fired in Step 1.
    await _goEncode();
  }

  Future<void> _goEncode() async {
    await _armRfidMode();
    if (!mounted) return;
    setState(() {
      _step = _Step.encode;
      _nearestEpc = null;
      _nearestRssi = null;
      _nearestInfo = null;
      _infoEpc = null;
      _newEpc = null;
      _errMsg = null;
      _statusMsg = 'Bring a tag close, then pull the trigger to encode.';
    });
    await _startScan();
  }

  Future<void> _startScan() async {
    if (_scanning) return;
    try {
      await _rfid?.startLocateScanning();
    } catch (_) {/* simulated reads still arrive via the stream */}
    if (!mounted) return;
    setState(() => _scanning = true);
  }

  Future<void> _stopScan() async {
    if (!_scanning) return;
    try {
      await _rfid?.stopLocateScanning();
    } catch (_) {}
    if (!mounted) return;
    setState(() => _scanning = false);
  }

  Future<void> _goSku() async {
    await _stopScan();
    await _armBarcodeMode();
    if (!mounted) return;
    setState(() {
      _selectedSku = null;
      _nearestEpc = null;
      _newEpc = null;
      _errMsg = null;
      _step = _Step.sku;
      _statusMsg = 'Pull the trigger to scan a barcode — or type to search.';
    });
  }

  // Decode the live nearest EPC against the tenant formula (debounced) so we
  // can show its SKU/description under the EPC when it passes the formula.
  void _scheduleNearestLookup() {
    final epc = _nearestEpc;
    if (epc == null || epc == _infoEpc) return;
    _lookupTimer?.cancel();
    _lookupTimer = Timer(const Duration(milliseconds: 350), () async {
      if (!mounted || _step != _Step.encode || _nearestEpc != epc) return;
      try {
        final rows = await context.read<WmsApiClient>().lookupEpcs([epc]);
        if (!mounted || _nearestEpc != epc) return;
        setState(() {
          _infoEpc = epc;
          _nearestInfo = rows.isNotEmpty ? rows.first : null;
        });
      } catch (_) {/* best-effort */}
    });
  }

  Future<void> _saveDoneStatus() async {
    final epc = _newEpc;
    if (epc == null || _statusSaved || _savingStatus) return;
    final api = context.read<WmsApiClient>();
    setState(() => _savingStatus = true);
    try {
      await api.postBulkStatus(epcs: [epc], targetStatus: _doneStatus);
      if (!mounted) return;
      setState(() {
        _statusSaved = true;
        _savingStatus = false;
      });
      _sounds.play(ScanCue.success);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _savingStatus = false;
        _errMsg = 'Status save failed: $e';
      });
      _sounds.play(ScanCue.error);
    }
  }

  // ── Step 2: commit = write + verify ─────────────────────────────────────
  void _fail(String msg) {
    if (!mounted) return;
    setState(() {
      _busy = false;
      _step = _Step.error;
      _errMsg = msg;
    });
  }

  Future<void> _runEncode() async {
    final sku = _selectedSku;
    if (sku == null || _busy) return;
    final oldEpc = _nearestEpc;
    if (oldEpc == null) {
      _sounds.play(ScanCue.error);
      setState(() => _statusMsg = 'No tag in range — bring it closer or raise the power, then pull again.');
      return;
    }
    final customSku = sku['sku']?.toString() ?? '';
    if (customSku.isEmpty) {
      _fail('Selected SKU is missing its code.');
      return;
    }
    final api = context.read<WmsApiClient>();
    setState(() {
      _busy = true;
      _errMsg = null;
      _newEpc = null;
      _statusMsg = 'Minting EPC + writing chip + verifying…';
    });
    _sounds.play(ScanCue.start);
    await _stopScan(); // release the radio for the chip write

    Map<String, dynamic> resolved;
    try {
      resolved = await api.postEncodeResolveAndClaim(customSku: customSku, oldEpc: oldEpc);
    } on WmsApiException catch (e) {
      _fail(e.statusCode == 404 ? 'SKU not in catalog.' : 'Encode-claim failed (HTTP ${e.statusCode}).');
      return;
    } catch (_) {
      _fail('Encode-claim failed (network).');
      return;
    }

    final newEpc = (resolved['epc'] as String?)?.toUpperCase() ?? '';
    final customSkuId = resolved['customSkuId']?.toString() ?? '';
    if (newEpc.length != 24 || customSkuId.isEmpty) {
      _fail('Bad encode response from server.');
      return;
    }
    if (!mounted) return;
    setState(() {
      _newEpc = newEpc;
      _doneStatus = 'unknown';
      _statusSaved = true;
      _savingStatus = false;
    });

    bool written = false;
    try {
      written = await RfidVendorChannel.writeEpcTag(targetEpc: oldEpc, newEpc: newEpc);
    } catch (_) {
      written = false;
    }
    if (!written) {
      _sounds.play(ScanCue.error);
      _fail('Chip write/verify failed — tag NOT encoded. Re-present the tag and pull again.');
      return;
    }
    try {
      // promoteNew:false → new EPC stays 'unknown'; the operator picks the
      // final status from the post-encode dropdown. Old EPC is deleted.
      await api.postEncodeFinalize(newEpc: newEpc, oldEpc: oldEpc, promoteNew: false);
    } catch (_) {/* chip written; finalize is best-effort */}
    _sounds.play(ScanCue.success);

    // Step 3 — print the companion non-RFID label.
    if (!mounted) return;
    setState(() {
      _step = _Step.printing;
      _statusMsg = 'Verified ✓ — printing label to .220…';
    });
    String? printErr;
    try {
      final label = await api.getNonRfidLabel(customSkuId: customSkuId);
      final zpl = label['zpl']?.toString() ?? '';
      final host = label['printer_host']?.toString() ?? '192.168.1.220';
      final port = (label['printer_port'] as num?)?.toInt() ?? 9100;
      final uri = label['printer_uri']?.toString() ?? 'PSTPRNT';
      if (zpl.isEmpty) {
        printErr = 'No label ZPL returned.';
      } else {
        printErr = await LanZplPrinter.send(host: host, port: port, uri: uri, zpl: zpl);
      }
    } catch (e) {
      printErr = 'Label fetch failed: $e';
    }
    if (!mounted) return;
    setState(() {
      _busy = false;
      _step = _Step.done;
      if (printErr != null) {
        _errMsg = 'Encoded ✓ but print failed: $printErr';
        _statusMsg = 'Tag $newEpc encoded. Label NOT printed — fix the .220 and reprint.';
      } else {
        _errMsg = null;
        _statusMsg = 'Encoded ✓ and label printed.';
      }
    });
  }

  // ── render ──────────────────────────────────────────────────────────────
  @override
  Widget build(BuildContext context) {
    return CarbonScaffold(
      pageTitle: 'ENCODE & PRINT',
      body: SafeArea(
        child: Padding(
          padding: EdgeInsets.all(14.w),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _stepper(),
              SizedBox(height: 12.h),
              if (_selectedSku != null) ...[
                _selectedSkuCard(),
                SizedBox(height: 10.h),
              ],
              Expanded(child: _step == _Step.sku ? _skuPane() : _flowPane()),
              // Antenna power — only meaningful in the RFID (encode) steps.
              if (_step != _Step.sku) ...[
                SizedBox(height: 8.h),
                const RfidPowerSlider(),
              ],
              SizedBox(height: 10.h),
              _primaryButton(),
            ],
          ),
        ),
      ),
    );
  }

  Widget _stepper() {
    const order = [_Step.sku, _Step.encode, _Step.printing];
    const labels = ['1. SKU', '2. Encode', '3. Print'];
    final curIdx = _step == _Step.error
        ? 1
        : _step == _Step.done
            ? 2
            : order.indexOf(_step);
    return Row(
      children: List.generate(3, (i) {
        final active = i == curIdx && _step != _Step.done;
        final done = i < curIdx || (_step == _Step.done && i <= 2);
        final isErr = _step == _Step.error && i == 1;
        final color = isErr
            ? _danger
            : active
                ? AppColors.primary
                : done
                    ? AppColors.success
                    : AppColors.border;
        return Expanded(
          child: Container(
            margin: EdgeInsets.symmetric(horizontal: 3.w),
            padding: EdgeInsets.symmetric(vertical: 7.h),
            decoration: BoxDecoration(
              color: AppColors.surface,
              border: Border.all(color: color, width: active || isErr ? 2 : 1),
            ),
            child: Text(
              '${labels[i]}${done ? ' ✓' : ''}',
              textAlign: TextAlign.center,
              style: GoogleFonts.manrope(
                fontSize: 11.sp,
                fontWeight: active ? FontWeight.w700 : FontWeight.w500,
                color: active || isErr ? color : AppColors.textMuted,
              ),
            ),
          ),
        );
      }),
    );
  }

  Widget _skuPane() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TextField(
          controller: _searchCtrl,
          onChanged: _onSearchChanged,
          style: GoogleFonts.spaceGrotesk(fontSize: 14.sp, color: AppColors.textMain),
          decoration: const InputDecoration(
            hintText: 'Scan a barcode (trigger) — or type SKU / UPC / name…',
            prefixIcon: Icon(Icons.qr_code_scanner, color: AppColors.textMuted),
            filled: true,
            fillColor: AppColors.surface,
            border: OutlineInputBorder(borderSide: BorderSide(color: AppColors.border), borderRadius: BorderRadius.zero),
            enabledBorder: OutlineInputBorder(borderSide: BorderSide(color: AppColors.border), borderRadius: BorderRadius.zero),
            focusedBorder: OutlineInputBorder(borderSide: BorderSide(color: AppColors.primary, width: 2), borderRadius: BorderRadius.zero),
          ),
        ),
        SizedBox(height: 10.h),
        Expanded(child: _skuResults()),
      ],
    );
  }

  Widget _skuResults() {
    if (_searchLoading) {
      return const Center(child: CircularProgressIndicator(color: AppColors.primary));
    }
    if (_searchError != null) {
      return Center(child: Text(_searchError!, style: GoogleFonts.manrope(color: _danger, fontSize: 12.sp)));
    }
    if (_results.isEmpty) {
      return Center(
        child: Text('Pull the trigger to scan a barcode,\nor type above to search.',
            textAlign: TextAlign.center,
            style: GoogleFonts.manrope(color: AppColors.textMuted, fontSize: 12.sp)),
      );
    }
    return ListView.builder(
      itemCount: _results.length,
      itemBuilder: (_, i) {
        final r = _results[i];
        return CatalogRowCard(row: r, showQty: false, onQtyTap: () {}, onTap: () => _pickSku(r));
      },
    );
  }

  Widget _selectedSkuCard() {
    final s = _selectedSku!;
    final desc = [s['name'], s['color'], s['size']]
        .map((e) => e?.toString() ?? '')
        .where((e) => e.trim().isNotEmpty)
        .join(' · ');
    return Container(
      padding: EdgeInsets.all(10.w),
      decoration: BoxDecoration(color: AppColors.surface, border: Border.all(color: AppColors.primary, width: 2)),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('${s['sku'] ?? ''}',
                    style: GoogleFonts.spaceGrotesk(fontSize: 14.sp, fontWeight: FontWeight.w700, color: AppColors.textMain)),
                if (desc.isNotEmpty)
                  Text(desc, style: GoogleFonts.manrope(fontSize: 11.sp, color: AppColors.textMuted)),
              ],
            ),
          ),
          if (!_busy && _step != _Step.printing)
            TextButton(
              onPressed: () => _goSku(),
              child: Text('Change', style: GoogleFonts.manrope(fontSize: 12.sp, color: AppColors.primary, fontWeight: FontWeight.w600)),
            ),
        ],
      ),
    );
  }

  Widget _flowPane() {
    final showEpc = _newEpc ?? _nearestEpc;
    final epcLabel = _newEpc != null ? 'new EPC' : (_scanning ? 'nearest tag (live)' : 'tag');
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SizedBox(height: 6.h),
        Container(
          padding: EdgeInsets.all(12.w),
          decoration: BoxDecoration(color: AppColors.surface, border: Border.all(color: AppColors.border)),
          child: Column(
            children: [
              Text(epcLabel, style: GoogleFonts.manrope(fontSize: 11.sp, color: AppColors.textMuted)),
              SizedBox(height: 4.h),
              Text(showEpc ?? '—',
                  textAlign: TextAlign.center,
                  style: GoogleFonts.spaceGrotesk(
                    fontSize: 13.sp,
                    fontWeight: FontWeight.w700,
                    color: showEpc == null ? AppColors.textMuted : AppColors.primary,
                  )),
              if (_newEpc == null && _nearestRssi != null)
                Text('$_nearestRssi dBm', style: GoogleFonts.spaceGrotesk(fontSize: 11.sp, color: AppColors.textMuted)),
              _decodedInfo(),
            ],
          ),
        ),
        _doneStatusTray(),
        const Spacer(),
        if (_busy) const Center(child: CircularProgressIndicator(color: AppColors.primary)),
        SizedBox(height: 12.h),
        _statusLine(),
        const Spacer(),
      ],
    );
  }

  /// Decoded SKU/description for the live nearest tag, shown under the EPC when
  /// it passes the tenant formula.
  Widget _decodedInfo() {
    final info = _nearestInfo;
    if (_newEpc != null || info == null) return const SizedBox.shrink();
    if (info['valid'] != true) {
      return Padding(
        padding: EdgeInsets.only(top: 6.h),
        child: Text('fails formula — not a Carbon tag',
            style: GoogleFonts.manrope(fontSize: 11.sp, color: AppColors.textMuted)),
      );
    }
    final sku = info['sku']?.toString() ?? '';
    final desc = [info['productName'], info['color'], info['size']]
        .map((e) => e?.toString() ?? '')
        .where((e) => e.trim().isNotEmpty)
        .join(' · ');
    final status = info['status']?.toString() ?? '';
    return Padding(
      padding: EdgeInsets.only(top: 6.h),
      child: Column(
        children: [
          if (sku.isNotEmpty)
            Text(sku,
                textAlign: TextAlign.center,
                style: GoogleFonts.spaceGrotesk(fontSize: 13.sp, fontWeight: FontWeight.w700, color: AppColors.textMain)),
          if (desc.isNotEmpty)
            Text(desc,
                textAlign: TextAlign.center,
                style: GoogleFonts.manrope(fontSize: 11.sp, color: AppColors.textMuted)),
          if (status.isNotEmpty)
            Text('status: $status', style: GoogleFonts.manrope(fontSize: 10.sp, color: AppColors.textMuted)),
        ],
      ),
    );
  }

  /// Post-encode status picker (UNKNOWN / LIVE / TAG KILLED) — the new EPC
  /// stays 'unknown' until the operator saves a choice (same as the Encode
  /// screen). Only shown once a tag is encoded.
  Widget _doneStatusTray() {
    if (_step != _Step.done || _newEpc == null) return const SizedBox.shrink();
    return Container(
      margin: EdgeInsets.only(top: 10.h),
      padding: EdgeInsets.symmetric(horizontal: 12.w, vertical: 6.h),
      decoration: BoxDecoration(color: AppColors.surface, border: Border.all(color: AppColors.border)),
      child: Row(
        children: [
          Text('STATUS', style: GoogleFonts.manrope(fontSize: 11.sp, fontWeight: FontWeight.w700, color: AppColors.textMuted)),
          SizedBox(width: 12.w),
          Expanded(
            child: DropdownButtonHideUnderline(
              child: DropdownButton<String>(
                isExpanded: true,
                isDense: true,
                value: _doneStatus,
                items: _statusOptions
                    .map((o) => DropdownMenuItem<String>(
                          value: o.$1,
                          child: Text(o.$2,
                              style: GoogleFonts.spaceGrotesk(fontSize: 14.sp, fontWeight: FontWeight.w800, color: AppColors.textMain)),
                        ))
                    .toList(),
                onChanged: _savingStatus
                    ? null
                    : (v) {
                        if (v == null) return;
                        setState(() {
                          _doneStatus = v;
                          _statusSaved = false;
                        });
                      },
              ),
            ),
          ),
          SizedBox(width: 8.w),
          TextButton(
            onPressed: (_statusSaved || _savingStatus) ? null : () => _saveDoneStatus(),
            child: Text(
              _savingStatus ? 'Saving…' : (_statusSaved ? 'Saved' : 'Save'),
              style: GoogleFonts.manrope(
                fontSize: 13.sp,
                fontWeight: FontWeight.w700,
                color: (_statusSaved || _savingStatus) ? AppColors.textMuted : AppColors.primary,
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _statusLine() {
    final isErr = _step == _Step.error || (_errMsg != null);
    return Container(
      width: double.infinity,
      padding: EdgeInsets.all(10.w),
      decoration: BoxDecoration(
        color: isErr ? _danger.withValues(alpha: 0.08) : AppColors.surface,
        border: Border.all(color: isErr ? _danger : AppColors.border),
      ),
      child: Text(
        _errMsg ?? _statusMsg,
        style: GoogleFonts.manrope(
          fontSize: 12.sp,
          color: isErr ? _danger : (_step == _Step.done ? AppColors.primary : AppColors.textMain),
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }

  Widget _primaryButton() {
    switch (_step) {
      case _Step.sku:
        return const SizedBox.shrink();
      case _Step.encode:
        return _bigButton(
          label: _busy ? 'Working…' : 'Encode & verify (or pull trigger)',
          onTap: _busy ? null : () => _runEncode(),
          icon: Icons.sensors,
        );
      case _Step.printing:
        return _bigButton(label: 'Printing…', onTap: null, icon: Icons.print);
      case _Step.done:
        return Row(
          children: [
            Expanded(child: _bigButton(label: 'Same SKU →', onTap: () => _goEncode(), icon: Icons.refresh)),
            SizedBox(width: 10.w),
            Expanded(child: _bigButton(label: 'New item', onTap: () => _goSku(), icon: Icons.qr_code_scanner, outlined: true)),
          ],
        );
      case _Step.error:
        return _bigButton(label: 'Try again', onTap: () => _goEncode(), icon: Icons.refresh);
    }
  }

  Widget _bigButton({required String label, VoidCallback? onTap, required IconData icon, bool outlined = false}) {
    final enabled = onTap != null;
    return SizedBox(
      height: 54.h,
      child: outlined
          ? OutlinedButton.icon(
              onPressed: onTap,
              icon: Icon(icon, size: 20.sp, color: AppColors.primary),
              label: Text(label, style: GoogleFonts.manrope(fontSize: 14.sp, fontWeight: FontWeight.w700, color: AppColors.primary)),
              style: OutlinedButton.styleFrom(
                shape: const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
                side: const BorderSide(color: AppColors.primary),
              ),
            )
          : ElevatedButton.icon(
              onPressed: onTap,
              icon: Icon(icon, size: 20.sp),
              label: Text(label, style: GoogleFonts.manrope(fontSize: 15.sp, fontWeight: FontWeight.w700)),
              style: ElevatedButton.styleFrom(
                backgroundColor: enabled ? AppColors.primary : AppColors.border,
                foregroundColor: Colors.white,
                shape: const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
                elevation: enabled ? 2 : 0,
              ),
            ),
    );
  }
}
