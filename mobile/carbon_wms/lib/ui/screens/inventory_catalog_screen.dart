import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/mobile_permissions.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/screens/locate_tag_screen.dart';
import 'package:carbon_wms/ui/widgets/camera_barcode_scanner.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';

/// Live read-only mirror of `/inventory/catalog` from the WMS web app.
///
///  * Top: search row — debounced 300 ms, `q` matches across EPC, name, SKU,
///    UPC, vendor and bin code (server-side, see `lib/server/inventory-catalog.ts`).
///  * Body: paged catalog rows in the same `_CountItemContainer`-style cards
///    used on the Count screen, so the operator can rely on the same muscle
///    memory for SKU/desc/qty placement.
///  * Tap the **xN** badge → drilldown screen listing every EPC for that
///    custom SKU. Each EPC row has the locate (Geiger) button that pushes
///    `LocateTagScreen(targetEpc: …)` exactly like the Count flow.
///  * Location filtering is implicit: the catalog endpoint scopes to
///    `session.lid` server-side, which matches the operator's currently
///    selected location in WMS web. This screen is a 100% mirror — no
///    mutations.
class InventoryCatalogScreen extends StatefulWidget {
  const InventoryCatalogScreen({super.key});

  @override
  State<InventoryCatalogScreen> createState() => _InventoryCatalogScreenState();
}

class _InventoryCatalogScreenState extends State<InventoryCatalogScreen> {
  static const int _pageSize = 200;
  static const _searchDebounce = Duration(milliseconds: 300);

  final TextEditingController _searchCtrl = TextEditingController();
  final ScrollController _scrollCtrl = ScrollController();
  Timer? _debounce;

  String _query = '';
  // Sort + filter (server-side via the catalog grid endpoint).
  String _sortBy = ''; // '', 'sku', 'name', 'qty_epc', 'bin'
  String _sortDir = 'asc';
  String _stock = ''; // '', 'in', 'out', 'manual'
  String _category = '';
  String _vendor = '';
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
    WidgetsBinding.instance.addPostFrameCallback((_) => _refresh());
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _scrollCtrl.removeListener(_onScroll);
    _scrollCtrl.dispose();
    _searchCtrl.dispose();
    super.dispose();
  }

  void _onScroll() {
    if (_loadingMore || _loading) return;
    if (_rows.length >= _total) return;
    final pos = _scrollCtrl.position;
    if (pos.pixels >= pos.maxScrollExtent - 240) {
      unawaited(_loadNextPage());
    }
  }

  void _onSearchChanged(String value) {
    _debounce?.cancel();
    _debounce = Timer(_searchDebounce, () {
      if (!mounted) return;
      if (value.trim() == _query) return;
      setState(() => _query = value.trim());
      unawaited(_refresh());
    });
  }

  /// Scan a SKU/UPC with the device camera and drop it into the search.
  Future<void> _onCamera() async {
    final code = await openCameraBarcodeScanner(context, title: 'SCAN SKU');
    if (!mounted || code == null || code.trim().isEmpty) return;
    _searchCtrl.text = code.trim();
    _searchCtrl.selection =
        TextSelection.collapsed(offset: _searchCtrl.text.length);
    _onSearchChanged(code.trim());
  }

  Future<void> _refresh() async {
    if (_loading) return;
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
        sortBy: _sortBy,
        sortDir: _sortDir,
        stock: _stock,
        category: _category,
        vendor: _vendor,
      );
      if (!mounted) return;
      final rows = (res['rows'] as List?)?.whereType<Map<String, dynamic>>().toList() ?? [];
      setState(() {
        _rows.addAll(rows);
        _total = (res['total'] as num?)?.toInt() ?? rows.length;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = 'Catalog load failed: $e';
      });
    }
  }

  Future<void> _loadNextPage() async {
    if (_loadingMore || _loading) return;
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
        sortBy: _sortBy,
        sortDir: _sortDir,
        stock: _stock,
        category: _category,
        vendor: _vendor,
      );
      if (!mounted) return;
      final rows = (res['rows'] as List?)?.whereType<Map<String, dynamic>>().toList() ?? [];
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
    // Push immediately with a loading placeholder so the operator gets the
    // screen-transition affordance even if the EPC fetch takes a beat.
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

  // ── sort + filter ──────────────────────────────────────────────────────────
  List<String> _distinct(String field) {
    final s = <String>{};
    for (final r in _rows) {
      final v = r[field]?.toString().trim();
      if (v != null && v.isNotEmpty) s.add(v);
    }
    final list = s.toList()..sort();
    return list;
  }

  String _sortLabel() {
    switch (_sortBy) {
      case 'sku':
        return _sortDir == 'asc' ? 'SKU A–Z' : 'SKU Z–A';
      case 'name':
        return _sortDir == 'desc' ? 'Name Z–A' : 'Name A–Z';
      case 'qty_epc':
        return _sortDir == 'desc' ? 'Qty high' : 'Qty low';
      case 'bin':
        return 'Bin';
      default:
        return 'Sort';
    }
  }

  Widget _sortFilterBar() {
    final hasFilter =
        _stock.isNotEmpty || _category.isNotEmpty || _vendor.isNotEmpty;
    return Padding(
      padding: EdgeInsets.fromLTRB(20.w, 0, 20.w, 8.h),
      child: Row(
        children: [
          Expanded(
            child: _barBtn(
                icon: Icons.swap_vert,
                label: _sortLabel(),
                active: _sortBy.isNotEmpty,
                onTap: _openSort),
          ),
          SizedBox(width: 10.w),
          Expanded(
            child: _barBtn(
                icon: Icons.filter_list,
                label: hasFilter ? 'Filtered' : 'Filter',
                active: hasFilter,
                onTap: _openFilter),
          ),
        ],
      ),
    );
  }

  Widget _barBtn({
    required IconData icon,
    required String label,
    required bool active,
    required VoidCallback onTap,
  }) {
    final c = active ? AppColors.primary : const Color(0xFF6D7979);
    return GestureDetector(
      onTap: onTap,
      child: Container(
        height: 48.h,
        decoration: BoxDecoration(
          color: Colors.white,
          border: Border.all(
              color: active ? AppColors.primary : const Color(0xFFBCC9C9),
              width: 1.5),
        ),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(icon, size: 21.sp, color: c),
            SizedBox(width: 8.w),
            Text(label,
                style: GoogleFonts.spaceGrotesk(
                    fontSize: 16.sp,
                    fontWeight: FontWeight.w900,
                    letterSpacing: 0.6,
                    color: c)),
          ],
        ),
      ),
    );
  }

  Widget _sheetTitle(String t) => Padding(
        padding: EdgeInsets.fromLTRB(20.w, 16.h, 20.w, 8.h),
        child: Text(t,
            style: GoogleFonts.spaceGrotesk(
                fontSize: 13.sp,
                fontWeight: FontWeight.w800,
                letterSpacing: 2.0,
                color: AppColors.primary)),
      );

  Future<void> _openSort() async {
    final opts = <(String, String, String)>[
      ('Default', '', 'asc'),
      ('SKU  ·  A–Z', 'sku', 'asc'),
      ('SKU  ·  Z–A', 'sku', 'desc'),
      ('Name  ·  A–Z', 'name', 'asc'),
      ('Name  ·  Z–A', 'name', 'desc'),
      ('Qty  ·  high → low', 'qty_epc', 'desc'),
      ('Qty  ·  low → high', 'qty_epc', 'asc'),
      ('Bin', 'bin', 'asc'),
    ];
    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: Colors.white,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            _sheetTitle('SORT BY'),
            for (final o in opts)
              ListTile(
                dense: true,
                title: Text(o.$1,
                    style: GoogleFonts.manrope(
                        fontSize: 15.sp, fontWeight: FontWeight.w700)),
                trailing: (_sortBy == o.$2 &&
                        (o.$2.isEmpty || _sortDir == o.$3))
                    ? Icon(Icons.check, color: AppColors.primary, size: 20.sp)
                    : null,
                onTap: () {
                  Navigator.of(ctx).pop();
                  setState(() {
                    _sortBy = o.$2;
                    _sortDir = o.$3;
                  });
                  unawaited(_refresh());
                },
              ),
            SizedBox(height: 8.h),
          ],
        ),
      ),
    );
  }

  Future<void> _openFilter() async {
    final cats = _distinct('category');
    final vendors = _distinct('vendor');
    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: Colors.white,
      isScrollControlled: true,
      builder: (ctx) => SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: 0.72.sh),
          child: ListView(
            shrinkWrap: true,
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  _sheetTitle('FILTER'),
                  if (_stock.isNotEmpty ||
                      _category.isNotEmpty ||
                      _vendor.isNotEmpty)
                    Padding(
                      padding: EdgeInsets.only(right: 16.w),
                      child: TextButton(
                        onPressed: () {
                          Navigator.of(ctx).pop();
                          setState(() {
                            _stock = '';
                            _category = '';
                            _vendor = '';
                          });
                          unawaited(_refresh());
                        },
                        child: Text('CLEAR',
                            style: GoogleFonts.spaceGrotesk(
                                fontWeight: FontWeight.w800,
                                color: const Color(0xFFD9534F))),
                      ),
                    ),
                ],
              ),
              _stockGroup(ctx),
              _filterGroup(ctx, 'CATEGORY', cats, _category,
                  (v) => setState(() => _category = v)),
              _filterGroup(ctx, 'VENDOR', vendors, _vendor,
                  (v) => setState(() => _vendor = v)),
              SizedBox(height: 12.h),
            ],
          ),
        ),
      ),
    );
  }

  /// Fixed STOCK filter — In stock / Out of stock / Manual items. Single-select
  /// (tap the active chip again to clear). Values map to the server `stock`
  /// param ('in' | 'out' | 'manual').
  Widget _stockGroup(BuildContext ctx) {
    const opts = <(String, String)>[
      ('in', 'In stock'),
      ('out', 'Out of stock'),
      ('manual', 'Manual items'),
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: EdgeInsets.fromLTRB(20.w, 14.h, 20.w, 6.h),
          child: Text('STOCK',
              style: GoogleFonts.spaceGrotesk(
                  fontSize: 12.sp,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 1.4,
                  color: const Color(0xFF8A9090))),
        ),
        Padding(
          padding: EdgeInsets.symmetric(horizontal: 16.w),
          child: Wrap(
            spacing: 8.w,
            runSpacing: 8.h,
            children: [
              for (final o in opts)
                GestureDetector(
                  onTap: () {
                    Navigator.of(ctx).pop();
                    setState(() => _stock = _stock == o.$1 ? '' : o.$1);
                    unawaited(_refresh());
                  },
                  child: Container(
                    padding:
                        EdgeInsets.symmetric(horizontal: 14.w, vertical: 9.h),
                    decoration: BoxDecoration(
                      color: _stock == o.$1
                          ? AppColors.primary
                          : const Color(0xFFECF1F1),
                      border: Border.all(
                          color: _stock == o.$1
                              ? AppColors.primary
                              : const Color(0xFFD7DEDE)),
                    ),
                    child: Text(o.$2,
                        style: GoogleFonts.spaceGrotesk(
                            fontSize: 14.sp,
                            fontWeight: FontWeight.w800,
                            color: _stock == o.$1
                                ? Colors.white
                                : const Color(0xFF3F4A4A))),
                  ),
                ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _filterGroup(
    BuildContext ctx,
    String title,
    List<String> opts,
    String current,
    void Function(String) onPick,
  ) {
    if (opts.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: EdgeInsets.fromLTRB(20.w, 14.h, 20.w, 6.h),
          child: Text(title,
              style: GoogleFonts.spaceGrotesk(
                  fontSize: 11.sp,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 1.4,
                  color: const Color(0xFF8A9090))),
        ),
        Padding(
          padding: EdgeInsets.symmetric(horizontal: 16.w),
          child: Wrap(
            spacing: 8.w,
            runSpacing: 8.h,
            children: [
              for (final o in opts)
                GestureDetector(
                  onTap: () {
                    Navigator.of(ctx).pop();
                    onPick(current == o ? '' : o);
                    unawaited(_refresh());
                  },
                  child: Container(
                    padding:
                        EdgeInsets.symmetric(horizontal: 12.w, vertical: 8.h),
                    decoration: BoxDecoration(
                      color: current == o
                          ? AppColors.primary
                          : const Color(0xFFECF1F1),
                      border: Border.all(
                          color: current == o
                              ? AppColors.primary
                              : const Color(0xFFD7DEDE)),
                    ),
                    child: Text(o,
                        style: GoogleFonts.spaceGrotesk(
                            fontSize: 13.sp,
                            fontWeight: FontWeight.w700,
                            color: current == o
                                ? Colors.white
                                : const Color(0xFF3F4A4A))),
                  ),
                ),
            ],
          ),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    return CarbonScaffold(
      pageTitle: 'CATALOG',
      body: Column(
        children: [
          // Search bar replaces the Count screen's TOTAL EPCs / TOTAL SKUs
          // counter row. Same vertical real-estate so the visual rhythm
          // (search → card list) feels native to operators coming from Count.
          Padding(
            padding: EdgeInsets.fromLTRB(20.w, 12.h, 20.w, 8.h),
            child: _SearchBar(
              controller: _searchCtrl,
              onChanged: _onSearchChanged,
              onClear: () {
                _searchCtrl.clear();
                _onSearchChanged('');
              },
              onCamera: _onCamera,
            ),
          ),
          _sortFilterBar(),
          _ResultMeta(total: _total, loading: _loading, query: _query),
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
            child: _loading && _rows.isEmpty
                ? const Center(child: CircularProgressIndicator())
                : _rows.isEmpty
                    ? Center(
                        child: Padding(
                          padding: EdgeInsets.all(24.r),
                          child: Text(
                            _query.isEmpty
                                ? 'No catalog rows for this location.'
                                : 'No matches for "$_query".',
                            textAlign: TextAlign.center,
                            style: GoogleFonts.manrope(
                              fontSize: 14.sp,
                              fontWeight: FontWeight.w700,
                              color: const Color(0xFF5A6464),
                            ),
                          ),
                        ),
                      )
                    : RefreshIndicator(
                        onRefresh: _refresh,
                        child: ListView.separated(
                          controller: _scrollCtrl,
                          padding: EdgeInsets.fromLTRB(20.w, 0, 20.w, 12.h),
                          itemCount: _rows.length + (_loadingMore ? 1 : 0),
                          separatorBuilder: (_, __) => SizedBox(height: 12.h),
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
          ),
        ],
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Search bar (top of screen)
// ═══════════════════════════════════════════════════════════════════════════

class _SearchBar extends StatelessWidget {
  const _SearchBar({
    required this.controller,
    required this.onChanged,
    required this.onClear,
    this.onCamera,
  });

  final TextEditingController controller;
  final ValueChanged<String> onChanged;
  final VoidCallback onClear;
  final VoidCallback? onCamera;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: Colors.white,
        border: Border.all(color: const Color(0xFFBCC9C9), width: 1.5),
      ),
      child: Padding(
        padding: EdgeInsets.symmetric(horizontal: 12.w),
        child: Row(
          children: [
            Icon(Icons.search, size: 24.sp, color: const Color(0xFF6D7979)),
            SizedBox(width: 10.w),
            Expanded(
              child: TextField(
                controller: controller,
                onChanged: onChanged,
                textInputAction: TextInputAction.search,
                style: GoogleFonts.spaceGrotesk(
                  fontSize: 17.sp,
                  fontWeight: FontWeight.w700,
                  color: AppColors.textMain,
                ),
                decoration: InputDecoration(
                  filled: false,
                  fillColor: Colors.transparent,
                  border: InputBorder.none,
                  enabledBorder: InputBorder.none,
                  focusedBorder: InputBorder.none,
                  disabledBorder: InputBorder.none,
                  isCollapsed: true,
                  contentPadding: EdgeInsets.symmetric(vertical: 17.h),
                  hintText: 'EPC · SKU · UPC · NAME · BIN',
                  hintStyle: GoogleFonts.spaceGrotesk(
                    fontSize: 14.sp,
                    fontWeight: FontWeight.w700,
                    letterSpacing: 1.0,
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
            if (onCamera != null)
              GestureDetector(
                onTap: onCamera,
                behavior: HitTestBehavior.opaque,
                child: Padding(
                  padding: EdgeInsets.symmetric(horizontal: 6.w),
                  child: Icon(Icons.photo_camera_outlined,
                      size: 22.sp, color: AppColors.primary),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Result-count meta row (just under search)
// ═══════════════════════════════════════════════════════════════════════════

class _ResultMeta extends StatelessWidget {
  const _ResultMeta({
    required this.total,
    required this.loading,
    required this.query,
  });
  final int total;
  final bool loading;
  final String query;

  @override
  Widget build(BuildContext context) {
    final String label;
    if (loading && total == 0) {
      label = 'LOADING…';
    } else if (query.isEmpty) {
      label = '$total CATALOG ROWS · LIVE LOCATION MIRROR';
    } else {
      label = '$total MATCH${total == 1 ? '' : 'ES'}';
    }
    return Padding(
      padding: EdgeInsets.fromLTRB(20.w, 0, 20.w, 8.h),
      child: Align(
        alignment: Alignment.centerLeft,
        child: Text(
          label,
          style: GoogleFonts.spaceGrotesk(
            fontSize: 11.sp,
            fontWeight: FontWeight.w700,
            letterSpacing: 1.4,
            color: const Color(0xFF6D7979),
          ),
        ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Row card — same visual rhythm as _CountItemContainer (read-only).
// ═══════════════════════════════════════════════════════════════════════════

class CatalogRowCard extends StatelessWidget {
  const CatalogRowCard({
    super.key,
    required this.row,
    required this.onQtyTap,
    this.showQty = true,
    this.onTap,
    this.selected = false,
  });

  final Map<String, dynamic> row;
  final VoidCallback onQtyTap;

  /// When false, the right-hand `xN` badge is hidden entirely. Used by
  /// the Encode + Print screens, where qty is irrelevant (the operator
  /// is picking a SKU template, not seeing in-stock count).
  final bool showQty;

  /// When provided, the whole row becomes tappable (Material InkWell
  /// splash on press). The qty-badge tap path is preserved for callers
  /// that don't want full-row tap (Catalog / Status Change keep using
  /// `onQtyTap` for their drill-down semantics).
  final VoidCallback? onTap;

  /// Highlight state for multi-select callers (Print screen). Tapping
  /// a row toggles this externally; the card just renders the visual
  /// difference — primary-teal background + white text when true.
  final bool selected;

  String _formatBin(String? raw) {
    final s = (raw ?? '').trim().toUpperCase().replaceAll(RegExp(r'[-\s]'), '');
    if (s.length == 5) {
      return '${s[0]}-${s[1]}-${s.substring(2, 4)}-${s[4]}';
    }
    return raw?.trim() ?? '';
  }

  @override
  Widget build(BuildContext context) {
    final sku = row['sku']?.toString() ?? '';
    final name = row['name']?.toString() ?? '';
    final color = row['color']?.toString() ?? '';
    final size = row['size']?.toString() ?? '';
    final priceStr = row['retail_price']?.toString();
    final price = double.tryParse(priceStr ?? '');
    // Role-gated: hide retail price when the role can't see it.
    final showPrice =
        context.read<MobilePermissions>().showField(FieldFlags.showRetailPrice);
    final priceText = (showPrice && price != null && price > 0)
        ? '\$${price.toStringAsFixed(2)}'
        : '';
    final qty = (row['active_epc_count'] as num?)?.toInt() ?? 0;
    final binRaw = row['bin_location']?.toString();
    final binText = (binRaw == null || binRaw.isEmpty)
        ? ''
        : 'BIN ${_formatBin(binRaw)}';

    final descParts = <String>[
      if (name.isNotEmpty) name,
      if (color.isNotEmpty) color,
      if (size.isNotEmpty) size,
    ];
    final desc = descParts.join(' · ');

    // Selected rows render in teal-on-white inverse so the operator
    // can scan a search result list and instantly see what's already
    // queued. Used by Print screen's multi-select.
    final fgMain = selected ? Colors.white : AppColors.textMain;
    final fgMuted =
        selected ? Colors.white.withValues(alpha: 0.92) : AppColors.textMain;
    final fgSecondary = selected
        ? Colors.white.withValues(alpha: 0.88)
        : const Color(0xFF3F4A4A);
    final fgPrimary = selected ? Colors.white : AppColors.primary;
    final cardBg = selected ? AppColors.primary : const Color(0xFFECECEC);

    final skuStyle = GoogleFonts.robotoMono(
      fontSize: 19.sp,
      fontWeight: FontWeight.w700,
      color: fgMain,
      height: 1.2,
    );
    final descStyle = GoogleFonts.manrope(
      fontSize: 14.sp,
      fontWeight: FontWeight.w700,
      color: fgMuted,
      height: 1.2,
    );
    final priceStyle = GoogleFonts.manrope(
      fontSize: 14.sp,
      fontWeight: FontWeight.w800,
      color: fgMuted,
      height: 1.2,
    );
    final binStyle = GoogleFonts.manrope(
      fontSize: 13.sp,
      fontWeight: FontWeight.w700,
      color: fgSecondary,
      letterSpacing: 0.2,
      height: 1.2,
    );
    final qtyStyle = GoogleFonts.spaceGrotesk(
      fontSize: 26.sp,
      fontWeight: FontWeight.w800,
      color: fgPrimary,
      height: 1.2,
    );

    final body = Padding(
      padding: const EdgeInsets.fromLTRB(12, 8, 8, 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Expanded(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.baseline,
                  textBaseline: TextBaseline.alphabetic,
                  children: [
                    Expanded(
                      child: Text(
                        sku.isEmpty ? 'SKU: —' : 'SKU: $sku',
                        style: skuStyle,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    if (priceText.isNotEmpty) ...[
                      SizedBox(width: 8.w),
                      Text(priceText, style: priceStyle),
                    ],
                  ],
                ),
                if (desc.isNotEmpty) ...[
                  SizedBox(height: 3.h),
                  Text(
                    desc,
                    style: descStyle,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
                if (binText.isNotEmpty) ...[
                  SizedBox(height: 2.h),
                  Text(
                    binText,
                    style: binStyle,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ],
            ),
          ),
          if (showQty) ...[
            SizedBox(width: 4.w),
            GestureDetector(
              onTap: qty > 0 ? onQtyTap : null,
              behavior: HitTestBehavior.opaque,
              child: Padding(
                padding: const EdgeInsets.only(left: 6, right: 12),
                child: Text('x$qty', style: qtyStyle),
              ),
            ),
          ],
        ],
      ),
    );

    // Whole-row tappable variant (Encode screen) — InkWell gives a press
    // splash that's our "you tapped me" affordance. Default callers keep
    // the legacy "tap on x N badge only" semantics.
    if (onTap != null) {
      return Material(
        color: cardBg,
        borderRadius: BorderRadius.zero,
        child: InkWell(
          onTap: onTap,
          child: body,
        ),
      );
    }
    return Material(
      color: cardBg,
      borderRadius: BorderRadius.zero,
      child: body,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// EPC drilldown — mirrors _CountEpcListScreen but data-fetched, with the
// sensors button (LocateTag) on every row exactly like Count.
// ═══════════════════════════════════════════════════════════════════════════

class CatalogEpcListScreen extends StatefulWidget {
  const CatalogEpcListScreen({
    super.key,
    required this.customSkuId,
    required this.row,
    required this.api,
  });

  final String customSkuId;
  final Map<String, dynamic> row;
  final WmsApiClient api;

  @override
  State<CatalogEpcListScreen> createState() => _CatalogEpcListScreenState();
}

class _CatalogEpcListScreenState extends State<CatalogEpcListScreen> {
  bool _loading = true;
  String? _error;
  List<Map<String, dynamic>> _epcs = const [];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final res = await widget.api.fetchCatalogEpcs(widget.customSkuId);
      if (!mounted) return;
      // Sort by serial number ascending so EPCs read in the order they were
      // commissioned — matches the catalog web view's default ordering.
      final sorted = List<Map<String, dynamic>>.from(res)
        ..sort((a, b) {
          final sa = int.tryParse(a['serial_number']?.toString() ?? '') ?? 0;
          final sb = int.tryParse(b['serial_number']?.toString() ?? '') ?? 0;
          return sa.compareTo(sb);
        });
      setState(() {
        _epcs = sorted;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = 'Load EPCs failed: $e';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final sku = widget.row['sku']?.toString() ?? '';
    final name = widget.row['name']?.toString() ?? '';
    final color = widget.row['color']?.toString() ?? '';
    final size = widget.row['size']?.toString() ?? '';
    final priceStr = widget.row['retail_price']?.toString();
    final price = double.tryParse(priceStr ?? '');
    final priceText =
        (price != null && price > 0) ? '\$${price.toStringAsFixed(2)}' : '';
    final binRaw = widget.row['bin_location']?.toString();
    final binText = binRaw == null || binRaw.isEmpty ? '' : binRaw;

    return CarbonScaffold(
      pageTitle: 'EPCS',
      body: Column(
        children: [
          // Drilldown header — same SKU + ITEM + color/size + bin format as
          // the Count screen's _CountEpcListScreen so the operator's eye
          // tracks consistently.
          Container(
            color: const Color(0xFFECECEC),
            padding: EdgeInsets.fromLTRB(16.w, 12.h, 16.w, 12.h),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _LabeledRow(
                  label: 'SKU',
                  value: sku.isEmpty ? '—' : sku,
                  trailing: priceText.isNotEmpty ? priceText : null,
                ),
                if (name.isNotEmpty) _LabeledRow(label: 'ITEM', value: name),
                if (color.isNotEmpty || size.isNotEmpty)
                  _LabeledRow(
                    label: 'VARIANT',
                    value:
                        [color, size].where((s) => s.isNotEmpty).join(' · '),
                  ),
                if (binText.isNotEmpty)
                  _LabeledRow(label: 'BIN', value: binText),
              ],
            ),
          ),
          if (_error != null)
            Padding(
              padding: EdgeInsets.all(12.r),
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
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : _epcs.isEmpty
                    ? Center(
                        child: Padding(
                          padding: EdgeInsets.all(24.r),
                          child: Text(
                            'No EPCs commissioned for this SKU.',
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
                        padding: EdgeInsets.fromLTRB(16.w, 8.h, 16.w, 12.h),
                        itemCount: _epcs.length,
                        separatorBuilder: (_, __) => Divider(height: 1.h),
                        itemBuilder: (_, i) {
                          final e = _epcs[i];
                          final epc = (e['epc']?.toString() ?? '').toUpperCase();
                          final serial = e['serial_number']?.toString() ?? '—';
                          final status = e['status']?.toString() ?? '';
                          final binCode = e['bin_code']?.toString() ?? '';
                          return Padding(
                            padding: EdgeInsets.symmetric(vertical: 8.h),
                            child: Row(
                              crossAxisAlignment: CrossAxisAlignment.center,
                              children: [
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    mainAxisSize: MainAxisSize.min,
                                    children: [
                                      Text(
                                        epc.isEmpty ? '—' : epc,
                                        style: GoogleFonts.robotoMono(
                                          fontSize: 17.sp,
                                          fontWeight: FontWeight.w700,
                                          color: AppColors.textMain,
                                          height: 1.2,
                                        ),
                                      ),
                                      SizedBox(height: 3.h),
                                      Text(
                                        [
                                          'serial: $serial',
                                          if (status.isNotEmpty) status,
                                        ].join(' · '),
                                        style: GoogleFonts.manrope(
                                          fontSize: 13.sp,
                                          fontWeight: FontWeight.w700,
                                          color: const Color(0xFF3F4A4A),
                                          height: 1.2,
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                                SizedBox(width: 8.w),
                                // Dedicated per-EPC bin location — the bin this
                                // exact chip is pinned to. Muted '—' when the
                                // chip has no bin on file.
                                _EpcBinPill(
                                    binCode:
                                        (binCode.isEmpty || binCode == '—')
                                            ? ''
                                            : binCode),
                                SizedBox(width: 8.w),
                                Tooltip(
                                  message: 'Locate this tag (Geiger)',
                                  child: IconButton(
                                    iconSize: 40.sp,
                                    padding: EdgeInsets.all(8.w),
                                    constraints: BoxConstraints(
                                      minWidth: 56.w,
                                      minHeight: 56.w,
                                    ),
                                    icon: Icon(Icons.sensors,
                                        size: 40.sp,
                                        color: AppColors.primary),
                                    onPressed: epc.isEmpty
                                        ? null
                                        : () {
                                            Navigator.of(context).push<void>(
                                              MaterialPageRoute<void>(
                                                builder: (_) =>
                                                    LocateTagScreen(
                                                  targetEpc: epc,
                                                  targetBin: binCode.isEmpty
                                                      ? null
                                                      : binCode,
                                                  targetSku: sku.isEmpty
                                                      ? null
                                                      : sku,
                                                  targetName: name.isEmpty
                                                      ? null
                                                      : name,
                                                  targetColor: color.isEmpty
                                                      ? null
                                                      : color,
                                                  targetSize: size.isEmpty
                                                      ? null
                                                      : size,
                                                  targetPriceText:
                                                      priceText.isEmpty
                                                          ? null
                                                          : priceText,
                                                ),
                                              ),
                                            );
                                          },
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
    );
  }
}

/// Compact per-EPC bin badge on the EPCs drilldown list. Teal-tinted with the
/// bin code when the chip is pinned to a bin; muted '—' when it has none.
class _EpcBinPill extends StatelessWidget {
  const _EpcBinPill({required this.binCode});
  final String binCode;

  @override
  Widget build(BuildContext context) {
    final has = binCode.isNotEmpty;
    return Container(
      constraints: BoxConstraints(minWidth: 56.w),
      padding: EdgeInsets.symmetric(horizontal: 10.w, vertical: 6.h),
      decoration: BoxDecoration(
        color: has ? const Color(0xFFEAF3F2) : const Color(0xFFF0F2F2),
        borderRadius: BorderRadius.circular(6.r),
        border: Border.all(color: const Color(0xFFD7DEDE)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            'BIN',
            style: GoogleFonts.spaceGrotesk(
              fontSize: 10.sp,
              fontWeight: FontWeight.w800,
              letterSpacing: 1.2,
              color: const Color(0xFF8A9090),
              height: 1.1,
            ),
          ),
          SizedBox(height: 2.h),
          Text(
            has ? binCode : '—',
            textAlign: TextAlign.center,
            style: GoogleFonts.robotoMono(
              fontSize: 15.sp,
              fontWeight: FontWeight.w700,
              color: has ? AppColors.primary : const Color(0xFF8A9090),
              height: 1.15,
            ),
          ),
        ],
      ),
    );
  }
}

class _LabeledRow extends StatelessWidget {
  const _LabeledRow({
    required this.label,
    required this.value,
    this.trailing,
  });
  final String label;
  final String value;
  final String? trailing;

  @override
  Widget build(BuildContext context) {
    final labelStyle = GoogleFonts.spaceGrotesk(
      fontSize: 12.sp,
      fontWeight: FontWeight.w800,
      color: const Color(0xFF5A6464),
      letterSpacing: 1.6,
      height: 1.2,
    );
    final valueStyle = GoogleFonts.manrope(
      fontSize: 16.sp,
      fontWeight: FontWeight.w700,
      color: AppColors.textMain,
      height: 1.25,
    );
    final trailingStyle = GoogleFonts.manrope(
      fontSize: 16.sp,
      fontWeight: FontWeight.w800,
      color: AppColors.textMain,
      height: 1.25,
    );
    return Padding(
      padding: EdgeInsets.only(bottom: 4.h),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.baseline,
        textBaseline: TextBaseline.alphabetic,
        children: [
          Text(label, style: labelStyle),
          SizedBox(width: 6.w),
          Expanded(child: Text(value, style: valueStyle)),
          if (trailing != null) Text(trailing!, style: trailingStyle),
        ],
      ),
    );
  }
}
