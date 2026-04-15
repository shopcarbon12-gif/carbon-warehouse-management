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
import 'package:carbon_wms/services/epc_asset_decoder.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/screens/encode_suite_screens.dart';
import 'package:carbon_wms/ui/screens/inventory_hub_screen.dart';
import 'package:carbon_wms/ui/screens/locate_tag_screen.dart';
import 'package:carbon_wms/ui/screens/transfer_slips_screen.dart';
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
  final Map<String, Map<String, dynamic>> _assetCache = <String, Map<String, dynamic>>{};
  String _currentLocationName = 'Orlando Warehouse';
  StreamSubscription<RfidTagRead>? _readsSub;
  StreamSubscription<String>? _triggerSub;
  Timer? _scanInactivityTimer;
  bool _scanOn = false;
  bool _connecting = false;
  bool _busyLookup = false;
  String? _status;
  _CountInventoryModuleSettings _moduleSettings = _CountInventoryModuleSettings.defaults;
  RfidManager? _rfidManager;

  @override
  void initState() {
    super.initState();
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
    _triggerSub?.cancel();
    _scanInactivityTimer?.cancel();
    final rfid = _rfidManager;
    if (rfid != null) {
      unawaited(rfid.stopLocateScanning());
    }
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
      final locs = await api.fetchSessionLocations();
      if (!mounted || locs.isEmpty) return;
      final next = (locs.first['name'] ?? locs.first['code'] ?? '').trim();
      if (next.isEmpty) return;
      setState(() => _currentLocationName = next);
    } catch (_) {}
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
    final next = await Navigator.of(context).push<_CountInventoryModuleSettings>(
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
      final parts = decodeAssetFromEpc(epc);
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

  void _applyLookup(String assetId, Map<String, dynamic> row, {required bool fromCache}) {
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
    final epcs = group.epcs.map((e) => _epcRows[e]).whereType<_SessionEpcRow>().toList()
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

  Future<void> _openEpcList({
    required String title,
    required List<String> epcs,
  }) async {
    await Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder: (_) => _CountEpcListScreen(title: title, epcs: epcs),
      ),
    );
  }

  Future<bool> _confirmDeleteItem() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Confirmation'),
        content: const Text('Delete item? (remove from scan list only)'),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text('Delete')),
        ],
      ),
    );
    return ok == true;
  }

  Future<void> _resetScreenToDefault() async {
    if (_scanOn) {
      await _stopScan(reason: 'Scan stopped');
    }
    if (!mounted) return;
    setState(() {
      _epcRows.clear();
      _groupedRows.clear();
      _status = 'Reset complete';
    });
  }

  Future<String?> _saveSessionCsvToDevice() async {
    final now = DateTime.now();
    final header =
        'asset_id,sku,name,color,size,qty,epc,prefix_hex,serial,first_seen_utc,last_seen_utc,lookup_source\n';
    final b = StringBuffer(header);
    final groups = _groupedRows.values.toList()..sort((a, c) => a.assetId.compareTo(c.assetId));
    for (final g in groups) {
      final source = g.cached ? 'cache' : (g.sku.isEmpty && g.name.isEmpty ? 'unresolved' : 'lookup');
      for (final epc in g.epcs) {
        final row = _epcRows[epc];
        if (row == null) continue;
        b.writeln(
          '${g.assetId},${_csv(g.sku)},${_csv(g.name)},${_csv(g.color)},${_csv(g.size)},${g.qty},${row.epc},${row.prefixHex},${row.serial},${row.firstSeen.toUtc().toIso8601String()},${row.lastSeen.toUtc().toIso8601String()},$source',
        );
      }
    }
    final baseDir = await getExternalStorageDirectory() ?? await getApplicationDocumentsDirectory();
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
    final groups = _groupedRows.values.toList()..sort((a, b) => a.assetId.compareTo(b.assetId));
    await Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder: (_) => _CountInventoryContinueScreen(
          groupedRows: groups,
          onSaveCsv: _saveSessionCsvToDevice,
          buildBackendPreviewPayload: () => _buildBackendPreviewPayload(groups),
        ),
      ),
    );
  }

  void _onBottomShortcutTap(int index) {
    switch (index) {
      case 0:
        Navigator.of(context).popUntil((route) => route.isFirst);
      case 1:
        if (Navigator.of(context).canPop()) {
          Navigator.of(context).pop();
        } else {
          Navigator.of(context).push<void>(
            MaterialPageRoute<void>(builder: (_) => const InventoryHubScreen()),
          );
        }
      case 2:
        Navigator.of(context).push<void>(
          MaterialPageRoute<void>(builder: (_) => const TransferSlipsScreen()),
        );
      case 3:
        Navigator.of(context).push<void>(
          MaterialPageRoute<void>(builder: (_) => const EncodeSuiteScreen(initialTab: 0)),
        );
    }
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
    final groups = _groupedRows.values.toList()..sort((a, b) => a.assetId.compareTo(b.assetId));
    final hasRealRows = groups.isNotEmpty;
    final assetCount = _epcRows.length;
    final skuCount = groups.where((g) => g.sku.trim().isNotEmpty).length;
    final summaryValueText = '$assetCount';
    final summarySkuValueText = '$skuCount';
    final continueButtonWidth = _continueButtonTightWidth();
    final tileColor = isDark ? const Color(0xFF1C2828) : const Color(0xFFEEF4F3);
    final textColor = isDark ? const Color(0xFFE0ECEC) : AppColors.textMain;
    final summaryLabelColor = isDark ? const Color(0xFF5C6C6C) : const Color(0xFF3F4A4A);
    final watermarkColor = isDark ? const Color(0x66A0B3B3) : const Color(0x2995A5A7);
    const summaryBoxWidth = 132.0;
    const summaryBoxHeight = 60.0;

    return CarbonScaffold(
      pageTitle: 'count',
      actions: [
        IconButton(
          icon: const Icon(Icons.settings_outlined),
          onPressed: _openModuleSettings,
        ),
      ],
      body: ColoredBox(
        color: Colors.white,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 2, 20, 0),
              child: Text(
                _currentLocationName.toUpperCase(),
                style: GoogleFonts.spaceGrotesk(
                  fontSize: 14,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 2.4,
                  color: AppColors.primary,
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 12, 20, 0),
              child: LayoutBuilder(
                builder: (context, constraints) {
                  final tileWidth = ((constraints.maxWidth - 8) / 2).clamp(160.0, 166.0);
                  return Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      SizedBox(
                        width: tileWidth,
                        child: Align(
                          alignment: Alignment.centerLeft,
                        child: _CountSummaryTile(
                          label: 'Total EPCs',
                            value: summaryValueText,
                          icon: Icons.inventory_2_outlined,
                            boxWidth: summaryBoxWidth,
                            boxHeight: summaryBoxHeight,
                          tileColor: tileColor,
                          textColor: textColor,
                            labelColor: summaryLabelColor,
                          watermarkColor: watermarkColor,
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      SizedBox(
                        width: tileWidth,
                        child: Align(
                          alignment: Alignment.centerRight,
                        child: _CountSummaryTile(
                          label: 'Total SKUs',
                            value: summarySkuValueText,
                          icon: Icons.precision_manufacturing_outlined,
                            boxWidth: summaryBoxWidth,
                            boxHeight: summaryBoxHeight,
                          tileColor: tileColor,
                          textColor: textColor,
                            labelColor: summaryLabelColor,
                          watermarkColor: watermarkColor,
                          ),
                        ),
                      ),
                    ],
                  );
                },
              ),
            ),
            const SizedBox(height: 12),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(20, 0, 20, 0),
                child: ColoredBox(
                  color: Colors.transparent,
                  child: hasRealRows
                    ? ListView.separated(
                        padding: const EdgeInsets.only(bottom: 12),
                          itemCount: groups.length,
                        separatorBuilder: (_, __) => const SizedBox(height: 8),
                        itemBuilder: (_, i) {
                          final g = groups[i];
                          final descParts = [g.name, g.color, g.size]
                              .map((s) => s.trim())
                              .where((s) => s.isNotEmpty)
                              .toList();
                          final desc = descParts.isEmpty ? 'ITEM DESCRIPTION' : descParts.join(' ');
                            final extra = <String>[
                              'Asset ID: ${g.assetId}',
                              if (g.vendor.trim().isNotEmpty) 'Vendor: ${g.vendor}',
                              'Unique EPCs in session: ${g.epcs.length}',
                              if (g.cached) 'Details source: offline cache',
                              if (!g.cached && (g.sku.isNotEmpty || g.name.isNotEmpty)) 'Details source: catalog lookup',
                            ];
                          return _CountItemContainer(
                              rowKey: 'real-${g.assetId}',
                            sku: g.sku.trim().isEmpty ? g.assetId : g.sku,
                            description: desc,
                            qtyText: 'x${g.qty}',
                              expandedLines: extra,
                              onQtyTap: () => _openEpcList(
                                title: g.sku.trim().isEmpty ? g.assetId : g.sku,
                                epcs: (g.epcs.toList()..sort()),
                              ),
                              onDelete: () {
                                setState(() {
                                  for (final epc in g.epcs) {
                                    _epcRows.remove(epc);
                                  }
                                  _groupedRows.remove(g.assetId);
                                });
                              },
                              confirmDelete: _confirmDeleteItem,
                          );
                        },
                      )
                      : Center(
                          child: Text(
                            'No items scanned yet',
                            style: GoogleFonts.manrope(
                              fontSize: 14,
                              fontWeight: FontWeight.w700,
                              color: const Color(0xFF5A6464),
                            ),
                          ),
                        ),
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 10, 20, 10),
              child: Row(
                children: [
                  Expanded(
                    child: Align(
                      alignment: Alignment.centerLeft,
                    child: SizedBox(
                        width: continueButtonWidth,
                        height: 40,
                      child: FilledButton(
                        onPressed: _connecting ? null : _toggleScan,
                        style: FilledButton.styleFrom(
                            backgroundColor: _scanOn ? const Color(0xFFBF2E2E) : const Color(0xFF0A7C80),
                          foregroundColor: Colors.white,
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(2)),
                          padding: const EdgeInsets.symmetric(horizontal: 12),
                        ),
                        child: Row(
                          children: [
                              Expanded(
                                child: Align(
                                  alignment: Alignment.centerLeft,
                                  child: Text(
                              _scanOn ? 'STOP' : 'START',
                              style: GoogleFonts.spaceGrotesk(
                                fontSize: 16,
                                fontWeight: FontWeight.w800,
                                letterSpacing: 1.8,
                              ),
                            ),
                                ),
                              ),
                              const SizedBox(width: 8),
                              SizedBox(
                                width: 20,
                                child: Icon(
                                  _scanOn ? Icons.stop_circle_outlined : Icons.play_circle_outline,
                                  size: 20,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  SizedBox(
                    width: 40,
                    height: 40,
                    child: FilledButton(
                      onPressed: _resetScreenToDefault,
                      style: FilledButton.styleFrom(
                        backgroundColor: const Color(0xFF6A7575),
                        foregroundColor: Colors.white,
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(2)),
                        padding: EdgeInsets.zero,
                      ),
                      child: const Icon(Icons.restart_alt, size: 20),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Align(
                      alignment: Alignment.centerRight,
                      child: IntrinsicWidth(
                    child: SizedBox(
                          height: 40,
                      child: FilledButton(
                            onPressed: _openContinue,
                        style: FilledButton.styleFrom(
                          backgroundColor: const Color(0xFF2BA3A3),
                          disabledBackgroundColor: const Color(0xFF2BA3A3),
                          foregroundColor: Colors.white,
                              disabledForegroundColor: Colors.white,
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(2)),
                          padding: const EdgeInsets.symmetric(horizontal: 12),
                              minimumSize: Size.zero,
                              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                        ),
                        child: Row(
                              mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(
                              'CONTINUE',
                              style: GoogleFonts.spaceGrotesk(
                                fontSize: 16,
                                fontWeight: FontWeight.w800,
                                letterSpacing: 1.5,
                                    color: Colors.white,
                              ),
                            ),
                                const SizedBox(width: 8),
                                const Icon(Icons.arrow_forward, size: 20, color: Colors.white),
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
            _CountBottomShortcuts(onTap: _onBottomShortcutTap),
          ],
        ),
      ),
    );
  }
}

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
        borderRadius: BorderRadius.circular(2),
        clipBehavior: Clip.hardEdge,
        child: Stack(
          children: [
            Positioned(
              right: 4,
              bottom: 0,
              child: Icon(icon, size: 52, color: watermarkColor),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(9, 3, 9, 3),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    label,
                    style: GoogleFonts.manrope(
                      fontSize: 13,
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
                          fontSize: 34,
                          fontWeight: FontWeight.w700,
                          letterSpacing: -1.0,
                          color: textColor,
                          height: 1.0,
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

double _continueButtonTightWidth() {
  const horizontalPadding = 12.0 * 2;
  const gap = 8.0;
  const iconSlot = 20.0;
  final painter = TextPainter(
    text: TextSpan(
      text: 'CONTINUE',
      style: GoogleFonts.spaceGrotesk(
        fontSize: 16,
        fontWeight: FontWeight.w800,
        letterSpacing: 1.5,
        color: Colors.white,
      ),
    ),
    maxLines: 1,
    textDirection: TextDirection.ltr,
  )..layout();
  return horizontalPadding + painter.size.width + gap + iconSlot;
}

class _CountBottomShortcuts extends StatelessWidget {
  const _CountBottomShortcuts({required this.onTap});

  final ValueChanged<int> onTap;

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final inactive = isDark ? const Color(0xFF7A9090) : AppColors.textMuted;
    final activeBg = isDark ? const Color(0xFF243030) : const Color(0xFFE2EEEC);
    const items = [
      (icon: Icons.dashboard, label: 'Dash', active: false),
      (icon: Icons.inventory_2_outlined, label: 'Stock', active: true),
      (icon: Icons.precision_manufacturing_outlined, label: 'Ops', active: false),
      (icon: Icons.qr_code_scanner, label: 'Tags', active: false),
    ];

    return Container(
      height: 78,
      decoration: BoxDecoration(
        color: isDark ? const Color(0xFF1C2828) : Colors.white,
        border: Border(top: BorderSide(color: isDark ? Colors.white12 : const Color(0xFFEDF2F1))),
      ),
      child: Row(
        children: items.asMap().entries.map((entry) {
          final idx = entry.key;
          final item = entry.value;
          return Expanded(
            child: GestureDetector(
              onTap: () => onTap(idx),
              behavior: HitTestBehavior.opaque,
              child: Container(
                margin: const EdgeInsets.symmetric(horizontal: 4, vertical: 8),
                decoration: BoxDecoration(
                  color: item.active ? activeBg : Colors.transparent,
                  borderRadius: BorderRadius.circular(4),
                ),
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(
                      item.icon,
                      size: 22,
                      color: item.active ? AppColors.primary : inactive,
                    ),
                    const SizedBox(height: 2),
                    Text(
                      item.label,
                      style: GoogleFonts.manrope(
                        fontSize: 12,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 0.8,
                        color: item.active ? AppColors.primary : inactive,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          );
        }).toList(),
      ),
    );
  }
}

class _CountItemContainer extends StatefulWidget {
  const _CountItemContainer({
    required this.rowKey,
    required this.sku,
    required this.description,
    required this.qtyText,
    this.expandedLines = const <String>[],
    this.onQtyTap,
    this.onDelete,
    this.confirmDelete,
  });

  final String rowKey;
  final String sku;
  final String description;
  final String qtyText;
  final List<String> expandedLines;
  final VoidCallback? onQtyTap;
  final VoidCallback? onDelete;
  final Future<bool> Function()? confirmDelete;

  @override
  State<_CountItemContainer> createState() => _CountItemContainerState();
}

class _CountItemContainerState extends State<_CountItemContainer> {
  static const _fixedContainerHeight = 45.0;
  static const _expandedContainerHeight = 55.0;
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final descStyle = GoogleFonts.manrope(
      fontSize: 13.5,
      fontWeight: FontWeight.w700,
      color: AppColors.textMain,
      letterSpacing: 0.3,
      height: 1.0,
    );

    final content = Material(
      color: const Color(0xFFEFF3F7),
      borderRadius: BorderRadius.zero,
      child: LayoutBuilder(
        builder: (context, constraints) {
          const horizontalPadding = 14.0 * 2;
          const qtyGap = 10.0;
          final qtyPainter = TextPainter(
            text: TextSpan(text: widget.qtyText, style: GoogleFonts.spaceGrotesk(fontSize: 28, fontWeight: FontWeight.w800, letterSpacing: 0.4, height: 1.0)),
            maxLines: 1,
            textDirection: Directionality.of(context),
          )..layout();
          final textAvailableWidth = (constraints.maxWidth - horizontalPadding - qtyGap - qtyPainter.width).clamp(0.0, double.infinity);
          final descPainter = TextPainter(
            text: TextSpan(text: widget.description, style: descStyle),
            maxLines: 1,
            textDirection: Directionality.of(context),
          )..layout(maxWidth: textAvailableWidth);
          final canExpand = descPainter.didExceedMaxLines;

          return InkWell(
            onTap: canExpand ? () => setState(() => _expanded = !_expanded) : null,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 4, 14, 4),
              child: AnimatedSize(
                duration: const Duration(milliseconds: 220),
                curve: Curves.easeInOut,
                alignment: Alignment.topCenter,
                child: SizedBox(
                  height: _expanded ? _expandedContainerHeight : _fixedContainerHeight,
        child: Row(
                    crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            Expanded(
              child: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                              'SKU:  ${widget.sku}',
                    style: GoogleFonts.spaceGrotesk(
                      fontSize: 15.5,
                                fontWeight: FontWeight.w900,
                      color: AppColors.textMain,
                      letterSpacing: 0.2,
                                height: 1.0,
                              ),
                            ),
                            const SizedBox(height: 1),
                            SizedBox(
                              width: double.infinity,
                              child: Text(
                                widget.description,
                                style: descStyle,
                                maxLines: _expanded ? 2 : 1,
                    overflow: TextOverflow.ellipsis,
                              ),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 10),
                      GestureDetector(
                        onTap: widget.onQtyTap,
                        behavior: HitTestBehavior.opaque,
              child: Text(
                          widget.qtyText,
                style: GoogleFonts.spaceGrotesk(
                  fontSize: 28,
                  fontWeight: FontWeight.w800,
                  color: AppColors.primary,
                  letterSpacing: 0.4,
                            height: 1.0,
                ),
              ),
            ),
          ],
                  ),
                ),
        ),
      ),
    );
        },
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
        padding: const EdgeInsets.symmetric(horizontal: 14),
        color: const Color(0xFFBF2E2E),
        child: const Icon(Icons.delete_outline, color: Colors.white, size: 26),
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
                  title: Text(r.epc, style: GoogleFonts.manrope(fontSize: 16, fontWeight: FontWeight.w700)),
                  subtitle: Text(
                    'serial ${r.serial} · scans ${r.scans}',
                    style: GoogleFonts.manrope(fontSize: 13, fontWeight: FontWeight.w600),
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

class _CountEpcListScreen extends StatelessWidget {
  const _CountEpcListScreen({
    required this.title,
    required this.epcs,
  });

  final String title;
  final List<String> epcs;

  @override
  Widget build(BuildContext context) {
    return CarbonScaffold(
      pageTitle: 'EPC LIST',
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 6),
            child: Text(
              title,
              style: GoogleFonts.spaceGrotesk(
                fontSize: 16,
                fontWeight: FontWeight.w800,
                color: AppColors.textMain,
              ),
            ),
          ),
          Expanded(
            child: ListView.separated(
              itemCount: epcs.length,
              separatorBuilder: (_, __) => const Divider(height: 1),
              itemBuilder: (_, i) => ListTile(
                dense: true,
                title: Text(
                  epcs[i],
                  style: GoogleFonts.manrope(fontSize: 14, fontWeight: FontWeight.w700),
                ),
              ),
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
    required this.buildBackendPreviewPayload,
  });

  final List<_GroupedRow> groupedRows;
  final Future<String?> Function() onSaveCsv;
  final Map<String, dynamic> Function() buildBackendPreviewPayload;

  @override
  State<_CountInventoryContinueScreen> createState() => _CountInventoryContinueScreenState();
}

class _CountInventoryContinueScreenState extends State<_CountInventoryContinueScreen> {
  bool _overrideEntireCloudQuantities = false;

  @override
  Widget build(BuildContext context) {
    final totalItems = widget.groupedRows.fold<int>(0, (sum, row) => sum + row.qty);
    final canUpload = totalItems > 0;
    const fileNameValue = '';
    const fileStatusValue = 'N/A';

    return CarbonScaffold(
      pageTitle: 'commit',
      actions: const [],
      bottomBar: Container(
        height: 80,
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
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 4),
            child: Row(
        children: [
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 4),
                    child: SizedBox(
                      height: double.infinity,
                      child: FilledButton(
                        onPressed: canUpload ? () {} : null,
                        style: FilledButton.styleFrom(
                          backgroundColor: const Color(0xFF1B7D7D),
                          disabledBackgroundColor: const Color(0xFF1B7D7D),
                          foregroundColor: Colors.white,
                          disabledForegroundColor: Colors.white,
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(2)),
                        ),
                        child: FittedBox(
                          fit: BoxFit.scaleDown,
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              const Icon(Icons.cloud_upload, size: 20),
                              const SizedBox(width: 8),
                              Text(
                                'UPLOAD',
                                style: GoogleFonts.manrope(
                                  fontSize: 14,
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
                    padding: const EdgeInsets.symmetric(horizontal: 4),
                    child: SizedBox(
                      height: double.infinity,
                      child: FilledButton(
                        onPressed: () {},
                        style: FilledButton.styleFrom(
                          backgroundColor: const Color(0xFF2BA3A3),
                          foregroundColor: Colors.white,
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(2)),
                        ),
                        child: FittedBox(
                          fit: BoxFit.scaleDown,
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              const Icon(Icons.save, size: 20),
                              const SizedBox(width: 8),
                              Text(
                                'SAVE TO FILE',
                                style: GoogleFonts.manrope(
                                  fontSize: 14,
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
      body: ColoredBox(
        color: Colors.white,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 16),
          children: [
            Text(
              'Inventory Management Terminal',
              style: GoogleFonts.spaceGrotesk(
                fontSize: 14,
                fontWeight: FontWeight.w500,
                letterSpacing: 3.0,
                color: const Color(0xFF5A6464),
              ),
            ),
            const SizedBox(height: 16),
            SizedBox(
              height: 148,
              child: Container(
                color: const Color(0xFFE7EBEB),
                padding: const EdgeInsets.fromLTRB(18, 16, 18, 14),
                child: Center(
                  child: FractionallySizedBox(
                    widthFactor: 0.9,
                    alignment: Alignment.center,
                    child: RichText(
                      textAlign: TextAlign.left,
                      text: TextSpan(
                        style: GoogleFonts.manrope(
                          fontSize: 30,
                          fontWeight: FontWeight.w800,
                          letterSpacing: -0.2,
                          height: 1.38,
                          color: const Color(0xFF11181C),
                        ),
                        children: const [
                          TextSpan(text: 'Upload to '),
                          TextSpan(text: 'CARBON', style: TextStyle(color: Color(0xFF009496), fontWeight: FontWeight.w800)),
                          TextSpan(text: '\nORLANDO\nWAREHOUSE '),
                          TextSpan(text: '001', style: TextStyle(color: Color(0xFF0E8E9A), fontWeight: FontWeight.w800)),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ),
            const SizedBox(height: 16),
            SizedBox(
              height: 145,
              child: Container(
                decoration: BoxDecoration(
                  color: const Color(0xFFFAFAFA),
                  border: const Border(left: BorderSide(color: Color(0xFF009496), width: 6)),
                  borderRadius: BorderRadius.circular(2),
                  boxShadow: const [
                    BoxShadow(
                      color: Color(0x14000000),
                      blurRadius: 6,
                      offset: Offset(0, 2),
                    ),
                  ],
                ),
                padding: const EdgeInsets.all(24),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Container(
                          width: 8,
                          height: 8,
                          decoration: const BoxDecoration(
                            color: Color(0xFF009496),
                            shape: BoxShape.circle,
                          ),
                        ),
                        const SizedBox(width: 8),
                        Text(
                          'TOTAL PROCESSING LOAD',
                          style: GoogleFonts.spaceGrotesk(
                            fontSize: 12,
                            fontWeight: FontWeight.w700,
                            letterSpacing: 4.0,
                            color: const Color(0xFF71717A),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 16),
                    Text(
                      'NO ITEMS SCANNED',
                      style: GoogleFonts.spaceGrotesk(
                        fontSize: 14,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 2.2,
                        color: const Color(0xFF009496),
                        height: 1.0,
                      ),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),
            SizedBox(
              height: 112,
              child: Container(
                decoration: BoxDecoration(
                  color: const Color(0xFFF0F5F4),
                  borderRadius: BorderRadius.circular(2),
                ),
                padding: const EdgeInsets.all(24),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Expanded(
                      child: Row(
                        children: [
                          Container(
                            width: 48,
                            height: 48,
                            decoration: BoxDecoration(
                              color: const Color(0xFF009496),
                              borderRadius: BorderRadius.circular(2),
                            ),
                            child: const Icon(
                              Icons.description_outlined,
                              color: Colors.white,
                              size: 24,
                ),
              ),
              const SizedBox(width: 16),
              Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              mainAxisAlignment: MainAxisAlignment.center,
                              children: [
                                Text(
                                  fileNameValue,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: GoogleFonts.manrope(
                                    fontSize: 16,
                                    fontWeight: FontWeight.w700,
                                    color: const Color(0xFF11181C),
                                  ),
                                ),
                                Text(
                                  fileStatusValue,
                                  style: GoogleFonts.spaceGrotesk(
                                    fontSize: 14,
                                    fontWeight: FontWeight.w800,
                                    letterSpacing: 2.2,
                                    color: const Color(0xFF009496),
                                    height: 1.0,
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
            const SizedBox(height: 16),
            SizedBox(
              height: 152,
              child: Container(
                decoration: BoxDecoration(
                  color: const Color(0xFFE7EBEB),
                  borderRadius: BorderRadius.circular(2),
                ),
                child: Material(
                  color: Colors.transparent,
                  child: InkWell(
                    borderRadius: BorderRadius.circular(2),
                    onTap: () {
                      setState(() => _overrideEntireCloudQuantities = !_overrideEntireCloudQuantities);
                    },
                    child: Padding(
                      padding: const EdgeInsets.fromLTRB(24, 20, 20, 20),
                      child: Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Expanded(
                            child: Padding(
                              padding: const EdgeInsets.only(right: 4),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    'Override Entire Cloud\nQuantities',
                                    style: GoogleFonts.manrope(
                                      fontSize: 18,
                                      fontWeight: FontWeight.w700,
                                      height: 1.35,
                                      color: const Color(0xFF11181C),
                                    ),
                                  ),
                                  const SizedBox(height: 8),
                                  Text(
                                    '- if checked: replaced existing\nquantities and zero missing items',
                                    maxLines: 2,
                                    style: GoogleFonts.spaceGrotesk(
                                      fontSize: 16,
                                      fontWeight: FontWeight.w700,
                                      height: 1.45,
                                      color: const Color(0xFFBF2E2E),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ),
                          SizedBox(
                            width: 44,
                            height: 44,
                            child: Checkbox(
                              value: _overrideEntireCloudQuantities,
                              onChanged: (next) {
                                setState(() => _overrideEntireCloudQuantities = next ?? false);
                              },
                              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(2)),
                              side: const BorderSide(color: Color(0xFF7C8A8A), width: 2),
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
  }
}

class _CountInventorySettingsScreen extends StatefulWidget {
  const _CountInventorySettingsScreen({required this.initial});

  final _CountInventoryModuleSettings initial;

  @override
  State<_CountInventorySettingsScreen> createState() => _CountInventorySettingsScreenState();
}

class _CountInventorySettingsScreenState extends State<_CountInventorySettingsScreen> {
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
              _CountInventoryModuleSettings(rfidPowerDbm: _power, rssiDistance: _rssi),
            );
          },
        ),
      ],
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 24, 16, 24),
        children: [
          Text('RFID Power (0-30dbm)', style: GoogleFonts.manrope(fontSize: 32, fontWeight: FontWeight.w700)),
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
              Text('$_power\ndbm', textAlign: TextAlign.center, style: const TextStyle(fontSize: 20)),
            ],
          ),
          const SizedBox(height: 20),
          Text('RSSI', style: GoogleFonts.manrope(fontSize: 32, fontWeight: FontWeight.w700)),
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
              style: GoogleFonts.manrope(fontSize: 30, fontWeight: FontWeight.w700),
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
        rssiDistance: ((m['rssiDistance'] as num?)?.toDouble() ?? 1.0).clamp(0.0, 1.0),
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

String _csv(String v) {
  final needsQuotes = v.contains(',') || v.contains('"') || v.contains('\n');
  if (!needsQuotes) return v;
  return '"${v.replaceAll('"', '""')}"';
}

String _two(int v) => v < 10 ? '0$v' : '$v';
