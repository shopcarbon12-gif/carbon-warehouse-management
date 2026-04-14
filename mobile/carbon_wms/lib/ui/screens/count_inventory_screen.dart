import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:path_provider/path_provider.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/hardware/rfid_tag_read.dart';
import 'package:carbon_wms/hardware/rfid_vendor_channel.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/screens/locate_tag_screen.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart' show CarbonScaffold;

const _countInvPrefsKey = 'count_inventory_module_settings_v1';
const _assetCachePrefsKey = 'count_inventory_asset_cache_v1';

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
  StreamSubscription<RfidTagRead>? _readsSub;
  StreamSubscription<String>? _triggerSub;
  Timer? _scanInactivityTimer;
  bool _scanOn = false;
  bool _connecting = false;
  bool _busyLookup = false;
  String? _status;
  _CountInventoryModuleSettings _moduleSettings =
      _CountInventoryModuleSettings.defaults;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      unawaited(_initModule());
    });
  }

  @override
  void dispose() {
    _readsSub?.cancel();
    _triggerSub?.cancel();
    _scanInactivityTimer?.cancel();
    unawaited(context.read<RfidManager>().stopLocateScanning());
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
    await _ensureScannerReady();
  }

  Future<void> _ensureScannerReady() async {
    if (_connecting) return;
    setState(() {
      _connecting = true;
      _status = 'Connecting RFID...';
    });
    final rfid = context.read<RfidManager>();
    rfid.scanContext = 'COUNT_INVENTORY';
    await rfid.autoDetectHardware();
    await rfid.reapplyHandheldHardwareSettings();
    await RfidVendorChannel.setAntennaPowerDbm(_moduleSettings.rfidPowerDbm);
    await _readsSub?.cancel();
    final scanner = rfid.activeScanner;
    if (scanner != null) {
      _readsSub = scanner.tagReadStream.listen(_onTagRead, onError: (_) {});
    }
    await _triggerSub?.cancel();
    _triggerSub = RfidVendorChannel.hardwareTriggerStream().listen((evt) {
      if (evt == 'down') {
        unawaited(_toggleScan());
      }
    }, onError: (_) {});
    if (!mounted) return;
    setState(() {
      _connecting = false;
      _status = scanner == null ? 'No scanner connected' : 'RFID ready';
    });
  }

  Future<void> _saveModuleSettings() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_countInvPrefsKey, _moduleSettings.toJsonString());
  }

  Future<void> _saveAssetCache() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_assetCachePrefsKey, jsonEncode(_assetCache));
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
    await RfidVendorChannel.setAntennaPowerDbm(_moduleSettings.rfidPowerDbm);
  }

  void _onTagRead(RfidTagRead read) {
    if (!_scanOn) return;
    final now = DateTime.now();
    _scanInactivityTimer?.cancel();
    _scanInactivityTimer = Timer(const Duration(seconds: 15), () {
      if (!mounted) return;
      unawaited(_stopScan(reason: 'Stopped after 15s inactivity'));
    });
    final epc = read.epcHex24;
    final row = _epcRows[epc];
    if (row != null) {
      row.scans += 1;
      row.lastSeen = now;
    } else {
      final parts = _decodeAssetFromEpc(epc);
      _epcRows[epc] = _SessionEpcRow(
        epc: epc,
        assetId: parts.assetId,
        prefixHex: parts.prefixHex,
        serial: parts.serial,
        firstSeen: now,
        lastSeen: now,
      );
    }
    final group = _groupedRows.putIfAbsent(
      _epcRows[epc]!.assetId,
      () => _GroupedRow(assetId: _epcRows[epc]!.assetId),
    );
    group.epcs.add(epc);
    group.qty = group.epcs.length;
    if (!_busyLookup) {
      _busyLookup = true;
      unawaited(_enrichGroups());
    }
    if (mounted) setState(() {});
  }

  Future<void> _enrichGroups() async {
    final api = context.read<WmsApiClient>();
    final pendingAssetIds = _groupedRows.keys.where((k) {
      final g = _groupedRows[k]!;
      return g.sku.isEmpty && g.name.isEmpty;
    }).toList();
    for (final assetId in pendingAssetIds) {
      final cached = _assetCache[assetId];
      if (cached != null) {
        _applyLookup(assetId, cached, fromCache: true);
        continue;
      }
      try {
        final row = await api.catalogGridSearchFirstRow(assetId);
        if (row != null) {
          _assetCache[assetId] = row;
          _applyLookup(assetId, row, fromCache: false);
          await _saveAssetCache();
        }
      } catch (_) {}
    }
    _busyLookup = false;
    if (mounted) setState(() {});
  }

  void _applyLookup(String assetId, Map<String, dynamic> row,
      {required bool fromCache}) {
    final g = _groupedRows[assetId];
    if (g == null) return;
    g.sku = (row['sku'] ?? '').toString();
    g.name = (row['name'] ?? '').toString();
    g.color = (row['color'] ?? '').toString();
    g.size = (row['size'] ?? '').toString();
    g.vendor = (row['vendor'] ?? '').toString();
    g.cached = fromCache;
  }

  Future<void> _toggleScan() async {
    if (_scanOn) {
      await _stopScan(reason: 'Scan stopped');
    } else {
      await _startScan();
    }
  }

  Future<void> _startScan() async {
    final rfid = context.read<RfidManager>();
    await RfidVendorChannel.setAntennaPowerDbm(_moduleSettings.rfidPowerDbm);
    await rfid.startLocateScanning();
    _scanInactivityTimer?.cancel();
    _scanInactivityTimer = Timer(const Duration(seconds: 15), () {
      if (!mounted) return;
      unawaited(_stopScan(reason: 'Stopped after 15s inactivity'));
    });
    if (!mounted) return;
    setState(() {
      _scanOn = true;
      _status = 'Scanning RFID tags...';
    });
  }

  Future<void> _stopScan({String? reason}) async {
    final rfid = context.read<RfidManager>();
    await rfid.stopLocateScanning();
    _scanInactivityTimer?.cancel();
    if (!mounted) return;
    setState(() {
      _scanOn = false;
      _status = reason ?? 'Scan stopped';
    });
  }

  Future<void> _openGroupDetails(_GroupedRow group) async {
    if (_scanOn) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Stop scan before opening item details')),
      );
      return;
    }
    final epcs = group.epcs
        .map((e) => _epcRows[e])
        .whereType<_SessionEpcRow>()
        .toList()
      ..sort((a, b) => a.epc.compareTo(b.epc));
    await Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder: (_) => _CountInventoryItemDetailsScreen(
          group: group,
          rows: epcs,
          settingsButton: IconButton(
            icon: const Icon(Icons.settings_outlined),
            onPressed: _openModuleSettings,
          ),
        ),
      ),
    );
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
          onSaveCsv: _saveSessionCsvToDevice,
          settingsButton: IconButton(
            icon: const Icon(Icons.settings_outlined),
            onPressed: _openModuleSettings,
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final groups = _groupedRows.values.toList()
      ..sort((a, b) => a.assetId.compareTo(b.assetId));
    final assetCount = _epcRows.length;
    final skuCount = groups.where((e) => e.sku.isNotEmpty).length;
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final card = isDark ? const Color(0xFF1C2828) : Colors.white;
    final muted = isDark ? const Color(0xFF7A9090) : AppColors.textMuted;
    final main = isDark ? const Color(0xFFE0ECEC) : AppColors.textMain;
    final qtyBg = isDark ? const Color(0xFF2E3A3A) : const Color(0xFFF4F0CF);

    return CarbonScaffold(
      pageTitle: 'COUNT INVENTORY',
      actions: [
        IconButton(
          icon: const Icon(Icons.settings_outlined),
          onPressed: _openModuleSettings,
        ),
      ],
      body: Column(
        children: [
          if (_status != null)
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              color: isDark ? const Color(0xFF243030) : const Color(0xFFEAF3F2),
              child: Text(
                _status!,
                style: GoogleFonts.manrope(
                    fontSize: 13, fontWeight: FontWeight.w700, color: main),
              ),
            ),
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 12, 12, 8),
            child: Row(
              children: [
                Expanded(
                  child: Container(
                    decoration: BoxDecoration(
                        color: const Color(0xFFF4F0CF),
                        borderRadius: BorderRadius.circular(6)),
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    child: Column(
                      children: [
                        Text('$assetCount',
                            style: GoogleFonts.manrope(
                                fontSize: 42, fontWeight: FontWeight.w700)),
                        Text('ASSET(s) READ',
                            style: GoogleFonts.manrope(
                                fontSize: 14, fontWeight: FontWeight.w700)),
                      ],
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Container(
                    decoration: BoxDecoration(
                        color: const Color(0xFFF4F0CF),
                        borderRadius: BorderRadius.circular(6)),
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    child: Column(
                      children: [
                        Text('$skuCount',
                            style: GoogleFonts.manrope(
                                fontSize: 42, fontWeight: FontWeight.w700)),
                        Text('SKU(s) READ',
                            style: GoogleFonts.manrope(
                                fontSize: 14, fontWeight: FontWeight.w700)),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
          Expanded(
            child: ListView.separated(
              itemCount: groups.length,
              separatorBuilder: (_, __) => Divider(
                  height: 1, color: Colors.black.withValues(alpha: 0.08)),
              itemBuilder: (_, i) {
                final g = groups[i];
                final subtitle = [g.name, g.color, g.size]
                    .where((e) => e.trim().isNotEmpty)
                    .join(' · ');
                return Material(
                  color: card,
                  child: InkWell(
                    onTap: () => _openGroupDetails(g),
                    child: Padding(
                      padding: const EdgeInsets.fromLTRB(12, 12, 10, 12),
                      child: Row(
                        children: [
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(g.assetId,
                                    style: GoogleFonts.manrope(
                                        fontSize: 36,
                                        fontWeight: FontWeight.w700,
                                        height: 1.05)),
                                const SizedBox(height: 4),
                                Text(
                                  g.sku.isEmpty ? 'SKU pending' : g.sku,
                                  style: GoogleFonts.manrope(
                                      fontSize: 18,
                                      fontWeight: FontWeight.w700,
                                      color: main),
                                ),
                                if (subtitle.isNotEmpty)
                                  Text(
                                    subtitle,
                                    style: GoogleFonts.manrope(
                                        fontSize: 16,
                                        fontWeight: FontWeight.w600,
                                        color: muted),
                                  ),
                              ],
                            ),
                          ),
                          Container(
                            width: 56,
                            height: 36,
                            alignment: Alignment.center,
                            decoration: BoxDecoration(
                                color: qtyBg,
                                borderRadius: BorderRadius.circular(12)),
                            child: Text('${g.qty}',
                                style: GoogleFonts.manrope(
                                    fontSize: 24, fontWeight: FontWeight.w700)),
                          ),
                          const SizedBox(width: 8),
                          const Icon(Icons.chevron_right, size: 34),
                        ],
                      ),
                    ),
                  ),
                );
              },
            ),
          ),
          Container(
            color: isDark ? const Color(0xFF1C2828) : const Color(0xFFF5F5F5),
            padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
            child: Row(
              children: [
                Expanded(
                  child: FilledButton(
                    onPressed: _connecting ? null : _toggleScan,
                    style: FilledButton.styleFrom(
                      backgroundColor: const Color(0xFF0C4A7B),
                      padding: const EdgeInsets.symmetric(vertical: 14),
                    ),
                    child: Text(_scanOn ? 'STOP' : 'START',
                        style: GoogleFonts.manrope(
                            fontSize: 32, fontWeight: FontWeight.w700)),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: FilledButton(
                    onPressed: groups.isEmpty ? null : _openContinue,
                    style: FilledButton.styleFrom(
                      backgroundColor: const Color(0xFF0C4A7B),
                      padding: const EdgeInsets.symmetric(vertical: 14),
                    ),
                    child: Text('CONTINUE',
                        style: GoogleFonts.manrope(
                            fontSize: 32, fontWeight: FontWeight.w700)),
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

class _CountInventoryItemDetailsScreen extends StatelessWidget {
  const _CountInventoryItemDetailsScreen({
    required this.group,
    required this.rows,
    required this.settingsButton,
  });

  final _GroupedRow group;
  final List<_SessionEpcRow> rows;
  final Widget settingsButton;

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return CarbonScaffold(
      pageTitle: 'COUNT DETAILS',
      actions: [settingsButton],
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 10),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text(
                '${group.assetId}  ·  ${group.sku.isEmpty ? 'SKU pending' : group.sku}',
                style: GoogleFonts.manrope(
                  fontSize: 20,
                  fontWeight: FontWeight.w700,
                  color: isDark ? const Color(0xFFE0ECEC) : AppColors.textMain,
                ),
              ),
            ),
          ),
          Expanded(
            child: ListView.builder(
              itemCount: rows.length,
              itemBuilder: (_, i) {
                final r = rows[i];
                return ListTile(
                  title: Text(r.epc,
                      style: GoogleFonts.manrope(
                          fontSize: 16, fontWeight: FontWeight.w700)),
                  subtitle: Text(
                    'serial ${r.serial} · scans ${r.scans}',
                    style: GoogleFonts.manrope(
                        fontSize: 13, fontWeight: FontWeight.w600),
                  ),
                  trailing: const Icon(Icons.radar),
                  onTap: () {
                    Navigator.of(context).push<void>(
                      MaterialPageRoute<void>(
                        builder: (_) => LocateTagScreen(targetEpc: r.epc),
                      ),
                    );
                  },
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
    required this.onSaveCsv,
    required this.settingsButton,
  });

  final List<_GroupedRow> groupedRows;
  final Future<String?> Function() onSaveCsv;
  final Widget settingsButton;

  @override
  State<_CountInventoryContinueScreen> createState() =>
      _CountInventoryContinueScreenState();
}

class _CountInventoryContinueScreenState
    extends State<_CountInventoryContinueScreen> {
  bool _overrideExisting = false;
  bool _saving = false;
  String? _status;

  Future<void> _saveCsv() async {
    setState(() {
      _saving = true;
      _status = null;
    });
    try {
      final path = await widget.onSaveCsv();
      if (!mounted) return;
      setState(
          () => _status = path == null ? 'Failed to save CSV' : 'Saved: $path');
    } catch (e) {
      if (!mounted) return;
      setState(() => _status = 'Save failed: $e');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return CarbonScaffold(
      pageTitle: 'COUNT CONTINUE',
      actions: [widget.settingsButton],
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 20),
        children: [
          Text('Upload to Carbon Jeans (001 - Orlando Warehouse)',
              style: GoogleFonts.manrope(
                  fontSize: 24, fontWeight: FontWeight.w700)),
          const SizedBox(height: 14),
          CheckboxListTile(
            value: _overrideExisting,
            onChanged: (v) => setState(() => _overrideExisting = v == true),
            title: Text(
              'Override Entire Cloud Quantities (Warning)',
              style: GoogleFonts.manrope(
                  fontSize: 22,
                  fontWeight: FontWeight.w700,
                  color: const Color(0xFFBF2E2E)),
            ),
            subtitle: Text(
                'If checked: replace existing quantities and zero missing items',
                style: GoogleFonts.manrope(fontSize: 16)),
            controlAffinity: ListTileControlAffinity.trailing,
          ),
          const SizedBox(height: 12),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: isDark ? const Color(0xFF1C2828) : const Color(0xFFF6F6F6),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Text(
              'Upload is currently disabled for this phase.\nCSV save is active.\nRows prepared: ${widget.groupedRows.length}',
              style: GoogleFonts.manrope(
                  fontSize: 16, fontWeight: FontWeight.w600),
            ),
          ),
          if (_status != null) ...[
            const SizedBox(height: 10),
            Text(_status!,
                style: GoogleFonts.manrope(
                    fontSize: 14,
                    fontWeight: FontWeight.w700,
                    color: AppColors.primary)),
          ],
          const SizedBox(height: 24),
          Row(
            children: [
              Expanded(
                child: FilledButton(
                  onPressed: null,
                  style: FilledButton.styleFrom(
                    backgroundColor: const Color(0xFF0C4A7B),
                    disabledBackgroundColor: const Color(0xFF5B6E7E),
                    padding: const EdgeInsets.symmetric(vertical: 14),
                  ),
                  child: Text('UPLOAD',
                      style: GoogleFonts.manrope(
                          fontSize: 30, fontWeight: FontWeight.w700)),
                ),
              ),
              const SizedBox(width: 16),
              Expanded(
                child: FilledButton(
                  onPressed: _saving ? null : _saveCsv,
                  style: FilledButton.styleFrom(
                    backgroundColor: const Color(0xFF0C4A7B),
                    padding: const EdgeInsets.symmetric(vertical: 14),
                  ),
                  child: Text(
                    _saving ? 'SAVING…' : 'SAVE TO FILE',
                    style: GoogleFonts.manrope(
                        fontSize: 24, fontWeight: FontWeight.w700),
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _CountInventorySettingsScreen extends StatefulWidget {
  const _CountInventorySettingsScreen({required this.initial});

  final _CountInventoryModuleSettings initial;

  @override
  State<_CountInventorySettingsScreen> createState() =>
      _CountInventorySettingsScreenState();
}

class _CountInventorySettingsScreenState
    extends State<_CountInventorySettingsScreen> {
  late int _power;
  late double _rssi;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _power = widget.initial.rfidPowerDbm;
    _rssi = widget.initial.rssiDistance;
  }

  Future<void> _restartRfidController() async {
    if (_busy) return;
    setState(() => _busy = true);
    final rfid = context.read<RfidManager>();
    await rfid.autoDetectHardware();
    await rfid.reapplyHandheldHardwareSettings();
    await RfidVendorChannel.setAntennaPowerDbm(_power);
    if (!mounted) return;
    setState(() => _busy = false);
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('RFID controller restarted')),
    );
  }

  @override
  Widget build(BuildContext context) {
    return CarbonScaffold(
      pageTitle: 'RFID SETTINGS',
      actions: [
        IconButton(
          icon: const Icon(Icons.save_outlined),
          onPressed: () {
            Navigator.of(context).pop(
              _CountInventoryModuleSettings(
                  rfidPowerDbm: _power, rssiDistance: _rssi),
            );
          },
        ),
      ],
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 24, 16, 24),
        children: [
          Text('RFID Power (0-30dbm)',
              style: GoogleFonts.manrope(
                  fontSize: 32, fontWeight: FontWeight.w700)),
          const SizedBox(height: 10),
          Row(
            children: [
              const Text('0 dbm', style: TextStyle(fontSize: 20)),
              Expanded(
                child: Slider(
                  value: _power.toDouble(),
                  min: 0,
                  max: 30,
                  divisions: 30,
                  onChanged: (v) => setState(() => _power = v.round()),
                ),
              ),
              Text('$_power\ndbm',
                  textAlign: TextAlign.center,
                  style: const TextStyle(fontSize: 20)),
            ],
          ),
          const SizedBox(height: 20),
          Text('RSSI',
              style: GoogleFonts.manrope(
                  fontSize: 32, fontWeight: FontWeight.w700)),
          const SizedBox(height: 10),
          Row(
            children: [
              const Text('Close', style: TextStyle(fontSize: 20)),
              Expanded(
                child: Slider(
                  value: _rssi,
                  min: 0,
                  max: 1,
                  onChanged: (v) => setState(() => _rssi = v),
                ),
              ),
              const Text('Far', style: TextStyle(fontSize: 20)),
            ],
          ),
          const SizedBox(height: 28),
          FilledButton(
            onPressed: _busy ? null : _restartRfidController,
            style: FilledButton.styleFrom(
              backgroundColor: const Color(0xFF0C4A7B),
              padding: const EdgeInsets.symmetric(vertical: 14),
            ),
            child: Text(
              _busy ? 'RESTARTING…' : 'Restart RFID Controller',
              style: GoogleFonts.manrope(
                  fontSize: 30, fontWeight: FontWeight.w700),
            ),
          ),
        ],
      ),
    );
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
        rssiDistance:
            ((m['rssiDistance'] as num?)?.toDouble() ?? 1.0).clamp(0.0, 1.0),
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
  });

  final String epc;
  final String assetId;
  final String prefixHex;
  final int serial;
  final DateTime firstSeen;
  DateTime lastSeen;
  int scans = 1;
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
}

class _DecodedEpcParts {
  const _DecodedEpcParts({
    required this.prefixHex,
    required this.assetId,
    required this.serial,
  });

  final String prefixHex;
  final String assetId;
  final int serial;
}

_DecodedEpcParts _decodeAssetFromEpc(String epc24) {
  final raw = epc24.trim().toUpperCase();
  if (raw.length != 24) {
    return const _DecodedEpcParts(prefixHex: '', assetId: 'INVALID', serial: 0);
  }
  final prefixHex = raw.substring(0, 5);
  final itemHex = raw.substring(5, 15);
  final serialHex = raw.substring(15);
  final assetDec = BigInt.parse(itemHex, radix: 16).toString();
  final serial = int.tryParse(serialHex, radix: 16) ?? 0;
  return _DecodedEpcParts(
      prefixHex: prefixHex, assetId: assetDec, serial: serial);
}

String _csv(String v) {
  final needsQuotes = v.contains(',') || v.contains('"') || v.contains('\n');
  if (!needsQuotes) return v;
  return '"${v.replaceAll('"', '""')}"';
}

String _two(int v) => v < 10 ? '0$v' : '$v';
