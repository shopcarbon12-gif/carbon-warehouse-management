import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:path_provider/path_provider.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/hardware/rfid_tag_read.dart';
import 'package:carbon_wms/hardware/rfid_vendor_channel.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/epc/epc_codec.dart';
import 'package:carbon_wms/services/handheld_device_identity.dart';
import 'package:carbon_wms/services/scan_sounds.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/screens/locate_tag_screen.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart' show CarbonScaffold;

const _countInvPrefsKey = 'count_inventory_module_settings_v1';
const _assetCachePrefsKey = 'count_inventory_asset_cache_v1';
const _countEpcPrefixFilter = 'F0A0B';

class CountInventoryScreen extends StatefulWidget {
  const CountInventoryScreen({super.key});

  @override
  State<CountInventoryScreen> createState() => _CountInventoryScreenState();
}

class _CountInventoryScreenState extends State<CountInventoryScreen> {
  final Map<String, _SessionEpcRow> _epcRows = <String, _SessionEpcRow>{};
  final Map<String, _GroupedRow> _groupedRows = <String, _GroupedRow>{};
  final Map<String, Map<String, dynamic>> _assetCache =
      <String, Map<String, dynamic>>{};
  List<Map<String, String>> _locations = [];
  String _currentLocationName = 'Loading...';
  String _currentLocationId = '';
  StreamSubscription<RfidTagRead>? _readsSub;
  StreamSubscription<RfidTagRead>? _directTagSub;
  StreamSubscription<String>? _triggerSub;
  StreamSubscription<String>? _barcodeSub;
  Timer? _scanInactivityTimer;
  Timer? _rfidKeepAliveTimer;
  Timer? _countAnimateTimer;
  // Throttles UI rebuilds during high-rate EPC ingest: tags ingest into in-memory maps
  // without setState; this timer flushes a single setState every 150ms while scanning is
  // live. Without it, Chainway's 300-700 tags/sec burst-rebuilds the list and starves the
  // main thread, causing audio focus churn and delayed start/stop beeps.
  Timer? _uiFlushTimer;
  static const Duration _uiFlushInterval = Duration(milliseconds: 150);
  Timer? _assetCachePersistTimer;
  DateTime? _assetCacheLastPersistAt;
  static const Duration _assetCachePersistDebounce = Duration(seconds: 2);
  bool _scanOn = false;
  bool _connecting = false;
  _CountInventoryModuleSettings _moduleSettings =
      _CountInventoryModuleSettings.defaults;
  RfidManager? _rfidManager;
  int _displayEpcCount = 0;
  int _displaySkuCount = 0;
  String? _previousScanContext;

  DateTime? _lastTriggerToggleAt;

  @override
  void initState() {
    super.initState();
    // Warm the shared scan sounds (pool-backed for low-latency per-tag read clicks).
    unawaited(ScanSounds.instance.init());
    WidgetsBinding.instance.addPostFrameCallback((_) {
      unawaited(_initModule());
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _rfidManager ??= context.read<RfidManager>();
  }

  @override
  void dispose() {
    _readsSub?.cancel();
    _directTagSub?.cancel();
    _triggerSub?.cancel();
    _barcodeSub?.cancel();
    _scanInactivityTimer?.cancel();
    _rfidKeepAliveTimer?.cancel();
    _countAnimateTimer?.cancel();
    _uiFlushTimer?.cancel();
    _assetCachePersistTimer?.cancel();
    final rfid = _rfidManager;
    if (rfid != null) {
      rfid.suppressEdgeStreaming = false;
      rfid.scanContext = _previousScanContext ?? 'TRANSFER';
      unawaited(rfid.pauseScanning());
      unawaited(rfid.reapplyHandheldHardwareSettings());
    }
    unawaited(() async {
      await RfidVendorChannel.open2dBarcode();
      await RfidVendorChannel.scannerEnableTriggerRelay();
    }());
    super.dispose();
  }

  Future<void> _initModule() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_countInvPrefsKey);
    final cacheRaw = prefs.getString(_assetCachePrefsKey);
    if (raw != null && raw.isNotEmpty) {
      final parsed = _CountInventoryModuleSettings.fromJsonString(raw);
      if (parsed != null) {
        _moduleSettings = parsed;
      }
    }
    if (cacheRaw != null && cacheRaw.isNotEmpty) {
      try {
        final decoded = jsonDecode(cacheRaw);
        if (decoded is Map<String, dynamic>) {
          for (final e in decoded.entries) {
            if (e.value is Map) {
              _assetCache[e.key] = Map<String, dynamic>.from(e.value as Map);
            }
          }
        }
      } catch (_) {}
    }
    if (!mounted) return;
    setState(() {});
    await _loadLocationName();
    await _ensureScannerReady();
  }

  Future<void> _loadLocationName() async {
    if (!mounted) return;
    try {
      final api = context.read<WmsApiClient>();
      final locs = await api
          .fetchSessionLocations()
          .timeout(const Duration(seconds: 6), onTimeout: () => []);
      if (!mounted) return;
      if (locs.isEmpty) {
        setState(() => _currentLocationName = 'COUNT SESSION');
        return;
      }
      final name = (locs.first['name'] ?? locs.first['code'] ?? '').trim();
      final id = (locs.first['id'] ?? '').trim();
      setState(() {
        _locations = locs;
        _currentLocationName = name.isNotEmpty ? name : 'COUNT SESSION';
        if (id.isNotEmpty) _currentLocationId = id;
      });
    } catch (_) {
      if (mounted) setState(() => _currentLocationName = 'COUNT SESSION');
    }
  }

  Future<void> _openLocationPicker() async {
    if (_locations.isEmpty) return;
    final picked = await showModalBottomSheet<Map<String, String>>(
      context: context,
      backgroundColor: Colors.white,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(8.r)),
      ),
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: EdgeInsets.fromLTRB(20.w, 16.h, 20.w, 8.h),
              child: Text(
                'SELECT LOCATION',
                style: GoogleFonts.spaceGrotesk(
                  fontSize: 13.sp,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 2.4,
                  color: AppColors.primary,
                ),
              ),
            ),
            ..._locations.map((loc) {
              final name = (loc['name'] ?? loc['code'] ?? '').trim();
              final id = (loc['id'] ?? '').trim();
              final isActive =
                  id == _currentLocationId || name == _currentLocationName;
              return ListTile(
                dense: true,
                title: Text(
                  name,
                  style: GoogleFonts.manrope(
                    fontSize: 15.sp,
                    fontWeight: FontWeight.w700,
                    color:
                        isActive ? AppColors.primary : const Color(0xFF11181C),
                  ),
                ),
                trailing: isActive
                    ? Icon(Icons.check, color: AppColors.primary, size: 20.sp)
                    : null,
                onTap: () => Navigator.of(ctx).pop(loc),
              );
            }),
            SizedBox(height: 8.h),
          ],
        ),
      ),
    );
    if (picked == null || !mounted) return;
    final name = (picked['name'] ?? picked['code'] ?? '').trim();
    final id = (picked['id'] ?? '').trim();
    if (name.isEmpty) return;
    setState(() {
      _currentLocationName = name;
      if (id.isNotEmpty) _currentLocationId = id;
    });
  }

  Future<void> _ensureScannerReady() async {
    if (_connecting) return;
    _connecting = true;
    try {
      final rfid = context.read<RfidManager>();
      _previousScanContext ??= rfid.scanContext;
      rfid.suppressEdgeStreaming = true;
      rfid.scanContext = 'COUNT';
      // Keep the existing active hardware session; avoid reconnect churn that can
      // momentarily disable RFID function mode before Count starts.

      // Disable 2D barcode trigger relay — prevent red laser in RFID count mode.
      // Trigger events are handled by our _triggerSub below (starts RFID, not 2D scan).
      await RfidVendorChannel.scannerDisableTriggerRelay();
      await RfidVendorChannel.close2dBarcode();
      await RfidVendorChannel.enableRfidFunctionMode();

      // Count gear settings override global settings while inside Count.
      await RfidVendorChannel.setAntennaPowerDbm(_moduleSettings.rfidPowerDbm);

      // Use only the direct vendor stream — RfidManager unified stream duplicates the same tags.
      await _readsSub?.cancel();
      _readsSub = null;
      await _directTagSub?.cancel();
      _directTagSub =
          RfidVendorChannel.tagReadStream().listen(_onTagRead, onError: (_) {});
      // Also listen to hardware_barcode — com.rscja.scanner broadcasts EPCs on OUTPUT_BARCODE_RFID
      // which arrives here. _ingestEpc deduplicates, so double-reads are safe.
      await _barcodeSub?.cancel();
      _barcodeSub = RfidVendorChannel.hardwareBarcodeStream().listen((raw) {
        if (kDebugMode) print('[CountInventory] hardware_barcode raw=$raw');
        final epc = _extractHardwareEpc(raw);
        if (epc == null) return;
        _ingestEpc(epc: epc, rssi: 0);
      }, onError: (_) {});
      await _triggerSub?.cancel();
      _triggerSub = RfidVendorChannel.hardwareTriggerStream().listen((event) {
        if (kDebugMode) print('[CountInventory] hardware_trigger event=$event');
        if (event == 'down') {
          if (_scanOn) {
            unawaited(_stopScan());
          } else {
            unawaited(_startScan());
          }
        }
      }, onError: (_) {});

      // Keep scanner transport warm on entry; scan starts only via START button or trigger.
      if (mounted) {
        setState(() {
          _scanOn = false;
        });
      }
    } finally {
      _connecting = false;
    }
  }

  Future<void> _saveModuleSettings() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_countInvPrefsKey, _moduleSettings.toJsonString());
  }

  Future<void> _openModuleSettings() async {
    final next =
        await Navigator.of(context).push<_CountInventoryModuleSettings>(
      MaterialPageRoute<_CountInventoryModuleSettings>(
        builder: (_) => _CountInventorySettingsScreen(initial: _moduleSettings),
      ),
    );
    if (next == null) return;
    setState(() => _moduleSettings = next);
    await _saveModuleSettings();
    // Count gear settings are authoritative while inside Count.
    await RfidVendorChannel.setAntennaPowerDbm(_moduleSettings.rfidPowerDbm);
  }

  Future<void> _playBeep() async {
    ScanSounds.instance.play(ScanCue.read);
  }

  Future<void> _playStartTone() async {
    ScanSounds.instance.play(ScanCue.start);
  }

  Future<void> _playStopTone() async {
    ScanSounds.instance.play(ScanCue.stop);
  }

  void _onTagRead(RfidTagRead read) {
    if (!_scanOn) return;
    final rssi = read.rssi ?? 0;
    // Count is inventory mode — accept all signal levels (rssiDistance filter is for locate/proximity, not count).
    final epc = read.epcHex24.toUpperCase();
    _ingestEpc(epc: epc, rssi: rssi);
  }

  void _ingestEpc({required String epc, required int rssi}) {
    final now = DateTime.now();
    // Normalize to even-length hex so odd-padded and unpadded forms map to the same key.
    final normalized = epc.length.isOdd ? '0$epc' : epc;
    final row = _epcRows[normalized];
    if (row != null) {
      // Hard lock: once an EPC is scanned in Count, repeat sightings are ignored.
      // Do NOT setState here — the flush timer repaints at 150ms intervals.
      return;
    }
    if (kDebugMode) {
      // ignore: avoid_print
      print('[CountInventory] onTagRead epc=$normalized rssi=$rssi');
    }
    _epcRows[normalized] = _SessionEpcRow(
      epc: normalized,
      assetId: normalized,
      prefixHex: '',
      serial: 0,
      firstSeen: now,
      lastSeen: now,
      rssi: rssi,
    );
    // Audible feedback on accepted EPC only — native SoundPool; does not block ingest.
    unawaited(_playBeep());
    // Group by system_id so repeated scans of the same SKU accumulate into one row.
    // Fall back to the raw EPC for tags we can't decode (legacy/foreign).
    final systemId = decodeSystemId(normalized);
    final groupKey = systemId?.toString() ?? normalized;
    final isNewGroup = !_groupedRows.containsKey(groupKey);
    final group = _groupedRows.putIfAbsent(
      groupKey,
      () => _GroupedRow(assetId: groupKey),
    );
    group.epcs.add(normalized);
    group.qty = group.epcs.length;
    group.lastRssi = rssi;
    if (isNewGroup) {
      if (systemId == null) {
        group.epcInvalid = true;
        group.sku = normalized;
      } else {
        final sysIdStr = systemId.toString();
        final cached = _assetCache[sysIdStr];
        if (cached != null) {
          _applyCatalogToGroup(group, cached);
        } else {
          unawaited(_resolveCatalog(sysIdStr, group));
        }
      }
    }
    // UI update happens via _uiFlushTimer at 150ms cadence; no per-tag setState.
  }

  Future<void> _resolveCatalog(String sysIdStr, _GroupedRow group) async {
    if (!mounted) return;
    final api = context.read<WmsApiClient>();
    try {
      final row = await api.catalogLookupBySystemId(sysIdStr);
      if (!mounted) return;
      if (row == null) {
        group.catalogMissing = true;
        group.catalogResolved = true;
      } else {
        final mapped = <String, dynamic>{
          'sku': (row['sku'] as String?) ?? '',
          'name': (row['name'] as String?) ?? '',
          'size': row['size'] as String?,
          'color': row['color'] as String?,
          'retail_price': row['retail_price'] as String?,
          'bin_location': row['bin_location'] as String?,
        };
        _applyCatalogToGroup(group, mapped);
        _assetCache[sysIdStr] = mapped;
        unawaited(_persistAssetCache());
      }
    } catch (_) {
      // Network error: leave unresolved so a future scan retries.
      // Do NOT set catalogMissing — that's reserved for confirmed 404.
    }
  }

  void _applyCatalogToGroup(_GroupedRow g, Map<String, dynamic> m) {
    g.customSku = (m['sku'] as String?) ?? '';
    g.itemName = (m['name'] as String?) ?? '';
    g.size = (m['size'] as String?) ?? '';
    g.color = (m['color'] as String?) ?? '';
    g.retailPriceStr = m['retail_price'] as String?;
    g.binLocation = m['bin_location'] as String?;
    g.catalogResolved = true;
    g.catalogMissing = false;
  }

  String _skuLine(_GroupedRow g) {
    if (g.epcInvalid) return 'Unknown EPC';
    if (g.catalogMissing) {
      return 'Unknown Item · system_id ${g.assetId}';
    }
    if (!g.catalogResolved) return 'SKU: …';
    if (g.customSku.isEmpty) return 'SKU: —';
    return 'SKU: ${g.customSku}';
  }

  String _priceText(_GroupedRow g) {
    if (!g.catalogResolved || g.catalogMissing || g.epcInvalid) return '';
    final price = double.tryParse(g.retailPriceStr ?? '');
    if (price == null || price <= 0) return '';
    return '\$${price.toStringAsFixed(2)}';
  }

  String _binText(_GroupedRow g) {
    if (!g.catalogResolved || g.catalogMissing || g.epcInvalid) return '';
    final bin = g.binLocation;
    if (bin == null || bin.trim().isEmpty) return '';
    return 'BIN ${bin.trim()}';
  }

  // Fallback row-2 text when the group is still pending, missing, or invalid —
  // at least show the first scanned EPC so the user sees something meaningful.
  String _fallbackRow2(_GroupedRow g) {
    if (g.catalogResolved && !g.catalogMissing && !g.epcInvalid) return '';
    if (g.epcs.isEmpty) return '';
    return g.epcs.first;
  }

  Future<void> _openGroupEpcList(_GroupedRow g) async {
    await Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder: (_) => _CountEpcListScreen(
          skuLine: _skuLine(g),
          itemName: g.itemName,
          color: g.color,
          size: g.size,
          priceText: _priceText(g),
          binText: _binText(g),
          epcs: g.epcs.toList()..sort(),
        ),
      ),
    );
  }

  Future<void> _persistAssetCache() async {
    final now = DateTime.now();
    final last = _assetCacheLastPersistAt;
    if (last != null &&
        now.difference(last) < _assetCachePersistDebounce &&
        _assetCachePersistTimer == null) {
      final wait = _assetCachePersistDebounce - now.difference(last);
      _assetCachePersistTimer = Timer(wait, () {
        _assetCachePersistTimer = null;
        unawaited(_persistAssetCache());
      });
      return;
    }
    if (_assetCachePersistTimer != null) {
      // A pending write is already scheduled; it will pick up the latest state.
      return;
    }
    _assetCacheLastPersistAt = now;
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_assetCachePrefsKey, jsonEncode(_assetCache));
    } catch (_) {}
  }

  void _startUiFlushTimer() {
    _uiFlushTimer?.cancel();
    _uiFlushTimer = Timer.periodic(_uiFlushInterval, (_) {
      if (!mounted) return;
      setState(() {});
      _syncDisplayedCounters();
    });
  }

  void _stopUiFlushTimer() {
    _uiFlushTimer?.cancel();
    _uiFlushTimer = null;
    // Final flush so the last few tags aren't missing from the UI.
    if (mounted) {
      setState(() {});
      _syncDisplayedCounters();
    }
  }

  void _syncDisplayedCounters() {
    if (!mounted) return;
    final targetEpc = _epcRows.length;
    final targetSku = _groupedRows.length;
    if (_displayEpcCount == targetEpc && _displaySkuCount == targetSku) {
      _countAnimateTimer?.cancel();
      _countAnimateTimer = null;
      return;
    }
    if (_countAnimateTimer != null) return;

    // Hard-lock visible progression to one-step increments only.
    _countAnimateTimer = Timer.periodic(const Duration(milliseconds: 35), (t) {
      if (!mounted) {
        t.cancel();
        _countAnimateTimer = null;
        return;
      }
      final epcTarget = _epcRows.length;
      final skuTarget = _groupedRows.length;
      setState(() {
        if (_displayEpcCount < epcTarget) {
          _displayEpcCount += 1;
        } else if (_displayEpcCount > epcTarget) {
          _displayEpcCount -= 1;
        }
        if (_displaySkuCount < skuTarget) {
          _displaySkuCount += 1;
        } else if (_displaySkuCount > skuTarget) {
          _displaySkuCount -= 1;
        }
      });
      if (_displayEpcCount == epcTarget && _displaySkuCount == skuTarget) {
        t.cancel();
        _countAnimateTimer = null;
      }
    });
  }

  Future<void> _startScan() async {
    if (_scanOn) return;
    await RfidVendorChannel.clearChainwaySeenEpcs();
    await RfidVendorChannel.setAntennaPowerDbm(_moduleSettings.rfidPowerDbm);
    try { await _rfidManager?.startLocateScanning(); } catch (_) {}
    if (!mounted) return;
    setState(() { _scanOn = true; });
    _startUiFlushTimer();
    unawaited(_playStartTone());
  }

  String? _extractHardwareEpc(String raw) {
    final compact = raw.trim().toUpperCase().replaceAll(RegExp(r'\s+'), '');
    if (compact.isEmpty) return null;
    final exact = RegExp(r'^[0-9A-F]{8,}$').firstMatch(compact)?.group(0);
    if (exact != null) return exact;
    final matches = RegExp(r'([0-9A-F]{8,})').allMatches(compact).toList();
    if (matches.isEmpty) return null;
    matches.sort(
        (a, b) => (b.group(1)?.length ?? 0).compareTo(a.group(1)?.length ?? 0));
    return matches.first.group(1);
  }

  Future<void> _stopScan() async {
    if (!_scanOn) return;
    _scanInactivityTimer?.cancel();
    _rfidKeepAliveTimer?.cancel();
    _stopUiFlushTimer();
    // Kill any in-flight read beeps so they don't trail past the stop event.
    ScanSounds.instance.stopAll();
    try { await _rfidManager?.stopLocateScanning(); } catch (_) {}
    if (!mounted) return;
    setState(() { _scanOn = false; });
    unawaited(_playStopTone());
  }

  Future<bool> _confirmDeleteItem() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Confirmation'),
        content: const Text('Delete item? (remove from scan list only)'),
        actions: [
          TextButton(
              onPressed: () => Navigator.of(ctx).pop(false),
              child: const Text('Cancel')),
          FilledButton(
              onPressed: () => Navigator.of(ctx).pop(true),
              child: const Text('Delete')),
        ],
      ),
    );
    return ok == true;
  }

  Future<void> _resetScreenToDefault() async {
    if (_scanOn) {
      await _stopScan();
    }
    if (!mounted) return;
    setState(() {
      _epcRows.clear();
      _groupedRows.clear();
    });
    _syncDisplayedCounters();
    unawaited(RfidVendorChannel.clearChainwaySeenEpcs());
  }

  Future<String?> _saveSessionCsvToDevice() async {
    final now = DateTime.now();
    final header =
        'asset_id,sku,name,color,size,qty,epc,prefix_hex,serial,first_seen_utc,last_seen_utc,lookup_source\n';
    final b = StringBuffer(header);
    final groups = _groupedRows.values.toList()
      ..sort((a, c) => a.assetId.compareTo(c.assetId));
    for (final g in groups) {
      final source = g.cached
          ? 'cache'
          : (g.sku.isEmpty && g.name.isEmpty ? 'unresolved' : 'lookup');
      for (final epc in g.epcs) {
        final row = _epcRows[epc];
        if (row == null) continue;
        b.writeln(
          '${g.assetId},${_csv(g.sku)},${_csv(g.name)},${_csv(g.color)},${_csv(g.size)},${g.qty},${row.epc},${row.prefixHex},${row.serial},${row.firstSeen.toUtc().toIso8601String()},${row.lastSeen.toUtc().toIso8601String()},$source',
        );
      }
    }
    final baseDir = await getExternalStorageDirectory() ??
        await getApplicationDocumentsDirectory();
    final dir = Directory('${baseDir.path}/reports');
    if (!await dir.exists()) {
      await dir.create(recursive: true);
    }
    final path =
        '${dir.path}/count_inventory_${now.year}${_two(now.month)}${_two(now.day)}_${_two(now.hour)}${_two(now.minute)}${_two(now.second)}.csv';
    await File(path).writeAsString(b.toString());
    return path;
  }

  Future<void> _openContinue() async {
    final groups = _groupedRows.values.toList()
      ..sort((a, b) => a.assetId.compareTo(b.assetId));
    await Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder: (_) => _CountInventoryContinueScreen(
          groupedRows: groups,
          locationName: _currentLocationName,
          onSaveCsv: _saveSessionCsvToDevice,
          buildBackendPreviewPayload: () => _buildBackendPreviewPayload(groups),
        ),
      ),
    );
  }

  Map<String, dynamic> _buildBackendPreviewPayload(List<_GroupedRow> groups) {
    return <String, dynamic>{
      'mode': 'count_inventory_preview',
      'generatedAtUtc': DateTime.now().toUtc().toIso8601String(),
      'items': groups
          .map((g) => <String, dynamic>{
                'assetId': g.assetId,
                'sku': g.sku,
                'name': g.name,
                'color': g.color,
                'size': g.size,
                'qty': g.qty,
                'epcs': g.epcs.toList()..sort(),
              })
          .toList(),
    };
  }

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final groups = _groupedRows.values.toList()
      ..sort((a, b) => a.assetId.compareTo(b.assetId));
    final hasRealRows = groups.isNotEmpty;
    final assetCount = _displayEpcCount;
    final skuCount = _displaySkuCount;
    final summaryValueText = '$assetCount';
    final summarySkuValueText = '$skuCount';
    final tileColor =
        isDark ? const Color(0xFF1C2828) : const Color(0xFFEEF4F3);
    final textColor = isDark ? const Color(0xFFE0ECEC) : AppColors.textMain;
    final summaryLabelColor =
        isDark ? const Color(0xFF5C6C6C) : const Color(0xFF3F4A4A);
    final watermarkColor =
        isDark ? const Color(0x66A0B3B3) : const Color(0x2995A5A7);
    const summaryBoxHeight = 60.0;

    return CarbonScaffold(
      pageTitle: 'count',
      actions: [
        IconButton(
          icon: const Icon(Icons.settings_outlined),
          onPressed: _openModuleSettings,
        ),
      ],
      body: Stack(
        children: [
          ColoredBox(
            color: Colors.white,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: EdgeInsets.fromLTRB(20.w, 2.h, 20.w, 0.h),
                  child: GestureDetector(
                    onTap: _locations.length > 1 ? _openLocationPicker : null,
                    behavior: HitTestBehavior.opaque,
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          _currentLocationName.toUpperCase(),
                          style: GoogleFonts.spaceGrotesk(
                            fontSize: 14.sp,
                            fontWeight: FontWeight.w700,
                            letterSpacing: 2.4,
                            color: AppColors.primary,
                          ),
                        ),
                        if (_locations.length > 1) ...[
                          SizedBox(width: 4.w),
                          Icon(Icons.expand_more,
                              size: 16.sp, color: AppColors.primary),
                        ],
                      ],
                    ),
                  ),
                ),
                Padding(
                  padding: EdgeInsets.fromLTRB(20.w, 12.h, 20.w, 0.h),
                  child: LayoutBuilder(
                    builder: (context, constraints) {
                      final tileWidth = (constraints.maxWidth - 8) / 2;
                      return Row(
                        children: [
                          _CountSummaryTile(
                            label: 'Total EPCs',
                            value: summaryValueText,
                            icon: Icons.inventory_2_outlined,
                            boxWidth: tileWidth,
                            boxHeight: summaryBoxHeight,
                            tileColor: tileColor,
                            textColor: textColor,
                            labelColor: summaryLabelColor,
                            watermarkColor: watermarkColor,
                          ),
                          SizedBox(width: 8.w),
                          _CountSummaryTile(
                            label: 'Total SKUs',
                            value: summarySkuValueText,
                            icon: Icons.precision_manufacturing_outlined,
                            boxWidth: tileWidth,
                            boxHeight: summaryBoxHeight,
                            tileColor: tileColor,
                            textColor: textColor,
                            labelColor: summaryLabelColor,
                            watermarkColor: watermarkColor,
                          ),
                        ],
                      );
                    },
                  ),
                ),
                SizedBox(height: 12.h),
                Expanded(
                  child: Padding(
                    padding: EdgeInsets.fromLTRB(20.w, 0.h, 20.w, 0.h),
                    child: hasRealRows
                        ? ListView.separated(
                            padding: EdgeInsets.only(bottom: 12.h),
                            itemCount: groups.length,
                            separatorBuilder: (_, __) => SizedBox(height: 12.h),
                            itemBuilder: (_, i) {
                              final g = groups[i];
                              return _CountItemContainer(
                                rowKey: 'real-${g.assetId}',
                                skuLine: _skuLine(g),
                                itemName: g.itemName,
                                color: g.color,
                                size: g.size,
                                priceText: _priceText(g),
                                binText: _binText(g),
                                descriptionFallback: _fallbackRow2(g),
                                qtyText: 'x${g.qty}',
                                onQtyTap: () => _openGroupEpcList(g),
                                onDelete: () {
                                  setState(() {
                                    for (final e in g.epcs) {
                                      _epcRows.remove(e);
                                    }
                                    _groupedRows.remove(g.assetId);
                                  });
                                  _syncDisplayedCounters();
                                },
                                confirmDelete: _confirmDeleteItem,
                              );
                            },
                          )
                        : Center(
                            child: Text(
                              'No items scanned yet',
                              style: GoogleFonts.manrope(
                                fontSize: 14.sp,
                                fontWeight: FontWeight.w700,
                                color: const Color(0xFF5A6464),
                              ),
                            ),
                          ),
                  ),
                ),
                Padding(
                  padding: EdgeInsets.fromLTRB(20.w, 10.h, 20.w, 10.h),
                  child: Row(
                    children: [
                      Expanded(
                        child: SizedBox(
                          height: 48,
                          child: FilledButton(
                            onPressed: () {
                              if (_scanOn) {
                                unawaited(_stopScan());
                              } else {
                                unawaited(_startScan());
                              }
                            },
                            style: FilledButton.styleFrom(
                              backgroundColor: _scanOn
                                  ? const Color(0xFFBF2E2E)
                                  : const Color(0xFF0A7C80),
                              foregroundColor: Colors.white,
                              shape: RoundedRectangleBorder(
                                  borderRadius: BorderRadius.circular(2.r)),
                              padding: EdgeInsets.symmetric(horizontal: 12.w),
                            ),
                            child: Row(
                              children: [
                                Expanded(
                                  child: Align(
                                    alignment: Alignment.centerLeft,
                                    child: Text(
                                      _scanOn ? 'STOP' : 'START',
                                      style: GoogleFonts.spaceGrotesk(
                                        fontSize: 16.sp,
                                        fontWeight: FontWeight.w800,
                                        letterSpacing: 1.8,
                                      ),
                                    ),
                                  ),
                                ),
                                SizedBox(width: 8.w),
                                Icon(
                                  _scanOn
                                      ? Icons.stop_circle_outlined
                                      : Icons.play_circle_outline,
                                  size: 20.sp,
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
                      SizedBox(width: 8.w),
                      SizedBox(
                        width: 48,
                        height: 48,
                        child: FilledButton(
                          onPressed: _resetScreenToDefault,
                          style: FilledButton.styleFrom(
                            backgroundColor: const Color(0xFF6A7575),
                            foregroundColor: Colors.white,
                            shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(2.r)),
                            padding: EdgeInsets.zero,
                          ),
                          child: Icon(Icons.restart_alt, size: 20.sp),
                        ),
                      ),
                      SizedBox(width: 8.w),
                      Expanded(
                        child: SizedBox(
                          height: 48,
                          child: FilledButton(
                            onPressed: _openContinue,
                            style: FilledButton.styleFrom(
                              backgroundColor: const Color(0xFF2BA3A3),
                              disabledBackgroundColor: const Color(0xFF2BA3A3),
                              foregroundColor: Colors.white,
                              disabledForegroundColor: Colors.white,
                              shape: RoundedRectangleBorder(
                                  borderRadius: BorderRadius.circular(2.r)),
                              padding: EdgeInsets.symmetric(horizontal: 12.w),
                            ),
                            child: Row(
                              mainAxisAlignment: MainAxisAlignment.center,
                              children: [
                                Text(
                                  'CONTINUE',
                                  style: GoogleFonts.spaceGrotesk(
                                    fontSize: 16.sp,
                                    fontWeight: FontWeight.w800,
                                    letterSpacing: 1.5,
                                    color: Colors.white,
                                  ),
                                ),
                                SizedBox(width: 8.w),
                                Icon(Icons.arrow_forward,
                                    size: 20.sp, color: Colors.white),
                              ],
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

// ── Legacy summary tile (kept for settings screen usage) ────────────────────

class _CountSummaryTile extends StatelessWidget {
  const _CountSummaryTile({
    required this.label,
    required this.value,
    required this.icon,
    required this.boxWidth,
    required this.boxHeight,
    required this.tileColor,
    required this.textColor,
    required this.labelColor,
    required this.watermarkColor,
  });

  final String label;
  final String value;
  final IconData icon;
  final double boxWidth;
  final double boxHeight;
  final Color tileColor;
  final Color textColor;
  final Color labelColor;
  final Color watermarkColor;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: boxWidth,
      height: boxHeight,
      child: Material(
        color: tileColor,
        borderRadius: BorderRadius.circular(2.r),
        clipBehavior: Clip.hardEdge,
        child: Stack(
          children: [
            Positioned(
              right: 4.w,
              bottom: 0.h,
              child: Icon(icon, size: 52.sp, color: watermarkColor),
            ),
            Padding(
              padding: EdgeInsets.fromLTRB(9.w, 3.h, 9.w, 3.h),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    label,
                    style: GoogleFonts.manrope(
                      fontSize: 13.sp,
                      fontWeight: FontWeight.w700,
                      color: labelColor,
                    ),
                  ),
                  Expanded(
                    child: Align(
                      alignment: Alignment.center,
                      child: Text(
                        _summaryCountDisplayString(value),
                        maxLines: 1,
                        softWrap: false,
                        overflow: TextOverflow.clip,
                        style: GoogleFonts.spaceGrotesk(
                          fontSize: 34.sp,
                          fontWeight: FontWeight.w700,
                          letterSpacing: -1.0,
                          color: textColor,
                          height: 1.0.h,
                        ),
                      ),
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

/// Summary numbers are never zero-padded (e.g. `00000` → `0`).
String _summaryCountDisplayString(String raw) {
  final n = int.tryParse(raw.trim());
  if (n == null) return raw;
  return n.toString();
}

class _CountItemContainer extends StatefulWidget {
  const _CountItemContainer({
    required this.rowKey,
    required this.skuLine,
    required this.itemName,
    required this.color,
    required this.size,
    required this.priceText,
    required this.binText,
    required this.descriptionFallback,
    required this.qtyText,
    this.onQtyTap,
    this.onDelete,
    this.confirmDelete,
  });

  final String rowKey;
  final String skuLine;
  final String itemName;
  final String color;
  final String size;
  final String priceText;
  final String binText;
  // Used when the group is still resolving / unknown / invalid — shown on row 2
  // in place of the item-name/color/size.
  final String descriptionFallback;
  final String qtyText;
  final VoidCallback? onQtyTap;
  final VoidCallback? onDelete;
  final Future<bool> Function()? confirmDelete;

  @override
  State<_CountItemContainer> createState() => _CountItemContainerState();
}

class _CountItemContainerState extends State<_CountItemContainer> {
  bool _expanded = false;

  // Cache styles per State instance — GoogleFonts.xxx() is a map lookup each
  // call, and we rebuild every 150ms during a scan burst. Building them once
  // per row instead of once per build saves a lot of work.
  late final TextStyle _skuStyle = GoogleFonts.robotoMono(
    fontSize: 19.sp,
    fontWeight: FontWeight.w700,
    color: AppColors.textMain,
    letterSpacing: 0.0,
    height: 1.2,
  );
  late final TextStyle _descStyle = GoogleFonts.manrope(
    fontSize: 14.sp,
    fontWeight: FontWeight.w700,
    color: AppColors.textMain,
    letterSpacing: 0.0,
    height: 1.2,
  );
  late final TextStyle _priceStyle = GoogleFonts.manrope(
    fontSize: 14.sp,
    fontWeight: FontWeight.w800,
    color: AppColors.textMain,
    letterSpacing: 0.0,
    height: 1.2,
  );
  late final TextStyle _binStyle = GoogleFonts.manrope(
    fontSize: 13.sp,
    fontWeight: FontWeight.w700,
    color: const Color(0xFF3F4A4A),
    letterSpacing: 0.2,
    height: 1.2,
  );
  late final TextStyle _qtyStyle = GoogleFonts.spaceGrotesk(
    fontSize: 26.sp,
    fontWeight: FontWeight.w800,
    color: AppColors.primary,
    letterSpacing: 0.0,
    height: 1.2,
  );

  @override
  Widget build(BuildContext context) {
    final skuStyle = _skuStyle;
    final descStyle = _descStyle;
    final priceStyle = _priceStyle;
    final binStyle = _binStyle;

    final descLeft = widget.descriptionFallback.isNotEmpty
        ? widget.descriptionFallback
        : [
            if (widget.itemName.isNotEmpty) widget.itemName,
            if (widget.color.isNotEmpty) widget.color,
            if (widget.size.isNotEmpty) widget.size,
          ].join(' ');

    final hasPrice = widget.priceText.isNotEmpty;
    final hasBin = widget.binText.isNotEmpty;

    final expanded = _expanded;
    final content = Material(
      color: const Color(0xFFECECEC),
      borderRadius: BorderRadius.zero,
      child: InkWell(
        onTap: () => setState(() => _expanded = !_expanded),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            Expanded(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(12, 8, 8, 8),
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    // Row 1 — SKU (left) + price (right)
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.baseline,
                      textBaseline: TextBaseline.alphabetic,
                      children: [
                        Expanded(
                          child: Text(
                            widget.skuLine,
                            style: skuStyle,
                            maxLines: expanded ? null : 1,
                            overflow: expanded
                                ? TextOverflow.visible
                                : TextOverflow.ellipsis,
                            textAlign: TextAlign.left,
                          ),
                        ),
                        if (hasPrice) ...[
                          SizedBox(width: 8.w),
                          Text(widget.priceText, style: priceStyle),
                        ],
                      ],
                    ),
                    if (descLeft.isNotEmpty) ...[
                      SizedBox(height: 3.h),
                      Text(
                        descLeft,
                        style: descStyle,
                        maxLines: expanded ? null : 1,
                        overflow: expanded
                            ? TextOverflow.visible
                            : TextOverflow.ellipsis,
                        textAlign: TextAlign.left,
                      ),
                    ],
                    if (hasBin) ...[
                      SizedBox(height: 2.h),
                      Text(
                        widget.binText,
                        style: binStyle,
                        maxLines: expanded ? null : 1,
                        overflow: expanded
                            ? TextOverflow.visible
                            : TextOverflow.ellipsis,
                      ),
                    ],
                  ],
                ),
              ),
            ),
            SizedBox(width: 4.w),
            GestureDetector(
              onTap: widget.onQtyTap,
              behavior: HitTestBehavior.opaque,
              child: Padding(
                padding: const EdgeInsets.only(left: 6, right: 12),
                child: Text(widget.qtyText, style: _qtyStyle),
              ),
            ),
          ],
        ),
      ),
    );

    if (widget.onDelete == null || widget.confirmDelete == null) {
      return content;
    }

    return Dismissible(
      key: ValueKey<String>(widget.rowKey),
      direction: DismissDirection.endToStart,
      background: Container(
        alignment: Alignment.centerRight,
        padding: EdgeInsets.symmetric(horizontal: 14.w),
        color: const Color(0xFFBF2E2E),
        child: Icon(Icons.delete_outline, color: Colors.white, size: 26.sp),
      ),
      confirmDismiss: (_) async {
        final ok = await widget.confirmDelete!.call();
        if (ok) widget.onDelete!.call();
        return ok;
      },
      child: content,
    );
  }
}

class _CountEpcListScreen extends StatelessWidget {
  const _CountEpcListScreen({
    required this.skuLine,
    required this.itemName,
    required this.color,
    required this.size,
    required this.priceText,
    required this.binText,
    required this.epcs,
  });

  final String skuLine;
  final String itemName;
  final String color;
  final String size;
  final String priceText;
  final String binText;
  final List<String> epcs;

  @override
  Widget build(BuildContext context) {
    // Strip the "SKU: " prefix the caller already added so we can show our own
    // labelled rows consistently (and avoid "SKU: SKU: …").
    final skuValue = skuLine.startsWith('SKU: ')
        ? skuLine.substring(5).trim()
        : skuLine;
    // Same idea for the bin — caller passes "BIN xxxxx".
    final binValue = binText.startsWith('BIN ')
        ? binText.substring(4).trim()
        : binText;

    final headerBg = const Color(0xFFECECEC);

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
    final skuValueStyle = GoogleFonts.robotoMono(
      fontSize: 19.sp,
      fontWeight: FontWeight.w700,
      color: AppColors.textMain,
      height: 1.25,
    );
    final priceStyle = GoogleFonts.manrope(
      fontSize: 16.sp,
      fontWeight: FontWeight.w800,
      color: AppColors.textMain,
      height: 1.25,
    );

    Widget labeledRow({
      required String label,
      required String value,
      TextStyle? overrideValueStyle,
      Widget? trailing,
    }) {
      return Padding(
        padding: EdgeInsets.only(bottom: 4.h),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.baseline,
          textBaseline: TextBaseline.alphabetic,
          children: [
            Text(label, style: labelStyle),
            SizedBox(width: 6.w),
            Expanded(
              child: Text(
                value,
                style: overrideValueStyle ?? valueStyle,
              ),
            ),
            if (trailing != null) ...[
              SizedBox(width: 8.w),
              trailing,
            ],
          ],
        ),
      );
    }

    final nameColorValue = [
      if (itemName.isNotEmpty) itemName,
      if (color.isNotEmpty) color,
    ].join(': ');

    return CarbonScaffold(
      pageTitle: 'EPC LIST',
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: double.infinity,
            color: headerBg,
            padding: EdgeInsets.fromLTRB(16.w, 12.h, 16.w, 10.h),
            margin: EdgeInsets.fromLTRB(16.w, 12.h, 16.w, 8.h),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // Row 1 — SKU value (left) + price (right)
                labeledRow(
                  label: 'SKU:',
                  value: skuValue,
                  overrideValueStyle: skuValueStyle,
                  trailing:
                      priceText.isNotEmpty ? Text(priceText, style: priceStyle) : null,
                ),
                if (nameColorValue.isNotEmpty)
                  labeledRow(label: 'NAME:COLOR:', value: nameColorValue),
                if (size.isNotEmpty) labeledRow(label: 'SIZE:', value: size),
                if (binValue.isNotEmpty) labeledRow(label: 'BIN:', value: binValue),
              ],
            ),
          ),
          Padding(
            padding: EdgeInsets.fromLTRB(20.w, 4.h, 20.w, 4.h),
            child: Text(
              'EPCs (${epcs.length})',
              style: GoogleFonts.spaceGrotesk(
                fontSize: 12.sp,
                fontWeight: FontWeight.w700,
                color: const Color(0xFF5A6464),
                letterSpacing: 2.0,
              ),
            ),
          ),
          Expanded(
            child: ListView.separated(
              padding: EdgeInsets.fromLTRB(16.w, 0, 16.w, 12.h),
              itemCount: epcs.length,
              separatorBuilder: (_, __) => Divider(height: 1.h),
              itemBuilder: (_, i) {
                final epc = epcs[i];
                final serial = decodeSerial(epc);
                final serialText = serial == null ? '—' : serial.toString();
                return Padding(
                  padding: EdgeInsets.symmetric(vertical: 8.h),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.center,
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(
                              epc,
                              style: GoogleFonts.robotoMono(
                                fontSize: 17.sp,
                                fontWeight: FontWeight.w700,
                                color: AppColors.textMain,
                                height: 1.2,
                              ),
                            ),
                            SizedBox(height: 3.h),
                            Text(
                              'serial: $serialText',
                              style: GoogleFonts.manrope(
                                fontSize: 15.sp,
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
                          icon: Icon(Icons.sensors,
                              size: 26.sp, color: AppColors.primary),
                          onPressed: () {
                            Navigator.of(context).push<void>(
                              MaterialPageRoute<void>(
                                builder: (_) =>
                                    LocateTagScreen(targetEpc: epc),
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

class _CountInventoryContinueScreen extends StatefulWidget {
  const _CountInventoryContinueScreen({
    required this.groupedRows,
    required this.locationName,
    required this.onSaveCsv,
    required this.buildBackendPreviewPayload,
  });

  final List<_GroupedRow> groupedRows;
  final String locationName;
  final Future<String?> Function() onSaveCsv;
  final Map<String, dynamic> Function() buildBackendPreviewPayload;

  @override
  State<_CountInventoryContinueScreen> createState() =>
      _CountInventoryContinueScreenState();
}

class _CountInventoryContinueScreenState
    extends State<_CountInventoryContinueScreen> {
  bool _overrideEntireCloudQuantities = false;
  bool _savingCsv = false;

  @override
  Widget build(BuildContext context) {
    final totalItems =
        widget.groupedRows.fold<int>(0, (sum, row) => sum + row.qty);
    final canUpload = totalItems > 0;
    const fileNameValue = '';
    const fileStatusValue = 'N/A';

    return CarbonScaffold(
      pageTitle: 'commit',
      actions: const [],
      bottomBar: Container(
        height: 80.h,
        decoration: const BoxDecoration(
          color: Colors.white,
          boxShadow: [
            BoxShadow(
              color: Color(0x14000000),
              blurRadius: 24,
              offset: Offset(0, -8),
            ),
          ],
        ),
        child: SafeArea(
          top: false,
          child: Padding(
            padding: EdgeInsets.fromLTRB(16.w, 0.h, 16.w, 0.h),
            child: Row(
              children: [
                Expanded(
                  child: Padding(
                    padding: EdgeInsets.symmetric(horizontal: 4.w),
                    child: SizedBox(
                      height: double.infinity,
                      child: FilledButton(
                        onPressed: canUpload ? () {} : null,
                        style: FilledButton.styleFrom(
                          backgroundColor: const Color(0xFF1B7D7D),
                          disabledBackgroundColor: const Color(0xFF1B7D7D),
                          foregroundColor: Colors.white,
                          disabledForegroundColor: Colors.white,
                          shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(2.r)),
                        ),
                        child: FittedBox(
                          fit: BoxFit.scaleDown,
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Icon(Icons.cloud_upload, size: 20.sp),
                              SizedBox(width: 8.w),
                              Text(
                                'UPLOAD',
                                style: GoogleFonts.spaceGrotesk(
                                  fontSize: 14.sp,
                                  fontWeight: FontWeight.w800,
                                  letterSpacing: 0.5,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
                Expanded(
                  child: Padding(
                    padding: EdgeInsets.symmetric(horizontal: 4.w),
                    child: SizedBox(
                      height: double.infinity,
                      child: FilledButton(
                        onPressed: _savingCsv
                            ? null
                            : () async {
                                setState(() => _savingCsv = true);
                                final messenger = ScaffoldMessenger.of(context);
                                try {
                                  final path = await widget.onSaveCsv();
                                  if (!mounted) return;
                                  messenger.showSnackBar(
                                    SnackBar(
                                      content: Text(path != null
                                          ? 'Saved: $path'
                                          : 'Save failed'),
                                      duration: const Duration(seconds: 4),
                                    ),
                                  );
                                } finally {
                                  if (mounted) {
                                    setState(() => _savingCsv = false);
                                  }
                                }
                              },
                        style: FilledButton.styleFrom(
                          backgroundColor: const Color(0xFF2BA3A3),
                          foregroundColor: Colors.white,
                          shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(2.r)),
                        ),
                        child: FittedBox(
                          fit: BoxFit.scaleDown,
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              _savingCsv
                                  ? SizedBox(
                                      width: 20.w,
                                      height: 20.h,
                                      child: const CircularProgressIndicator(
                                          strokeWidth: 2, color: Colors.white))
                                  : Icon(Icons.save, size: 20.sp),
                              SizedBox(width: 8.w),
                              Text(
                                'SAVE TO FILE',
                                style: GoogleFonts.spaceGrotesk(
                                  fontSize: 14.sp,
                                  fontWeight: FontWeight.w800,
                                  letterSpacing: 0.5,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
      body: LayoutBuilder(
        builder: (context, constraints) {
          const double padTop = 6;
          const double padBottom = 12;
          final double heroH = 148.h;
          final double procH = 145.h;
          final double fileH = 112.h;
          final double overH = 148.h;

          final labelStyle = GoogleFonts.spaceGrotesk(
            fontSize: 14.sp,
            fontWeight: FontWeight.w500,
            letterSpacing: 3.0,
            color: const Color(0xFF5A6464),
          );

          return ColoredBox(
            color: Colors.white,
            child: SingleChildScrollView(
              padding: EdgeInsets.fromLTRB(16.w, padTop, 16.w, padBottom),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text('Inventory Management Terminal', style: labelStyle),
                  SizedBox(height: 12.h),
                  SizedBox(
                    height: heroH,
                    child: Container(
                      color: const Color(0xFFE7EBEB),
                      padding: EdgeInsets.fromLTRB(14.w, 10.h, 14.w, 8.h),
                      child: Center(
                        child: FractionallySizedBox(
                          widthFactor: 0.9,
                          alignment: Alignment.center,
                          child: RichText(
                            textAlign: TextAlign.left,
                            text: TextSpan(
                              style: GoogleFonts.manrope(
                                fontSize: 30.sp,
                                fontWeight: FontWeight.w800,
                                letterSpacing: -0.2,
                                height: 1.38.h,
                                color: const Color(0xFF11181C),
                              ),
                              children: [
                                const TextSpan(text: 'Upload to '),
                                TextSpan(
                                  text: widget.locationName.toUpperCase(),
                                  style: const TextStyle(
                                      color: Color(0xFF009496),
                                      fontWeight: FontWeight.w800),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                  SizedBox(height: 12.h),
                  SizedBox(
                    height: procH,
                    child: Container(
                      decoration: BoxDecoration(
                        color: const Color(0xFFFAFAFA),
                        border: Border(
                            left: BorderSide(
                                color: const Color(0xFF009496), width: 6.w)),
                        borderRadius: BorderRadius.circular(2.r),
                        boxShadow: const [
                          BoxShadow(
                            color: Color(0x14000000),
                            blurRadius: 6,
                            offset: Offset(0, 2),
                          ),
                        ],
                      ),
                      padding: EdgeInsets.fromLTRB(14.w, 12.h, 14.w, 12.h),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Container(
                                width: 8.w,
                                height: 8.h,
                                decoration: const BoxDecoration(
                                  color: Color(0xFF009496),
                                  shape: BoxShape.circle,
                                ),
                              ),
                              SizedBox(width: 8.w),
                              Text(
                                'TOTAL PROCESSING LOAD',
                                style: GoogleFonts.spaceGrotesk(
                                  fontSize: 12.sp,
                                  fontWeight: FontWeight.w700,
                                  letterSpacing: 4.0,
                                  color: const Color(0xFF71717A),
                                ),
                              ),
                            ],
                          ),
                          SizedBox(height: 8.h),
                          Text(
                            'NO ITEMS SCANNED',
                            style: GoogleFonts.spaceGrotesk(
                              fontSize: 14.sp,
                              fontWeight: FontWeight.w800,
                              letterSpacing: 2.2,
                              color: const Color(0xFF009496),
                              height: 1.0.h,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                  SizedBox(height: 12.h),
                  SizedBox(
                    height: fileH,
                    child: Container(
                      decoration: BoxDecoration(
                        color: const Color(0xFFF0F5F4),
                        borderRadius: BorderRadius.circular(2.r),
                      ),
                      padding: EdgeInsets.all(24.r),
                      child: Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Expanded(
                            child: Row(
                              children: [
                                Container(
                                  width: 48.w,
                                  height: 48.h,
                                  decoration: BoxDecoration(
                                    color: const Color(0xFF009496),
                                    borderRadius: BorderRadius.circular(2.r),
                                  ),
                                  child: Icon(
                                    Icons.description_outlined,
                                    color: Colors.white,
                                    size: 24.sp,
                                  ),
                                ),
                                SizedBox(width: 16.w),
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    mainAxisAlignment: MainAxisAlignment.center,
                                    children: [
                                      Text(
                                        fileNameValue,
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                        style: GoogleFonts.manrope(
                                          fontSize: 16.sp,
                                          fontWeight: FontWeight.w700,
                                          color: const Color(0xFF11181C),
                                        ),
                                      ),
                                      Text(
                                        fileStatusValue,
                                        style: GoogleFonts.spaceGrotesk(
                                          fontSize: 14.sp,
                                          fontWeight: FontWeight.w800,
                                          letterSpacing: 2.2,
                                          color: const Color(0xFF009496),
                                          height: 1.0.h,
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                  SizedBox(height: 12.h),
                  SizedBox(
                    height: overH,
                    child: Container(
                      decoration: BoxDecoration(
                        color: const Color(0xFFE7EBEB),
                        borderRadius: BorderRadius.circular(2.r),
                      ),
                      child: Material(
                        color: Colors.transparent,
                        child: InkWell(
                          borderRadius: BorderRadius.circular(2.r),
                          onTap: () {
                            setState(() => _overrideEntireCloudQuantities =
                                !_overrideEntireCloudQuantities);
                          },
                          child: Padding(
                            padding:
                                EdgeInsets.fromLTRB(14.w, 12.h, 12.w, 12.h),
                            child: Row(
                              mainAxisAlignment: MainAxisAlignment.spaceBetween,
                              children: [
                                Expanded(
                                  child: Padding(
                                    padding: EdgeInsets.only(right: 4.w),
                                    child: Column(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.start,
                                      children: [
                                        Text(
                                          'Override Entire Cloud\nQuantities',
                                          style: GoogleFonts.manrope(
                                            fontSize: 18.sp,
                                            fontWeight: FontWeight.w700,
                                            height: 1.35.h,
                                            color: const Color(0xFF11181C),
                                          ),
                                        ),
                                        SizedBox(height: 4.h),
                                        Text(
                                          '- if checked: replaced existing\nquantities and zero missing items',
                                          maxLines: 2,
                                          style: GoogleFonts.spaceGrotesk(
                                            fontSize: 16.sp,
                                            fontWeight: FontWeight.w700,
                                            height: 1.45.h,
                                            color: const Color(0xFFBF2E2E),
                                          ),
                                        ),
                                      ],
                                    ),
                                  ),
                                ),
                                SizedBox(
                                  width: 44.w,
                                  height: 44.h,
                                  child: Checkbox(
                                    value: _overrideEntireCloudQuantities,
                                    onChanged: (next) {
                                      setState(() =>
                                          _overrideEntireCloudQuantities =
                                              next ?? false);
                                    },
                                    shape: RoundedRectangleBorder(
                                        borderRadius:
                                            BorderRadius.circular(2.r)),
                                    side: BorderSide(
                                        color: const Color(0xFF7C8A8A),
                                        width: 2.w),
                                    activeColor: const Color(0xFF009496),
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}

/// Count gear → RFID settings (Count-only prefs). Stitch reference: stitch_carbonwms_project_requirements (11)/code.html
class _CountInventorySettingsScreen extends StatefulWidget {
  const _CountInventorySettingsScreen({required this.initial});

  final _CountInventoryModuleSettings initial;

  @override
  State<_CountInventorySettingsScreen> createState() =>
      _CountInventorySettingsScreenState();
}

class _CountInventorySettingsScreenState
    extends State<_CountInventorySettingsScreen> {
  static const Color _primary = Color(0xFF009496);
  static const Color _outline = Color(0xFF6D7979);
  static const Color _onSurface = Color(0xFF171D1D);
  static const Color _sliderTrack = Color(0xFFEAF0EE);

  late int _power;
  late double _rssi;
  bool _busy = false;
  String _hardwareId = '—';
  String _firmware = '—';
  Timer? _powerApplyTimer;
  Map<String, dynamic> _diag = const <String, dynamic>{};
  static const MethodChannel _device = MethodChannel('carbon_wms/rfid');

  /// Maps stored 0..1 to RSSI display dB in [-90, -30] (stitch mock).
  int get _rssiDb => (-90 + _rssi * 60).round();

  @override
  void initState() {
    super.initState();
    _power = widget.initial.rfidPowerDbm;
    _rssi = widget.initial.rssiDistance;
    _loadDeviceMeta();
    _refreshDiagnostics();
  }

  @override
  void dispose() {
    _powerApplyTimer?.cancel();
    super.dispose();
  }

  Future<void> _loadDeviceMeta() async {
    try {
      final info = await PackageInfo.fromPlatform();
      final id = await HandheldDeviceIdentity.primaryDeviceIdForServer();
      if (!mounted) return;
      setState(() {
        _firmware = 'v${info.version}+${info.buildNumber}';
        _hardwareId = id;
      });
    } catch (_) {
      if (mounted) setState(() {});
    }
  }

  Future<void> _refreshDiagnostics() async {
    final d = await RfidVendorChannel.deviceDiagnostics();
    if (!mounted) return;
    setState(() => _diag = d);
  }

  void _schedulePowerApply() {
    _powerApplyTimer?.cancel();
    _powerApplyTimer = Timer(const Duration(milliseconds: 180), () async {
      await RfidVendorChannel.setAntennaPowerDbm(_power);
      if (!mounted) return;
      final rfid = context.read<RfidManager>();
      await rfid.reapplyHandheldHardwareSettings();
      if (mounted) {
        setState(() {});
      }
    });
  }

  Future<void> _openScannerSettings() async {
    try {
      final ok = await _device.invokeMethod<bool>('device.openScannerSettings');
      if (!mounted) return;
      if (ok == true) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
            content: Text('Scanner settings app not found on this device.')),
      );
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Unable to open scanner settings.')),
      );
    }
  }

  Future<void> _restartRfidController() async {
    if (_busy) return;
    setState(() => _busy = true);
    final rfid = context.read<RfidManager>();
    await rfid.autoDetectHardware();
    await rfid.reapplyHandheldHardwareSettings();
    await RfidVendorChannel.setAntennaPowerDbm(_power);
    await _refreshDiagnostics();
    if (!mounted) return;
    setState(() => _busy = false);
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('RFID controller restarted')),
    );
  }

  @override
  Widget build(BuildContext context) {
    final sliderTheme = SliderTheme.of(context).copyWith(
      activeTrackColor: _sliderTrack,
      inactiveTrackColor: _sliderTrack,
      trackHeight: 12,
      thumbColor: _primary,
      overlayColor: _primary.withValues(alpha: 0.12),
      thumbShape: _RectSliderThumbShape(width: 24.w, height: 48.h),
      trackShape: const RoundedRectSliderTrackShape(),
    );

    return CarbonScaffold(
      pageTitle: 'rfid settings',
      actions: const [],
      bottomBar: Container(
        decoration: const BoxDecoration(
          color: Colors.white,
          border: Border(top: BorderSide(color: Color(0xFFF4F4F5))),
        ),
        child: SafeArea(
          top: false,
          child: Padding(
            padding: EdgeInsets.fromLTRB(24.w, 16.h, 24.w, 16.h),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                SizedBox(
                  width: double.infinity,
                  height: 56.h,
                  child: FilledButton.icon(
                    onPressed: () {
                      Navigator.of(context).pop(
                        _CountInventoryModuleSettings(
                            rfidPowerDbm: _power, rssiDistance: _rssi),
                      );
                    },
                    style: FilledButton.styleFrom(
                      backgroundColor: _primary,
                      foregroundColor: Colors.white,
                      shape: const RoundedRectangleBorder(
                          borderRadius: BorderRadius.zero),
                      textStyle: GoogleFonts.spaceGrotesk(
                        fontSize: 14.sp,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 2,
                      ),
                    ),
                    icon: Icon(Icons.save_outlined, size: 22.sp),
                    label: const Text('SAVE'),
                  ),
                ),
                SizedBox(height: 12.h),
                SizedBox(
                  width: double.infinity,
                  height: 56.h,
                  child: OutlinedButton.icon(
                    onPressed: _busy ? null : _restartRfidController,
                    style: OutlinedButton.styleFrom(
                      foregroundColor: _primary,
                      side: BorderSide(color: _primary, width: 2.w),
                      shape: const RoundedRectangleBorder(
                          borderRadius: BorderRadius.zero),
                      textStyle: GoogleFonts.spaceGrotesk(
                        fontSize: 14.sp,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 2,
                      ),
                    ),
                    icon: _busy
                        ? SizedBox(
                            width: 22.w,
                            height: 22.h,
                            child: const CircularProgressIndicator(
                                strokeWidth: 2, color: _primary),
                          )
                        : Icon(Icons.restart_alt, size: 22.sp),
                    label: Text(_busy ? 'RESTARTING…' : 'RESTART CONTROLLER'),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
      body: ColoredBox(
        color: Colors.white,
        child: ListView(
          padding: EdgeInsets.fromLTRB(24.w, 48.h, 24.w, 24.h),
          children: [
            Text(
              'RFID Settings',
              style: GoogleFonts.manrope(
                fontSize: 30.sp,
                fontWeight: FontWeight.w800,
                letterSpacing: -0.5,
                height: 1.15.h,
                color: _onSurface,
              ),
            ),
            SizedBox(height: 4.h),
            Text(
              'Configure antenna interface and signal filtering.',
              style: GoogleFonts.inter(
                fontSize: 14.sp,
                fontWeight: FontWeight.w500,
                color: _outline,
                height: 1.3.h,
              ),
            ),
            SizedBox(height: 40.h),
            Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Expanded(
                  child: Text(
                    'ANTENNA POWER OUTPUT',
                    style: GoogleFonts.manrope(
                      fontSize: 12.sp,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 2,
                      color: _outline,
                    ),
                  ),
                ),
                Text.rich(
                  TextSpan(
                    children: [
                      TextSpan(
                        text: '$_power',
                        style: GoogleFonts.robotoMono(
                          fontSize: 32.sp,
                          fontWeight: FontWeight.w700,
                          color: _primary,
                        ),
                      ),
                      TextSpan(
                        text: ' dBm',
                        style: GoogleFonts.robotoMono(
                          fontSize: 14.sp,
                          fontWeight: FontWeight.w500,
                          color: _outline,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            SizedBox(height: 24.h),
            SizedBox(
              height: 56.h,
              child: SliderTheme(
                data: sliderTheme,
                child: Slider(
                  value: _power.toDouble(),
                  min: 0,
                  max: 30,
                  divisions: 30,
                  onChanged: (v) {
                    setState(() => _power = v.round());
                    _schedulePowerApply();
                  },
                ),
              ),
            ),
            SizedBox(height: 8.h),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(
                  '0 dBm',
                  style: GoogleFonts.robotoMono(
                    fontSize: 10.sp,
                    fontWeight: FontWeight.w700,
                    color: _outline,
                  ),
                ),
                Text(
                  '30 dBm',
                  style: GoogleFonts.robotoMono(
                    fontSize: 10.sp,
                    fontWeight: FontWeight.w700,
                    color: _outline,
                  ),
                ),
              ],
            ),
            SizedBox(height: 48.h),
            Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Expanded(
                  child: Text(
                    'RSSI SENSITIVITY',
                    style: GoogleFonts.manrope(
                      fontSize: 12.sp,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 2,
                      color: _outline,
                    ),
                  ),
                ),
                Text.rich(
                  TextSpan(
                    children: [
                      TextSpan(
                        text: '$_rssiDb',
                        style: GoogleFonts.robotoMono(
                          fontSize: 32.sp,
                          fontWeight: FontWeight.w700,
                          color: _primary,
                        ),
                      ),
                      TextSpan(
                        text: ' dB',
                        style: GoogleFonts.robotoMono(
                          fontSize: 14.sp,
                          fontWeight: FontWeight.w500,
                          color: _outline,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            SizedBox(height: 24.h),
            SizedBox(
              height: 56.h,
              child: SliderTheme(
                data: sliderTheme,
                child: Slider(
                  value: _rssi,
                  min: 0,
                  max: 1,
                  onChanged: (v) => setState(() => _rssi = v),
                ),
              ),
            ),
            SizedBox(height: 8.h),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(
                  '-90 dB',
                  style: GoogleFonts.robotoMono(
                    fontSize: 10.sp,
                    fontWeight: FontWeight.w700,
                    color: _outline,
                  ),
                ),
                Text(
                  '-30 dB',
                  style: GoogleFonts.robotoMono(
                    fontSize: 10.sp,
                    fontWeight: FontWeight.w700,
                    color: _outline,
                  ),
                ),
              ],
            ),
            SizedBox(height: 32.h),
            SizedBox(
              width: double.infinity,
              height: 48.h,
              child: OutlinedButton.icon(
                onPressed: _openScannerSettings,
                style: OutlinedButton.styleFrom(
                  foregroundColor: _primary,
                  side: BorderSide(color: _primary, width: 2.w),
                  shape: const RoundedRectangleBorder(
                      borderRadius: BorderRadius.zero),
                ),
                icon: Icon(Icons.tune, size: 20.sp),
                label: Text(
                  'OPEN DEVICE SCANNER SETTINGS',
                  style: GoogleFonts.spaceGrotesk(
                    fontSize: 12.sp,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 1.5,
                  ),
                ),
              ),
            ),
            SizedBox(height: 24.h),
            Text(
              'DIAGNOSTICS',
              style: GoogleFonts.manrope(
                fontSize: 10.sp,
                fontWeight: FontWeight.w800,
                letterSpacing: 2,
                color: _outline,
              ),
            ),
            SizedBox(height: 6.h),
            Text(
              'Chainway SDK: ${_diag['chainwaySdkPresent'] == true ? 'present' : 'missing'}\n'
              'Zebra SDK: ${_diag['zebraSdkPresent'] == true ? 'present' : 'missing'}\n'
              'Chainway error: ${(_diag['chainwayLastError'] ?? '').toString().isEmpty ? 'none' : _diag['chainwayLastError']}\n'
              'Zebra error: ${(_diag['zebraLastError'] ?? '').toString().isEmpty ? 'none' : _diag['zebraLastError']}',
              style: GoogleFonts.robotoMono(
                fontSize: 11.sp,
                fontWeight: FontWeight.w500,
                color: _onSurface,
                height: 1.35.h,
              ),
            ),
            SizedBox(height: 24.h),
            Divider(height: 1.h, thickness: 1, color: const Color(0xFFF4F4F5)),
            SizedBox(height: 32.h),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'HARDWARE ID',
                        style: GoogleFonts.manrope(
                          fontSize: 10.sp,
                          fontWeight: FontWeight.w800,
                          letterSpacing: 2,
                          color: _outline,
                        ),
                      ),
                      SizedBox(height: 4.h),
                      Text(
                        _hardwareId,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: GoogleFonts.robotoMono(
                          fontSize: 14.sp,
                          fontWeight: FontWeight.w700,
                          color: _onSurface,
                        ),
                      ),
                    ],
                  ),
                ),
                SizedBox(width: 16.w),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'FIRMWARE',
                        style: GoogleFonts.manrope(
                          fontSize: 10.sp,
                          fontWeight: FontWeight.w800,
                          letterSpacing: 2,
                          color: _outline,
                        ),
                      ),
                      SizedBox(height: 4.h),
                      Text(
                        _firmware,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: GoogleFonts.robotoMono(
                          fontSize: 14.sp,
                          fontWeight: FontWeight.w700,
                          color: _onSurface,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// Rectangular slider thumb (stitch / industrial).
class _RectSliderThumbShape extends SliderComponentShape {
  const _RectSliderThumbShape({required this.width, required this.height});

  final double width;
  final double height;

  @override
  Size getPreferredSize(bool isEnabled, bool isDiscrete) => Size(width, height);

  @override
  void paint(
    PaintingContext context,
    Offset center, {
    required Animation<double> activationAnimation,
    required Animation<double> enableAnimation,
    required bool isDiscrete,
    required TextPainter labelPainter,
    required RenderBox parentBox,
    required SliderThemeData sliderTheme,
    required TextDirection textDirection,
    required double value,
    required double textScaleFactor,
    required Size sizeWithOverflow,
  }) {
    final canvas = context.canvas;
    final rect = Rect.fromCenter(center: center, width: width, height: height);
    final fill = Paint()
      ..color = sliderTheme.thumbColor ?? const Color(0xFF009496);
    final shadow = Paint()..color = const Color(0x1A000000);
    canvas.drawRect(rect.translate(0, 2), shadow);
    canvas.drawRect(rect, fill);
  }
}

class _CountInventoryModuleSettings {
  const _CountInventoryModuleSettings({
    required this.rfidPowerDbm,
    required this.rssiDistance,
  });

  final int rfidPowerDbm;
  final double rssiDistance;

  static const defaults = _CountInventoryModuleSettings(
    rfidPowerDbm: 30,
    rssiDistance: 1.0,
  );

  Map<String, dynamic> toJson() => <String, dynamic>{
        'rfidPowerDbm': rfidPowerDbm,
        'rssiDistance': rssiDistance,
      };

  String toJsonString() => jsonEncode(toJson());

  static _CountInventoryModuleSettings? fromJsonString(String raw) {
    try {
      final m = jsonDecode(raw);
      if (m is! Map<String, dynamic>) return null;
      return _CountInventoryModuleSettings(
        rfidPowerDbm: ((m['rfidPowerDbm'] as num?)?.round() ?? 30).clamp(0, 30),
        rssiDistance: ((m['rssiDistance'] as num?)?.toDouble() ?? 1.0)
            .clamp(0.0, 1.0), // 1.0 = -30 dB
      );
    } catch (_) {
      return null;
    }
  }
}

class _SessionEpcRow {
  _SessionEpcRow({
    required this.epc,
    required this.assetId,
    required this.prefixHex,
    required this.serial,
    required this.firstSeen,
    required this.lastSeen,
    this.rssi = -99,
  });

  final String epc;
  final String assetId;
  final String prefixHex;
  final int serial;
  final DateTime firstSeen;
  DateTime lastSeen;
  int scans = 1;
  int duplicateSightings = 0;
  int rssi;
}

class _GroupedRow {
  _GroupedRow({required this.assetId});

  final String assetId;
  final Set<String> epcs = <String>{};
  int qty = 0;
  String sku = '';
  String name = '';
  String color = '';
  String size = '';
  String vendor = '';
  bool cached = false;
  int lastRssi = -99;

  // Catalog-resolved fields.
  String customSku = '';
  String itemName = '';
  String? retailPriceStr; // raw "52.00" string from API
  String? binLocation;
  bool catalogResolved = false; // true once lookup completes (success OR 404)
  bool catalogMissing = false; // true only if lookup returned null
  bool epcInvalid = false; // true if decodeSystemId returned null
}

class _DecodedEpc {
  const _DecodedEpc({
    required this.prefix,
    required this.systemId,
    required this.serial,
  });

  final String prefix;
  final int systemId;
  final int serial;
}

_DecodedEpc? _decodeEpc(String epc) {
  final s = epc.toUpperCase().replaceAll(RegExp(r'[^0-9A-F]'), '');
  if (s.length != 24) return null;
  final prefix = s.substring(0, 5);
  final systemIdHex = s.substring(5, 15);
  final serialHex = s.substring(15, 24);
  final systemId = int.tryParse(systemIdHex, radix: 16);
  final serial = int.tryParse(serialHex, radix: 16);
  if (systemId == null || serial == null) return null;
  return _DecodedEpc(prefix: prefix, systemId: systemId, serial: serial);
}

String _csv(String v) {
  final needsQuotes = v.contains(',') || v.contains('"') || v.contains('\n');
  if (!needsQuotes) return v;
  return '"${v.replaceAll('"', '""')}"';
}

String _two(int v) => v < 10 ? '0$v' : '$v';
