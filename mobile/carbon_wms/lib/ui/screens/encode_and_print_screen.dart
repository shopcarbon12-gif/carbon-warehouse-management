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

/// Handheld Encode & Print — the mobile twin of the web Tags & Labels
/// "Encode & Print" page. One tag at a time:
///
///   1. Pick a target SKU (catalog search).
///   2. Present a tag + pull the trigger → the handheld captures the closest
///      EPC (strongest RSSI) as the tag to encode.
///   3. Encode & Print →
///        • POST /api/rfid/encode-resolve-and-claim → mint a fresh EPC for the
///          chosen SKU, rotating the scanned tag.
///        • RfidVendorChannel.writeEpcTag → write the chip AND re-read-verify
///          (this IS the "confirm" step — returns true only when the chip
///          reads back the new EPC).
///        • POST /api/rfid/encode-finalize → flip the items row to in-stock.
///        • GET /api/rfid/nonrfid-label → non-RFID price-label ZPL, sent to the
///          Zebra .220 over raw TCP 9100 (LanZplPrinter).
///   4. Complete → "Encode another?" keeps the SKU and clears the tag.
class EncodeAndPrintScreen extends StatefulWidget {
  const EncodeAndPrintScreen({super.key});

  static const String routeName = '/encode-and-print';

  @override
  State<EncodeAndPrintScreen> createState() => _EncodeAndPrintScreenState();
}

enum _Step { scan, encoding, printing, done, error }

const Color _danger = Color(0xFFDC2626);

class _EncodeAndPrintScreenState extends State<EncodeAndPrintScreen> {
  static const Duration _searchDebounce = Duration(milliseconds: 300);
  static const int _minQueryLen = 2;

  RfidManager? _rfid;
  StreamSubscription<RfidTagRead>? _directTagSub;
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

  // scan + flow
  bool _running = false;
  bool _busy = false;
  String? _scannedEpc;
  int? _scannedRssi;
  String? _newEpc;
  _Step _step = _Step.scan;
  String _statusMsg = 'Pick a SKU, then present a tag and pull the trigger.';
  String? _errMsg;
  int _powerDbm = 30;

  @override
  void initState() {
    super.initState();
    unawaited(_sounds.setTagBeepSuppressed(true));
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted) return;
      context.read<RfidManager>().scanContext = 'RE_ENCODE';
      _powerDbm = context.read<MobileSettingsRepository>().config.transferOutAntennaPower;
      unawaited(_sounds.init());
      await _ensureScannerReady();
      if (mounted) setState(() {});
    });
  }

  Future<void> _ensureScannerReady() async {
    await RfidVendorChannel.scannerDisableTriggerRelay();
    await RfidVendorChannel.close2dBarcode();
    await RfidVendorChannel.enableRfidFunctionMode();
    await RfidVendorChannel.setZebraTriggerModeRfid();
    await RfidVendorChannel.setAntennaPowerDbm(_powerDbm);

    await _directTagSub?.cancel();
    _directTagSub = RfidVendorChannel.tagReadStream().listen(_onTagRead, onError: (_) {});

    await _triggerSub?.cancel();
    _triggerSub = RfidVendorChannel.hardwareTriggerStream().listen((event) {
      if (event == 'down') unawaited(_toggleScan());
    }, onError: (_) {});
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
    unawaited(_directTagSub?.cancel());
    unawaited(_triggerSub?.cancel());
    unawaited(_rfid?.stopLocateScanning());
    _sounds.stopAll();
    unawaited(_sounds.setTagBeepSuppressed(false));
    super.dispose();
  }

  // ── search ──────────────────────────────────────────────────────────────
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
    _debounce = Timer(_searchDebounce, () {
      if (!mounted || trimmed == _query) return;
      setState(() => _query = trimmed);
      unawaited(_runSearch());
    });
  }

  Future<void> _runSearch() async {
    if (_query.isEmpty) return;
    setState(() {
      _searchLoading = true;
      _searchError = null;
      _results = [];
    });
    try {
      final res = await context.read<WmsApiClient>().fetchCatalogGrid(q: _query, page: 1, limit: 100);
      if (!mounted) return;
      final rows = (res['rows'] as List?)?.whereType<Map<String, dynamic>>().toList() ?? [];
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
  }

  void _pickSku(Map<String, dynamic> row) {
    setState(() {
      _selectedSku = row;
      _results = [];
      _query = '';
      _searchCtrl.clear();
      _errMsg = null;
    });
  }

  void _clearSku() {
    setState(() => _selectedSku = null);
  }

  // ── scan ────────────────────────────────────────────────────────────────
  Future<void> _toggleScan() async {
    if (_busy) return;
    if (_running) {
      await _stopScan();
    } else {
      await _startScan();
    }
  }

  Future<void> _startScan() async {
    if (_running || _busy) return;
    final m = _rfid;
    if (m == null) return;
    _powerDbm = context.read<MobileSettingsRepository>().config.transferOutAntennaPower;
    await RfidVendorChannel.setAntennaPowerDbm(_powerDbm);
    try {
      await m.startLocateScanning();
    } catch (_) {/* simulated reads still arrive via the stream */}
    if (!mounted) return;
    setState(() => _running = true);
    _sounds.play(ScanCue.start);
  }

  Future<void> _stopScan() async {
    await _rfid?.stopLocateScanning();
    if (!mounted) return;
    setState(() => _running = false);
    _sounds.play(ScanCue.stop);
  }

  void _onTagRead(RfidTagRead read) {
    if (!_running || _busy) return;
    final epc = read.epcHex24;
    if (epc.length != 24) return;
    final rssi = read.rssi;
    // Keep the strongest (closest) tag as the encode target.
    final stronger =
        _scannedEpc == null || (rssi != null && (_scannedRssi == null || rssi > _scannedRssi!));
    if (stronger) {
      setState(() {
        _scannedEpc = epc.toUpperCase();
        if (rssi != null) _scannedRssi = rssi;
      });
    }
  }

  // ── encode + print ────────────────────────────────────────────────────
  void _fail(String msg) {
    if (!mounted) return;
    setState(() {
      _busy = false;
      _step = _Step.error;
      _errMsg = msg;
    });
  }

  Future<void> _encodeAndPrint() async {
    final sku = _selectedSku;
    final oldEpc = _scannedEpc;
    if (sku == null || oldEpc == null || _busy) return;
    final customSku = sku['sku']?.toString() ?? '';
    if (customSku.isEmpty) {
      _fail('Selected SKU is missing its code.');
      return;
    }
    // Capture the client before any await — no BuildContext across async gaps.
    final api = context.read<WmsApiClient>();
    if (_running) await _stopScan(); // release the radio for the chip write
    if (!mounted) return;
    setState(() {
      _busy = true;
      _step = _Step.encoding;
      _errMsg = null;
      _newEpc = null;
      _statusMsg = 'Minting a fresh EPC for $customSku…';
    });

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
      _statusMsg = 'Writing chip + verifying re-read…';
    });

    bool written = false;
    try {
      written = await RfidVendorChannel.writeEpcTag(targetEpc: oldEpc, newEpc: newEpc);
    } catch (_) {
      written = false;
    }
    if (!written) {
      _sounds.play(ScanCue.error);
      _fail('Chip write/verify failed — tag NOT encoded. Re-present the tag and try again.');
      return;
    }

    // Chip confirmed → flip items row to in-stock (best-effort).
    try {
      await api.postEncodeFinalize(newEpc: newEpc, oldEpc: oldEpc);
    } catch (_) {/* chip is written; finalize is best-effort */}
    _sounds.play(ScanCue.success);

    // Print the companion non-RFID price label to the Zebra .220.
    if (!mounted) return;
    setState(() {
      _step = _Step.printing;
      _statusMsg = 'Printing non-RFID label to .220…';
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
        _statusMsg = 'Tag $newEpc encoded. Label NOT printed — fix the printer and reprint.';
      } else {
        _errMsg = null;
        _statusMsg = 'Encoded ✓ and label printed.';
      }
    });
  }

  void _reset() {
    setState(() {
      _scannedEpc = null;
      _scannedRssi = null;
      _newEpc = null;
      _errMsg = null;
      _step = _Step.scan;
      _statusMsg = _selectedSku == null
          ? 'Pick a SKU, then present a tag and pull the trigger.'
          : 'Present the next tag and pull the trigger.';
    });
  }

  // ── render ──────────────────────────────────────────────────────────────
  bool get _canEncode =>
      !_busy && _step == _Step.scan && _selectedSku != null && _scannedEpc != null;

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
              Expanded(child: _step == _Step.scan ? _scanPane() : _flowPane()),
              SizedBox(height: 10.h),
              _primaryButton(),
            ],
          ),
        ),
      ),
    );
  }

  Widget _stepper() {
    const order = [_Step.scan, _Step.encoding, _Step.printing, _Step.done];
    final labels = ['Scan', 'Encode', 'Print', 'Done'];
    final curIdx = _step == _Step.error ? 1 : order.indexOf(_step);
    return Row(
      children: List.generate(order.length, (i) {
        final active = i == curIdx;
        final done = i < curIdx;
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
              '${i + 1}. ${labels[i]}${done ? ' ✓' : ''}',
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

  Widget _scanPane() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // selected SKU or search
        if (_selectedSku != null) _selectedSkuCard() else _searchField(),
        SizedBox(height: 10.h),
        if (_selectedSku == null) Expanded(child: _searchResults()) else _tagSection(),
      ],
    );
  }

  Widget _searchField() {
    return TextField(
      controller: _searchCtrl,
      onChanged: _onSearchChanged,
      style: GoogleFonts.spaceGrotesk(fontSize: 14.sp, color: AppColors.textMain),
      decoration: const InputDecoration(
        hintText: 'Search SKU, UPC, name, system id…',
        prefixIcon: Icon(Icons.search, color: AppColors.textMuted),
        filled: true,
        fillColor: AppColors.surface,
        border: OutlineInputBorder(borderSide: BorderSide(color: AppColors.border), borderRadius: BorderRadius.zero),
        enabledBorder: OutlineInputBorder(borderSide: BorderSide(color: AppColors.border), borderRadius: BorderRadius.zero),
        focusedBorder: OutlineInputBorder(borderSide: BorderSide(color: AppColors.primary, width: 2), borderRadius: BorderRadius.zero),
      ),
    );
  }

  Widget _searchResults() {
    if (_searchLoading) {
      return const Center(child: CircularProgressIndicator(color: AppColors.primary));
    }
    if (_searchError != null) {
      return Center(child: Text(_searchError!, style: GoogleFonts.manrope(color: _danger, fontSize: 12.sp)));
    }
    if (_results.isEmpty) {
      return Center(
        child: Text('Search and tap a SKU to encode to.',
            style: GoogleFonts.manrope(color: AppColors.textMuted, fontSize: 12.sp)),
      );
    }
    return ListView.builder(
      itemCount: _results.length,
      itemBuilder: (_, i) {
        final r = _results[i];
        return CatalogRowCard(
          row: r,
          showQty: false,
          onQtyTap: () {},
          onTap: () => _pickSku(r),
        );
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
      decoration: BoxDecoration(
        color: AppColors.surface,
        border: Border.all(color: AppColors.primary, width: 2),
      ),
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
          if (!_busy)
            TextButton(
              onPressed: _clearSku,
              child: Text('Change', style: GoogleFonts.manrope(fontSize: 12.sp, color: AppColors.primary, fontWeight: FontWeight.w600)),
            ),
        ],
      ),
    );
  }

  Widget _tagSection() {
    return Expanded(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(height: 6.h),
          Container(
            padding: EdgeInsets.all(14.w),
            decoration: BoxDecoration(color: AppColors.surface, border: Border.all(color: AppColors.border)),
            child: Column(
              children: [
                Text(_running ? 'Reading… present ONE tag' : 'Tag to encode',
                    style: GoogleFonts.manrope(fontSize: 11.sp, color: AppColors.textMuted)),
                SizedBox(height: 6.h),
                Text(
                  _scannedEpc ?? '—',
                  textAlign: TextAlign.center,
                  style: GoogleFonts.spaceGrotesk(
                    fontSize: 13.sp,
                    fontWeight: FontWeight.w700,
                    color: _scannedEpc == null ? AppColors.textMuted : AppColors.primary,
                  ),
                ),
                if (_scannedRssi != null)
                  Text('$_scannedRssi dBm', style: GoogleFonts.spaceGrotesk(fontSize: 11.sp, color: AppColors.textMuted)),
              ],
            ),
          ),
          SizedBox(height: 10.h),
          OutlinedButton.icon(
            onPressed: _busy ? null : () => _toggleScan(),
            icon: Icon(_running ? Icons.stop : Icons.sensors, color: _running ? _danger : AppColors.primary),
            label: Text(
              _running ? 'Stop scanning' : (_scannedEpc == null ? 'Scan tag (or pull trigger)' : 'Re-scan'),
              style: GoogleFonts.manrope(fontSize: 13.sp, fontWeight: FontWeight.w600),
            ),
            style: OutlinedButton.styleFrom(
              padding: EdgeInsets.symmetric(vertical: 12.h),
              shape: const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
              side: BorderSide(color: _running ? _danger : AppColors.border),
            ),
          ),
          const Spacer(),
          _statusLine(),
        ],
      ),
    );
  }

  Widget _flowPane() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SizedBox(height: 10.h),
        if (_newEpc != null)
          Container(
            padding: EdgeInsets.all(12.w),
            decoration: BoxDecoration(color: AppColors.surface, border: Border.all(color: AppColors.border)),
            child: Column(
              children: [
                Text('new EPC', style: GoogleFonts.manrope(fontSize: 11.sp, color: AppColors.textMuted)),
                SizedBox(height: 4.h),
                Text(_newEpc!,
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
    if (_step == _Step.done || _step == _Step.error) {
      return _bigButton(
        label: _step == _Step.error ? 'Try again' : 'Encode another →',
        color: AppColors.primary,
        onTap: _reset,
        icon: Icons.refresh,
      );
    }
    return _bigButton(
      label: 'Encode & Print',
      color: AppColors.primary,
      onTap: _canEncode ? () => _encodeAndPrint() : null,
      icon: Icons.print,
    );
  }

  Widget _bigButton({required String label, required Color color, VoidCallback? onTap, required IconData icon}) {
    final enabled = onTap != null;
    return SizedBox(
      height: 54.h,
      child: ElevatedButton.icon(
        onPressed: onTap,
        icon: Icon(icon, size: 20.sp),
        label: Text(label, style: GoogleFonts.manrope(fontSize: 15.sp, fontWeight: FontWeight.w700)),
        style: ElevatedButton.styleFrom(
          backgroundColor: enabled ? color : AppColors.border,
          foregroundColor: Colors.white,
          shape: const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
          elevation: enabled ? 2 : 0,
        ),
      ),
    );
  }
}
