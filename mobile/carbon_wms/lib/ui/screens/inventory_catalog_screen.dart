import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/screens/locate_tag_screen.dart';
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
            ),
          ),
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
  const CatalogRowCard({super.key, required this.row, required this.onQtyTap});

  final Map<String, dynamic> row;
  final VoidCallback onQtyTap;

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
    final priceText =
        (price != null && price > 0) ? '\$${price.toStringAsFixed(2)}' : '';
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

    final skuStyle = GoogleFonts.robotoMono(
      fontSize: 19.sp,
      fontWeight: FontWeight.w700,
      color: AppColors.textMain,
      height: 1.2,
    );
    final descStyle = GoogleFonts.manrope(
      fontSize: 14.sp,
      fontWeight: FontWeight.w700,
      color: AppColors.textMain,
      height: 1.2,
    );
    final priceStyle = GoogleFonts.manrope(
      fontSize: 14.sp,
      fontWeight: FontWeight.w800,
      color: AppColors.textMain,
      height: 1.2,
    );
    final binStyle = GoogleFonts.manrope(
      fontSize: 13.sp,
      fontWeight: FontWeight.w700,
      color: const Color(0xFF3F4A4A),
      letterSpacing: 0.2,
      height: 1.2,
    );
    final qtyStyle = GoogleFonts.spaceGrotesk(
      fontSize: 26.sp,
      fontWeight: FontWeight.w800,
      color: AppColors.primary,
      height: 1.2,
    );

    return Material(
      color: const Color(0xFFECECEC),
      borderRadius: BorderRadius.zero,
      child: Padding(
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
        ),
      ),
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
                                          if (binCode.isNotEmpty)
                                            'BIN $binCode',
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
