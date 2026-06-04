import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/hardware/rfid_tag_read.dart';
import 'package:carbon_wms/hardware/rfid_vendor_channel.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/scan_sounds.dart';
import 'package:carbon_wms/services/transfer_slip_printer.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/screens/inventory_catalog_screen.dart'
    show CatalogRowCard;
import 'package:carbon_wms/ui/widgets/camera_barcode_scanner.dart'
    show openCameraBarcodeScanner;
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';

/// Transfer OUT — a standalone feature (separate from Transfer In). The
/// operator picks a destination, pulls the trigger to scan RFID items, and/or
/// searches SKUs to add non-RFID (manual) lines, then commits a slip.
///
/// Behavior (matches desktop v2):
///   • Live (in-stock) EPCs flip to in-transit at the destination.
///   • Non-live EPCs (damaged / tag_killed / …) ship in their CURRENT status —
///     they are flagged in the staged list so the operator knows they travel
///     as-is and get inspected on receive.
/// On commit the slip is persisted (so it lands in Reports → Transfers exactly
/// like the desktop) and can be printed / shared from the sent screen.
class TransferOutScreen extends StatefulWidget {
  const TransferOutScreen({super.key});

  @override
  State<TransferOutScreen> createState() => _TransferOutScreenState();
}

enum _OutStage { building, sent }

class _ManualLine {
  _ManualLine({required this.row});
  final Map<String, dynamic> row;
  int qty = 1;
  String get id => row['custom_sku_id']?.toString() ?? '';
}

class _TransferOutScreenState extends State<TransferOutScreen> {
  static const Color _primary = AppColors.primary;
  static const Color _transit = Color(0xFFE08A2C);
  static const Color _red = Color(0xFFD9534F);
  static const String _powerPrefsKey = 'transfer_out_power_dbm_v1';

  int _powerDbm = 27;

  // ── locations ───────────────────────────────────────────────────────────
  List<Map<String, String>> _locations = [];
  String? _sourceId;
  String? _destId;

  // ── staged contents ─────────────────────────────────────────────────────
  final Set<String> _epcs = <String>{};
  // epc → enrichment {sku,name,color,size,status,nonLive}
  final Map<String, Map<String, dynamic>> _epcInfo = {};
  final List<_ManualLine> _manual = [];
  Timer? _enrichDebounce;

  // ── search (manual add) ─────────────────────────────────────────────────
  final TextEditingController _searchCtrl = TextEditingController();
  Timer? _searchDebounce;
  String _query = '';
  bool _searchLoading = false;
  List<Map<String, dynamic>> _searchResults = [];

  // ── scanner ──────────────────────────────────────────────────────────────
  StreamSubscription<RfidTagRead>? _tagSub;
  StreamSubscription<String>? _barcodeSub;
  StreamSubscription<String>? _triggerSub;
  bool _scanning = false;
  RfidManager? _rfid;

  // ── commit / sent ─────────────────────────────────────────────────────────
  bool _committing = false;
  String? _error;
  _OutStage _stage = _OutStage.building;
  String? _sentTransferId;
  int? _sentSlipNumber;
  int _sentLive = 0;
  int _sentNonLive = 0;
  int _sentManual = 0;

  @override
  void initState() {
    super.initState();
    unawaited(ScanSounds.instance.init());
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      await _loadPower();
      await _loadLocations();
      await _initScanner();
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _rfid ??= context.read<RfidManager>();
  }

  @override
  void dispose() {
    _enrichDebounce?.cancel();
    _searchDebounce?.cancel();
    _searchCtrl.dispose();
    _tagSub?.cancel();
    _barcodeSub?.cancel();
    _triggerSub?.cancel();
    final r = _rfid;
    if (r != null) {
      unawaited(r.pauseScanning());
      unawaited(r.setSessionPowerOverrideDbm(null));
    }
    unawaited(RfidVendorChannel.open2dBarcode());
    super.dispose();
  }

  // ── loaders ───────────────────────────────────────────────────────────────
  Future<void> _loadPower() async {
    final prefs = await SharedPreferences.getInstance();
    final v = prefs.getInt(_powerPrefsKey);
    if (v != null && mounted) setState(() => _powerDbm = v.clamp(0, 30));
  }

  Future<void> _loadLocations() async {
    try {
      final locs = await context.read<WmsApiClient>().fetchSessionLocations();
      if (!mounted) return;
      setState(() {
        _locations = locs.where((l) => (l['id'] ?? '').isNotEmpty).toList();
        // Source defaults to the operator's active location (first returned).
        _sourceId ??= _locations.isNotEmpty ? _locations.first['id'] : null;
      });
    } catch (e) {
      if (mounted) setState(() => _error = 'Could not load locations: $e');
    }
  }

  Future<void> _initScanner() async {
    if (!mounted) return;
    final mgr = context.read<RfidManager>();
    mgr.scanContext = 'TRANSFER';
    await mgr.setSessionPowerOverrideDbm(_powerDbm);
    try {
      await RfidVendorChannel.scannerDisableTriggerRelay();
      await RfidVendorChannel.close2dBarcode();
      await RfidVendorChannel.enableRfidFunctionMode();
      await RfidVendorChannel.setZebraTriggerModeRfid();
      await RfidVendorChannel.setAntennaPowerDbm(_powerDbm);
    } catch (_) {/* optional */}

    await _tagSub?.cancel();
    _tagSub = RfidVendorChannel.tagReadStream().listen(_onTagRead,
        onError: (_) {});
    await _barcodeSub?.cancel();
    _barcodeSub = RfidVendorChannel.hardwareBarcodeStream().listen((raw) {
      final epc = _extract24Hex(raw);
      if (epc != null) _ingestEpc(epc);
    }, onError: (_) {});
    await _triggerSub?.cancel();
    _triggerSub = RfidVendorChannel.hardwareTriggerStream().listen((event) {
      if (event == 'down') {
        if (_scanning) {
          unawaited(_stopScan());
        } else {
          unawaited(_startScan());
        }
      }
    }, onError: (_) {});
  }

  // ── scanning ──────────────────────────────────────────────────────────────
  void _onTagRead(RfidTagRead read) {
    if (!_scanning) return;
    final epc = read.epcHex24.toUpperCase();
    if (epc.isNotEmpty) _ingestEpc(epc);
  }

  String? _extract24Hex(String raw) {
    final s = raw.toUpperCase().replaceAll(RegExp(r'\s+'), '');
    return RegExp(r'([0-9A-F]{24})').firstMatch(s)?.group(1);
  }

  void _ingestEpc(String epc) {
    if (_epcs.contains(epc)) return;
    setState(() {
      _epcs.add(epc);
      _error = null;
    });
    try {
      ScanSounds.instance.play(ScanCue.success);
    } catch (_) {}
    _scheduleEnrich();
  }

  Future<void> _startScan() async {
    if (_scanning) return;
    setState(() => _scanning = true);
    try {
      ScanSounds.instance.play(ScanCue.start);
    } catch (_) {}
    try {
      await RfidVendorChannel.startZebraInventory();
    } catch (_) {}
    try {
      await RfidVendorChannel.startChainwayInventory();
    } catch (_) {}
  }

  Future<void> _stopScan() async {
    if (!_scanning) return;
    setState(() => _scanning = false);
    try {
      ScanSounds.instance.play(ScanCue.stop);
    } catch (_) {}
    try {
      await RfidVendorChannel.stopZebraInventory();
    } catch (_) {}
    try {
      await RfidVendorChannel.stopChainwayInventory();
    } catch (_) {}
  }

  // ── enrichment (batched, off the hot scan path) ────────────────────────────
  void _scheduleEnrich() {
    _enrichDebounce?.cancel();
    _enrichDebounce = Timer(const Duration(milliseconds: 600), _enrich);
  }

  Future<void> _enrich() async {
    final missing =
        _epcs.where((e) => !_epcInfo.containsKey(e)).toList(growable: false);
    if (missing.isEmpty) return;
    try {
      final rows =
          await context.read<WmsApiClient>().lookupTransferEpcs(missing);
      if (!mounted) return;
      setState(() {
        for (final r in rows) {
          final epc = (r['epc'] ?? '').toString().toUpperCase();
          if (epc.isEmpty) continue;
          final status = (r['status'] ?? '').toString();
          _epcInfo[epc] = {
            'sku': r['sku'],
            'name': r['name'],
            'color': r['color'],
            'size': r['size'],
            'status': status,
            'nonLive': status.isNotEmpty && status != 'in-stock',
          };
        }
      });
    } catch (_) {/* enrichment is best-effort */}
  }

  // ── manual search/add ───────────────────────────────────────────────────────
  void _onSearchChanged(String value) {
    _searchDebounce?.cancel();
    final t = value.trim();
    if (t.length < 2) {
      if (_searchResults.isNotEmpty || _query.isNotEmpty) {
        setState(() {
          _query = '';
          _searchResults = [];
        });
      }
      return;
    }
    _searchDebounce = Timer(const Duration(milliseconds: 300), () async {
      if (!mounted || t == _query) return;
      setState(() {
        _query = t;
        _searchLoading = true;
      });
      try {
        final res = await context
            .read<WmsApiClient>()
            .fetchCatalogGrid(q: t, page: 1, limit: 60);
        if (!mounted) return;
        setState(() {
          _searchResults = (res['rows'] as List?)
                  ?.whereType<Map<String, dynamic>>()
                  .toList() ??
              [];
          _searchLoading = false;
        });
      } catch (_) {
        if (mounted) setState(() => _searchLoading = false);
      }
    });
  }

  void _addManual(Map<String, dynamic> row) {
    final id = row['custom_sku_id']?.toString() ?? '';
    if (id.isEmpty) return;
    setState(() {
      final existing = _manual.where((m) => m.id == id).toList().firstOrNull;
      if (existing != null) {
        existing.qty += 1;
      } else {
        _manual.add(_ManualLine(row: row));
      }
      _searchCtrl.clear();
      _query = '';
      _searchResults = [];
    });
  }

  void _bumpManual(_ManualLine line, int delta) {
    setState(() {
      line.qty = (line.qty + delta).clamp(0, 100000);
      if (line.qty == 0) _manual.remove(line);
    });
  }

  Future<void> _onCameraTap() async {
    await SystemChrome.setPreferredOrientations([
      DeviceOrientation.portraitUp,
      DeviceOrientation.landscapeLeft,
      DeviceOrientation.landscapeRight,
    ]);
    try {
      if (!mounted) return;
      final code =
          await openCameraBarcodeScanner(context, title: 'SCAN PRODUCT');
      if (!mounted || code == null || code.trim().isEmpty) return;
      _searchCtrl.text = code.trim();
      _onSearchChanged(code.trim());
    } finally {
      await SystemChrome.setPreferredOrientations(
          [DeviceOrientation.portraitUp]);
    }
  }

  // ── commit ──────────────────────────────────────────────────────────────────
  bool get _canCommit =>
      _destId != null &&
      _sourceId != null &&
      (_epcs.isNotEmpty || _manual.isNotEmpty) &&
      !_committing;

  int get _distinctSkus {
    final s = <String>{};
    for (final e in _epcs) {
      final sku = _epcInfo[e]?['sku']?.toString();
      if (sku != null && sku.isNotEmpty) s.add(sku);
    }
    for (final m in _manual) {
      final sku = m.row['sku']?.toString();
      if (sku != null && sku.isNotEmpty) s.add(sku);
    }
    return s.isEmpty ? (_epcs.isNotEmpty || _manual.isNotEmpty ? 1 : 0) : s.length;
  }

  Future<void> _commit() async {
    if (!_canCommit) return;
    final api = context.read<WmsApiClient>();
    setState(() {
      _committing = true;
      _error = null;
    });
    try {
      if (_scanning) await _stopScan();
      final res = await api.commitTransferOut(
        sourceLocationId: _sourceId!,
        destinationLocationId: _destId!,
        epcs: _epcs.toList(),
        manualLines: _manual
            .where((m) => m.qty > 0)
            .map((m) => {'customSkuId': m.id, 'qty': m.qty})
            .toList(),
      );
      if (!mounted) return;
      setState(() {
        _stage = _OutStage.sent;
        _sentTransferId = res['transferId']?.toString();
        _sentSlipNumber = (res['slipNumber'] as num?)?.toInt();
        _sentLive = (res['liveCount'] as num?)?.toInt() ?? 0;
        _sentNonLive = (res['nonLiveCount'] as num?)?.toInt() ?? 0;
        _sentManual = (res['manualCount'] as num?)?.toInt() ?? 0;
      });
    } catch (e) {
      if (mounted) {
        setState(() => _error =
            e is WmsApiException ? _friendly(e) : 'Transfer failed: $e');
      }
    } finally {
      if (mounted) setState(() => _committing = false);
    }
  }

  String _friendly(WmsApiException e) {
    try {
      final body = e.body;
      final m = RegExp(r'"error"\s*:\s*"([^"]+)"').firstMatch(body);
      if (m != null) return m.group(1)!;
    } catch (_) {}
    return 'Transfer failed (${e.statusCode})';
  }

  void _resetForNew() {
    setState(() {
      _stage = _OutStage.building;
      _epcs.clear();
      _epcInfo.clear();
      _manual.clear();
      _destId = null;
      _error = null;
      _sentTransferId = null;
      _sentSlipNumber = null;
    });
  }

  Future<void> _printSlip() async {
    final id = _sentTransferId;
    if (id == null) return;
    try {
      final html = await context.read<WmsApiClient>().fetchTransferSlipHtml(id);
      await TransferSlipPrinter.printSlip(
        html: html,
        docName: 'Transfer Slip ${_sentSlipNumber ?? ''}'.trim(),
      );
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Print failed: $e')),
        );
      }
    }
  }

  Future<void> _shareSlip() async {
    final id = _sentTransferId;
    if (id == null) return;
    try {
      final html = await context.read<WmsApiClient>().fetchTransferSlipHtml(id);
      await TransferSlipPrinter.shareSlip(
        html: html,
        docName: 'Transfer_Slip_${_sentSlipNumber ?? id}',
      );
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Share failed: $e')),
        );
      }
    }
  }

  // ── ui ───────────────────────────────────────────────────────────────────
  String _locName(String? id) {
    if (id == null) return '';
    final l = _locations.where((x) => x['id'] == id).toList().firstOrNull;
    if (l == null) return '';
    return l['name']?.isNotEmpty == true ? l['name']! : (l['code'] ?? '');
  }

  @override
  Widget build(BuildContext context) {
    if (_stage == _OutStage.sent) return _buildSent();
    return CarbonScaffold(
      pageTitle: 'TRANSFER OUT',
      bottomBar: _buildBottomBar(),
      body: ColoredBox(
        color: Colors.white,
        child: Column(
          children: [
            _locationRow(),
            _tilesRow(),
            _searchBar(),
            if (_error != null) _errorBanner(_error!),
            Expanded(child: _stagedList()),
          ],
        ),
      ),
    );
  }

  Widget _locationRow() {
    return Container(
      color: const Color(0xFFF5F7F7),
      padding: EdgeInsets.fromLTRB(16.w, 12.h, 16.w, 8.h),
      child: Column(
        children: [
          InkWell(
            onTap: _pickSource,
            child: _LocBox(
              label: 'FROM',
              value: _locName(_sourceId).isEmpty ? 'Choose…' : _locName(_sourceId),
              locked: true,
              placeholder: _sourceId == null,
            ),
          ),
          SizedBox(height: 6.h),
          Icon(LucideIcons.arrowDown, size: 18.sp, color: _primary),
          SizedBox(height: 6.h),
          InkWell(
            onTap: _pickDestination,
            child: _LocBox(
              label: 'TO',
              value: _destId == null ? 'Choose…' : _locName(_destId),
              locked: false,
              placeholder: _destId == null,
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _pickSource() async {
    final picked = await _pickLocation(
      title: 'SOURCE',
      exclude: _destId,
    );
    if (picked != null && mounted) setState(() => _sourceId = picked);
  }

  Future<String?> _pickLocation({
    required String title,
    String? exclude,
  }) {
    final options =
        _locations.where((l) => l['id'] != exclude).toList(growable: false);
    return showModalBottomSheet<String>(
      context: context,
      backgroundColor: Colors.white,
      builder: (ctx) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: [
            Padding(
              padding: EdgeInsets.all(16.w),
              child: Text(title,
                  style: GoogleFonts.spaceGrotesk(
                      fontWeight: FontWeight.w800, letterSpacing: 1.4)),
            ),
            for (final l in options)
              ListTile(
                title: Text(l['name']?.isNotEmpty == true
                    ? l['name']!
                    : (l['code'] ?? '')),
                onTap: () => Navigator.of(ctx).pop(l['id']),
              ),
            if (options.isEmpty)
              Padding(
                padding: EdgeInsets.all(16.w),
                child: const Text('No other locations available.'),
              ),
          ],
        ),
      ),
    );
  }

  Future<void> _pickDestination() async {
    final picked = await _pickLocation(title: 'DESTINATION', exclude: _sourceId);
    if (picked != null && mounted) setState(() => _destId = picked);
  }

  Widget _tilesRow() {
    return Padding(
      padding: EdgeInsets.fromLTRB(16.w, 12.h, 16.w, 0),
      child: Row(
        children: [
          _Tile(label: 'SKUs', value: _distinctSkus),
          SizedBox(width: 8.w),
          _Tile(label: 'RFID', value: _epcs.length),
          SizedBox(width: 8.w),
          _Tile(
            label: 'Manual',
            value: _manual.fold<int>(0, (a, m) => a + m.qty),
          ),
        ],
      ),
    );
  }

  Widget _searchBar() {
    return Padding(
      padding: EdgeInsets.fromLTRB(16.w, 10.h, 16.w, 6.h),
      child: Row(
        children: [
          Expanded(
            child: Container(
              decoration: BoxDecoration(
                color: Colors.white,
                border: Border.all(color: const Color(0xFFBCC9C9), width: 1.5),
              ),
              child: Padding(
                padding: EdgeInsets.symmetric(horizontal: 12.w),
                child: Row(
                  children: [
                    Icon(Icons.search,
                        size: 20.sp, color: const Color(0xFF6D7979)),
                    SizedBox(width: 8.w),
                    Expanded(
                      child: TextField(
                        controller: _searchCtrl,
                        onChanged: _onSearchChanged,
                        style: GoogleFonts.spaceGrotesk(
                            fontSize: 14.sp, fontWeight: FontWeight.w600),
                        decoration: const InputDecoration(
                          // The global input theme fills with grey; turn it off
                          // so the field is pure white inside the search box
                          // (no box-inside-a-box).
                          filled: false,
                          border: InputBorder.none,
                          isCollapsed: true,
                          contentPadding: EdgeInsets.symmetric(vertical: 14),
                          hintText: 'Search a SKU to add manually…',
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
          SizedBox(width: 8.w),
          InkWell(
            onTap: _onCameraTap,
            child: Container(
              height: 48.h,
              width: 48.w,
              color: const Color(0xFFEEF4F3),
              child: Icon(LucideIcons.camera, size: 22.sp, color: _primary),
            ),
          ),
        ],
      ),
    );
  }

  Widget _stagedList() {
    // When a search is active, show results to pick from.
    if (_query.isNotEmpty) {
      if (_searchLoading) {
        return const Center(child: CircularProgressIndicator(color: _primary));
      }
      if (_searchResults.isEmpty) {
        return Center(
          child: Text('No matches for "$_query".',
              style: GoogleFonts.manrope(
                  fontSize: 13.sp, fontWeight: FontWeight.w600)),
        );
      }
      return ListView.separated(
        padding: EdgeInsets.fromLTRB(16.w, 4.h, 16.w, 12.h),
        itemCount: _searchResults.length,
        separatorBuilder: (_, __) => SizedBox(height: 10.h),
        itemBuilder: (_, i) => CatalogRowCard(
          row: _searchResults[i],
          showQty: false,
          onTap: () => _addManual(_searchResults[i]),
          onQtyTap: () => _addManual(_searchResults[i]),
        ),
      );
    }

    if (_epcs.isEmpty && _manual.isEmpty) {
      return Center(
        child: Padding(
          padding: EdgeInsets.all(28.w),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(LucideIcons.packageOpen,
                  size: 44.sp, color: const Color(0xFFBCC9C9)),
              SizedBox(height: 12.h),
              Text(
                'Pick a destination, then pull the trigger to scan — or search to add manual lines.',
                textAlign: TextAlign.center,
                style: GoogleFonts.manrope(
                    fontSize: 13.sp,
                    fontWeight: FontWeight.w600,
                    color: const Color(0xFF5A6464),
                    height: 1.4),
              ),
            ],
          ),
        ),
      );
    }

    final epcList = _epcs.toList();
    return ListView(
      padding: EdgeInsets.fromLTRB(0, 6.h, 0, 16.h),
      children: [
        for (final m in _manual)
          _ManualRow(line: m, onMinus: () => _bumpManual(m, -1), onPlus: () => _bumpManual(m, 1)),
        for (final epc in epcList) _epcRow(epc),
      ],
    );
  }

  Widget _epcRow(String epc) {
    final info = _epcInfo[epc];
    final sku = info?['sku']?.toString();
    final name = info?['name']?.toString();
    final color = info?['color']?.toString();
    final size = info?['size']?.toString();
    final nonLive = info?['nonLive'] == true;
    final status = info?['status']?.toString() ?? '';
    return Container(
      decoration: const BoxDecoration(
        border: Border(bottom: BorderSide(color: Color(0xFFEFF2F2))),
      ),
      padding: EdgeInsets.fromLTRB(16.w, 8.h, 12.w, 8.h),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(sku?.isNotEmpty == true ? sku! : epc,
                    style: GoogleFonts.robotoMono(
                        fontSize: 13.sp,
                        fontWeight: FontWeight.w700,
                        color: AppColors.textMain)),
                if (name != null && name.isNotEmpty)
                  Text(
                    [
                      name,
                      if (color != null && color.isNotEmpty) color,
                      if (size != null && size.isNotEmpty) size,
                    ].join(' · '),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: GoogleFonts.manrope(
                        fontSize: 12.sp, color: const Color(0xFF6D7979)),
                  ),
              ],
            ),
          ),
          if (nonLive)
            Container(
              padding: EdgeInsets.symmetric(horizontal: 8.w, vertical: 3.h),
              color: _transit.withValues(alpha: 0.16),
              child: Text(
                status.toUpperCase().replaceAll('_', ' '),
                style: GoogleFonts.spaceGrotesk(
                    fontSize: 9.sp,
                    fontWeight: FontWeight.w800,
                    letterSpacing: .6,
                    color: _transit),
              ),
            )
          else
            Icon(LucideIcons.radio, size: 16.sp, color: _primary),
        ],
      ),
    );
  }

  Widget _errorBanner(String msg) {
    return Container(
      width: double.infinity,
      color: const Color(0xFFFCE7E7),
      padding: EdgeInsets.symmetric(horizontal: 16.w, vertical: 10.h),
      child: Text(msg,
          style: GoogleFonts.manrope(
              fontSize: 12.sp, fontWeight: FontWeight.w700, color: _red)),
    );
  }

  Widget _buildBottomBar() {
    return SafeArea(
      top: false,
      child: Container(
        color: Colors.white,
        padding: EdgeInsets.fromLTRB(16.w, 12.h, 16.w, 14.h),
        child: Row(
          children: [
            Expanded(
              child: SizedBox(
                height: 56.h,
                child: OutlinedButton.icon(
                  onPressed: _scanning ? _stopScan : _startScan,
                  style: OutlinedButton.styleFrom(
                    foregroundColor: _scanning ? _red : _primary,
                    side: BorderSide(
                        color: _scanning ? _red : _primary, width: 2.w),
                    shape: const RoundedRectangleBorder(
                        borderRadius: BorderRadius.zero),
                    textStyle: GoogleFonts.spaceGrotesk(
                        fontSize: 13.sp,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 1.6),
                  ),
                  icon: Icon(_scanning ? LucideIcons.square : LucideIcons.scan,
                      size: 20.sp),
                  label: Text(_scanning ? 'STOP' : 'SCAN'),
                ),
              ),
            ),
            SizedBox(width: 10.w),
            Expanded(
              flex: 2,
              child: SizedBox(
                height: 56.h,
                child: FilledButton.icon(
                  onPressed: _canCommit ? _commit : null,
                  style: FilledButton.styleFrom(
                    backgroundColor: _primary,
                    disabledBackgroundColor: const Color(0xFFBCC9C9),
                    foregroundColor: Colors.white,
                    shape: const RoundedRectangleBorder(
                        borderRadius: BorderRadius.zero),
                    textStyle: GoogleFonts.spaceGrotesk(
                        fontSize: 13.sp,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 1.6),
                  ),
                  icon: _committing
                      ? SizedBox(
                          width: 20.w,
                          height: 20.h,
                          child: const CircularProgressIndicator(
                              strokeWidth: 2, color: Colors.white))
                      : Icon(LucideIcons.send, size: 20.sp),
                  label: Text(_committing ? 'SENDING…' : 'REVIEW & TRANSFER'),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildSent() {
    final total = _sentLive + _sentNonLive;
    return CarbonScaffold(
      pageTitle: 'TRANSFER OUT',
      body: ColoredBox(
        color: Colors.white,
        child: Column(
          children: [
            Container(
              width: double.infinity,
              color: _transit.withValues(alpha: 0.12),
              padding: EdgeInsets.fromLTRB(16.w, 18.h, 16.w, 18.h),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('SENT · IN TRANSIT',
                      style: GoogleFonts.spaceGrotesk(
                          fontSize: 18.sp,
                          fontWeight: FontWeight.w800,
                          color: _transit)),
                  SizedBox(height: 4.h),
                  Text(
                    '$total RFID${_sentNonLive > 0 ? " ($_sentNonLive non-live, kept)" : ""}'
                    '${_sentManual > 0 ? " · $_sentManual manual" : ""} → ${_locName(_destId)}',
                    style: GoogleFonts.manrope(
                        fontSize: 13.sp, color: const Color(0xFF3F4A4A)),
                  ),
                  SizedBox(height: 6.h),
                  Text('SLIP #${_sentSlipNumber ?? "—"}',
                      style: GoogleFonts.robotoMono(
                          fontSize: 13.sp,
                          fontWeight: FontWeight.w700,
                          color: AppColors.textMain)),
                ],
              ),
            ),
            SizedBox(height: 16.h),
            Padding(
              padding: EdgeInsets.symmetric(horizontal: 16.w),
              child: Row(
                children: [
                  Expanded(
                    child: _SentBtn(
                      label: 'PRINT SLIP',
                      icon: LucideIcons.printer,
                      filled: true,
                      onTap: _printSlip,
                    ),
                  ),
                  SizedBox(width: 10.w),
                  Expanded(
                    child: _SentBtn(
                      label: 'SAVE / SHARE',
                      icon: LucideIcons.share2,
                      filled: false,
                      onTap: _shareSlip,
                    ),
                  ),
                ],
              ),
            ),
            const Spacer(),
            Padding(
              padding: EdgeInsets.fromLTRB(16.w, 0, 16.w, 16.h),
              child: Row(
                children: [
                  Expanded(
                    child: _SentBtn(
                      label: 'NEW TRANSFER',
                      icon: LucideIcons.plus,
                      filled: false,
                      onTap: _resetForNew,
                    ),
                  ),
                  SizedBox(width: 10.w),
                  Expanded(
                    child: _SentBtn(
                      label: 'DONE',
                      icon: LucideIcons.home,
                      filled: true,
                      onTap: () => Navigator.of(context).pop(),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ── small widgets ─────────────────────────────────────────────────────────

class _LocBox extends StatelessWidget {
  const _LocBox({
    required this.label,
    required this.value,
    required this.locked,
    this.placeholder = false,
  });
  final String label;
  final String value;
  final bool locked;
  final bool placeholder;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      decoration: BoxDecoration(
        color: locked ? const Color(0xFFECF1F1) : Colors.white,
        border: Border.all(
          color: const Color(0xFFD7DEDE),
          width: 1,
          style: locked ? BorderStyle.solid : BorderStyle.solid,
        ),
      ),
      padding: EdgeInsets.symmetric(horizontal: 10.w, vertical: 8.h),
      child: Row(
        children: [
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(label,
                  style: GoogleFonts.spaceGrotesk(
                      fontSize: 9.sp,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 1.2,
                      color: const Color(0xFF8A9090))),
              SizedBox(height: 2.h),
              Text(value,
                  style: GoogleFonts.spaceGrotesk(
                      fontSize: 15.sp,
                      fontWeight: FontWeight.w800,
                      color: placeholder
                          ? const Color(0xFF8A9090)
                          : (locked
                              ? const Color(0xFF3F4A4A)
                              : AppColors.textMain))),
            ],
          ),
          const Spacer(),
          if (locked)
            Icon(LucideIcons.lock, size: 16.sp, color: const Color(0xFF8A9090))
          else
            Icon(LucideIcons.chevronDown, size: 18.sp, color: AppColors.primary),
        ],
      ),
    );
  }
}

class _Tile extends StatelessWidget {
  const _Tile({required this.label, required this.value});
  final String label;
  final int value;

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: Container(
        height: 58.h,
        color: const Color(0xFFEEF4F3),
        padding: EdgeInsets.fromLTRB(9.w, 4.h, 9.w, 4.h),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label,
                style: GoogleFonts.manrope(
                    fontSize: 12.sp,
                    fontWeight: FontWeight.w700,
                    color: const Color(0xFF3F4A4A))),
            Expanded(
              child: Center(
                child: Text('$value',
                    style: GoogleFonts.spaceGrotesk(
                        fontSize: 26.sp,
                        fontWeight: FontWeight.w800,
                        color: AppColors.textMain)),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ManualRow extends StatelessWidget {
  const _ManualRow(
      {required this.line, required this.onMinus, required this.onPlus});
  final _ManualLine line;
  final VoidCallback onMinus;
  final VoidCallback onPlus;

  @override
  Widget build(BuildContext context) {
    final sku = line.row['sku']?.toString() ?? '';
    final name = line.row['name']?.toString() ?? '';
    final color = line.row['color']?.toString() ?? '';
    final size = line.row['size']?.toString() ?? '';
    return Container(
      decoration: const BoxDecoration(
        border: Border(bottom: BorderSide(color: Color(0xFFEFF2F2))),
      ),
      padding: EdgeInsets.fromLTRB(16.w, 8.h, 12.w, 8.h),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(sku,
                    style: GoogleFonts.robotoMono(
                        fontSize: 13.sp,
                        fontWeight: FontWeight.w700,
                        color: AppColors.textMain)),
                Text(
                  [
                    if (name.isNotEmpty) name,
                    if (color.isNotEmpty) color,
                    if (size.isNotEmpty) size,
                  ].join(' · '),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: GoogleFonts.manrope(
                      fontSize: 12.sp, color: const Color(0xFF6D7979)),
                ),
              ],
            ),
          ),
          _StepBtn(icon: Icons.remove, onTap: onMinus),
          SizedBox(width: 8.w),
          SizedBox(
            width: 28.w,
            child: Text('${line.qty}',
                textAlign: TextAlign.center,
                style: GoogleFonts.spaceGrotesk(
                    fontSize: 16.sp, fontWeight: FontWeight.w800)),
          ),
          SizedBox(width: 8.w),
          _StepBtn(icon: Icons.add, onTap: onPlus),
        ],
      ),
    );
  }
}

class _StepBtn extends StatelessWidget {
  const _StepBtn({required this.icon, required this.onTap});
  final IconData icon;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: 30.w,
        height: 30.h,
        alignment: Alignment.center,
        decoration:
            BoxDecoration(border: Border.all(color: const Color(0xFFBCC9C9))),
        child: Icon(icon, size: 18.sp, color: const Color(0xFF3F4A4A)),
      ),
    );
  }
}

class _SentBtn extends StatelessWidget {
  const _SentBtn({
    required this.label,
    required this.icon,
    required this.filled,
    required this.onTap,
  });
  final String label;
  final IconData icon;
  final bool filled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final bg = filled ? AppColors.primary : const Color(0xFFEEF4F3);
    final fg = filled ? Colors.white : const Color(0xFF3F4A4A);
    return GestureDetector(
      onTap: onTap,
      child: Container(
        height: 54.h,
        color: bg,
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(icon, size: 18.sp, color: fg),
            SizedBox(width: 8.w),
            Text(label,
                style: GoogleFonts.manrope(
                    fontSize: 13.sp,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 1.0,
                    color: fg)),
          ],
        ),
      ),
    );
  }
}

extension _FirstOrNull<E> on List<E> {
  E? get firstOrNull => isEmpty ? null : first;
}
