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
import 'package:carbon_wms/services/mobile_settings_repository.dart';
import 'package:carbon_wms/services/scan_sounds.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/screens/inventory_catalog_screen.dart'
    show CatalogRowCard;
import 'package:carbon_wms/ui/screens/locate_tag_screen.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';
import 'package:carbon_wms/ui/widgets/rfid_power_slider.dart';

/// Handheld Encode flow — re-write any UHF tag's EPC with a Carbon-Jeans
/// SGTIN-96 EPC bound to a chosen catalog SKU.
///
///   Step 1 (PICK SKU)
///     • Search box + 2D-imager broadcast both feed the catalog query.
///     • Tap a row → SKU is locked in.
///
///   Step 2 (ENCODE — single-press)
///     • Operator pulls the trigger ONCE. The handheld reads whatever EPC
///       is in range, immediately POSTs encode-claim (server allocates the
///       next serial atomically and inserts the new items row), then
///       writes the returned 24-hex EPC to the chip via the SDK.
///     • Success → ScanCue.success, status panel with old/new EPC +
///       [TEST WITH GEIGER] button.
///     • Failure → ScanCue.error, red banner, no panel; trigger ready
///       again for the next attempt.
///
/// Power: bottom slider, defaults to 10 dBm on entry (close-range only,
/// so a stray rack-tag can't accidentally get rewritten).
class EncodeScreen extends StatefulWidget {
  const EncodeScreen({super.key});

  @override
  State<EncodeScreen> createState() => _EncodeScreenState();
}

class _EncodeScreenState extends State<EncodeScreen> {
  static const Duration _searchDebounce = Duration(milliseconds: 300);
  static const int _minQueryLen = 2;
  static const int _kReadWindowMs = 1500;

  final TextEditingController _searchCtrl = TextEditingController();
  Timer? _debounce;

  // ── search state
  String _query = '';
  bool _searchLoading = false;
  String? _searchError;
  List<Map<String, dynamic>> _searchResults = [];

  // ── selected SKU
  Map<String, dynamic>? _selectedSku;

  // ── encode state
  bool _encoding = false;
  String? _encodeError;
  _EncodeResult? _lastResult;

  // ── streams
  StreamSubscription<RfidTagRead>? _readsSub;
  StreamSubscription<String>? _barcodeSub;
  StreamSubscription<String>? _triggerSub;

  @override
  void initState() {
    super.initState();
    unawaited(ScanSounds.instance.init());
    _activateScanners();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      // Force the radio to 10 dBm on entry. Operator can drag the bottom
      // slider mid-session if they need more range.
      unawaited(
        context.read<MobileSettingsRepository>().setGlobalAntennaPower(10),
      );
      // Geiger-routed sink so reads land in `geigerTagReads` (no edge
      // ingest, no ghost filter) — this screen wants every raw read.
      context.read<RfidManager>().scanContext = 'GEIGER_FIND';
      _attachStreams();
    });
  }

  @override
  void dispose() {
    _debounce?.cancel();
    unawaited(_readsSub?.cancel());
    unawaited(_barcodeSub?.cancel());
    unawaited(_triggerSub?.cancel());
    unawaited(context.read<RfidManager>().stopLocateScanning());
    _searchCtrl.dispose();
    super.dispose();
  }

  // ── scanner mode ──────────────────────────────────────────────────────
  void _activateScanners() {
    // Both 2D imager and UHF stay armed:
    //   • 2D feeds the search box (Step 1)
    //   • UHF trigger fires the read+write (Step 2)
    unawaited(RfidVendorChannel.open2dBarcode());
    unawaited(RfidVendorChannel.enableRfidFunctionMode());
    unawaited(RfidVendorChannel.setZebraTriggerModeRfid());
  }

  void _attachStreams() {
    final rfid = context.read<RfidManager>();
    _readsSub = rfid.geigerTagReads.listen((_) {/* drained per-encode */});
    _barcodeSub = RfidVendorChannel.hardwareBarcodeStream().listen((raw) {
      if (!mounted) return;
      final code = raw.trim();
      if (code.isEmpty) return;
      // EPC-shaped barcode (24 hex) is ignored at search step — the trigger
      // half handles UHF reads. Anything else fills the search box.
      if (RegExp(r'^[0-9A-F]{24}$').hasMatch(code.toUpperCase())) return;
      _searchCtrl.text = code;
      _searchCtrl.selection =
          TextSelection.collapsed(offset: _searchCtrl.text.length);
      _onSearchChanged(code);
    }, onError: (_) {});
    _triggerSub = RfidVendorChannel.hardwareTriggerStream().listen((event) {
      if (!mounted) return;
      if (event != 'down') return;
      // Ignore trigger pulls until the operator has picked a SKU OR
      // before a previous encode finishes.
      if (_selectedSku == null || _encoding) return;
      unawaited(_runEncodeOnce());
    }, onError: (_) {});
  }

  // ── search ────────────────────────────────────────────────────────────
  void _onSearchChanged(String value) {
    _debounce?.cancel();
    final trimmed = value.trim();
    if (trimmed.length < _minQueryLen) {
      if (_searchResults.isNotEmpty || _query.isNotEmpty) {
        setState(() {
          _query = '';
          _searchResults = [];
          _searchError = null;
        });
      }
      return;
    }
    _debounce = Timer(_searchDebounce, () {
      if (!mounted) return;
      if (trimmed == _query) return;
      setState(() => _query = trimmed);
      unawaited(_runSearch());
    });
  }

  Future<void> _runSearch() async {
    if (_query.isEmpty) return;
    setState(() {
      _searchLoading = true;
      _searchError = null;
      _searchResults = [];
    });
    try {
      final api = context.read<WmsApiClient>();
      final res = await api.fetchCatalogGrid(q: _query, page: 1, limit: 100);
      if (!mounted) return;
      final rows = (res['rows'] as List?)
              ?.whereType<Map<String, dynamic>>()
              .toList() ??
          [];
      setState(() {
        _searchResults = rows;
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

  // ── pick SKU / clear SKU ──────────────────────────────────────────────
  void _selectSku(Map<String, dynamic> row) {
    setState(() {
      _selectedSku = row;
      _searchCtrl.clear();
      _query = '';
      _searchResults = [];
      _lastResult = null;
      _encodeError = null;
    });
  }

  void _changeSku() {
    setState(() {
      _selectedSku = null;
      _lastResult = null;
      _encodeError = null;
    });
  }

  // ── single-press read+write ───────────────────────────────────────────
  Future<void> _runEncodeOnce() async {
    final sku = _selectedSku;
    if (sku == null) return;
    final customSkuId = sku['custom_sku_id']?.toString() ?? '';
    if (customSkuId.isEmpty) {
      _failure('SKU is missing custom_sku_id');
      return;
    }
    // Capture every Provider lookup BEFORE any await so we never cross a
    // BuildContext across an async gap (the analyzer rule we keep tripping
    // on async work in long screens).
    final rfid = context.read<RfidManager>();
    final api = context.read<WmsApiClient>();
    setState(() {
      _encoding = true;
      _encodeError = null;
      // Keep the previous panel visible until the next result lands so
      // there's no flash-of-empty-screen between attempts.
    });

    // 1) read — start the inventory and grab the strongest read in a tight
    // window. We don't need many reads; the first valid EPC wins.
    String? oldEpc;
    final completer = Completer<String?>();
    final tempSub = rfid.geigerTagReads.listen((read) {
      final epc = read.epcHex24.toUpperCase();
      if (epc.isEmpty) return;
      if (!completer.isCompleted) completer.complete(epc);
    }, onError: (_) {
      if (!completer.isCompleted) completer.complete(null);
    });
    unawaited(rfid.startLocateScanning());
    try {
      oldEpc = await completer.future
          .timeout(const Duration(milliseconds: _kReadWindowMs), onTimeout: () => null);
    } finally {
      await tempSub.cancel();
      unawaited(rfid.stopLocateScanning());
    }
    if (oldEpc == null) {
      _failure('No tag detected — get closer and try again');
      return;
    }

    // 2) claim — server returns the new 24-hex + serial in one txn.
    Map<String, dynamic> claim;
    try {
      claim = await api.postEncodeClaim(
        customSkuId: customSkuId,
        oldEpc: oldEpc,
      );
    } catch (e) {
      _failure('Server: $e');
      return;
    }
    final newEpc = (claim['epc'] as String?)?.toUpperCase() ?? '';
    final serial = (claim['serial'] as num?)?.toInt() ?? 0;
    if (newEpc.length != 24) {
      _failure('Server returned invalid EPC');
      return;
    }

    // 3) write — native SDK call. Single-target by oldEpc so a stray rack
    // tag can't get hit. RFD8500 + Chainway both support EPC-match select.
    final ok = await RfidVendorChannel.writeEpcTag(
      targetEpc: oldEpc,
      newEpc: newEpc,
    );
    if (!ok) {
      // Roll back the WMS row so we don't leave a phantom item — best-
      // effort kill via a follow-up status flip. The new items row will
      // show up but immediately be killed; operator sees the error and
      // can retry, which produces a fresh serial on the next claim.
      _failure('Write rejected by chip');
      return;
    }

    if (!mounted) return;
    setState(() {
      _encoding = false;
      _lastResult = _EncodeResult(
        oldEpc: oldEpc!,
        newEpc: newEpc,
        serial: serial,
      );
    });
    ScanSounds.instance.play(ScanCue.success);
  }

  void _failure(String reason) {
    if (!mounted) return;
    setState(() {
      _encoding = false;
      _encodeError = reason;
    });
    ScanSounds.instance.play(ScanCue.error);
  }

  // ── ui ────────────────────────────────────────────────────────────────
  @override
  Widget build(BuildContext context) {
    return CarbonScaffold(
      pageTitle: 'ENCODE',
      body: SafeArea(
        top: false,
        child: Column(
          children: [
            Expanded(child: _buildBody()),
            const RfidPowerSlider(),
          ],
        ),
      ),
    );
  }

  Widget _buildBody() {
    if (_selectedSku == null) {
      return _buildSearchStep();
    }
    return _buildEncodeStep();
  }

  // Step 1 — SKU search
  Widget _buildSearchStep() {
    return Column(
      children: [
        Padding(
          padding: EdgeInsets.fromLTRB(20.w, 12.h, 20.w, 8.h),
          child: _SearchBar(
            controller: _searchCtrl,
            onChanged: _onSearchChanged,
            onClear: () {
              _searchCtrl.clear();
              _onSearchChanged('');
            },
          ),
        ),
        Padding(
          padding: EdgeInsets.fromLTRB(20.w, 0, 20.w, 8.h),
          child: Align(
            alignment: Alignment.centerLeft,
            child: Text(
              _query.isEmpty
                  ? 'TYPE OR 2D-SCAN A BARCODE'
                  : (_searchLoading
                      ? 'SEARCHING…'
                      : '${_searchResults.length} RESULTS'),
              style: GoogleFonts.spaceGrotesk(
                fontSize: 11.sp,
                fontWeight: FontWeight.w700,
                letterSpacing: 1.4,
                color: const Color(0xFF6D7979),
              ),
            ),
          ),
        ),
        if (_searchError != null)
          Padding(
            padding: EdgeInsets.fromLTRB(20.w, 4.h, 20.w, 4.h),
            child: Text(
              _searchError!,
              style: GoogleFonts.manrope(
                fontSize: 12.sp,
                fontWeight: FontWeight.w700,
                color: const Color(0xFFBF2E2E),
              ),
            ),
          ),
        Expanded(
          child: _query.isEmpty
              ? const _SearchEmptyHint()
              : _searchLoading && _searchResults.isEmpty
                  ? const Center(child: CircularProgressIndicator())
                  : _searchResults.isEmpty
                      ? Center(
                          child: Padding(
                            padding: EdgeInsets.all(24.r),
                            child: Text(
                              'No matches for "$_query".',
                              textAlign: TextAlign.center,
                              style: GoogleFonts.manrope(
                                fontSize: 14.sp,
                                fontWeight: FontWeight.w700,
                                color: const Color(0xFF5A6464),
                              ),
                            ),
                          ),
                        )
                      : ListView.separated(
                          padding: EdgeInsets.fromLTRB(20.w, 0, 20.w, 12.h),
                          itemCount: _searchResults.length,
                          separatorBuilder: (_, __) => SizedBox(height: 12.h),
                          itemBuilder: (_, i) {
                            final r = _searchResults[i];
                            return CatalogRowCard(
                              row: r,
                              onQtyTap: () => _selectSku(r),
                            );
                          },
                        ),
        ),
      ],
    );
  }

  // Step 2 — locked SKU + encode prompt + status panel
  Widget _buildEncodeStep() {
    final sku = _selectedSku!;
    final name = sku['name']?.toString() ?? '';
    final color = sku['color']?.toString() ?? '';
    final size = sku['size']?.toString() ?? '';
    final skuCode = sku['sku']?.toString() ?? '';
    final priceStr = sku['retail_price']?.toString();
    final price = double.tryParse(priceStr ?? '');
    final priceText =
        (price != null && price > 0) ? '\$${price.toStringAsFixed(2)}' : '';

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _LockedSkuCard(
          sku: skuCode,
          name: name,
          color: color,
          size: size,
          priceText: priceText,
          onChange: _changeSku,
        ),
        if (_encoding)
          Padding(
            padding: EdgeInsets.symmetric(vertical: 12.h),
            child: const Center(child: CircularProgressIndicator()),
          )
        else if (_encodeError != null)
          _ErrorBanner(message: _encodeError!),
        if (_lastResult != null)
          Padding(
            padding: EdgeInsets.fromLTRB(20.w, 8.h, 20.w, 0),
            child: _ResultPanel(
              result: _lastResult!,
              onTestWithGeiger: () {
                Navigator.of(context).push<void>(
                  MaterialPageRoute<void>(
                    builder: (_) => LocateTagScreen(
                      targetEpc: _lastResult!.newEpc,
                      targetSku: skuCode.isEmpty ? null : skuCode,
                      targetName: name.isEmpty ? null : name,
                      targetColor: color.isEmpty ? null : color,
                      targetSize: size.isEmpty ? null : size,
                      targetPriceText: priceText.isEmpty ? null : priceText,
                    ),
                  ),
                );
              },
            ),
          ),
        Expanded(
          child: Center(
            child: Padding(
              padding: EdgeInsets.symmetric(horizontal: 24.w),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    LucideIcons.tag,
                    size: 64.sp,
                    color: AppColors.primary.withValues(alpha: 0.65),
                  ),
                  SizedBox(height: 12.h),
                  Text(
                    'PULL TRIGGER TO ENCODE',
                    textAlign: TextAlign.center,
                    style: GoogleFonts.manrope(
                      fontSize: 16.sp,
                      fontWeight: FontWeight.w900,
                      letterSpacing: 2.0,
                      color: AppColors.textMain,
                    ),
                  ),
                  SizedBox(height: 6.h),
                  Text(
                    'Hold the gun close to ONE tag and pull.\nReads + writes in a single press.',
                    textAlign: TextAlign.center,
                    style: GoogleFonts.manrope(
                      fontSize: 12.sp,
                      fontWeight: FontWeight.w600,
                      color: const Color(0xFF6D7979),
                      height: 1.5,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}

// ═════════════════════════════════════════════════════════════════════════
// internal model
// ═════════════════════════════════════════════════════════════════════════

class _EncodeResult {
  const _EncodeResult({
    required this.oldEpc,
    required this.newEpc,
    required this.serial,
  });
  final String oldEpc;
  final String newEpc;
  final int serial;
}

// ═════════════════════════════════════════════════════════════════════════
// search bar — copied styling from geiger / status_change
// ═════════════════════════════════════════════════════════════════════════

class _SearchBar extends StatelessWidget {
  const _SearchBar({
    required this.controller,
    required this.onChanged,
    required this.onClear,
  });

  final TextEditingController controller;
  final ValueChanged<String> onChanged;
  final VoidCallback onClear;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: const BoxDecoration(
        color: Color(0xFFF0F5F4),
        borderRadius: BorderRadius.all(Radius.circular(2)),
      ),
      child: Padding(
        padding: EdgeInsets.symmetric(horizontal: 12.w),
        child: Row(
          children: [
            Icon(Icons.search, size: 22.sp, color: const Color(0xFF6D7979)),
            SizedBox(width: 10.w),
            Expanded(
              child: TextField(
                controller: controller,
                onChanged: onChanged,
                autofocus: true,
                textInputAction: TextInputAction.search,
                style: GoogleFonts.spaceGrotesk(
                  fontSize: 15.sp,
                  fontWeight: FontWeight.w600,
                  color: AppColors.textMain,
                ),
                decoration: InputDecoration(
                  border: InputBorder.none,
                  isCollapsed: true,
                  contentPadding: EdgeInsets.symmetric(vertical: 16.h),
                  hintText: 'SKU · UPC · NAME',
                  hintStyle: GoogleFonts.spaceGrotesk(
                    fontSize: 13.sp,
                    fontWeight: FontWeight.w600,
                    letterSpacing: 1.2,
                    color: const Color(0xFF6D7979),
                  ),
                ),
              ),
            ),
            if (controller.text.isNotEmpty)
              GestureDetector(
                onTap: onClear,
                child: Padding(
                  padding: EdgeInsets.symmetric(horizontal: 6.w),
                  child: Icon(Icons.close,
                      size: 20.sp, color: const Color(0xFF6D7979)),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _SearchEmptyHint extends StatelessWidget {
  const _SearchEmptyHint();
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
              'PICK A SKU FIRST',
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
              'Type or 2D-scan a barcode.\nPick a result, then pull the trigger to encode.',
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

// ═════════════════════════════════════════════════════════════════════════
// locked-SKU header card
// ═════════════════════════════════════════════════════════════════════════

class _LockedSkuCard extends StatelessWidget {
  const _LockedSkuCard({
    required this.sku,
    required this.name,
    required this.color,
    required this.size,
    required this.priceText,
    required this.onChange,
  });

  final String sku;
  final String name;
  final String color;
  final String size;
  final String priceText;
  final VoidCallback onChange;

  @override
  Widget build(BuildContext context) {
    final desc = [
      if (name.isNotEmpty) name,
      if (color.isNotEmpty) color,
      if (size.isNotEmpty) size,
    ].join(' · ');
    return Container(
      width: double.infinity,
      color: AppColors.primary,
      padding: EdgeInsets.fromLTRB(16.w, 12.h, 12.w, 12.h),
      margin: EdgeInsets.fromLTRB(20.w, 12.h, 20.w, 0),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.baseline,
                  textBaseline: TextBaseline.alphabetic,
                  children: [
                    Expanded(
                      child: Text(
                        sku.isEmpty ? 'SKU: —' : 'SKU: $sku',
                        style: GoogleFonts.robotoMono(
                          fontSize: 17.sp,
                          fontWeight: FontWeight.w800,
                          color: Colors.white,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    if (priceText.isNotEmpty) ...[
                      SizedBox(width: 8.w),
                      Text(
                        priceText,
                        style: GoogleFonts.manrope(
                          fontSize: 13.sp,
                          fontWeight: FontWeight.w800,
                          color: Colors.white,
                        ),
                      ),
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
                      color: Colors.white.withValues(alpha: 0.92),
                    ),
                  ),
                ],
              ],
            ),
          ),
          SizedBox(width: 8.w),
          GestureDetector(
            onTap: onChange,
            behavior: HitTestBehavior.opaque,
            child: Container(
              padding:
                  EdgeInsets.symmetric(horizontal: 10.w, vertical: 6.h),
              decoration: BoxDecoration(
                color: Colors.white.withValues(alpha: 0.18),
                borderRadius: BorderRadius.circular(2.r),
              ),
              child: Text(
                'CHANGE SKU',
                style: GoogleFonts.spaceGrotesk(
                  fontSize: 10.sp,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 1.4,
                  color: Colors.white,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

// ═════════════════════════════════════════════════════════════════════════
// success result panel
// ═════════════════════════════════════════════════════════════════════════

class _ResultPanel extends StatelessWidget {
  const _ResultPanel({required this.result, required this.onTestWithGeiger});

  final _EncodeResult result;
  final VoidCallback onTestWithGeiger;

  @override
  Widget build(BuildContext context) {
    final epcStyle = GoogleFonts.spaceGrotesk(
      fontSize: 13.sp,
      fontWeight: FontWeight.w700,
      letterSpacing: 0.4,
      color: AppColors.textMain,
    );
    final labelStyle = GoogleFonts.spaceGrotesk(
      fontSize: 10.sp,
      fontWeight: FontWeight.w700,
      letterSpacing: 1.4,
      color: const Color(0xFF6D7979),
    );
    return Container(
      width: double.infinity,
      color: const Color(0xFFECECEC),
      padding: EdgeInsets.fromLTRB(14.w, 10.h, 14.w, 10.h),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.check_circle_outline,
                  color: AppColors.primary, size: 20.sp),
              SizedBox(width: 6.w),
              Text(
                'ENCODED',
                style: GoogleFonts.spaceGrotesk(
                  fontSize: 11.sp,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 1.6,
                  color: AppColors.primary,
                ),
              ),
              const Spacer(),
              Text('SERIAL ${result.serial}', style: labelStyle),
            ],
          ),
          SizedBox(height: 8.h),
          Text('OLD EPC', style: labelStyle),
          SizedBox(height: 2.h),
          Text(result.oldEpc, style: epcStyle, maxLines: 1, overflow: TextOverflow.ellipsis),
          SizedBox(height: 6.h),
          Text('NEW EPC', style: labelStyle),
          SizedBox(height: 2.h),
          Text(result.newEpc, style: epcStyle, maxLines: 1, overflow: TextOverflow.ellipsis),
          SizedBox(height: 10.h),
          GestureDetector(
            onTap: onTestWithGeiger,
            child: Container(
              height: 44.h,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: AppColors.primary,
                borderRadius: BorderRadius.circular(2.r),
              ),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(LucideIcons.radio, size: 16.sp, color: Colors.white),
                  SizedBox(width: 8.w),
                  Text(
                    'TEST WITH GEIGER',
                    style: GoogleFonts.manrope(
                      fontSize: 13.sp,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 2.0,
                      color: Colors.white,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

// ═════════════════════════════════════════════════════════════════════════
// error banner
// ═════════════════════════════════════════════════════════════════════════

class _ErrorBanner extends StatelessWidget {
  const _ErrorBanner({required this.message});
  final String message;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      color: const Color(0xFFFCE7E7),
      padding: EdgeInsets.fromLTRB(14.w, 10.h, 14.w, 10.h),
      margin: EdgeInsets.fromLTRB(20.w, 8.h, 20.w, 0),
      child: Row(
        children: [
          Icon(Icons.error_outline,
              color: const Color(0xFFBF2E2E), size: 18.sp),
          SizedBox(width: 8.w),
          Expanded(
            child: Text(
              message,
              style: GoogleFonts.manrope(
                fontSize: 13.sp,
                fontWeight: FontWeight.w700,
                color: const Color(0xFFBF2E2E),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
