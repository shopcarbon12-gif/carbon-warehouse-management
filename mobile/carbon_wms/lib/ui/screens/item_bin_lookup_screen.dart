import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/hardware/rfid_vendor_channel.dart';
import 'package:carbon_wms/services/scan_sounds.dart';
import 'package:carbon_wms/ui/widgets/camera_barcode_scanner.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';

/// Item Bin Lookup — a barcode-first, read-only "where does this item live?"
/// tool under Bin Management. Pull the trigger, the 2D imager reads the item's
/// hang-tag / UPC, and the screen answers with EVERY bin the item is assigned
/// to (single or multi-bin) plus the unit count in each. The laser re-fires
/// automatically after each answer so the operator can walk a rack and keep
/// scanning without touching the screen.
///
/// This never mutates anything — no bin assign, no status change. It's the
/// pure lookup companion to Bin Assign / Clean Bin.
class ItemBinLookupScreen extends StatefulWidget {
  const ItemBinLookupScreen({super.key});

  @override
  State<ItemBinLookupScreen> createState() => _ItemBinLookupScreenState();
}

class _ItemBinLookupScreenState extends State<ItemBinLookupScreen> {
  // ── palette (shared with Item Lookup for a consistent feel) ─────────────────
  static const Color _ink = Color(0xFF171D1D);
  static const Color _slate = Color(0xFF3F4A4A);
  static const Color _muted = Color(0xFF8A9090);
  static const Color _teal = Color(0xFF1B7D7D);
  static const Color _red = Color(0xFFD9534F);
  static const Color _surface = Color(0xFFF5F7F7);
  static const Color _card = Color(0xFFECECEC);
  static const Color _tileBg = Color(0xFFEEF4F3);
  static const Color _border2 = Color(0xFFBCC9C9);
  static const Color _border = Color(0xFFD7DEDE);

  final _ctrl = TextEditingController();

  _BinResult? _result;
  bool _busy = false;
  String? _err;

  StreamSubscription<String>? _barcodeSub;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      _wireBarcode();
      await _armBarcode();
      // Fire the laser straight away so the first pull-less scan is possible
      // and the trigger is primed.
      await _fireLaser();
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _barcodeSub?.cancel();
    // Leave the imager stopped and hand the next screen a fresh 2D session.
    unawaited(RfidVendorChannel.scannerStop2d());
    unawaited(RfidVendorChannel.open2dBarcode());
    _ctrl.dispose();
    super.dispose();
  }

  // ── scanner wiring ──────────────────────────────────────────────────────────
  void _wireBarcode() {
    _barcodeSub?.cancel();
    _barcodeSub = RfidVendorChannel.hardwareBarcodeStream().listen((raw) async {
      if (!mounted) return;
      final code = raw.trim();
      if (code.isEmpty) return;
      // Reset the native 2D toggle so the NEXT trigger pull re-fires the laser
      // (the relay leaves scanActive TRUE after a decode — see
      // CarbonHardwareBarcodeRelay).
      await RfidVendorChannel.scannerStop2d();
      await _performLookup(code);
      // Re-fire the laser immediately for the next item — continuous rack walk.
      await _fireLaser();
    }, onError: (_) {});
  }

  Future<void> _armBarcode() async {
    try {
      await RfidVendorChannel.scannerDisableTriggerRelay();
      await RfidVendorChannel.disableRfidFunctionMode();
      await RfidVendorChannel.open2dBarcode();
      await RfidVendorChannel.scannerEnableTriggerRelay();
      await RfidVendorChannel.setZebraTriggerMode2D();
    } catch (_) {/* best-effort across vendors */}
  }

  /// Restart the 2D scan session so the laser lights for the next barcode.
  Future<void> _fireLaser() async {
    if (!mounted) return;
    try {
      await RfidVendorChannel.scannerStop2d();
      await RfidVendorChannel.scannerStart2d();
    } catch (_) {}
  }

  // ── lookup ──────────────────────────────────────────────────────────────────
  Future<void> _onCamera() async {
    final code = await openCameraBarcodeScanner(context, title: 'SCAN ITEM');
    if (!mounted || code == null || code.trim().isEmpty) return;
    await _performLookup(code.trim());
  }

  Future<void> _performLookup(String input) async {
    final raw = input.trim().toUpperCase();
    if (raw.isEmpty) return;
    _ctrl.text = raw;
    setState(() {
      _busy = true;
      _err = null;
    });

    try {
      final api = context.read<WmsApiClient>();
      final map = await api.catalogGridSearchFirstRow(raw);
      if (!mounted) return;

      if (map == null) {
        setState(() {
          _result = null;
          _err = 'No catalog match for "$raw". Try the SKU or UPC.';
          _busy = false;
        });
        try {
          ScanSounds.instance.play(ScanCue.error);
        } catch (_) {}
        return;
      }

      final sku = map['sku']?.toString().trim() ?? '';
      final name = _stripBrand(map['name']?.toString().trim() ?? '');
      final upc =
          (map['sku_upc'] ?? map['matrix_upc'])?.toString().trim() ?? '';
      final customSkuId = map['custom_sku_id']?.toString().trim() ?? '';
      final matrixId = map['matrix_id']?.toString().trim() ?? '';

      // Expand the scan into every custom-SKU (colour/size variant) of the
      // product, then pull each variant's live EPCs so we can show, PER BIN,
      // the colour · size · qty breakdown of what's stored there. A scan of a
      // single-variant tag simply resolves to one variant.
      final skuIds = <String>{};
      if (matrixId.isNotEmpty) {
        try {
          final variants = await api.fetchCatalogVariantsForMatrix(matrixId);
          for (final v in variants) {
            final id = v['id']?.toString().trim() ?? '';
            final cnt = (v['epc_count'] as num?)?.toInt() ?? 0;
            if (id.isNotEmpty && cnt > 0) skuIds.add(id);
          }
        } catch (_) {/* fall back to the scanned variant below */}
      }
      if (skuIds.isEmpty && customSkuId.isNotEmpty) skuIds.add(customSkuId);

      // Fetch all variants' EPCs in parallel, then aggregate.
      final lists = await Future.wait(
        skuIds.map((id) => api.fetchCatalogEpcs(id).catchError(
              (_) => <Map<String, dynamic>>[],
            )),
      );
      if (!mounted) return;

      // bin code → variant-key → running variant tally. '' bin = unbinned.
      final byBin = <String, Map<String, _VariantQty>>{};
      var total = 0;
      for (final list in lists) {
        for (final e in list) {
          final status = (e['status']?.toString() ?? '').toLowerCase();
          // Only in-stock (a.k.a. "live") units occupy a bin.
          if (status.isNotEmpty && status != 'in-stock') continue;
          total++;
          final rawBin = e['bin_code']?.toString().trim() ?? '';
          final bin = (rawBin.isEmpty || rawBin == '—') ? '' : rawBin;
          final color = e['color']?.toString().trim() ?? '';
          final size = e['size']?.toString().trim() ?? '';
          final vSku = e['sku']?.toString().trim() ?? '';
          final key = '$color|$size|$vSku';
          final slot = byBin.putIfAbsent(bin, () => <String, _VariantQty>{});
          final v = slot[key];
          if (v == null) {
            slot[key] =
                _VariantQty(color: color, size: size, sku: vSku, qty: 1);
          } else {
            v.qty++;
          }
        }
      }

      _BinGroup buildGroup(String bin, Map<String, _VariantQty> variants) {
        final list = variants.values.toList()
          ..sort((a, b) {
            final c = a.color.toUpperCase().compareTo(b.color.toUpperCase());
            if (c != 0) return c;
            return _sizeRank(a.size).compareTo(_sizeRank(b.size));
          });
        final t = list.fold<int>(0, (s, v) => s + v.qty);
        return _BinGroup(bin: bin, total: t, variants: list);
      }

      final binGroups = <_BinGroup>[];
      final binKeys = byBin.keys.where((k) => k.isNotEmpty).toList()..sort();
      for (final k in binKeys) {
        binGroups.add(buildGroup(k, byBin[k]!));
      }
      final unbinned =
          byBin.containsKey('') ? buildGroup('', byBin['']!) : null;

      // Last-resort fallback: no per-EPC data at all — surface the row's
      // comma-joined bin summary as bare bins (no counts).
      if (binGroups.isEmpty && unbinned == null) {
        final summary = map['bin_location']?.toString().trim() ?? '';
        if (summary.isNotEmpty) {
          for (final b in summary.split(',')) {
            final t = b.trim();
            if (t.isNotEmpty) {
              binGroups.add(_BinGroup(bin: t, total: 0, variants: const []));
            }
          }
        }
      }

      setState(() {
        _result = _BinResult(
          code: raw,
          sku: sku.isNotEmpty ? sku : upc,
          name: name,
          upc: upc,
          bins: binGroups,
          unbinned: unbinned,
          total: total,
        );
        _busy = false;
      });
      try {
        ScanSounds.instance.play(ScanCue.success);
      } catch (_) {}
      try {
        HapticFeedback.selectionClick();
      } catch (_) {}
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _result = null;
        _err = 'Lookup failed — check network and login.';
        _busy = false;
      });
    }
  }

  /// Strip the "Carbon" brand word from a display string (operator request).
  String _stripBrand(String s) {
    final cleaned = s
        .replaceAll(RegExp(r'\bcarbon\b', caseSensitive: false), '')
        .replaceAll(RegExp(r'\s+'), ' ')
        .trim();
    return cleaned.isNotEmpty ? cleaned : '—';
  }

  void _clear() {
    _ctrl.clear();
    setState(() {
      _result = null;
      _err = null;
    });
    unawaited(_fireLaser());
  }

  // ── build ─────────────────────────────────────────────────────────────────
  @override
  Widget build(BuildContext context) {
    return CarbonScaffold(
      pageTitle: 'ITEM BIN LOOKUP',
      body: ColoredBox(
        color: _surface,
        child: Column(
          children: [
            _searchBar(),
            Expanded(
              child: _busy
                  ? const Center(child: CircularProgressIndicator(color: _teal))
                  : _result != null
                      ? _resultView(_result!)
                      : _err != null
                          ? _notFound(_err!)
                          : _idle(),
            ),
          ],
        ),
      ),
    );
  }

  Widget _searchBar() {
    return Padding(
      padding: EdgeInsets.fromLTRB(16.w, 14.h, 16.w, 10.h),
      child: Row(
        children: [
          Expanded(
            child: Container(
              decoration: BoxDecoration(
                color: Colors.white,
                border: Border.all(color: _border2, width: 1.5),
              ),
              padding: EdgeInsets.symmetric(horizontal: 12.w),
              child: Row(
                children: [
                  Icon(LucideIcons.search, size: 23.sp, color: _muted),
                  SizedBox(width: 9.w),
                  Expanded(
                    child: TextField(
                      controller: _ctrl,
                      onSubmitted: (v) => unawaited(_performLookup(v)),
                      textInputAction: TextInputAction.search,
                      style: GoogleFonts.robotoMono(
                        fontSize: 17.sp,
                        fontWeight: FontWeight.w700,
                        color: _ink,
                      ),
                      decoration: InputDecoration(
                        filled: false,
                        border: InputBorder.none,
                        enabledBorder: InputBorder.none,
                        focusedBorder: InputBorder.none,
                        isCollapsed: true,
                        contentPadding: EdgeInsets.symmetric(vertical: 16.h),
                        hintText: 'Scan or type a barcode · SKU · UPC',
                        hintStyle: GoogleFonts.manrope(
                          fontSize: 16.sp,
                          fontWeight: FontWeight.w700,
                          color: _muted,
                        ),
                      ),
                    ),
                  ),
                  if (_ctrl.text.isNotEmpty)
                    GestureDetector(
                      onTap: _clear,
                      child: Icon(Icons.close, size: 19.sp, color: _muted),
                    ),
                ],
              ),
            ),
          ),
          SizedBox(width: 8.w),
          GestureDetector(
            onTap: _onCamera,
            child: Container(
              width: 52.w,
              height: 52.w,
              decoration: BoxDecoration(
                color: Colors.white,
                border: Border.all(color: _border2, width: 1.5),
              ),
              child: Icon(LucideIcons.camera, size: 24.sp, color: _teal),
            ),
          ),
        ],
      ),
    );
  }

  // ── states ──────────────────────────────────────────────────────────────────
  Widget _idle() {
    return ListView(
      padding: EdgeInsets.fromLTRB(16.w, 8.h, 16.w, 24.h),
      children: [
        SizedBox(height: 24.h),
        Center(
          child: Container(
            width: 108.w,
            height: 108.w,
            decoration: const BoxDecoration(
                color: Color(0xFFEAF3F2), shape: BoxShape.circle),
            child: Icon(Icons.barcode_reader, size: 50.sp, color: _teal),
          ),
        ),
        SizedBox(height: 16.h),
        Text(
          'Scan an item',
          textAlign: TextAlign.center,
          style: GoogleFonts.spaceGrotesk(
              fontSize: 20.sp, fontWeight: FontWeight.w800, color: _ink),
        ),
        SizedBox(height: 8.h),
        Padding(
          padding: EdgeInsets.symmetric(horizontal: 30.w),
          child: Text(
            'Pull the trigger to read a barcode. The screen shows every bin the '
            'item is assigned to, then the laser re-arms for the next scan.',
            textAlign: TextAlign.center,
            style: GoogleFonts.manrope(
                fontSize: 15.sp, fontWeight: FontWeight.w600, color: _muted),
          ),
        ),
      ],
    );
  }

  Widget _resultView(_BinResult r) {
    final binCount = r.bins.length;
    final multi = binCount > 1;
    return ListView(
      padding: EdgeInsets.fromLTRB(16.w, 14.h, 16.w, 24.h),
      children: [
        // Item header
        Container(
          width: double.infinity,
          color: _card,
          padding: EdgeInsets.fromLTRB(14.w, 12.h, 14.w, 12.h),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                r.name,
                style: GoogleFonts.spaceGrotesk(
                    fontSize: 20.sp,
                    fontWeight: FontWeight.w800,
                    color: _ink,
                    height: 1.15),
              ),
              SizedBox(height: 6.h),
              Text(
                r.sku,
                style: GoogleFonts.robotoMono(
                    fontSize: 16.sp, fontWeight: FontWeight.w700, color: _teal),
              ),
              if (r.upc.isNotEmpty) ...[
                SizedBox(height: 4.h),
                Text('UPC ${r.upc}',
                    style: GoogleFonts.robotoMono(
                        fontSize: 13.sp,
                        fontWeight: FontWeight.w600,
                        color: _muted)),
              ],
            ],
          ),
        ),
        SizedBox(height: 14.h),
        // Summary tiles
        Row(
          children: [
            _tile('BINS', binCount == 0 ? '0' : '$binCount', color: _teal),
            SizedBox(width: 10.w),
            _tile('UNITS', r.total > 0 ? '${r.total}' : '—', color: _ink),
          ],
        ),
        SizedBox(height: 14.h),
        // Assigned-bins block — each bin with its colour · size · qty content.
        Container(
          decoration: BoxDecoration(
            color: Colors.white,
            border: Border.all(color: _border),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: EdgeInsets.fromLTRB(14.w, 12.h, 14.w, 8.h),
                child: Text(
                  multi ? 'ASSIGNED BINS' : 'ASSIGNED BIN',
                  style: GoogleFonts.spaceGrotesk(
                    fontSize: 11.sp,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 1.6,
                    color: _muted,
                  ),
                ),
              ),
              if (r.bins.isEmpty)
                Padding(
                  padding: EdgeInsets.fromLTRB(14.w, 6.h, 14.w, 16.h),
                  child: Text(
                    'No bin assigned to this item.',
                    style: GoogleFonts.manrope(
                        fontSize: 16.sp,
                        fontWeight: FontWeight.w700,
                        color: _slate),
                  ),
                )
              else
                for (final b in r.bins) _binGroup(b),
              if (r.unbinned != null) _binGroup(r.unbinned!, unbinned: true),
            ],
          ),
        ),
      ],
    );
  }

  /// One bin's block: bin code + unit total on the header row, then a
  /// colour · size · qty line for every variant stored in it.
  Widget _binGroup(_BinGroup g, {bool unbinned = false}) {
    return Container(
      padding: EdgeInsets.fromLTRB(14.w, 12.h, 14.w, 10.h),
      decoration: const BoxDecoration(
        border: Border(top: BorderSide(color: Color(0xFFECF1F1))),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(unbinned ? Icons.help_outline : LucideIcons.mapPin,
                  size: 22.sp, color: unbinned ? _muted : _teal),
              SizedBox(width: 12.w),
              Expanded(
                child: Text(
                  unbinned ? 'No bin on file' : g.bin,
                  style: unbinned
                      ? GoogleFonts.manrope(
                          fontSize: 16.sp,
                          fontWeight: FontWeight.w700,
                          color: _muted)
                      : GoogleFonts.robotoMono(
                          fontSize: 22.sp,
                          fontWeight: FontWeight.w700,
                          color: _ink),
                ),
              ),
              if (g.total > 0) ...[
                SizedBox(width: 10.w),
                Container(
                  padding:
                      EdgeInsets.symmetric(horizontal: 12.w, vertical: 5.h),
                  decoration: BoxDecoration(
                    color: _tileBg,
                    borderRadius: BorderRadius.circular(4.r),
                  ),
                  child: Text(
                    g.total == 1 ? '1 unit' : '${g.total} units',
                    style: GoogleFonts.spaceGrotesk(
                        fontSize: 14.sp,
                        fontWeight: FontWeight.w800,
                        color: unbinned ? _muted : _teal),
                  ),
                ),
              ],
            ],
          ),
          if (g.variants.isNotEmpty) ...[
            SizedBox(height: 8.h),
            for (final v in g.variants)
              Padding(
                padding: EdgeInsets.only(left: 34.w, bottom: 6.h),
                child: Row(
                  children: [
                    Expanded(child: _variantLabel(v)),
                    SizedBox(width: 10.w),
                    Text(
                      'x${v.qty}',
                      style: GoogleFonts.spaceGrotesk(
                          fontSize: 16.sp,
                          fontWeight: FontWeight.w800,
                          color: _slate),
                    ),
                  ],
                ),
              ),
          ],
        ],
      ),
    );
  }

  /// "COLOR · SIZE" label with graceful fallbacks when a variant is missing
  /// one dimension (or both — then show the SKU).
  Widget _variantLabel(_VariantQty v) {
    final parts = [
      if (v.color.isNotEmpty) v.color.toUpperCase(),
      if (v.size.isNotEmpty) v.size.toUpperCase(),
    ];
    final label = parts.isNotEmpty
        ? parts.join('  ·  ')
        : (v.sku.isNotEmpty ? v.sku : '—');
    return Text(
      label,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: GoogleFonts.manrope(
          fontSize: 15.sp, fontWeight: FontWeight.w700, color: _ink),
    );
  }

  Widget _tile(String label, String value, {required Color color}) {
    return Expanded(
      child: Container(
        height: 82.h,
        color: _tileBg,
        alignment: Alignment.center,
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text(
              label,
              style: GoogleFonts.manrope(
                fontSize: 12.sp,
                fontWeight: FontWeight.w800,
                letterSpacing: 0.6,
                color: _muted,
              ),
            ),
            SizedBox(height: 3.h),
            Text(
              value,
              style: GoogleFonts.spaceGrotesk(
                fontSize: 34.sp,
                fontWeight: FontWeight.w700,
                letterSpacing: -1,
                height: 1.0,
                color: color,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _notFound(String msg) {
    return ListView(
      padding: EdgeInsets.fromLTRB(30.w, 40.h, 30.w, 24.h),
      children: [
        Center(
          child: Container(
            width: 96.w,
            height: 96.w,
            decoration: const BoxDecoration(
                color: Color(0xFFFDECEA), shape: BoxShape.circle),
            child: Icon(Icons.search_off, size: 44.sp, color: _red),
          ),
        ),
        SizedBox(height: 16.h),
        Text(
          'No match',
          textAlign: TextAlign.center,
          style: GoogleFonts.spaceGrotesk(
              fontSize: 21.sp, fontWeight: FontWeight.w800, color: _ink),
        ),
        SizedBox(height: 14.h),
        Center(
          child: Container(
            color: _card,
            padding: EdgeInsets.symmetric(horizontal: 13.w, vertical: 9.h),
            child: Text(
              _ctrl.text.isEmpty ? '—' : _ctrl.text,
              style: GoogleFonts.robotoMono(
                  fontSize: 15.sp, fontWeight: FontWeight.w700, color: _slate),
            ),
          ),
        ),
        SizedBox(height: 14.h),
        Text(
          msg,
          textAlign: TextAlign.center,
          style: GoogleFonts.manrope(
              fontSize: 14.sp, fontWeight: FontWeight.w600, color: _muted),
        ),
      ],
    );
  }
}

/// Rank sizes into apparel order (XS < S < M < L < XL < 2XL …). Numeric sizes
/// (waist 30, 32) sort by value; anything unknown falls to the end alphabetically.
int _sizeRank(String size) {
  final s = size.trim().toUpperCase();
  const order = {
    'XXS': -3,
    '2XS': -3,
    'XS': -2,
    'S': -1,
    'M': 0,
    'L': 1,
    'XL': 2,
    'XXL': 3,
    '2XL': 3,
    'XXXL': 4,
    '3XL': 4,
    '4XL': 5,
  };
  if (order.containsKey(s)) return order[s]!;
  final n = int.tryParse(s.replaceAll(RegExp(r'[^0-9]'), ''));
  if (n != null) return 100 + n; // numeric sizes after lettered ones
  return 100000 + s.hashCode.abs() % 1000; // unknown → stable tail
}

class _BinResult {
  const _BinResult({
    required this.code,
    required this.sku,
    required this.name,
    required this.upc,
    required this.bins,
    required this.unbinned,
    required this.total,
  });
  final String code;
  final String sku;
  final String name;
  final String upc;
  final List<_BinGroup> bins;
  final _BinGroup? unbinned;
  final int total;
}

class _BinGroup {
  const _BinGroup({
    required this.bin,
    required this.total,
    required this.variants,
  });
  final String bin;
  final int total; // 0 = count unknown (summary fallback)
  final List<_VariantQty> variants;
}

class _VariantQty {
  _VariantQty({
    required this.color,
    required this.size,
    required this.sku,
    required this.qty,
  });
  final String color;
  final String size;
  final String sku;
  int qty;
}
