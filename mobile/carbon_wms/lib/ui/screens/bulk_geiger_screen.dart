import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:carbon_wms/hardware/hardware_trigger.dart';
import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/hardware/rfid_tag_read.dart';
import 'package:carbon_wms/hardware/rfid_vendor_channel.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/beep_pacer.dart';
import 'package:carbon_wms/services/mobile_permissions.dart';
import 'package:carbon_wms/services/scan_sounds.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/guards/permission_guard.dart';
import 'package:carbon_wms/ui/screens/locate_tag_screen.dart';
import 'package:carbon_wms/ui/widgets/camera_barcode_scanner.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';

/// Find & Locate → Bulk Geiger (owner, 2026-10-15).
///
/// The Geiger search (EPC, SKU, UPC, name, bin…), but you add MANY different
/// EPCs to one list. Pull the trigger: full power, and each listed EPC beeps
/// ONCE the first time the sled hears it and its line turns green — never
/// again this session. Tap any EPC to open the regular Geiger for that one tag
/// (hot/cold beeping until found); back returns to this list as it was.
///
/// Quiet mode on the RFD8500 (a tag already read stays silent while the sled
/// keeps powering it) leaves the radio free for tags not heard yet. Read-only:
/// nothing here changes stock. The list is kept on this handheld.
class BulkGeigerScreen extends StatefulWidget {
  const BulkGeigerScreen({super.key, this.initialEpcs = const <String>[], this.initialQuery});

  /// Added to the list on open (e.g. Cloud + Geiger's tags).
  final List<String> initialEpcs;

  /// Pre-filled search (e.g. from the Geiger screen).
  final String? initialQuery;

  @override
  State<BulkGeigerScreen> createState() => _BulkGeigerScreenState();
}

const Color _kFoundBg = Color(0xFFD6F5E6);
const Color _kFoundStripe = Color(0xFF16A34A);
const Color _kCard = Color(0xFFECECEC);
const Color _kMuted = Color(0xFF6D7979);
const Color _kRed = Color(0xFFBF2E2E);

final RegExp _epc24 = RegExp(r'^[0-9A-F]{24}$');

class _Target {
  const _Target({
    required this.epc,
    this.sku,
    this.name,
    this.color,
    this.size,
    this.status,
    this.bin,
  });

  final String epc;
  final String? sku;
  final String? name;
  final String? color;
  final String? size;
  final String? status;
  final String? bin;

  bool get hasInfo => (sku ?? '').isNotEmpty;

  static String? _s(Object? v) {
    final t = v?.toString().trim() ?? '';
    return t.isEmpty || t == '—' ? null : t;
  }

  /// Row from `GET /api/inventory/catalog?customSkuId=…`.
  factory _Target.fromCatalogEpc(Map<String, dynamic> e, Map<String, dynamic> skuRow) => _Target(
        epc: (e['epc']?.toString() ?? '').toUpperCase(),
        sku: _s(e['sku']) ?? _s(skuRow['sku']),
        name: _s(e['name']) ?? _s(skuRow['name']),
        color: _s(e['color']) ?? _s(skuRow['color']),
        size: _s(e['size']) ?? _s(skuRow['size']),
        status: _s(e['status']),
        bin: _s(e['bin_code']),
      );

  /// Row from `POST /api/handheld/epc-lookup` — keeps a bin we already had.
  _Target withLookup(Map<String, dynamic> r) => _Target(
        epc: epc,
        sku: _s(r['sku']) ?? sku,
        name: _s(r['productName']) ?? name,
        color: _s(r['color']) ?? color,
        size: _s(r['size']) ?? size,
        status: _s(r['status']) ?? status,
        bin: bin,
      );

  Map<String, dynamic> toJson() => {
        'epc': epc,
        'sku': sku,
        'name': name,
        'color': color,
        'size': size,
        'status': status,
        'bin': bin,
      };

  factory _Target.fromJson(Map<String, dynamic> j) => _Target(
        epc: (j['epc']?.toString() ?? '').toUpperCase(),
        sku: _s(j['sku']),
        name: _s(j['name']),
        color: _s(j['color']),
        size: _s(j['size']),
        status: _s(j['status']),
        bin: _s(j['bin']),
      );
}

class _Hit {
  const _Hit(this.at, this.rssi);
  final DateTime at;
  final int? rssi;
}

class _BulkGeigerScreenState extends State<BulkGeigerScreen> {
  static const String _prefsKey = 'bulk_geiger_targets_v1';
  static const Duration _searchDebounce = Duration(milliseconds: 300);
  static const Duration _repaintEvery = Duration(milliseconds: 150);

  final List<_Target> _targets = <_Target>[];
  final Map<String, int> _indexOf = <String, int>{};
  final Map<String, _Hit> _found = <String, _Hit>{};

  final TextEditingController _searchCtrl = TextEditingController();
  Timer? _debounce;
  String _query = '';
  bool _searching = false;
  String? _searchError;
  List<Map<String, dynamic>> _results = <Map<String, dynamic>>[];

  // Radio.
  RfidManager? _rfid;
  WmsApiClient? _api;
  String? _previousScanContext;
  StreamSubscription<RfidTagRead>? _vendorSub;
  StreamSubscription<RfidTagRead>? _geigerSub;
  StreamSubscription<String>? _triggerSub;
  bool _scanning = false;
  bool _busy = false;
  int _maxDbm = 30;
  final BeepPacer _beeper = BeepPacer();
  Timer? _repaintTimer;

  @override
  void initState() {
    super.initState();
    unawaited(ScanSounds.instance.init());
    // Only a NEW find beeps (once per EPC) — never the native per-read beep.
    unawaited(ScanSounds.instance.setTagBeepSuppressed(true));
    unawaited(_armRfidTrigger());
    WidgetsBinding.instance.addPostFrameCallback((_) => unawaited(_init()));
  }

  Future<void> _armRfidTrigger() async {
    try {
      await RfidVendorChannel.scannerDisableTriggerRelay();
      await RfidVendorChannel.close2dBarcode();
      await RfidVendorChannel.enableRfidFunctionMode();
      await RfidVendorChannel.setZebraTriggerModeRfid();
    } catch (_) {/* best-effort — no-op when the sled is not connected */}
  }

  Future<void> _init() async {
    if (!mounted) return;
    final rfid = context.read<RfidManager>();
    _rfid = rfid;
    _api = context.read<WmsApiClient>();
    rfid.lifecycleStopTick.addListener(_onLifecycleStop);
    _previousScanContext = rfid.scanContext;
    rfid.scanContext = 'GEIGER_FIND';
    _geigerSub = rfid.geigerTagReads.listen(_onRead, onError: (_) {});
    _vendorSub = RfidVendorChannel.tagReadStream().listen(_onRead, onError: (_) {});
    _triggerSub = hardwareTriggerFor(this).listen((e) {
      if (mounted && e == 'down') unawaited(_toggle());
    }, onError: (_) {});

    final range = await RfidVendorChannel.getPowerRangeDbm();
    if (range != null) _maxDbm = range.maxDbm;
    await rfid.setSessionPowerOverrideDbm(_maxDbm);
    unawaited(RfidVendorChannel.setAntennaPowerDbm(_maxDbm));

    await _loadSaved();
    if (widget.initialEpcs.isNotEmpty) _addEpcs(widget.initialEpcs);
    final q = widget.initialQuery?.trim() ?? '';
    if (q.isNotEmpty && mounted) {
      _searchCtrl.text = q;
      _onSearchChanged(q);
    }
  }

  void _onLifecycleStop() {
    // App to background / screen off: RfidManager already stopped the radio.
    if (mounted && _scanning) setState(() => _scanning = false);
  }

  @override
  void dispose() {
    _rfid?.lifecycleStopTick.removeListener(_onLifecycleStop);
    _debounce?.cancel();
    _repaintTimer?.cancel();
    _beeper.dispose();
    unawaited(_vendorSub?.cancel());
    unawaited(_geigerSub?.cancel());
    unawaited(_triggerSub?.cancel());
    // Leaving never leaves the sled transmitting, and hands the next screen
    // the defaults back.
    unawaited(RfidVendorChannel.stopZebraInventory());
    unawaited(RfidVendorChannel.stopChainwayInventory());
    unawaited(RfidVendorChannel.setQuietInventory(false));
    unawaited(ScanSounds.instance.setTagBeepSuppressed(false));
    final rfid = _rfid;
    final prev = _previousScanContext;
    if (rfid != null) {
      scheduleMicrotask(() {
        if (prev != null) rfid.scanContext = prev;
        unawaited(rfid.setSessionPowerOverrideDbm(null));
      });
    }
    _searchCtrl.dispose();
    super.dispose();
  }

  // ── List ────────────────────────────────────────────────────────────────

  Future<void> _loadSaved() async {
    try {
      final p = await SharedPreferences.getInstance();
      final raw = p.getString(_prefsKey);
      if (raw == null || raw.isEmpty) return;
      final list = jsonDecode(raw);
      if (list is! List) return;
      final saved = list
          .whereType<Map<String, dynamic>>()
          .map(_Target.fromJson)
          .where((t) => _epc24.hasMatch(t.epc))
          .toList();
      if (!mounted || saved.isEmpty) return;
      setState(() => _put(saved));
    } catch (_) {/* start empty */}
  }

  Future<void> _save() async {
    try {
      final p = await SharedPreferences.getInstance();
      await p.setString(_prefsKey, jsonEncode(_targets.map((t) => t.toJson()).toList()));
    } catch (_) {}
  }

  /// Adds / refreshes targets (no duplicates). Returns how many were new.
  int _put(Iterable<_Target> items) {
    var added = 0;
    for (final t in items) {
      final i = _indexOf[t.epc];
      if (i == null) {
        _indexOf[t.epc] = _targets.length;
        _targets.add(t);
        added++;
      } else if (!_targets[i].hasInfo && t.hasInfo) {
        _targets[i] = t;
      }
    }
    return added;
  }

  void _reindex() {
    _indexOf
      ..clear()
      ..addEntries([for (var i = 0; i < _targets.length; i++) MapEntry(_targets[i].epc, i)]);
  }

  /// Raw EPCs (typed, pasted, sent from the web) → list, then product info.
  void _addEpcs(List<String> epcs) {
    final clean = <String>{
      for (final e in epcs)
        if (_epc24.hasMatch(e.trim().toUpperCase())) e.trim().toUpperCase(),
    }.toList();
    if (clean.isEmpty) return;
    var added = 0;
    setState(() {
      added = _put(clean.map((e) => _Target(epc: e)));
    });
    unawaited(_save());
    unawaited(_enrich(clean.where((e) => !(_targets[_indexOf[e]!].hasInfo)).toList()));
    _toast(added == 0 ? 'Already on the list.' : 'Added $added EPC${added == 1 ? '' : 's'}.');
  }

  Future<void> _enrich(List<String> epcs) async {
    final api = _api;
    if (api == null || epcs.isEmpty) return;
    for (var i = 0; i < epcs.length; i += 500) {
      final chunk = epcs.sublist(i, i + 500 > epcs.length ? epcs.length : i + 500);
      try {
        final rows = await api.lookupEpcs(chunk);
        if (!mounted) return;
        setState(() {
          for (final r in rows) {
            final e = (r['epcHex'] ?? r['epc'])?.toString().toUpperCase();
            final idx = e == null ? null : _indexOf[e];
            if (idx != null) _targets[idx] = _targets[idx].withLookup(r);
          }
        });
      } catch (_) {/* the raw EPC still hunts */}
    }
    unawaited(_save());
  }

  void _remove(_Target t) {
    setState(() {
      _targets.removeWhere((x) => x.epc == t.epc);
      _found.remove(t.epc);
      _reindex();
    });
    unawaited(_save());
  }

  Future<void> _clearAll() async {
    if (_targets.isEmpty) return;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Clear the list?'),
        content: Text('Removes all ${_targets.length} EPCs from Bulk Geiger on this handheld.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('CANCEL')),
          FilledButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text('CLEAR')),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    if (_scanning) await _stop();
    setState(() {
      _targets.clear();
      _indexOf.clear();
      _found.clear();
    });
    unawaited(_save());
  }

  void _toast(String text) {
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(
      SnackBar(content: Text(text), duration: const Duration(milliseconds: 1400), behavior: SnackBarBehavior.floating),
    );
  }

  // ── Search ──────────────────────────────────────────────────────────────

  List<String> get _typedEpcs {
    final out = <String>{};
    for (final tok in _searchCtrl.text.toUpperCase().split(RegExp(r'[^0-9A-F]+'))) {
      if (_epc24.hasMatch(tok)) out.add(tok);
    }
    return out.toList();
  }

  void _onSearchChanged(String value) {
    _debounce?.cancel();
    final q = value.trim();
    setState(() {}); // typed-EPC chip + clear button
    if (q.length < 2) {
      if (_query.isNotEmpty || _results.isNotEmpty) {
        setState(() {
          _query = '';
          _results = <Map<String, dynamic>>[];
          _searchError = null;
          _searching = false;
        });
      }
      return;
    }
    _debounce = Timer(_searchDebounce, () {
      if (!mounted || q == _query) return;
      _query = q;
      unawaited(_runSearch(q));
    });
  }

  Future<void> _runSearch(String q) async {
    final api = _api ?? context.read<WmsApiClient>();
    setState(() {
      _searching = true;
      _searchError = null;
    });
    try {
      final res = await api.fetchCatalogGrid(q: q, page: 1, limit: 50);
      if (!mounted || q != _query) return;
      setState(() {
        _results = (res['rows'] as List?)?.whereType<Map<String, dynamic>>().toList() ?? <Map<String, dynamic>>[];
        _searching = false;
      });
    } catch (e) {
      if (!mounted || q != _query) return;
      setState(() {
        _searching = false;
        _searchError = 'Search failed: $e';
      });
    }
  }

  void _clearSearch() {
    _searchCtrl.clear();
    _onSearchChanged('');
  }

  Future<void> _onCamera() async {
    final code = await openCameraBarcodeScanner(context, title: 'SCAN SKU');
    if (!mounted || code == null || code.trim().isEmpty) return;
    _searchCtrl.text = code.trim();
    _onSearchChanged(code.trim());
  }

  /// One SKU's EPCs → tick the ones to add (live ones pre-ticked).
  Future<void> _pickFromSku(Map<String, dynamic> row) async {
    final id = row['custom_sku_id']?.toString() ?? '';
    final api = _api;
    if (id.isEmpty || api == null) return;
    final picked = await showModalBottomSheet<List<_Target>>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(),
      builder: (_) => _SkuEpcPicker(row: row, api: api, alreadyAdded: _indexOf.keys.toSet()),
    );
    if (picked == null || picked.isEmpty || !mounted) return;
    var added = 0;
    setState(() {
      added = _put(picked);
    });
    unawaited(_save());
    _toast(added == 0 ? 'Already on the list.' : 'Added $added EPC${added == 1 ? '' : 's'}.');
  }

  // ── Scan ────────────────────────────────────────────────────────────────

  Future<void> _toggle() async {
    if (_busy) return;
    _busy = true;
    try {
      if (_scanning) {
        await _stop();
      } else {
        await _start();
      }
    } finally {
      _busy = false;
    }
  }

  Future<void> _start() async {
    if (_scanning || _targets.isEmpty) return;
    if (_rfid?.isBackgrounded ?? false) return;
    if (_found.length >= _targets.length) {
      _toast('Every EPC on the list is found. CLEAR FOUND to look again.');
      return;
    }
    setState(() => _scanning = true);
    ScanSounds.instance.play(ScanCue.start);
    // Re-asserted every start: a Locate opened from this list restores the
    // per-read beep, the 2D imager, the default session, its one-tag filter
    // and the power in its dispose — which can land after we are back.
    unawaited(ScanSounds.instance.setTagBeepSuppressed(true));
    _rfid?.scanContext = 'GEIGER_FIND';
    unawaited(_armRfidTrigger());
    unawaited(RfidVendorChannel.setEpcInventoryFilter(null));
    unawaited(RfidVendorChannel.setQuietInventory(true));
    unawaited(_rfid?.setSessionPowerOverrideDbm(_maxDbm));
    unawaited(RfidVendorChannel.setAntennaPowerDbm(_maxDbm));
    try {
      await RfidVendorChannel.startZebraInventory();
    } catch (_) {}
    if (!mounted || !_scanning) return;
    try {
      await RfidVendorChannel.startChainwayInventory();
    } catch (_) {}
  }

  Future<void> _stop({bool silent = false}) async {
    if (!_scanning) return;
    setState(() => _scanning = false);
    _beeper.cancel();
    if (!silent) ScanSounds.instance.play(ScanCue.stop);
    try {
      await RfidVendorChannel.stopZebraInventory();
    } catch (_) {}
    try {
      await RfidVendorChannel.stopChainwayInventory();
    } catch (_) {}
  }

  void _onRead(RfidTagRead r) {
    if (!_scanning) return;
    final epc = r.exactEpc96 ?? r.epcHex24.toUpperCase();
    // Found once → silent for the rest of the session; not listed → ignored.
    if (_found.containsKey(epc) || !_indexOf.containsKey(epc)) return;
    _found[epc] = _Hit(DateTime.now(), r.rssi);
    _beeper.request();
    if (_found.length >= _targets.length) {
      // Nothing left to look for.
      ScanSounds.instance.play(ScanCue.success);
      unawaited(_stop(silent: true));
      return;
    }
    _repaintTimer ??= Timer(_repaintEvery, () {
      _repaintTimer = null;
      if (mounted) setState(() {});
    });
  }

  void _clearFound() {
    setState(_found.clear);
  }

  /// The regular Geiger for one tag — hot/cold until found.
  Future<void> _locate(_Target t) async {
    if (_scanning) await _stop();
    if (!mounted) return;
    await context.pushGuarded<void>(
      ScreenIds.locateTag,
      (_) => LocateTagScreen(
        targetEpc: t.epc,
        targetBin: t.bin,
        targetSku: t.sku,
        targetName: t.name,
        targetColor: t.color,
        targetSize: t.size,
      ),
    );
    if (!mounted) return;
    unawaited(ScanSounds.instance.setTagBeepSuppressed(true));
    _rfid?.scanContext = 'GEIGER_FIND';
  }

  // ── UI ──────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    final typed = _typedEpcs.where((e) => !_indexOf.containsKey(e)).toList();
    final showResults = _query.isNotEmpty;
    return CarbonScaffold(
      pageTitle: 'BULK GEIGER',
      body: ColoredBox(
        color: Colors.white,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: EdgeInsets.fromLTRB(20.w, 12.h, 20.w, 6.h),
              child: _SearchField(
                controller: _searchCtrl,
                onChanged: _onSearchChanged,
                onClear: _clearSearch,
                onCamera: _onCamera,
              ),
            ),
            if (typed.isNotEmpty)
              Padding(
                padding: EdgeInsets.fromLTRB(20.w, 0, 20.w, 6.h),
                child: _WideButton(
                  label: 'ADD ${typed.length} EPC${typed.length == 1 ? '' : 'S'} TYPED ABOVE',
                  icon: Icons.add,
                  onPressed: () {
                    _addEpcs(typed);
                    _clearSearch();
                  },
                ),
              ),
            if (showResults)
              ConstrainedBox(
                constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.34),
                child: _ResultsPanel(
                  searching: _searching,
                  error: _searchError,
                  query: _query,
                  rows: _results,
                  onPick: _pickFromSku,
                ),
              ),
            _ListHeader(
              total: _targets.length,
              found: _found.length,
              scanning: _scanning,
              onClearFound: _found.isEmpty ? null : _clearFound,
              onClearAll: _targets.isEmpty || _scanning ? null : _clearAll,
            ),
            Expanded(
              child: _targets.isEmpty
                  ? const _EmptyHint()
                  : ListView.separated(
                      padding: EdgeInsets.fromLTRB(20.w, 4.h, 20.w, 12.h),
                      itemCount: _targets.length,
                      separatorBuilder: (_, __) => SizedBox(height: 8.h),
                      itemBuilder: (_, i) {
                        final t = _targets[i];
                        return _TargetTile(
                          key: ValueKey<String>('bulk-${t.epc}'),
                          target: t,
                          hit: _found[t.epc],
                          scanning: _scanning,
                          onLocate: () => unawaited(_locate(t)),
                          onRemove: () => _remove(t),
                        );
                      },
                    ),
            ),
            Padding(
              padding: EdgeInsets.fromLTRB(20.w, 6.h, 20.w, 12.h),
              child: SizedBox(
                height: 56,
                child: FilledButton.icon(
                  onPressed: _targets.isEmpty ? null : () => unawaited(_toggle()),
                  icon: Icon(_scanning ? Icons.pause : Icons.play_arrow, size: 24),
                  label: Text(
                    _scanning ? 'PAUSE' : 'START (or pull the trigger)',
                    style: GoogleFonts.spaceGrotesk(fontSize: 16.sp, fontWeight: FontWeight.w900, letterSpacing: 0.8),
                  ),
                  style: FilledButton.styleFrom(
                    backgroundColor: _scanning ? _kRed : AppColors.primary,
                    foregroundColor: Colors.white,
                    disabledBackgroundColor: const Color(0xFFBCC9C9),
                    shape: const RoundedRectangleBorder(),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

String _time(DateTime d) {
  final l = d.toLocal();
  String two(int n) => n.toString().padLeft(2, '0');
  final h = l.hour % 12 == 0 ? 12 : l.hour % 12;
  return '$h:${two(l.minute)}:${two(l.second)} ${l.hour < 12 ? 'AM' : 'PM'}';
}

class _SearchField extends StatelessWidget {
  const _SearchField({required this.controller, required this.onChanged, required this.onClear, required this.onCamera});

  final TextEditingController controller;
  final ValueChanged<String> onChanged;
  final VoidCallback onClear;
  final VoidCallback onCamera;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(color: Colors.white, border: Border.all(color: const Color(0xFFBCC9C9), width: 1.5)),
      padding: EdgeInsets.symmetric(horizontal: 12.w),
      child: Row(
        children: [
          Icon(Icons.search, size: 22.sp, color: _kMuted),
          SizedBox(width: 10.w),
          Expanded(
            child: TextField(
              controller: controller,
              onChanged: onChanged,
              textInputAction: TextInputAction.search,
              style: GoogleFonts.spaceGrotesk(fontSize: 15.sp, fontWeight: FontWeight.w600, color: AppColors.textMain),
              decoration: InputDecoration(
                filled: false,
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                isCollapsed: true,
                contentPadding: EdgeInsets.symmetric(vertical: 16.h),
                hintText: 'EPC · SKU · UPC · NAME · BIN',
                hintStyle: GoogleFonts.spaceGrotesk(fontSize: 13.sp, fontWeight: FontWeight.w600, letterSpacing: 1.2, color: _kMuted),
              ),
            ),
          ),
          if (controller.text.isNotEmpty)
            GestureDetector(
              onTap: onClear,
              child: Padding(
                padding: EdgeInsets.symmetric(horizontal: 6.w),
                child: Icon(Icons.close, size: 20.sp, color: _kMuted),
              ),
            ),
          GestureDetector(
            onTap: onCamera,
            behavior: HitTestBehavior.opaque,
            child: Padding(
              padding: EdgeInsets.symmetric(horizontal: 6.w),
              child: Icon(Icons.photo_camera_outlined, size: 22.sp, color: AppColors.primary),
            ),
          ),
        ],
      ),
    );
  }
}

class _ResultsPanel extends StatelessWidget {
  const _ResultsPanel({required this.searching, required this.error, required this.query, required this.rows, required this.onPick});

  final bool searching;
  final String? error;
  final String query;
  final List<Map<String, dynamic>> rows;
  final ValueChanged<Map<String, dynamic>> onPick;

  @override
  Widget build(BuildContext context) {
    Widget body;
    if (searching && rows.isEmpty) {
      body = Padding(padding: EdgeInsets.all(16.r), child: const Center(child: CircularProgressIndicator()));
    } else if (error != null) {
      body = Padding(
        padding: EdgeInsets.all(12.r),
        child: Text(error!, style: GoogleFonts.manrope(fontSize: 12.sp, fontWeight: FontWeight.w700, color: _kRed)),
      );
    } else if (rows.isEmpty) {
      body = Padding(
        padding: EdgeInsets.all(12.r),
        child: Text('No matches for "$query".', style: GoogleFonts.manrope(fontSize: 13.sp, fontWeight: FontWeight.w700, color: _kMuted)),
      );
    } else {
      body = ListView.separated(
        shrinkWrap: true,
        padding: EdgeInsets.fromLTRB(20.w, 0, 20.w, 6.h),
        itemCount: rows.length,
        separatorBuilder: (_, __) => SizedBox(height: 6.h),
        itemBuilder: (_, i) {
          final r = rows[i];
          final variant = [r['color'], r['size']].where((x) => (x?.toString() ?? '').isNotEmpty).join(' · ');
          final qty = (r['active_epc_count'] as num?)?.toInt();
          return Material(
            color: const Color(0xFFF0F5F4),
            child: InkWell(
              onTap: () => onPick(r),
              child: Padding(
                padding: EdgeInsets.symmetric(horizontal: 12.w, vertical: 8.h),
                child: Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            (r['name']?.toString() ?? '').toUpperCase(),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: GoogleFonts.spaceGrotesk(fontSize: 13.sp, fontWeight: FontWeight.w900, color: AppColors.textMain),
                          ),
                          Text(
                            [r['sku'], if (variant.isNotEmpty) variant].where((x) => (x?.toString() ?? '').isNotEmpty).join(' · '),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: GoogleFonts.robotoMono(fontSize: 12.sp, fontWeight: FontWeight.w700, color: AppColors.textMain),
                          ),
                        ],
                      ),
                    ),
                    if (qty != null)
                      Text('x$qty', style: GoogleFonts.spaceGrotesk(fontSize: 16.sp, fontWeight: FontWeight.w900, color: AppColors.primary)),
                    SizedBox(width: 8.w),
                    Icon(Icons.playlist_add, color: AppColors.primary, size: 24.sp),
                  ],
                ),
              ),
            ),
          );
        },
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        Padding(
          padding: EdgeInsets.fromLTRB(20.w, 0, 20.w, 4.h),
          child: Text(
            searching ? 'SEARCHING…' : 'TAP A RESULT TO ADD ITS EPCS',
            style: GoogleFonts.spaceGrotesk(fontSize: 11.sp, fontWeight: FontWeight.w800, letterSpacing: 1.3, color: _kMuted),
          ),
        ),
        Flexible(child: body),
      ],
    );
  }
}

class _ListHeader extends StatelessWidget {
  const _ListHeader({required this.total, required this.found, required this.scanning, required this.onClearFound, required this.onClearAll});

  final int total;
  final int found;
  final bool scanning;
  final VoidCallback? onClearFound;
  final VoidCallback? onClearAll;

  @override
  Widget build(BuildContext context) {
    return Container(
      color: const Color(0xFFF0F5F4),
      margin: EdgeInsets.only(top: 6.h),
      padding: EdgeInsets.fromLTRB(20.w, 6.h, 12.w, 6.h),
      child: Row(
        children: [
          Expanded(
            child: Text(
              total == 0 ? 'NO EPCS YET' : 'FOUND $found / $total${scanning ? '  ·  SCANNING' : ''}',
              style: GoogleFonts.spaceGrotesk(
                fontSize: 14.sp,
                fontWeight: FontWeight.w900,
                letterSpacing: 1.0,
                color: found > 0 ? _kFoundStripe : AppColors.textMain,
              ),
            ),
          ),
          TextButton(onPressed: onClearFound, child: const Text('CLEAR FOUND')),
          TextButton(onPressed: onClearAll, child: const Text('CLEAR LIST')),
        ],
      ),
    );
  }
}

class _TargetTile extends StatelessWidget {
  const _TargetTile({
    super.key,
    required this.target,
    required this.hit,
    required this.scanning,
    required this.onLocate,
    required this.onRemove,
  });

  final _Target target;
  final _Hit? hit;
  final bool scanning;
  final VoidCallback onLocate;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final t = target;
    final found = hit != null;
    final variant = [t.color, t.size].where((x) => (x ?? '').isNotEmpty).join(' · ');
    final facts = [
      if ((t.status ?? '').isNotEmpty) t.status!.toUpperCase(),
      if ((t.bin ?? '').isNotEmpty) 'BIN ${t.bin}',
    ].join('  ·  ');
    return Material(
      color: found ? _kFoundBg : _kCard,
      child: InkWell(
        onTap: onLocate,
        child: Container(
          decoration: BoxDecoration(
            border: Border(left: BorderSide(color: found ? _kFoundStripe : Colors.transparent, width: 5)),
          ),
          padding: EdgeInsets.fromLTRB(12.w, 8.h, 4.w, 8.h),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      t.hasInfo ? (t.name ?? t.sku!).toUpperCase() : 'EPC NOT IN THE CATALOG',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: GoogleFonts.spaceGrotesk(
                        fontSize: 14.sp,
                        fontWeight: FontWeight.w900,
                        color: t.hasInfo ? Colors.black : _kMuted,
                      ),
                    ),
                    if (t.hasInfo)
                      Text(
                        [t.sku, if (variant.isNotEmpty) variant].join(' · '),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: GoogleFonts.robotoMono(fontSize: 12.sp, fontWeight: FontWeight.w700, color: AppColors.textMain),
                      ),
                    Text(t.epc, style: GoogleFonts.robotoMono(fontSize: 11.sp, fontWeight: FontWeight.w600, color: _kMuted)),
                    if (facts.isNotEmpty)
                      Text(facts, style: GoogleFonts.spaceGrotesk(fontSize: 11.sp, fontWeight: FontWeight.w800, color: AppColors.textMain)),
                    if (found)
                      Text(
                        'FOUND ${_time(hit!.at)}${hit!.rssi != null ? '  ·  ${hit!.rssi} dBm' : ''}',
                        style: GoogleFonts.spaceGrotesk(fontSize: 12.sp, fontWeight: FontWeight.w900, color: _kFoundStripe),
                      ),
                  ],
                ),
              ),
              IconButton(
                tooltip: 'Geiger this tag',
                onPressed: onLocate,
                icon: Icon(Icons.sensors, color: AppColors.primary, size: 28.sp),
              ),
              if (!scanning)
                IconButton(
                  tooltip: 'Remove from the list',
                  onPressed: onRemove,
                  icon: Icon(Icons.close, color: _kMuted, size: 20.sp),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _WideButton extends StatelessWidget {
  const _WideButton({required this.label, required this.icon, required this.onPressed});

  final String label;
  final IconData icon;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 44,
      child: FilledButton.icon(
        onPressed: onPressed,
        icon: Icon(icon, size: 18),
        label: Text(label, style: GoogleFonts.spaceGrotesk(fontSize: 13.sp, fontWeight: FontWeight.w900, letterSpacing: 0.8)),
        style: FilledButton.styleFrom(
          backgroundColor: const Color(0xFF2BA3A3),
          foregroundColor: Colors.white,
          shape: const RoundedRectangleBorder(),
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
            Icon(Icons.radar, size: 48.sp, color: const Color(0xFFBCC9C9)),
            SizedBox(height: 12.h),
            Text(
              'Add the EPCs to look for.',
              textAlign: TextAlign.center,
              style: GoogleFonts.manrope(fontSize: 15.sp, fontWeight: FontWeight.w800, color: const Color(0xFF5A6464)),
            ),
            SizedBox(height: 6.h),
            Text(
              'Search a SKU, UPC or name and tap a result, or type / paste EPCs. Then pull the trigger — each one beeps once when found.',
              textAlign: TextAlign.center,
              style: GoogleFonts.manrope(fontSize: 12.sp, fontWeight: FontWeight.w600, color: _kMuted, height: 1.4),
            ),
          ],
        ),
      ),
    );
  }
}

/// Bottom sheet: one SKU's EPCs at this location, tick the ones to add.
class _SkuEpcPicker extends StatefulWidget {
  const _SkuEpcPicker({required this.row, required this.api, required this.alreadyAdded});

  final Map<String, dynamic> row;
  final WmsApiClient api;
  final Set<String> alreadyAdded;

  @override
  State<_SkuEpcPicker> createState() => _SkuEpcPickerState();
}

class _SkuEpcPickerState extends State<_SkuEpcPicker> {
  bool _loading = true;
  String? _error;
  List<_Target> _epcs = <_Target>[];
  final Set<String> _ticked = <String>{};

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final rows = await widget.api.fetchCatalogEpcs(widget.row['custom_sku_id']?.toString() ?? '');
      if (!mounted) return;
      final list = rows.map((e) => _Target.fromCatalogEpc(e, widget.row)).where((t) => _epc24.hasMatch(t.epc)).toList()
        ..sort((a, b) {
          // Live first, then the rest; stable by EPC.
          final la = a.status == 'in-stock' ? 0 : 1;
          final lb = b.status == 'in-stock' ? 0 : 1;
          return la != lb ? la - lb : a.epc.compareTo(b.epc);
        });
      setState(() {
        _epcs = list;
        _ticked
          ..clear()
          ..addAll(list.where((t) => t.status == 'in-stock' && !widget.alreadyAdded.contains(t.epc)).map((t) => t.epc));
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = 'Could not load the EPCs: $e';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final r = widget.row;
    final variant = [r['color'], r['size']].where((x) => (x?.toString() ?? '').isNotEmpty).join(' · ');
    final addable = _epcs.where((t) => !widget.alreadyAdded.contains(t.epc)).toList();
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.8),
        child: Padding(
          padding: EdgeInsets.fromLTRB(20.w, 14.h, 20.w, 12.h),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                (r['name']?.toString() ?? '').toUpperCase(),
                style: GoogleFonts.spaceGrotesk(fontSize: 16.sp, fontWeight: FontWeight.w900, color: Colors.black),
              ),
              Text(
                [r['sku'], if (variant.isNotEmpty) variant].where((x) => (x?.toString() ?? '').isNotEmpty).join(' · '),
                style: GoogleFonts.robotoMono(fontSize: 13.sp, fontWeight: FontWeight.w700),
              ),
              SizedBox(height: 8.h),
              if (_loading)
                Padding(padding: EdgeInsets.all(20.r), child: const Center(child: CircularProgressIndicator()))
              else if (_error != null)
                Text(_error!, style: GoogleFonts.manrope(fontSize: 12.sp, fontWeight: FontWeight.w700, color: _kRed))
              else if (_epcs.isEmpty)
                Text('No EPCs for this item here.', style: GoogleFonts.manrope(fontSize: 13.sp, fontWeight: FontWeight.w700, color: _kMuted))
              else ...[
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        '${_ticked.length} OF ${addable.length} TICKED',
                        style: GoogleFonts.spaceGrotesk(fontSize: 11.sp, fontWeight: FontWeight.w800, letterSpacing: 1.2, color: _kMuted),
                      ),
                    ),
                    TextButton(
                      onPressed: () => setState(() => _ticked
                        ..clear()
                        ..addAll(addable.where((t) => t.status == 'in-stock').map((t) => t.epc))),
                      child: const Text('LIVE ONLY'),
                    ),
                    TextButton(
                      onPressed: () => setState(() => _ticked
                        ..clear()
                        ..addAll(addable.map((t) => t.epc))),
                      child: const Text('ALL'),
                    ),
                    TextButton(onPressed: () => setState(_ticked.clear), child: const Text('NONE')),
                  ],
                ),
                Flexible(
                  child: ListView.builder(
                    shrinkWrap: true,
                    itemCount: _epcs.length,
                    itemBuilder: (_, i) {
                      final t = _epcs[i];
                      final added = widget.alreadyAdded.contains(t.epc);
                      return CheckboxListTile(
                        dense: true,
                        contentPadding: EdgeInsets.zero,
                        controlAffinity: ListTileControlAffinity.leading,
                        value: added || _ticked.contains(t.epc),
                        onChanged: added
                            ? null
                            : (v) => setState(() {
                                  if (v == true) {
                                    _ticked.add(t.epc);
                                  } else {
                                    _ticked.remove(t.epc);
                                  }
                                }),
                        title: Text(t.epc, style: GoogleFonts.robotoMono(fontSize: 12.sp, fontWeight: FontWeight.w700)),
                        subtitle: Text(
                          [
                            (t.status ?? 'no status').toUpperCase(),
                            if ((t.bin ?? '').isNotEmpty) 'BIN ${t.bin}',
                            if (added) 'ON THE LIST',
                          ].join('  ·  '),
                          style: GoogleFonts.spaceGrotesk(fontSize: 11.sp, fontWeight: FontWeight.w800, color: _kMuted),
                        ),
                      );
                    },
                  ),
                ),
              ],
              SizedBox(height: 8.h),
              _WideButton(
                label: _ticked.isEmpty ? 'TICK THE EPCS TO ADD' : 'ADD ${_ticked.length} EPC${_ticked.length == 1 ? '' : 'S'}',
                icon: Icons.playlist_add,
                onPressed: _ticked.isEmpty
                    ? null
                    : () => Navigator.of(context).pop(_epcs.where((t) => _ticked.contains(t.epc)).toList()),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
