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

/// Handheld Encode & Print — 3-step commissioning flow:
///
///   Step 1 (SKU):   pull the trigger → 2D imager fires → the scanned barcode
///                   (UPC/SKU) resolves the target SKU. Manual type-to-search
///                   is always available as a fallback. Picking a SKU → Step 2.
///   Step 2 (Encode): one trigger pull = read the presented tag + write the
///                   fresh EPC + re-read-verify (RfidVendorChannel.writeEpcTag
///                   verifies internally — it returns true only when the chip
///                   reads back the new EPC).
///   Step 3 (Print): only when the write verified, print the companion
///                   non-RFID price label to the Zebra .220 (192.168.1.220)
///                   over raw TCP 9100.
///
/// The scanner is flipped between 2D-barcode mode (Step 1) and RFID mode
/// (Step 2) as the operator advances.
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
  static const Duration _captureWindow = Duration(milliseconds: 1400);

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
  int _powerDbm = 30;

  // tag capture (Step 2)
  bool _capturing = false;
  String? _capturedEpc;
  int? _capturedRssi;

  String? _newEpc;
  String _statusMsg = 'Pull the trigger to scan a barcode — or type to search.';
  String? _errMsg;

  @override
  void initState() {
    super.initState();
    unawaited(_sounds.setTagBeepSuppressed(true));
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
    // Barcode (2D) — only acted on while picking a SKU.
    _barcodeSub?.cancel();
    _barcodeSub = RfidVendorChannel.hardwareBarcodeStream().listen((raw) {
      if (!mounted || _step != _Step.sku) return;
      final code = raw.trim();
      if (code.isEmpty) return;
      // Ignore EPC-shaped reads — those aren't product barcodes.
      if (RegExp(r'^[0-9A-F]{24}$').hasMatch(code.toUpperCase())) return;
      _onBarcode(code);
    }, onError: (_) {});

    // RFID reads — only captured during the Step-2 read window.
    _tagSub?.cancel();
    _tagSub = RfidVendorChannel.tagReadStream().listen((read) {
      if (!_capturing) return;
      final epc = read.epcHex24;
      if (epc.length != 24) return;
      final rssi = read.rssi;
      final stronger =
          _capturedEpc == null || (rssi != null && (_capturedRssi == null || rssi > _capturedRssi!));
      if (stronger) {
        _capturedEpc = epc.toUpperCase();
        if (rssi != null) _capturedRssi = rssi;
      }
    }, onError: (_) {});

    // Physical trigger — fires the encode pipeline in Step 2.
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
  }

  Future<void> _armRfidMode() async {
    await RfidVendorChannel.scannerDisableTriggerRelay();
    await RfidVendorChannel.close2dBarcode();
    await RfidVendorChannel.enableRfidFunctionMode();
    await RfidVendorChannel.setZebraTriggerModeRfid();
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
      // Auto-pick an exact UPC/SKU match, or the only result.
      final exact = rows.firstWhere(
        (r) => _digits(r['upc']) == _digits(code) || '${r['sku']}'.toUpperCase() == code.toUpperCase(),
        orElse: () => <String, dynamic>{},
      );
      if (exact.isNotEmpty) {
        _pickSku(exact);
      } else if (rows.length == 1) {
        _pickSku(rows.first);
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
    _sounds.play(ScanCue.success);
    await _goEncode();
  }

  Future<void> _goEncode() async {
    await _armRfidMode();
    if (!mounted) return;
    setState(() {
      _step = _Step.encode;
      _capturedEpc = null;
      _capturedRssi = null;
      _newEpc = null;
      _errMsg = null;
      _statusMsg = 'Present a tag and pull the trigger to encode + verify.';
    });
  }

  Future<void> _goSku() async {
    await _armBarcodeMode();
    if (!mounted) return;
    setState(() {
      _selectedSku = null;
      _capturedEpc = null;
      _newEpc = null;
      _errMsg = null;
      _step = _Step.sku;
      _statusMsg = 'Pull the trigger to scan a barcode — or type to search.';
    });
  }

  // ── Step 2: read + write + verify (one trigger) ─────────────────────────
  void _fail(String msg) {
    if (!mounted) return;
    setState(() {
      _busy = false;
      _step = _Step.error;
      _errMsg = msg;
    });
  }

  Future<String?> _captureTag() async {
    _capturedEpc = null;
    _capturedRssi = null;
    _capturing = true;
    try {
      await _rfid?.startLocateScanning();
    } catch (_) {/* simulated reads still arrive via the stream */}
    await Future<void>.delayed(_captureWindow);
    _capturing = false;
    try {
      await _rfid?.stopLocateScanning();
    } catch (_) {}
    return _capturedEpc;
  }

  Future<void> _runEncode() async {
    final sku = _selectedSku;
    if (sku == null || _busy) return;
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
      _statusMsg = 'Reading the tag…';
    });
    _sounds.play(ScanCue.start);

    final oldEpc = await _captureTag();
    if (!mounted) return;
    if (oldEpc == null) {
      _sounds.play(ScanCue.error);
      setState(() {
        _busy = false;
        _statusMsg = 'No tag read — present a tag and pull the trigger again.';
      });
      return;
    }
    setState(() => _statusMsg = 'Minting EPC + writing chip + verifying…');

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
    setState(() => _newEpc = newEpc);

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
      await api.postEncodeFinalize(newEpc: newEpc, oldEpc: oldEpc);
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
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SizedBox(height: 6.h),
        if (_capturedEpc != null || _newEpc != null)
          Container(
            padding: EdgeInsets.all(12.w),
            decoration: BoxDecoration(color: AppColors.surface, border: Border.all(color: AppColors.border)),
            child: Column(
              children: [
                Text(_newEpc != null ? 'new EPC' : 'tag read',
                    style: GoogleFonts.manrope(fontSize: 11.sp, color: AppColors.textMuted)),
                SizedBox(height: 4.h),
                Text(_newEpc ?? _capturedEpc ?? '—',
                    textAlign: TextAlign.center,
                    style: GoogleFonts.spaceGrotesk(fontSize: 13.sp, fontWeight: FontWeight.w700, color: AppColors.primary)),
              ],
            ),
          ),
        const Spacer(),
        if (_busy) const Center(child: CircularProgressIndicator(color: AppColors.primary)),
        SizedBox(height: 14.h),
        _statusLine(),
        const Spacer(),
      ],
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
            Expanded(
              child: _bigButton(label: 'Same SKU →', onTap: () => _goEncode(), icon: Icons.refresh),
            ),
            SizedBox(width: 10.w),
            Expanded(
              child: _bigButton(label: 'New item', onTap: () => _goSku(), icon: Icons.qr_code_scanner, outlined: true),
            ),
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
