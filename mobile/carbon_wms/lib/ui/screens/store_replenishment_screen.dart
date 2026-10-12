import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/screens/inventory_catalog_screen.dart'
    show CatalogEpcListScreen;
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart' show CarbonScaffold;

/// Store Replenishment (Find & Locate) — refill the showroom from the back.
///
/// 1. Sales: the showroom's POS sales (completed; refunds hidden), TODAY by
///    default (date range top-left), newest first, grouped by day — number,
///    then time · customer · employee, and the number of items sold on the
///    right. Day and time are the STORE's (Orlando), from the server, so a
///    phone with a wrong clock zone still shows the right time. A sale turns
///    GREEN once every item that has stock has been picked.
/// 2. Tap a sale → its sold items, Cloud + Geiger style, in pick order (bin,
///    then name): SKU, name, colour, size, BIN and SOLD (large), and the LIVE
///    stock count on the right. Only items with stock are listed; SHOW ALL
///    adds the rest, greyed out, no checkbox.
/// 3. Tap the stock count → the live EPCs of that item (bin per EPC, SKU /
///    item / variant / price on top); the radio icon opens Locate Tag.
/// 4. The checkbox = found and pulled to the showroom. It changes NO stock;
///    it is saved on the server so every handheld sees the same progress.
///
/// Server: /api/mobile/store-replenishment/* (lib/server/store-replenishment.ts).
const Color _kCardGrey = Color(0xFFECECEC);
const Color _kCardDone = Color(0xFFD6F5E6);
const Color _kGreen = Color(0xFF16A34A);
const Color _kTextMuted = Color(0xFF8A9090);
const Color _kLightTeal = Color(0xFF2BA3A3);
const Color _kDisabledGrey = Color(0xFFBCC9C9);

const List<String> _kMonths = [
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
];

/// Calendar day as the server's YYYY-MM-DD (the picker's dates are plain
/// calendar days, so no time zone is involved).
String _ymd(DateTime d) =>
    '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

String? _s(Map<String, dynamic> m, String k) {
  final v = m[k];
  if (v == null) return null;
  final t = v.toString().trim();
  return t.isEmpty ? null : t;
}

int _i(Map<String, dynamic> m, String k) =>
    (m[k] is num) ? (m[k] as num).toInt() : int.tryParse('${m[k]}') ?? 0;

String _apiError(Object e) {
  if (e is WmsApiException) {
    if (e.statusCode == 401) return 'Signed out — sign in again.';
    return 'Server error ${e.statusCode}';
  }
  return e.toString();
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Sales
// ═══════════════════════════════════════════════════════════════════════════

class StoreReplenishmentScreen extends StatefulWidget {
  const StoreReplenishmentScreen({super.key});

  @override
  State<StoreReplenishmentScreen> createState() =>
      _StoreReplenishmentScreenState();
}

class _StoreReplenishmentScreenState extends State<StoreReplenishmentScreen> {
  bool _loading = true;
  String? _error;
  List<Map<String, dynamic>> _sales = const [];
  DateTimeRange? _range; // null = today (in the store's time zone)

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
      final api = context.read<WmsApiClient>();
      final r = _range;
      final rows = await api.fetchReplenishmentSales(
        fromDate: r == null ? null : _ymd(r.start),
        toDate: r == null ? null : _ymd(r.end),
      );
      if (!mounted) return;
      setState(() {
        _sales = rows;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = 'Could not load sales: ${_apiError(e)}';
      });
    }
  }

  Future<void> _pickRange() async {
    final now = DateTime.now();
    final picked = await showDateRangePicker(
      context: context,
      firstDate: DateTime(2026, 1, 1),
      lastDate: DateTime(now.year, now.month, now.day),
      initialDateRange: _range ??
          DateTimeRange(
            start: DateTime(now.year, now.month, now.day),
            end: DateTime(now.year, now.month, now.day),
          ),
    );
    if (picked == null) return;
    setState(() => _range = picked);
    unawaited(_load());
  }

  Future<void> _openSale(Map<String, dynamic> sale) async {
    await Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder: (_) => ReplenishmentSaleScreen(
          saleId: _i(sale, 'id'),
          saleNumber: _s(sale, 'saleNumber') ?? '',
        ),
      ),
    );
    // Picks made inside may have finished the sale (→ green).
    if (mounted) unawaited(_load());
  }

  String get _rangeLabel {
    final r = _range;
    if (r == null) return 'TODAY';
    String d(DateTime x) => '${_kMonths[x.month - 1]} ${x.day}';
    return r.start == r.end ? d(r.start) : '${d(r.start)} – ${d(r.end)}';
  }

  @override
  Widget build(BuildContext context) {
    final done = _sales.where((s) => s['complete'] == true).length;
    return CarbonScaffold(
      pageTitle: 'store replenishment',
      body: ColoredBox(
        color: Colors.white,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _HeaderStrip(
              left: _rangeLabel,
              right: _sales.isEmpty
                  ? 'SHOWROOM SALES'
                  : 'DONE $done / ${_sales.length}',
              onLeftTap: _pickRange,
            ),
            if (_error != null) _ErrorStrip(_error!),
            Expanded(child: _buildBody()),
            _BottomBar(
              children: [
                _BarButton(
                  icon: Icons.refresh,
                  onPressed: _loading ? null : _load,
                ),
                _BarButton(
                  icon: Icons.date_range,
                  label: 'DATES',
                  onPressed: _pickRange,
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildBody() {
    if (_loading && _sales.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_sales.isEmpty) {
      return const _Empty(
        icon: LucideIcons.store,
        title: 'No showroom sales',
        subtitle: 'Completed POS sales in this date range appear here.',
      );
    }
    // Group by local day, newest first (the server already sorts).
    final children = <Widget>[];
    String? lastDay;
    for (final sale in _sales) {
      final day = _s(sale, 'localDay') ?? '';
      if (day != lastDay) {
        children.add(_DayHeader(day));
        lastDay = day;
      }
      children.add(Padding(
        padding: EdgeInsets.only(bottom: 12.h),
        child: _SaleCard(sale: sale, onTap: () => _openSale(sale)),
      ));
    }
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: EdgeInsets.fromLTRB(20.w, 4.h, 20.w, 16.h),
        children: children,
      ),
    );
  }
}

class _SaleCard extends StatelessWidget {
  const _SaleCard({required this.sale, required this.onTap});

  final Map<String, dynamic> sale;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final complete = sale['complete'] == true;
    final sold = _i(sale, 'soldQty');
    final pickable = _i(sale, 'pickableLines');
    final picked = _i(sale, 'pickedLines');
    // Owner's order: time · customer · employee.
    final people = [
      if (_s(sale, 'localTime') != null) _s(sale, 'localTime')!,
      _s(sale, 'customer') ?? 'No customer',
      _s(sale, 'employee') ?? 'No employee',
    ].join(' · ');
    final progress = pickable == 0
        ? 'NOTHING IN STOCK TO PICK'
        : complete
            ? 'REPLENISHED · $picked / $pickable'
            : 'PICKED $picked / $pickable';
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Container(
        color: complete ? _kCardDone : _kCardGrey,
        child: IntrinsicHeight(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Container(width: 4, color: complete ? _kGreen : AppColors.primary),
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(12, 10, 8, 10),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        '#${_s(sale, 'saleNumber') ?? ''}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 18,
                          fontWeight: FontWeight.w700,
                          color: Color(0xFF171D1D),
                          fontFamily: 'monospace',
                          height: 1.2,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        people.toUpperCase(),
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 14,
                          fontWeight: FontWeight.w700,
                          color: AppColors.textMain,
                          height: 1.25,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        progress,
                        style: GoogleFonts.spaceGrotesk(
                          fontSize: 11.sp,
                          fontWeight: FontWeight.w800,
                          letterSpacing: 1.2,
                          color: complete ? _kGreen : _kTextMuted,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              _CountBlock(
                count: sold,
                caption: 'SOLD',
                color: complete ? _kGreen : AppColors.primary,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. One sale's items
// ═══════════════════════════════════════════════════════════════════════════

class ReplenishmentSaleScreen extends StatefulWidget {
  const ReplenishmentSaleScreen({
    super.key,
    required this.saleId,
    required this.saleNumber,
  });

  final int saleId;
  final String saleNumber;

  @override
  State<ReplenishmentSaleScreen> createState() =>
      _ReplenishmentSaleScreenState();
}

class _ReplenishmentSaleScreenState extends State<ReplenishmentSaleScreen> {
  bool _loading = true;
  bool _showAll = false;
  String? _error;
  List<Map<String, dynamic>> _lines = const [];
  final Set<int> _saving = <int>{};

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
      final api = context.read<WmsApiClient>();
      final r = await api.fetchReplenishmentSale(widget.saleId);
      final lines = r['lines'];
      if (!mounted) return;
      setState(() {
        _lines = lines is List
            ? lines.whereType<Map<String, dynamic>>().toList()
            : const [];
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = 'Could not load the sale: ${_apiError(e)}';
      });
    }
  }

  Future<void> _togglePicked(Map<String, dynamic> line, bool picked) async {
    final id = _i(line, 'lineId');
    if (_saving.contains(id)) return;
    setState(() {
      _saving.add(id);
      line['picked'] = picked; // optimistic
    });
    try {
      await context.read<WmsApiClient>().setReplenishmentPicked(id, picked);
    } catch (e) {
      if (!mounted) return;
      setState(() => line['picked'] = !picked);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Not saved: ${_apiError(e)}')),
      );
    } finally {
      if (mounted) setState(() => _saving.remove(id));
    }
  }

  Future<void> _openEpcs(Map<String, dynamic> line) async {
    final skuId = _s(line, 'customSkuId');
    if (skuId == null) return;
    await Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder: (_) => CatalogEpcListScreen(
          customSkuId: skuId,
          api: context.read<WmsApiClient>(),
          liveOnly: true,
          row: {
            'sku': _s(line, 'sku') ?? '',
            'name': _s(line, 'name') ?? '',
            'color': _s(line, 'color') ?? '',
            'size': _s(line, 'size') ?? '',
            'retail_price': line['retailPrice'],
            'bin_location': _s(line, 'bin') ?? '',
          },
        ),
      ),
    );
    // Stock can move while the operator is away (sold, killed, …).
    if (mounted) unawaited(_load());
  }

  @override
  Widget build(BuildContext context) {
    final pickable = _lines.where((l) => l['pickable'] == true).toList();
    final hidden = _lines.length - pickable.length;
    final picked = pickable.where((l) => l['picked'] == true).length;
    final complete = pickable.isNotEmpty && picked == pickable.length;
    final visible = _showAll ? _lines : pickable;
    return CarbonScaffold(
      pageTitle: '#${widget.saleNumber}',
      body: ColoredBox(
        color: Colors.white,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _HeaderStrip(
              left: complete ? 'REPLENISHED' : 'TO PICK',
              leftColor: complete ? _kGreen : null,
              right: pickable.isEmpty
                  ? 'NOTHING IN STOCK'
                  : 'PICKED $picked / ${pickable.length}',
            ),
            if (_error != null) _ErrorStrip(_error!),
            Expanded(
              child: _loading && _lines.isEmpty
                  ? const Center(child: CircularProgressIndicator())
                  : visible.isEmpty
                      ? _Empty(
                          icon: LucideIcons.packageX,
                          title: 'Nothing in stock to pick',
                          subtitle: hidden > 0
                              ? 'Tap SHOW ALL to see the $hidden sold item${hidden == 1 ? '' : 's'} with no stock.'
                              : 'This sale has no items.',
                        )
                      : RefreshIndicator(
                          onRefresh: _load,
                          child: ListView.separated(
                            padding:
                                EdgeInsets.fromLTRB(20.w, 12.h, 20.w, 16.h),
                            itemCount: visible.length,
                            separatorBuilder: (_, __) => SizedBox(height: 12.h),
                            itemBuilder: (_, i) {
                              final line = visible[i];
                              return _LineCard(
                                line: line,
                                saving: _saving.contains(_i(line, 'lineId')),
                                onPicked: (v) => _togglePicked(line, v),
                                onStockTap: () => _openEpcs(line),
                              );
                            },
                          ),
                        ),
            ),
            _BottomBar(
              children: [
                _BarButton(
                  icon: Icons.refresh,
                  onPressed: _loading ? null : _load,
                ),
                _BarButton(
                  icon: _showAll ? Icons.visibility_off : Icons.visibility,
                  label: _showAll ? 'IN STOCK ONLY' : 'SHOW ALL',
                  primary: true,
                  onPressed: () => setState(() => _showAll = !_showAll),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _LineCard extends StatelessWidget {
  const _LineCard({
    required this.line,
    required this.saving,
    required this.onPicked,
    required this.onStockTap,
  });

  final Map<String, dynamic> line;
  final bool saving;
  final ValueChanged<bool> onPicked;
  final VoidCallback onStockTap;

  @override
  Widget build(BuildContext context) {
    final pickable = line['pickable'] == true;
    final picked = pickable && line['picked'] == true;
    final stock = _i(line, 'inStock');
    final sold = _i(line, 'soldQty');
    final sku = _s(line, 'sku');
    final desc = [
      _s(line, 'name'),
      _s(line, 'color'),
      _s(line, 'size'),
    ].whereType<String>().join(' · ').toUpperCase();
    final bin = _s(line, 'bin');
    final pickedBy = _s(line, 'pickedBy');
    final textColor = pickable ? AppColors.textMain : _kTextMuted;

    return Opacity(
      opacity: pickable ? 1 : 0.55,
      child: Container(
        color: picked ? _kCardDone : _kCardGrey,
        child: IntrinsicHeight(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Container(
                width: 4,
                color: !pickable
                    ? _kDisabledGrey
                    : picked
                        ? _kGreen
                        : AppColors.primary,
              ),
              // Checkbox only for items with stock to pick.
              if (pickable)
                SizedBox(
                  width: 48,
                  child: Center(
                    child: saving
                        ? const SizedBox(
                            width: 22,
                            height: 22,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : Transform.scale(
                            scale: 1.35,
                            child: Checkbox(
                              value: picked,
                              activeColor: _kGreen,
                              onChanged: (v) => onPicked(v ?? false),
                            ),
                          ),
                  ),
                )
              else
                const SizedBox(width: 12),
              Expanded(
                child: GestureDetector(
                  onTap: pickable ? () => onPicked(!picked) : null,
                  behavior: HitTestBehavior.opaque,
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(4, 10, 8, 10),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          sku == null ? 'NO CATALOG ITEM' : 'SKU: $sku',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 17,
                            fontWeight: FontWeight.w700,
                            color: textColor,
                            fontFamily: 'monospace',
                            height: 1.2,
                          ),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          desc.isEmpty ? '—' : desc,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 14,
                            fontWeight: FontWeight.w700,
                            color: textColor,
                            height: 1.2,
                          ),
                        ),
                        const SizedBox(height: 6),
                        // Where to walk and how many — large and black.
                        Text(
                          'BIN ${bin ?? '—'}   ·   SOLD $sold',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: GoogleFonts.spaceGrotesk(
                            fontSize: 18.sp,
                            fontWeight: FontWeight.w900,
                            letterSpacing: 0.4,
                            color: pickable ? Colors.black : _kTextMuted,
                            height: 1.15,
                          ),
                        ),
                        if (!pickable || (picked && pickedBy != null)) ...[
                          const SizedBox(height: 3),
                          Text(
                            !pickable
                                ? 'OUT OF STOCK'
                                : 'PICKED BY ${pickedBy!.toUpperCase()}',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: GoogleFonts.spaceGrotesk(
                              fontSize: 11.sp,
                              fontWeight: FontWeight.w800,
                              letterSpacing: 1.0,
                              color: picked ? _kGreen : _kTextMuted,
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                ),
              ),
              GestureDetector(
                onTap: pickable ? onStockTap : null,
                behavior: HitTestBehavior.opaque,
                child: _CountBlock(
                  count: stock,
                  caption: 'IN STOCK',
                  color: !pickable
                      ? _kDisabledGrey
                      : picked
                          ? _kGreen
                          : AppColors.primary,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Shared pieces (Cloud + Geiger look)
// ═══════════════════════════════════════════════════════════════════════════

class _CountBlock extends StatelessWidget {
  const _CountBlock({
    required this.count,
    required this.caption,
    required this.color,
  });

  final int count;
  final String caption;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 64,
      color: color,
      alignment: Alignment.center,
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            '$count',
            style: GoogleFonts.spaceGrotesk(
              fontSize: 24.sp,
              fontWeight: FontWeight.w900,
              color: Colors.white,
              height: 1.0,
            ),
          ),
          const SizedBox(height: 2),
          Text(
            caption,
            textAlign: TextAlign.center,
            style: GoogleFonts.spaceGrotesk(
              fontSize: 8.sp,
              fontWeight: FontWeight.w800,
              letterSpacing: 0.8,
              color: Colors.white,
            ),
          ),
        ],
      ),
    );
  }
}

class _HeaderStrip extends StatelessWidget {
  const _HeaderStrip({
    required this.left,
    required this.right,
    this.leftColor,
    this.onLeftTap,
  });

  final String left;
  final String right;
  final Color? leftColor;
  final VoidCallback? onLeftTap;

  @override
  Widget build(BuildContext context) {
    final c = leftColor ?? Colors.black;
    return Container(
      width: double.infinity,
      color: const Color(0xFFF0F5F4),
      padding: EdgeInsets.fromLTRB(20.w, 8.h, 20.w, 8.h),
      child: Row(
        children: [
          GestureDetector(
            onTap: onLeftTap,
            child: Container(
              padding: EdgeInsets.symmetric(horizontal: 10.w, vertical: 5.h),
              color: c.withValues(alpha: 0.12),
              child: Text(
                left,
                style: GoogleFonts.spaceGrotesk(
                  fontSize: 15.sp,
                  fontWeight: FontWeight.w900,
                  letterSpacing: 1.2,
                  color: c,
                ),
              ),
            ),
          ),
          SizedBox(width: 10.w),
          Expanded(
            child: Text(
              right,
              textAlign: TextAlign.right,
              style: GoogleFonts.spaceGrotesk(
                fontSize: 16.sp,
                fontWeight: FontWeight.w900,
                letterSpacing: 1.2,
                color: Colors.black,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _DayHeader extends StatelessWidget {
  const _DayHeader(this.label);
  final String label;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(top: 12.h, bottom: 8.h),
      child: Text(
        label,
        style: GoogleFonts.spaceGrotesk(
          fontSize: 16.sp,
          fontWeight: FontWeight.w900,
          letterSpacing: 1.2,
          color: Colors.black,
        ),
      ),
    );
  }
}

class _ErrorStrip extends StatelessWidget {
  const _ErrorStrip(this.text);
  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      color: const Color(0xFFFFF4F4),
      padding: EdgeInsets.symmetric(horizontal: 16.w, vertical: 8.h),
      child: Text(
        text,
        style: GoogleFonts.spaceGrotesk(
          fontSize: 12.sp,
          fontWeight: FontWeight.w700,
          color: const Color(0xFFD9534F),
        ),
      ),
    );
  }
}

class _Empty extends StatelessWidget {
  const _Empty({required this.icon, required this.title, required this.subtitle});
  final IconData icon;
  final String title;
  final String subtitle;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: EdgeInsets.symmetric(horizontal: 24.w),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 48.sp, color: _kTextMuted),
            SizedBox(height: 12.h),
            Text(
              title,
              textAlign: TextAlign.center,
              style: GoogleFonts.spaceGrotesk(
                fontSize: 18.sp,
                fontWeight: FontWeight.w800,
                color: AppColors.textMain,
              ),
            ),
            SizedBox(height: 6.h),
            Text(
              subtitle,
              textAlign: TextAlign.center,
              style: GoogleFonts.spaceGrotesk(
                fontSize: 13.sp,
                color: _kTextMuted,
                height: 1.35,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _BottomBar extends StatelessWidget {
  const _BottomBar({required this.children});
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final spaced = <Widget>[];
    for (var i = 0; i < children.length; i++) {
      if (i > 0) spaced.add(SizedBox(width: 8.w));
      spaced.add(Expanded(child: children[i]));
    }
    return Padding(
      padding: EdgeInsets.fromLTRB(20.w, 10.h, 20.w, 10.h),
      child: Row(children: spaced),
    );
  }
}

class _BarButton extends StatelessWidget {
  const _BarButton({
    required this.icon,
    required this.onPressed,
    this.label,
    this.primary = false,
  });

  final IconData icon;
  final VoidCallback? onPressed;
  final String? label;
  final bool primary;

  @override
  Widget build(BuildContext context) {
    final style = FilledButton.styleFrom(
      backgroundColor: primary ? AppColors.primary : _kLightTeal,
      disabledBackgroundColor: _kDisabledGrey,
      foregroundColor: Colors.white,
      padding: EdgeInsets.zero,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
    );
    return SizedBox(
      height: 48,
      child: label == null
          ? FilledButton(
              onPressed: onPressed,
              style: style,
              child: Icon(icon, size: 22),
            )
          : FilledButton.icon(
              onPressed: onPressed,
              style: style,
              icon: Icon(icon, size: 18, color: Colors.white),
              label: Text(
                label!,
                style: GoogleFonts.spaceGrotesk(
                  fontSize: 14.sp,
                  fontWeight: FontWeight.w900,
                  letterSpacing: 1.6,
                ),
              ),
            ),
    );
  }
}
