import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:path_provider/path_provider.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:carbon_wms/audio/geiger_beep_wav.dart';
import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/hardware/rfid_tag_read.dart';
import 'package:carbon_wms/hardware/rfid_vendor_channel.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/epc_asset_decoder.dart';
import 'package:carbon_wms/services/handheld_device_identity.dart';
import 'package:carbon_wms/services/mobile_settings_repository.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/screens/encode_suite_screens.dart';
import 'package:carbon_wms/ui/screens/inventory_hub_screen.dart';
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
  List<Map<String, String>> _locations = [];
  String _currentLocationName = 'Loading...';
  String _currentLocationId = '';
  StreamSubscription<String>? _readsSub;
  StreamSubscription<String>? _triggerSub;
  bool _scanOn = false;
  bool _connecting = false;
  bool _busyLookup = false;
  _CountInventoryModuleSettings _moduleSettings = _CountInventoryModuleSettings.defaults;
  RfidManager? _rfidManager;
  late final AudioPlayer _scanAudio;
  Uint8List? _scanBeepBytes;

  @override
  void initState() {
    super.initState();
    _scanAudio = AudioPlayer()
      ..setReleaseMode(ReleaseMode.stop)
      ..setPlayerMode(PlayerMode.lowLatency);
    _scanBeepBytes = buildGeigerBeepWav();
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
    unawaited(_scanAudio.dispose());
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
      final name = (locs.first['name'] ?? locs.first['code'] ?? '').trim();
      final id = (locs.first['id'] ?? '').trim();
      setState(() {
        _locations = locs;
        if (name.isNotEmpty) _currentLocationName = name;
        if (id.isNotEmpty) _currentLocationId = id;
      });
    } catch (_) {}
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
              final isActive = id == _currentLocationId || name == _currentLocationName;
              return ListTile(
                dense: true,
                title: Text(
                  name,
                  style: GoogleFonts.manrope(
                    fontSize: 15.sp,
                    fontWeight: FontWeight.w700,
                    color: isActive ? AppColors.primary : const Color(0xFF11181C),
                  ),
                ),
                trailing: isActive ? Icon(Icons.check, color: AppColors.primary, size: 20.sp) : null,
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
    setState(() {
      _connecting = true;
    });
    final rfid = context.read<RfidManager>();
    final settingsRepo = context.read<MobileSettingsRepository>();
    rfid.scanContext = 'COUNT_INVENTORY';
    await rfid.autoDetectHardware();
    await rfid.reapplyHandheldHardwareSettings();
    await RfidVendorChannel.setAntennaPowerDbm(_moduleSettings.rfidPowerDbm);
    await _readsSub?.cancel();
    _readsSub = rfid.visibleEpcs.listen((epc) {
      final read = RfidTagRead.tryParse(epc);
      if (read == null) return;
      _onTagRead(read);
    }, onError: (_) {});
    await _triggerSub?.cancel();
    _triggerSub = RfidVendorChannel.hardwareTriggerStream().listen((evt) {
      final holdReleaseMode = settingsRepo.config.triggerModeHoldRelease;
      if (holdReleaseMode) {
        if (evt == 'down' && !_scanOn) {
          unawaited(_startScan());
          return;
        }
        if (evt == 'up' && _scanOn) {
          unawaited(_stopScan());
        }
        return;
      }
      if (evt == 'down') {
        unawaited(_toggleScan());
      }
    }, onError: (_) {});
    if (!mounted) return;
    setState(() {
      _connecting = false;
    });
  }

  Future<void> _saveAssetCache() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_assetCachePrefsKey, jsonEncode(_assetCache));
  }

  Future<void> _saveModuleSettings() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_countInvPrefsKey, _moduleSettings.toJsonString());
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

  Future<void> _playBeep() async {
    final bytes = _scanBeepBytes;
    if (bytes == null) return;
    try {
      await _scanAudio.play(BytesSource(bytes));
    } catch (_) {}
  }

  void _onTagRead(RfidTagRead read) {
    if (!_scanOn) {
      if (mounted) {
        setState(() => _scanOn = true);
      } else {
        _scanOn = true;
      }
    }
    final now = DateTime.now();
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
      unawaited(_playBeep());
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
        final row = await api.catalogLookupBySystemId(assetId);
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
      await _stopScan();
    } else {
      await _startScan();
    }
  }

  Future<void> _startScan() async {
    final rfid = context.read<RfidManager>();
    await RfidVendorChannel.setAntennaPowerDbm(_moduleSettings.rfidPowerDbm);
    await rfid.startLocateScanning();
    // Built-in Chainway / rscja UHF often ignores Flutter inventory until BARCODESTARTSCAN is sent.
    if (!rfid.isHardwareLinked) {
      await RfidVendorChannel.scannerStart2d();
    }
    if (!mounted) return;
    setState(() {
      _scanOn = true;
    });
  }

  Future<void> _stopScan() async {
    final rfid = context.read<RfidManager>();
    await rfid.stopLocateScanning();
    if (!rfid.isHardwareLinked) {
      await RfidVendorChannel.scannerStop2d();
    }
    if (!mounted) return;
    setState(() {
      _scanOn = false;
    });
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
      await _stopScan();
    }
    if (!mounted) return;
    setState(() {
      _epcRows.clear();
      _groupedRows.clear();
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
          locationName: _currentLocationName,
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
    final skuCount = groups.length;
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
          icon: Icon(Icons.settings_outlined),
          onPressed: _openModuleSettings,
        ),
      ],
      body: ColoredBox(
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
                      Icon(Icons.expand_more, size: 16.sp, color: AppColors.primary),
                    ],
                  ],
                ),
              ),
            ),
            Padding(
              padding: EdgeInsets.fromLTRB(20.w, 12.h, 20.w, 0.h),
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
                      SizedBox(width: 8.w),
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
            SizedBox(height: 12.h),
            Expanded(
              child: Padding(
                padding: EdgeInsets.fromLTRB(20.w, 0.h, 20.w, 0.h),
                child: ColoredBox(
                  color: Colors.transparent,
                  child: hasRealRows
                    ? ListView.separated(
                        padding: EdgeInsets.only(bottom: 12.h),
                          itemCount: groups.length,
                        separatorBuilder: (_, __) => SizedBox(height: 8.h),
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
                              fontSize: 14.sp,
                              fontWeight: FontWeight.w700,
                              color: const Color(0xFF5A6464),
                            ),
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
                    child: Align(
                      alignment: Alignment.centerLeft,
                    child: SizedBox(
                        width: continueButtonWidth,
                        height: 40.h,
                      child: FilledButton(
                        onPressed: _connecting ? null : _toggleScan,
                        style: FilledButton.styleFrom(
                            backgroundColor: _scanOn ? const Color(0xFFBF2E2E) : const Color(0xFF0A7C80),
                          foregroundColor: Colors.white,
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(2.r)),
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
                              SizedBox(
                                width: 20.w,
                                child: Icon(
                                  _scanOn ? Icons.stop_circle_outlined : Icons.play_circle_outline,
                                  size: 20.sp,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ),
                  SizedBox(width: 8.w),
                  SizedBox(
                    width: 40.w,
                    height: 40.h,
                    child: FilledButton(
                      onPressed: _resetScreenToDefault,
                      style: FilledButton.styleFrom(
                        backgroundColor: const Color(0xFF6A7575),
                        foregroundColor: Colors.white,
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(2.r)),
                        padding: EdgeInsets.zero,
                      ),
                      child: Icon(Icons.restart_alt, size: 20.sp),
                    ),
                  ),
                  SizedBox(width: 8.w),
                  Expanded(
                    child: Align(
                      alignment: Alignment.centerRight,
                      child: IntrinsicWidth(
                    child: SizedBox(
                          height: 40.h,
                      child: FilledButton(
                            onPressed: _openContinue,
                        style: FilledButton.styleFrom(
                          backgroundColor: const Color(0xFF2BA3A3),
                          disabledBackgroundColor: const Color(0xFF2BA3A3),
                          foregroundColor: Colors.white,
                              disabledForegroundColor: Colors.white,
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(2.r)),
                          padding: EdgeInsets.symmetric(horizontal: 12.w),
                              minimumSize: Size.zero,
                              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                        ),
                        child: Row(
                              mainAxisSize: MainAxisSize.min,
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
                                Icon(Icons.arrow_forward, size: 20.sp, color: Colors.white),
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

double _continueButtonTightWidth() {
  const horizontalPadding = 12.0 * 2;
  const gap = 8.0;
  const iconSlot = 20.0;
  final painter = TextPainter(
    text: TextSpan(
      text: 'CONTINUE',
      style: GoogleFonts.spaceGrotesk(
        fontSize: 16.sp,
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
      height: 78.h,
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
                margin: EdgeInsets.symmetric(horizontal: 4.w, vertical: 8.h),
                decoration: BoxDecoration(
                  color: item.active ? activeBg : Colors.transparent,
                  borderRadius: BorderRadius.circular(4.r),
                ),
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(
                      item.icon,
                      size: 22.sp,
                      color: item.active ? AppColors.primary : inactive,
                    ),
                    SizedBox(height: 2.h),
                    Text(
                      item.label,
                      style: GoogleFonts.manrope(
                        fontSize: 12.sp,
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
      fontSize: 13.5.sp,
      fontWeight: FontWeight.w700,
      color: AppColors.textMain,
      letterSpacing: 0.3,
      height: 1.0.h,
    );

    final content = Material(
      color: const Color(0xFFEFF3F7),
      borderRadius: BorderRadius.zero,
      child: LayoutBuilder(
        builder: (context, constraints) {
          const horizontalPadding = 14.0 * 2;
          const qtyGap = 10.0;
          final qtyPainter = TextPainter(
            text: TextSpan(text: widget.qtyText, style: GoogleFonts.spaceGrotesk(fontSize: 28.sp, fontWeight: FontWeight.w800, letterSpacing: 0.4, height: 1.0.h)),
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
        padding: EdgeInsets.fromLTRB(14.w, 4.h, 14.w, 4.h),
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
                      fontSize: 15.5.sp,
                                fontWeight: FontWeight.w900,
                      color: AppColors.textMain,
                      letterSpacing: 0.2,
                                height: 1.0.h,
                              ),
                            ),
                            SizedBox(height: 1.h),
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
            SizedBox(width: 10.w),
                      GestureDetector(
                        onTap: widget.onQtyTap,
                        behavior: HitTestBehavior.opaque,
              child: Text(
                          widget.qtyText,
                style: GoogleFonts.spaceGrotesk(
                  fontSize: 28.sp,
                  fontWeight: FontWeight.w800,
                  color: AppColors.primary,
                  letterSpacing: 0.4,
                            height: 1.0.h,
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
            padding: EdgeInsets.fromLTRB(16.w, 12.h, 16.w, 6.h),
            child: Text(
              title,
              style: GoogleFonts.spaceGrotesk(
                fontSize: 16.sp,
                fontWeight: FontWeight.w800,
                color: AppColors.textMain,
              ),
            ),
          ),
          Expanded(
            child: ListView.separated(
              itemCount: epcs.length,
              separatorBuilder: (_, __) => Divider(height: 1.h),
              itemBuilder: (_, i) => ListTile(
                dense: true,
                title: Text(
                  epcs[i],
                  style: GoogleFonts.manrope(fontSize: 14.sp, fontWeight: FontWeight.w700),
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
    required this.locationName,
    required this.onSaveCsv,
    required this.buildBackendPreviewPayload,
  });

  final List<_GroupedRow> groupedRows;
  final String locationName;
  final Future<String?> Function() onSaveCsv;
  final Map<String, dynamic> Function() buildBackendPreviewPayload;

  @override
  State<_CountInventoryContinueScreen> createState() => _CountInventoryContinueScreenState();
}

class _CountInventoryContinueScreenState extends State<_CountInventoryContinueScreen> {
  bool _overrideEntireCloudQuantities = false;
  bool _savingCsv = false;

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
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(2.r)),
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
                        onPressed: _savingCsv ? null : () async {
                          setState(() => _savingCsv = true);
                          final messenger = ScaffoldMessenger.of(context);
                          try {
                            final path = await widget.onSaveCsv();
                            if (!mounted) return;
                            messenger.showSnackBar(
                              SnackBar(
                                content: Text(path != null ? 'Saved: $path' : 'Save failed'),
                                duration: const Duration(seconds: 4),
                              ),
                            );
                          } finally {
                            if (mounted) setState(() => _savingCsv = false);
                          }
                        },
                        style: FilledButton.styleFrom(
                          backgroundColor: const Color(0xFF2BA3A3),
                          foregroundColor: Colors.white,
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(2.r)),
                        ),
                        child: FittedBox(
                          fit: BoxFit.scaleDown,
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              _savingCsv
                                  ? SizedBox(width: 20.w, height: 20.h, child: const CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
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
                                  style: const TextStyle(color: Color(0xFF009496), fontWeight: FontWeight.w800),
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
                        border: Border(left: BorderSide(color: Color(0xFF009496), width: 6.w)),
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
                                    crossAxisAlignment: CrossAxisAlignment.start,
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
                            setState(() => _overrideEntireCloudQuantities = !_overrideEntireCloudQuantities);
                          },
                          child: Padding(
                            padding: EdgeInsets.fromLTRB(14.w, 12.h, 12.w, 12.h),
                            child: Row(
                              mainAxisAlignment: MainAxisAlignment.spaceBetween,
                              children: [
                                Expanded(
                                  child: Padding(
                                    padding: EdgeInsets.only(right: 4.w),
                                    child: Column(
                                      crossAxisAlignment: CrossAxisAlignment.start,
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
                                      setState(() => _overrideEntireCloudQuantities = next ?? false);
                                    },
                                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(2.r)),
                                    side: BorderSide(color: Color(0xFF7C8A8A), width: 2.w),
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
  State<_CountInventorySettingsScreen> createState() => _CountInventorySettingsScreenState();
}

class _CountInventorySettingsScreenState extends State<_CountInventorySettingsScreen> {
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
        const SnackBar(content: Text('Scanner settings app not found on this device.')),
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
              _CountInventoryModuleSettings(rfidPowerDbm: _power, rssiDistance: _rssi),
            );
          },
                    style: FilledButton.styleFrom(
                      backgroundColor: _primary,
                      foregroundColor: Colors.white,
                      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
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
                      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
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
                            child: CircularProgressIndicator(strokeWidth: 2, color: _primary),
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
                  shape: const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
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
            Divider(height: 1.h, thickness: 1, color: Color(0xFFF4F4F5)),
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
    final fill = Paint()..color = sliderTheme.thumbColor ?? const Color(0xFF009496);
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
