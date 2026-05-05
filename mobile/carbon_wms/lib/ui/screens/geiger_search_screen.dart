import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/hardware/rfid_vendor_channel.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/screens/inventory_catalog_screen.dart'
    show CatalogEpcListScreen, CatalogRowCard;
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';

/// Search-first entry point to the Locate flow.
///
/// Differences from the Catalog screen:
///   * **Empty by default.** Don't auto-load page 1 — the operator's intent
///     here is "find a specific item then locate one of its EPCs", so showing
///     the entire catalog the moment they enter the screen is noise.
///   * Once the operator types a query (debounced, ≥2 chars), results render
///     in the same `CatalogRowCard` containers used on the Catalog and Count
///     screens. Tapping the **xN** badge drills into [CatalogEpcListScreen],
///     which already wires the per-EPC sensors button to [LocateTagScreen].
///
/// Data source is identical to the Catalog screen: `GET /api/inventory/catalog`
/// scoped to `session.lid`. 100% web-mirror, read-only.
class GeigerSearchScreen extends StatefulWidget {
  const GeigerSearchScreen({super.key});

  @override
  State<GeigerSearchScreen> createState() => _GeigerSearchScreenState();
}

class _GeigerSearchScreenState extends State<GeigerSearchScreen> {
  static const int _pageSize = 200;
  static const _searchDebounce = Duration(milliseconds: 300);
  // Below 2 chars the result set is too noisy and the EPC EXISTS clause makes
  // the query progressively slower as the table grows. Two characters keeps
  // the latency tight while still surfacing partial matches.
  static const int _minQueryLen = 2;

  final TextEditingController _searchCtrl = TextEditingController();
  final ScrollController _scrollCtrl = ScrollController();
  Timer? _debounce;
  StreamSubscription<String>? _barcodeSub;

  String _query = '';
  int _page = 1;
  int _total = 0;
  bool _loading = false;
  bool _loadingMore = false;
  String? _error;
  final List<Map<String, dynamic>> _rows = [];

  @override
  void initState() {
    super.initState();
    _scrollCtrl.addListener(_onScroll);
    // 2D-only mode: pulling/holding the trigger fires the imager, not UHF.
    // Both Chainway and Zebra paths covered defensively — calls are no-ops
    // on devices without the matching SDK so we don't need to know which
    // hardware we're on.
    unawaited(RfidVendorChannel.disableRfidFunctionMode());
    unawaited(RfidVendorChannel.open2dBarcode());
    unawaited(RfidVendorChannel.setZebraTriggerMode2D());
    // Decoded 2D barcodes flow in here. We populate the search field +
    // run a search synchronously so the operator sees results immediately
    // after release. Only accept payloads that aren't 24-hex EPCs — those
    // belong on Count/Locate, not the Geiger picker.
    _barcodeSub = RfidVendorChannel.hardwareBarcodeStream().listen((raw) {
      if (!mounted) return;
      final code = raw.trim();
      if (code.isEmpty) return;
      _searchCtrl.text = code;
      _searchCtrl.selection =
          TextSelection.collapsed(offset: _searchCtrl.text.length);
      _onSearchChanged(code);
    }, onError: (_) {});
    // Deliberately no _refresh() on init — start blank (per spec).
  }

  @override
  void dispose() {
    _debounce?.cancel();
    unawaited(_barcodeSub?.cancel());
    _scrollCtrl.removeListener(_onScroll);
    _scrollCtrl.dispose();
    _searchCtrl.dispose();
    // Restore RFID-trigger mode for the next screen. The locate screen
    // also asserts RFID mode on entry — this is belt-and-braces so any
    // intermediate screen that doesn't manage trigger state isn't left
    // accidentally in 2D mode.
    unawaited(RfidVendorChannel.setZebraTriggerModeRfid());
    unawaited(RfidVendorChannel.enableRfidFunctionMode());
    super.dispose();
  }

  void _onScroll() {
    if (_loadingMore || _loading) return;
    if (_query.isEmpty || _rows.length >= _total) return;
    final pos = _scrollCtrl.position;
    if (pos.pixels >= pos.maxScrollExtent - 240) {
      unawaited(_loadNextPage());
    }
  }

  void _onSearchChanged(String value) {
    _debounce?.cancel();
    final trimmed = value.trim();
    if (trimmed.length < _minQueryLen) {
      // Below threshold → drop the result set so the screen returns to the
      // "type to search" placeholder rather than showing stale results.
      if (_rows.isNotEmpty || _query.isNotEmpty) {
        setState(() {
          _query = '';
          _rows.clear();
          _total = 0;
          _loading = false;
          _error = null;
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
      _loading = true;
      _error = null;
      _page = 1;
      _rows.clear();
      _total = 0;
    });
    try {
      final api = context.read<WmsApiClient>();
      final res = await api.fetchCatalogGrid(
        q: _query,
        page: 1,
        limit: _pageSize,
      );
      if (!mounted) return;
      final rows = (res['rows'] as List?)
              ?.whereType<Map<String, dynamic>>()
              .toList() ??
          [];
      setState(() {
        _rows.addAll(rows);
        _total = (res['total'] as num?)?.toInt() ?? rows.length;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = 'Search failed: $e';
      });
    }
  }

  Future<void> _loadNextPage() async {
    if (_loadingMore || _loading || _query.isEmpty) return;
    if (_rows.length >= _total) return;
    setState(() {
      _loadingMore = true;
      _error = null;
    });
    final next = _page + 1;
    try {
      final api = context.read<WmsApiClient>();
      final res = await api.fetchCatalogGrid(
        q: _query,
        page: next,
        limit: _pageSize,
      );
      if (!mounted) return;
      final rows = (res['rows'] as List?)
              ?.whereType<Map<String, dynamic>>()
              .toList() ??
          [];
      setState(() {
        _page = next;
        _rows.addAll(rows);
        _total = (res['total'] as num?)?.toInt() ?? _total;
        _loadingMore = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loadingMore = false;
        _error = 'Load more failed: $e';
      });
    }
  }

  Future<void> _openEpcList(Map<String, dynamic> row) async {
    final id = row['custom_sku_id']?.toString() ?? '';
    if (id.isEmpty) return;
    final api = context.read<WmsApiClient>();
    await Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder: (_) => CatalogEpcListScreen(
          customSkuId: id,
          row: row,
          api: api,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return CarbonScaffold(
      pageTitle: 'GEIGER',
      body: Column(
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
          if (_query.isNotEmpty)
            Padding(
              padding: EdgeInsets.fromLTRB(20.w, 0, 20.w, 8.h),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  _loading ? 'SEARCHING…' : '$_total RESULTS',
                  style: GoogleFonts.spaceGrotesk(
                    fontSize: 11.sp,
                    fontWeight: FontWeight.w700,
                    letterSpacing: 1.4,
                    color: const Color(0xFF6D7979),
                  ),
                ),
              ),
            ),
          if (_error != null)
            Padding(
              padding: EdgeInsets.fromLTRB(20.w, 4.h, 20.w, 4.h),
              child: Text(
                _error!,
                style: GoogleFonts.manrope(
                  fontSize: 12.sp,
                  fontWeight: FontWeight.w700,
                  color: const Color(0xFFBF2E2E),
                ),
              ),
            ),
          Expanded(
            child: _query.isEmpty
                ? const _EmptyHint()
                : _loading && _rows.isEmpty
                    ? const Center(child: CircularProgressIndicator())
                    : _rows.isEmpty
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
                            controller: _scrollCtrl,
                            padding:
                                EdgeInsets.fromLTRB(20.w, 0, 20.w, 12.h),
                            itemCount:
                                _rows.length + (_loadingMore ? 1 : 0),
                            separatorBuilder: (_, __) =>
                                SizedBox(height: 12.h),
                            itemBuilder: (_, i) {
                              if (i >= _rows.length) {
                                return Padding(
                                  padding: EdgeInsets.symmetric(vertical: 16.h),
                                  child: const Center(
                                      child: CircularProgressIndicator()),
                                );
                              }
                              final r = _rows[i];
                              return CatalogRowCard(
                                row: r,
                                onQtyTap: () => _openEpcList(r),
                              );
                            },
                          ),
          ),
        ],
      ),
    );
  }
}

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
                  hintText: 'EPC · SKU · UPC · NAME · BIN',
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

class _EmptyHint extends StatelessWidget {
  const _EmptyHint();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: EdgeInsets.all(24.r),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.sensors, size: 48.sp, color: const Color(0xFFBCC9C9)),
            SizedBox(height: 12.h),
            Text(
              'Type to search the catalog.',
              textAlign: TextAlign.center,
              style: GoogleFonts.manrope(
                fontSize: 15.sp,
                fontWeight: FontWeight.w800,
                color: const Color(0xFF5A6464),
              ),
            ),
            SizedBox(height: 6.h),
            Text(
              'Pick a result, then locate one of its EPCs with the Geiger meter.',
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
