import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/report_csv_export.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';

/// Reports → Counts → Combine & review (owner, 2026-10-15).
///
/// The phone twin of the web page /reports/count-sessions/review: pick a Count
/// file and the Add-On files scanned against it, see the combined result
/// against the live WMS, then push it once — add to current stock, or override
/// the entire stock (every live tag here the count did not see → unknown).
/// All the rules live on the server (lib/server/count-review.ts); this screen
/// only shows them and sends the choice.
class CountReviewScreen extends StatefulWidget {
  const CountReviewScreen({super.key});

  @override
  State<CountReviewScreen> createState() => _CountReviewScreenState();
}

const _red = Color(0xFFBF2E2E);
const _amber = Color(0xFFB7791F);
const _muted = Color(0xFF6D7979);

/// Server error body → one readable line.
String _errText(Object e) {
  if (e is WmsApiException) {
    try {
      final j = jsonDecode(e.body);
      if (j is Map && j['error'] != null) return j['error'].toString();
    } catch (_) {}
    return 'HTTP ${e.statusCode}';
  }
  return e.toString();
}

String _when(String? iso) {
  final d = DateTime.tryParse(iso ?? '')?.toLocal();
  if (d == null) return '—';
  String two(int n) => n.toString().padLeft(2, '0');
  final h = d.hour % 12 == 0 ? 12 : d.hour % 12;
  return '${two(d.month)}/${two(d.day)}/${d.year} $h:${two(d.minute)} ${d.hour < 12 ? 'AM' : 'PM'}';
}

String _day(String? iso) {
  final d = DateTime.tryParse(iso ?? '')?.toLocal();
  if (d == null) return '—';
  String two(int n) => n.toString().padLeft(2, '0');
  return '${two(d.month)}/${two(d.day)}/${d.year}';
}

String _n(num v) {
  final s = v.toInt().toString();
  return s.replaceAllMapped(RegExp(r'\B(?=(\d{3})+(?!\d))'), (_) => ',');
}

List<Map<String, dynamic>> _list(Map<String, dynamic>? m, String key) =>
    ((m?[key] as List?) ?? const []).whereType<Map<String, dynamic>>().toList();

class _CountReviewScreenState extends State<CountReviewScreen> {
  bool _loadingFiles = false;
  String? _error;
  List<Map<String, dynamic>> _files = [];
  bool _isSuperAdmin = false;
  final Set<String> _selected = {};

  Map<String, dynamic>? _review;
  List<String> _reviewedIds = [];
  bool _reviewing = false;
  bool _pushing = false;
  String _mode = 'add';
  final TextEditingController _confirm = TextEditingController();
  final Set<String> _revive = {};
  bool _zeroManual = false;
  Map<String, dynamic>? _result;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _loadFiles());
  }

  @override
  void dispose() {
    _confirm.dispose();
    super.dispose();
  }

  Future<void> _loadFiles() async {
    setState(() {
      _loadingFiles = true;
      _error = null;
    });
    try {
      final res = await context.read<WmsApiClient>().fetchCountReviewFiles();
      if (!mounted) return;
      setState(() {
        _files = _list(res, 'files');
        _isSuperAdmin = res['isSuperAdmin'] == true;
        _loadingFiles = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loadingFiles = false;
        _error = 'Could not load the count files: ${_errText(e)}';
      });
    }
  }

  Future<void> _runReview() async {
    if (_selected.isEmpty) return;
    final ids = _selected.toList();
    setState(() {
      _reviewing = true;
      _error = null;
      _result = null;
      _revive.clear();
      _confirm.clear();
      _zeroManual = false;
    });
    try {
      final res = await context.read<WmsApiClient>().postCountReview(ids);
      if (!mounted) return;
      setState(() {
        _review = res['review'] as Map<String, dynamic>?;
        _isSuperAdmin = res['isSuperAdmin'] == true || _isSuperAdmin;
        _reviewedIds = ids;
        _reviewing = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _reviewing = false;
        _error = 'Review failed: ${_errText(e)}';
      });
    }
  }

  Future<void> _push() async {
    final rv = _review;
    if (rv == null) return;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(_mode == 'override' ? 'Override entire stock?' : 'Add to current stock?'),
        content: Text(
          _mode == 'override'
              ? '${_n(_goLive(rv))} tags go live and ${_n((rv['missingTotal'] as num?) ?? 0)} live tags that were not scanned go to unknown.'
                  '${_zeroManual ? ' Non-RFID manual stock is zeroed.' : ''}'
              : '${_n(_goLive(rv))} tags go live. Nothing else changes.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('CANCEL')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('PUSH')),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    setState(() {
      _pushing = true;
      _error = null;
    });
    try {
      final res = await context.read<WmsApiClient>().postCountPush(
            reportIds: _reviewedIds,
            mode: _mode,
            confirmZeroCount: _mode == 'override' ? int.tryParse(_confirm.text.trim()) : null,
            reviveEpcs: _revive.toList(),
            zeroManual: _mode == 'override' && _zeroManual,
          );
      if (!mounted) return;
      setState(() {
        _result = res['result'] as Map<String, dynamic>?;
        _pushing = false;
        _selected.clear();
      });
      await _loadFiles();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _pushing = false;
        _error = 'Push failed: ${_errText(e)}';
      });
    }
  }

  int _goLive(Map<String, dynamic> rv) =>
      _list(rv, 'willGoLive').length + _list(rv, 'newTags').length + _list(rv, 'liveElsewhere').length;

  @override
  Widget build(BuildContext context) {
    final rv = _review;
    return CarbonScaffold(
      pageTitle: 'COUNT REVIEW',
      body: RefreshIndicator(
        onRefresh: _loadFiles,
        child: ListView(
          padding: EdgeInsets.fromLTRB(16.w, 12.h, 16.w, 32.h),
          children: [
            _sectionTitle('1 · PICK THE COUNT FILES'),
            if (_error != null) _note(_error!, color: _red),
            ..._dayChips(),
            if (_loadingFiles && _files.isEmpty)
              Padding(padding: EdgeInsets.all(24.r), child: const Center(child: CircularProgressIndicator()))
            else if (_files.isEmpty)
              _note('No Count or Add-On files in the last 30 days.')
            else
              ..._files.map(_fileRow),
            SizedBox(height: 6.h),
            _note('Every Add-On save holds the whole session so far, so ticking them all is safe — each tag is counted once.'),
            SizedBox(height: 8.h),
            _primaryButton(
              _reviewing ? 'COMBINING…' : 'COMBINE & REVIEW (${_selected.length})',
              _selected.isEmpty || _reviewing || _pushing ? null : _runReview,
            ),
            if (rv != null) ..._reviewBody(rv),
          ],
        ),
      ),
    );
  }

  List<Widget> _dayChips() {
    final byDay = <String, List<Map<String, dynamic>>>{};
    for (final f in _files) {
      if (f['pushedAt'] != null) continue;
      byDay.putIfAbsent(_day(f['uploadedAt']?.toString()), () => []).add(f);
    }
    if (byDay.isEmpty) return const [];
    return [
      Wrap(
        spacing: 8.w,
        runSpacing: 8.h,
        children: byDay.entries.map((e) {
          final counts = e.value.where((f) => f['activity'] == 'MOBILE COUNT').length;
          final addOns = e.value.where((f) => f['activity'] == 'ADD-ON COUNT').length;
          return OutlinedButton(
            onPressed: () => setState(() {
              _selected
                ..clear()
                ..addAll(e.value.map((f) => f['id'].toString()));
            }),
            child: Text('${e.key} — $counts Count + $addOns Add-On', style: GoogleFonts.robotoMono(fontSize: 12.sp, fontWeight: FontWeight.w700)),
          );
        }).toList(),
      ),
      SizedBox(height: 10.h),
    ];
  }

  Widget _fileRow(Map<String, dynamic> f) {
    final id = f['id'].toString();
    final pushed = f['pushedAt'] != null;
    final isCount = f['activity'] == 'MOBILE COUNT';
    return Padding(
      padding: EdgeInsets.only(bottom: 6.h),
      child: Material(
        color: AppColors.surface,
        child: InkWell(
          onTap: pushed
              ? null
              : () => setState(() {
                    if (!_selected.remove(id)) _selected.add(id);
                  }),
          child: Padding(
            padding: EdgeInsets.fromLTRB(4.w, 6.h, 10.w, 6.h),
            child: Row(
              children: [
                Checkbox(
                  value: _selected.contains(id),
                  onChanged: pushed
                      ? null
                      : (_) => setState(() {
                            if (!_selected.remove(id)) _selected.add(id);
                          }),
                ),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(f['filename']?.toString() ?? '', style: GoogleFonts.robotoMono(fontSize: 12.sp, fontWeight: FontWeight.w700, color: AppColors.textMain)),
                      SizedBox(height: 2.h),
                      Text(
                        '${isCount ? 'COUNT' : 'ADD-ON'} · ${_when(f['uploadedAt']?.toString())}${(f['uploadedBy'] ?? '').toString().isNotEmpty ? ' · ${f['uploadedBy']}' : ''}',
                        style: GoogleFonts.manrope(fontSize: 12.sp, fontWeight: FontWeight.w600, color: _muted),
                      ),
                      if (pushed)
                        Text(
                          'PUSHED ${_when(f['pushedAt']?.toString())} · ${f['pushMode'] == 'override' ? 'OVERRIDE' : 'ADD'}',
                          style: GoogleFonts.spaceGrotesk(fontSize: 10.sp, fontWeight: FontWeight.w800, color: _amber, letterSpacing: 1.1),
                        ),
                    ],
                  ),
                ),
                Text('x${_n((f['rowCount'] as num?) ?? 0)}', style: GoogleFonts.spaceGrotesk(fontSize: 18.sp, fontWeight: FontWeight.w800, color: AppColors.primary)),
              ],
            ),
          ),
        ),
      ),
    );
  }

  List<Widget> _reviewBody(Map<String, dynamic> rv) {
    final pushedAlready = _list(rv, 'alreadyPushed');
    final missingTotal = ((rv['missingTotal'] as num?) ?? 0).toInt();
    final killedProducts = _list(rv, 'killedProducts');
    final manual = _list(rv, 'manual');
    final manualUnits = ((rv['manualUnits'] as num?) ?? 0).toInt();
    final missing = _list(rv, 'missing');
    final goLive = _goLive(rv);
    final confirmOk = _mode == 'add' || (int.tryParse(_confirm.text.trim()) == missingTotal);
    final canPush = _result == null && pushedAlready.isEmpty && confirmOk && !_pushing && !_reviewing;
    return [
      SizedBox(height: 22.h),
      _sectionTitle('2 · REVIEW — ${(rv['locationName'] ?? '').toString().toUpperCase()}'),
      if (pushedAlready.isNotEmpty)
        _note('Already pushed: ${pushedAlready.map((f) => f['filename']).join(', ')}. Untick them — a file is pushed once.', color: _red),
      GridView.count(
        crossAxisCount: 2,
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        mainAxisSpacing: 8.h,
        crossAxisSpacing: 8.w,
        childAspectRatio: 1.9,
        children: [
          _tile(_n((rv['scanned'] as num?) ?? 0), 'unique tags scanned'),
          _tile(_n((rv['alreadyLive'] as num?) ?? 0), 'already live here — nothing changes'),
          _tile(_n(goLive), 'will go live here', color: AppColors.primary),
          _tile(_n(killedProducts.length + _list(rv, 'killedNoProduct').length), 'killed in WMS, found on the shelf', color: _amber),
          _tile(_n(_list(rv, 'otherStatus').length), 'sold / damaged / other status, found', color: _amber),
          _tile(_n(_list(rv, 'defective').length), 'not in WMS, no product', color: _amber),
          _tile(_n(missingTotal), 'live here, NOT scanned — unknown on override', color: _red),
          _tile(_n(manualUnits), 'non-RFID manual units (${manual.length} SKUs)'),
        ],
      ),
      SizedBox(height: 10.h),
      _bucket('WILL GO LIVE — UNKNOWN IN WMS', _list(rv, 'willGoLive'), 'count-review-will-go-live'),
      _bucket('LIVE AT ANOTHER LOCATION — WILL MOVE HERE', _list(rv, 'liveElsewhere'), 'count-review-live-elsewhere'),
      _bucket('NEW TAGS — WILL BE ADDED LIVE', _list(rv, 'newTags'), 'count-review-new-tags'),
      _bucket(
        'KILLED TAGS FOUND — PRODUCTS',
        killedProducts,
        'count-review-killed-products',
        color: _amber,
        initiallyExpanded: true,
        note: _isSuperAdmin
            ? 'Ignored by the push unless you tick them — ticked tags are brought back to live (super-admin).'
            : 'Ignored by the push. Only a super-admin can bring a killed tag back.',
        pickable: _isSuperAdmin,
      ),
      _bucket('KILLED TAGS WITH NO PRODUCT', _list(rv, 'killedNoProduct'), 'count-review-killed-no-product',
          note: "The EPC doesn't match any custom SKU — filed as defective earlier. Ignored by the push."),
      _bucket('SOLD / DAMAGED / OTHER STATUS, FOUND', _list(rv, 'otherStatus'), 'count-review-other-status', note: 'Ignored by the push — a scan never changes these.'),
      _bucket('NOT IN WMS — NO PRODUCT', _list(rv, 'defective'), 'count-review-not-in-wms', note: 'Filed as defective by the push, like any count upload.'),
      _bucket(
        'LIVE HERE BUT NOT SCANNED ($missingTotal)',
        missing,
        'count-review-not-scanned',
        color: _red,
        initiallyExpanded: true,
        note: 'Override entire stock sets these to unknown; each comes back to live the next time it is scanned.'
            '${missing.length < missingTotal ? ' Showing the first ${_n(missing.length)} — the web page CSV has all.' : ''}',
      ),
      if (manual.isNotEmpty) _manualBucket(manual),
      SizedBox(height: 18.h),
      _sectionTitle('3 · PUSH TO THE WMS'),
      RadioGroup<String>(
        groupValue: _mode,
        onChanged: (v) => setState(() {
          _mode = v ?? 'add';
          _confirm.clear();
        }),
        child: Column(
          children: [
            _radio('add', 'Add to current stock', '${_n(goLive)} tags go live here. Nothing else changes.'),
            _radio('override', 'Override entire stock',
                'The same, and the ${_n(missingTotal)} live tags at ${rv['locationName'] ?? 'this location'} that the count did not see go to unknown.'),
          ],
        ),
      ),
      if (_mode == 'override') ...[
        if (manual.isNotEmpty)
          CheckboxListTile(
            contentPadding: EdgeInsets.only(left: 24.w),
            controlAffinity: ListTileControlAffinity.leading,
            value: _zeroManual,
            onChanged: (v) => setState(() => _zeroManual = v ?? false),
            title: Text('Also zero out non-RFID manual stock (${_n(manualUnits)} units, ${manual.length} SKUs)',
                style: GoogleFonts.manrope(fontSize: 13.sp, fontWeight: FontWeight.w700)),
          ),
        Padding(
          padding: EdgeInsets.fromLTRB(24.w, 6.h, 0, 6.h),
          child: TextField(
            controller: _confirm,
            keyboardType: TextInputType.number,
            onChanged: (_) => setState(() {}),
            decoration: InputDecoration(labelText: 'Type $missingTotal to confirm', border: const OutlineInputBorder()),
          ),
        ),
      ],
      if (_revive.isNotEmpty) _note('${_revive.length} killed tag(s) ticked to bring back to live.', color: _amber),
      SizedBox(height: 8.h),
      _primaryButton(
        _pushing ? 'PUSHING…' : (_mode == 'override' ? 'PUSH — OVERRIDE ENTIRE STOCK' : 'PUSH — ADD TO CURRENT STOCK'),
        canPush ? _push : null,
        color: _mode == 'override' ? _red : AppColors.primary,
      ),
      if (_result != null) ...[
        SizedBox(height: 10.h),
        Container(
          padding: EdgeInsets.all(12.r),
          decoration: BoxDecoration(border: Border.all(color: AppColors.primary), color: Colors.white),
          child: Text(
            'PUSHED (${_result!['mode'] == 'override' ? 'override entire stock' : 'add to current stock'}). '
            '${_n((_result!['wentLive'] as num?) ?? 0)} tags went live'
            '${((_result!['revived'] as num?) ?? 0) > 0 ? ', ${_n(_result!['revived'] as num)} killed tags brought back' : ''}'
            '${_result!['mode'] == 'override' ? ', ${_n((_result!['zeroedToUnknown'] as num?) ?? 0)} not-scanned tags set to unknown' : ''}'
            '${((_result!['manualZeroed'] as num?) ?? 0) > 0 ? ', ${_n((_result!['manualUnitsZeroed'] as num?) ?? 0)} manual units zeroed' : ''}'
            '. Shopify quantities are syncing now. These files are locked from being pushed again.',
            style: GoogleFonts.manrope(fontSize: 13.sp, fontWeight: FontWeight.w700, color: AppColors.textMain, height: 1.35),
          ),
        ),
      ],
    ];
  }

  Widget _sectionTitle(String t) => Padding(
        padding: EdgeInsets.only(bottom: 8.h),
        child: Text(t, style: GoogleFonts.spaceGrotesk(fontSize: 12.sp, fontWeight: FontWeight.w800, letterSpacing: 1.4, color: _muted)),
      );

  Widget _note(String t, {Color color = _muted}) => Padding(
        padding: EdgeInsets.symmetric(vertical: 4.h),
        child: Text(t, style: GoogleFonts.manrope(fontSize: 12.sp, fontWeight: FontWeight.w700, color: color, height: 1.35)),
      );

  Widget _tile(String value, String label, {Color color = AppColors.textMain}) => Container(
        padding: EdgeInsets.symmetric(horizontal: 10.w, vertical: 8.h),
        color: AppColors.surface,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text(value, style: GoogleFonts.spaceGrotesk(fontSize: 20.sp, fontWeight: FontWeight.w800, color: color)),
            Text(label, maxLines: 2, overflow: TextOverflow.ellipsis, style: GoogleFonts.manrope(fontSize: 11.sp, fontWeight: FontWeight.w600, color: _muted, height: 1.2)),
          ],
        ),
      );

  Widget _primaryButton(String label, VoidCallback? onPressed, {Color color = AppColors.primary}) => SizedBox(
        width: double.infinity,
        height: 48.h,
        child: FilledButton(
          style: FilledButton.styleFrom(backgroundColor: color, shape: const RoundedRectangleBorder()),
          onPressed: onPressed,
          child: Text(label, style: GoogleFonts.spaceGrotesk(fontSize: 13.sp, fontWeight: FontWeight.w800, letterSpacing: 1.2)),
        ),
      );

  Widget _radio(String value, String title, String sub) => RadioListTile<String>(
        contentPadding: EdgeInsets.zero,
        value: value,
        title: Text(title, style: GoogleFonts.manrope(fontSize: 14.sp, fontWeight: FontWeight.w800)),
        subtitle: Text(sub, style: GoogleFonts.manrope(fontSize: 12.sp, fontWeight: FontWeight.w600, height: 1.3)),
      );

  static const _csvHeader = ['epc', 'status', 'product', 'upc', 'custom_sku', 'colour', 'size', 'bin', 'last_seen', 'location', 'found_in'];
  List<String> _csvRow(Map<String, dynamic> t) => [
        for (final k in ['epc', 'status', 'product', 'upc', 'sku', 'color', 'size', 'bin', 'lastSeenAt', 'location', 'file']) (t[k] ?? '').toString(),
      ];

  Widget _bucket(
    String title,
    List<Map<String, dynamic>> rows,
    String csvName, {
    Color color = AppColors.textMain,
    bool initiallyExpanded = false,
    String? note,
    bool pickable = false,
  }) {
    if (rows.isEmpty) return const SizedBox.shrink();
    const cap = 300;
    return Padding(
      padding: EdgeInsets.only(bottom: 6.h),
      child: Material(
        color: AppColors.surface,
        child: ExpansionTile(
          initiallyExpanded: initiallyExpanded,
          tilePadding: EdgeInsets.symmetric(horizontal: 10.w),
          childrenPadding: EdgeInsets.fromLTRB(10.w, 0, 10.w, 8.h),
          title: Text('$title (${_n(rows.length)})', style: GoogleFonts.spaceGrotesk(fontSize: 12.sp, fontWeight: FontWeight.w800, color: color, letterSpacing: 0.8)),
          children: [
            if (note != null) Align(alignment: Alignment.centerLeft, child: _note(note)),
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                onPressed: () => exportReportCsv(context, header: _csvHeader, rows: rows.map(_csvRow).toList(), filename: csvName),
                icon: const Icon(Icons.download, size: 18),
                label: const Text('DOWNLOAD CSV'),
              ),
            ),
            ...rows.take(cap).map((t) => _tagRow(t, pickable: pickable)),
            if (rows.length > cap) _note('+${_n(rows.length - cap)} more in the CSV.'),
          ],
        ),
      ),
    );
  }

  Widget _tagRow(Map<String, dynamic> t, {bool pickable = false}) {
    final epc = (t['epc'] ?? '').toString();
    final product = t['product']?.toString();
    final details = [t['sku'], t['color'], t['size']].where((x) => x != null && x.toString().isNotEmpty).join(' · ');
    return Container(
      margin: EdgeInsets.only(top: 6.h),
      padding: EdgeInsets.all(8.r),
      color: Colors.white,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (pickable)
            Checkbox(
              value: _revive.contains(epc),
              onChanged: (_) => setState(() {
                if (!_revive.remove(epc)) _revive.add(epc);
              }),
            ),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(product ?? 'no product', style: GoogleFonts.manrope(fontSize: 13.sp, fontWeight: FontWeight.w800, color: product == null ? _muted : AppColors.textMain)),
                if (details.isNotEmpty) Text(details, style: GoogleFonts.robotoMono(fontSize: 11.sp, fontWeight: FontWeight.w600)),
                SelectableText(epc, style: GoogleFonts.robotoMono(fontSize: 11.sp, color: _muted)),
                Text(
                  'Last seen ${_when(t['lastSeenAt']?.toString())}${t['bin'] != null ? ' · bin ${t['bin']}' : ''}${t['file'] != null ? ' · ${t['file']}' : ''}',
                  style: GoogleFonts.manrope(fontSize: 11.sp, fontWeight: FontWeight.w600, color: _muted),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _manualBucket(List<Map<String, dynamic>> manual) => Padding(
        padding: EdgeInsets.only(bottom: 6.h),
        child: Material(
          color: AppColors.surface,
          child: ExpansionTile(
            tilePadding: EdgeInsets.symmetric(horizontal: 10.w),
            childrenPadding: EdgeInsets.fromLTRB(10.w, 0, 10.w, 8.h),
            title: Text('NON-RFID MANUAL STOCK (${manual.length})',
                style: GoogleFonts.spaceGrotesk(fontSize: 12.sp, fontWeight: FontWeight.w800, letterSpacing: 0.8)),
            children: [
              Align(alignment: Alignment.centerLeft, child: _note('Never touched by a push unless you tick “Also zero out manual stock”.')),
              ...manual.map((m) => Container(
                    margin: EdgeInsets.only(top: 6.h),
                    padding: EdgeInsets.all(8.r),
                    color: Colors.white,
                    child: Row(
                      children: [
                        Expanded(
                          child: Text(
                            '${m['product'] ?? '—'}\n${[m['sku'], m['color'], m['size']].where((x) => x != null).join(' · ')}',
                            style: GoogleFonts.manrope(fontSize: 12.sp, fontWeight: FontWeight.w700, height: 1.3),
                          ),
                        ),
                        Text('x${m['qty']}', style: GoogleFonts.spaceGrotesk(fontSize: 16.sp, fontWeight: FontWeight.w800, color: AppColors.primary)),
                      ],
                    ),
                  )),
            ],
          ),
        ),
      );
}
