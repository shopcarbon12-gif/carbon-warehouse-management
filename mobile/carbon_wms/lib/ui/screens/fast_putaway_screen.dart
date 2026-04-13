import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/handheld_device_identity.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/widgets/camera_barcode_scanner.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart' show WmsText;
import 'package:carbon_wms/ui/screens/dashboard_screen.dart' show DashboardScreen;
import 'package:carbon_wms/ui/screens/epc_detail_screen.dart';
import 'package:carbon_wms/ui/screens/bin_assign_settings_screen.dart';

// ── Palette ───────────────────────────────────────────────────────────────────
const Color _surface    = Color(0xFFFFFFFF);
const Color _surfaceLow = Color(0xFFF3F3F4);
const Color _surfaceMid = Color(0xFFEEEEEE);

const Color _tealDark   = Color(0xFF1B7D7D);
const Color _tealLight  = Color(0xFF2BA3A3);
const Color _tealDarkDk  = Color(0xFF1B7D7D);
const Color _tealLightDk = Color(0xFF4DB6AC);

// ── SKU parsing ───────────────────────────────────────────────────────────────

/// Parse scanned barcode into its components.
///
/// No C prefix: base=7, color=chars8-9, size=remainder
///   searchKey (specific color) = first 9 chars
///   searchKey (all colors)     = first 7 chars
///
/// With C prefix: base=9(incl C), color=chars10-11, size=remainder
///   searchKey (specific color) = first 11 chars
///   searchKey (all colors)     = first 9 chars
class _SkuParts {
  const _SkuParts({
    required this.raw,
    required this.base,
    required this.colorCode,
    required this.sizeCode,
    required this.searchKeySpecific,
    required this.searchKeyAllColors,
  });

  final String raw;
  final String base;
  final String colorCode;
  final String sizeCode;
  final String searchKeySpecific;
  final String searchKeyAllColors;

  static _SkuParts parse(String sku) {
    final s = sku.trim().toUpperCase();
    if (s.startsWith('C') && s.length >= 9) {
      // C prefix: base = first 9 chars
      final base  = s.substring(0, 9);
      final color = s.length >= 11 ? s.substring(9, 11) : '';
      final size  = s.length > 11  ? s.substring(11)    : '';
      return _SkuParts(
        raw: s,
        base: base,
        colorCode: color,
        sizeCode: size,
        searchKeySpecific:  s.length >= 11 ? s.substring(0, 11) : s,
        searchKeyAllColors: base,
      );
    } else if (s.length >= 7) {
      // No C prefix: base = first 7 chars
      final base  = s.substring(0, 7);
      final color = s.length >= 9 ? s.substring(7, 9) : '';
      final size  = s.length > 9  ? s.substring(9)    : '';
      return _SkuParts(
        raw: s,
        base: base,
        colorCode: color,
        sizeCode: size,
        searchKeySpecific:  s.length >= 9 ? s.substring(0, 9) : s,
        searchKeyAllColors: base,
      );
    }
    return _SkuParts(
      raw: s, base: s, colorCode: '', sizeCode: '',
      searchKeySpecific: s, searchKeyAllColors: s,
    );
  }
}

/// Format raw 5-char bin code (e.g. "2B03L") → "2-B-03-L".
String _formatBinCode(String raw) {
  final s = raw.trim().toUpperCase().replaceAll(RegExp(r'[-\s]'), '');
  if (s.length == 5) {
    return '${s[0]}-${s[1]}-${s.substring(2, 4)}-${s[4]}';
  }
  return raw.trim().toUpperCase();
}

// ── Stored item model ─────────────────────────────────────────────────────────

class _StoredItem {
  _StoredItem({
    required this.sku,
    required this.description,
    required this.qty,
    required this.customSkuId,
    required this.binId,
    this.epcs = const [],
  });

  final String sku;
  final String description;
  final int    qty;
  final String customSkuId;
  final String binId;
  final List<String> epcs;

  _StoredItem copyWith({int? qty, List<String>? epcs}) => _StoredItem(
    sku: sku,
    description: description,
    qty: qty ?? this.qty,
    customSkuId: customSkuId,
    binId: binId,
    epcs: epcs ?? this.epcs,
  );

  static _StoredItem fromMap(Map<String, dynamic> m, {String binId = ''}) {
    final epcsRaw = m['epcs'];
    final epcs = epcsRaw is List ? epcsRaw.map((e) => e.toString()).toList() : <String>[];
    return _StoredItem(
      sku: m['sku']?.toString() ?? m['customSku']?.toString() ?? '',
      description: m['description']?.toString() ?? m['title']?.toString() ?? '',
      qty: (m['qty'] as int?) ?? (m['quantity'] as int?) ?? epcs.length,
      customSkuId: m['customSkuId']?.toString() ?? m['id']?.toString() ?? '',
      binId: m['binId']?.toString() ?? binId,
      epcs: epcs,
    );
  }
}

/// Bin Assign — fast 2D putaway with hardware wedge, camera, or manual entry.
class FastPutawayScreen extends StatefulWidget {
  const FastPutawayScreen({super.key});

  @override
  State<FastPutawayScreen> createState() => _FastPutawayScreenState();
}

class _FastPutawayScreenState extends State<FastPutawayScreen> {
  final _scanFocus  = FocusNode();
  final _hiddenCtrl = TextEditingController();

  // ── Bin state ──
  String _currentBin   = '';   // formatted bin code e.g. "2-B-03-L"
  String _currentBinId = '';   // DB id for API calls
  bool   _binActive    = false;

  // ── UI state ──
  bool   _busy     = false;
  bool   _flashOk  = false;
  bool   _awaitingBinScan = true;   // true = waiting for bin, false = waiting for item

  // ── Stored contents ──
  List<_StoredItem> _storedContents = [];
  List<_StoredItem> _undoSnapshot   = [];   // snapshot before clean

  int get _storedTotal => _storedContents.fold(0, (sum, e) => sum + e.qty);

  // ── Settings ──
  @override
  void initState() {
    super.initState();
    _loadSettings();
    WidgetsBinding.instance.addPostFrameCallback((_) => _scanFocus.requestFocus());
  }

  @override
  void dispose() {
    _hiddenCtrl.dispose();
    _scanFocus.dispose();
    super.dispose();
  }

  Future<void> _loadSettings() async {
    // Reload any settings that affect scan behaviour (reserved for future use).
    await SharedPreferences.getInstance();
  }

  // ── Scan dispatch ─────────────────────────────────────────────────────────

  void _onScanSubmit(String raw) {
    final v = raw.trim();
    if (v.isEmpty) return;
    _hiddenCtrl.clear();
    if (_awaitingBinScan) {
      unawaited(_handleBinScan(v));
    } else {
      unawaited(_handleItemScan(v));
    }
  }

  // ── Bin scan flow ─────────────────────────────────────────────────────────

  Future<void> _handleBinScan(String raw) async {
    final code = _formatBinCode(raw);
    setState(() => _busy = true);
    try {
      final api = context.read<WmsApiClient>();
      // Look up bin in WMS
      final bins = await api.fetchBins();
      final match = bins.cast<Map<String, dynamic>?>().firstWhere(
        (b) => b != null && (b['code']?.toString().toUpperCase() == code.toUpperCase()),
        orElse: () => null,
      );

      if (match == null) {
        // Bin doesn't exist — prompt to create
        setState(() => _busy = false);
        if (!mounted) return;
        final create = await _showCreateBinDialog(code);
        if (create != true) {
          _scanFocus.requestFocus();
          return;
        }
        setState(() => _busy = true);
        final created = await api.createBin(code);
        final newId = created['id']?.toString() ?? created['binId']?.toString() ?? '';
        setState(() {
          _busy = false;
          _currentBin   = code;
          _currentBinId = newId;
          _binActive    = true;
          _storedContents = [];
          _awaitingBinScan = false;
        });
        _flashSuccess();
        _scanFocus.requestFocus();
        return;
      }

      // Bin exists — load contents
      final binId = match['id']?.toString() ?? match['binId']?.toString() ?? '';
      List<_StoredItem> items = [];
      if (binId.isNotEmpty) {
        try {
          final contents = await api.fetchBinContents(binId);
          final rawItems = contents['items'] ?? contents['storedContents'] ?? contents['rows'];
          if (rawItems is List) {
            items = rawItems
                .whereType<Map<String, dynamic>>()
                .map((m) => _StoredItem.fromMap(m, binId: binId))
                .where((i) => i.sku.isNotEmpty)
                .toList();
          }
        } catch (_) {
          // contents fetch failed — show empty, not fatal
        }
      }

      setState(() {
        _busy = false;
        _currentBin   = code;
        _currentBinId = binId;
        _binActive    = true;
        _storedContents = items;
        _awaitingBinScan = false;
      });
      _flashSuccess();
    } catch (e) {
      if (mounted) {
        setState(() => _busy = false);
        _showError('Bin lookup failed: $e');
      }
    }
    if (mounted) _scanFocus.requestFocus();
  }

  // ── Item scan flow ────────────────────────────────────────────────────────

  Future<void> _handleItemScan(String raw) async {
    final parts = _SkuParts.parse(raw);
    setState(() => _busy = true);
    try {
      final api = context.read<WmsApiClient>();

      // 1. Search catalog by specific-color key
      final specificRow = await api.catalogGridSearchFirstRow(parts.searchKeySpecific);

      if (specificRow == null) {
        setState(() => _busy = false);
        if (!mounted) return;
        _showError('Item not found in catalog: ${parts.raw}');
        _scanFocus.requestFocus();
        return;
      }

      setState(() => _busy = false);

      // 2. Show assign popup
      if (!mounted) return;
      await _showAssignPopup(skuParts: parts, catalogRow: specificRow);
    } catch (e) {
      if (mounted) {
        setState(() => _busy = false);
        _showError('Item scan failed: $e');
        _scanFocus.requestFocus();
      }
    }
  }

  // ── Assign popup ──────────────────────────────────────────────────────────

  Future<void> _showAssignPopup({
    required _SkuParts skuParts,
    required Map<String, dynamic> catalogRow,
  }) async {
    final isDark   = Theme.of(context).brightness == Brightness.dark;
    final sheetBg  = isDark ? const Color(0xFF1C2828) : _surface;
    final btnMid   = isDark ? const Color(0xFF243030) : _surfaceMid;
    final textMain = isDark ? const Color(0xFFE0ECEC) : AppColors.textMain;

    final title    = catalogRow['title']?.toString() ?? catalogRow['description']?.toString() ?? '';
    final matrixId = catalogRow['matrixId']?.toString() ?? catalogRow['productId']?.toString() ?? '';
    final colorCode = skuParts.colorCode;
    final colorLabel = colorCode.isNotEmpty ? 'COLOR $colorCode' : 'THIS COLOR';
    final api = context.read<WmsApiClient>();

    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: sheetBg,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(12)),
      ),
      builder: (ctx) {
        return _AssignPopup(
          sku: skuParts.raw,
          title: title,
          colorCode: colorCode,
          colorLabel: colorLabel,
          matrixId: matrixId,
          sheetBg: sheetBg,
          btnMid: btnMid,
          textMain: textMain,
          onAssignSingleColor: () async {
            Navigator.pop(ctx);
            await _doAssign(skuScanned: skuParts.raw, scope: 'single_color');
          },
          onAssignAllColors: () async {
            Navigator.pop(ctx);
            await _doAssign(skuScanned: skuParts.searchKeyAllColors, scope: 'all_colors');
          },
          onAssignSelectedColors: (List<String> selectedSkus) async {
            Navigator.pop(ctx);
            for (final s in selectedSkus) {
              await _doAssign(skuScanned: s, scope: 'single_color');
            }
          },
          api: api,
        );
      },
    );

    if (mounted) _scanFocus.requestFocus();
  }

  Future<void> _doAssign({required String skuScanned, required String scope}) async {
    setState(() => _busy = true);
    try {
      final api      = context.read<WmsApiClient>();
      final deviceId = await HandheldDeviceIdentity.primaryDeviceIdForServer();
      final result   = await api.postPutawayAssign(
        deviceId:   deviceId,
        binCode:    _currentBin,
        skuScanned: skuScanned,
        scope:      scope,
      );

      // Reload bin contents (RFID quantities)
      List<_StoredItem> newItems = _storedContents;
      if (_currentBinId.isNotEmpty) {
        try {
          final contents = await api.fetchBinContents(_currentBinId);
          final rawItems = contents['items'] ?? contents['storedContents'] ?? contents['rows'];
          if (rawItems is List) {
            newItems = rawItems
                .whereType<Map<String, dynamic>>()
                .map((m) => _StoredItem.fromMap(m, binId: _currentBinId))
                .where((i) => i.sku.isNotEmpty)
                .toList();
          }
        } catch (_) {
          // If bin contents fetch fails, try to build from API result
          final raw = result['storedContents'];
          if (raw is List) {
            newItems = raw
                .whereType<Map<String, dynamic>>()
                .map((m) => _StoredItem.fromMap(m, binId: _currentBinId))
                .toList();
          }
        }
      }

      setState(() {
        _busy = false;
        _storedContents = newItems;
      });
      _flashSuccess();
    } catch (e) {
      if (mounted) {
        setState(() => _busy = false);
        _showError('Assign failed: $e');
      }
    }
    if (mounted) _scanFocus.requestFocus();
  }

  // ── Clean & Empty ─────────────────────────────────────────────────────────

  Future<void> _onCleanBin() async {
    if (_currentBin.isEmpty) return;
    final confirm = await _showConfirmDialog(
      title: 'CLEAN & EMPTY BIN',
      body: 'This will remove ALL items assigned to bin $_currentBin.\nThis action can be undone.',
      confirmLabel: 'CLEAN',
      destructive: true,
    );
    if (confirm != true) return;

    // Snapshot for undo
    _undoSnapshot = List.of(_storedContents);

    setState(() => _busy = true);
    try {
      final api = context.read<WmsApiClient>();
      await api.postCleanBinByCode(_currentBin);
      setState(() {
        _busy = false;
        _storedContents = [];
      });
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text('Bin $_currentBin cleaned.'),
          action: SnackBarAction(label: 'UNDO', onPressed: _onUndoClean),
          duration: const Duration(seconds: 8),
        ));
      }
    } catch (e) {
      if (mounted) {
        setState(() => _busy = false);
        _showError('Clean failed: $e');
      }
    }
  }

  Future<void> _onUndoClean() async {
    if (_undoSnapshot.isEmpty || _currentBin.isEmpty) return;
    setState(() => _busy = true);
    try {
      final api      = context.read<WmsApiClient>();
      final deviceId = await HandheldDeviceIdentity.primaryDeviceIdForServer();
      for (final item in _undoSnapshot) {
        await api.postPutawayAssign(
          deviceId:   deviceId,
          binCode:    _currentBin,
          skuScanned: item.sku,
          scope:      'single_color',
        );
      }
      // Reload after re-assign
      List<_StoredItem> restored = _undoSnapshot;
      if (_currentBinId.isNotEmpty) {
        try {
          final contents = await api.fetchBinContents(_currentBinId);
          final rawItems = contents['items'] ?? contents['storedContents'] ?? contents['rows'];
          if (rawItems is List) {
            restored = rawItems
                .whereType<Map<String, dynamic>>()
                .map((m) => _StoredItem.fromMap(m, binId: _currentBinId))
                .where((i) => i.sku.isNotEmpty)
                .toList();
          }
        } catch (_) {}
      }
      setState(() {
        _busy = false;
        _storedContents = restored;
        _undoSnapshot   = [];
      });
    } catch (e) {
      if (mounted) {
        setState(() => _busy = false);
        _showError('Undo failed: $e');
      }
    }
  }

  // ── Swipe delete item ─────────────────────────────────────────────────────

  Future<void> _onDeleteItem(_StoredItem item) async {
    final confirm = await _showConfirmDialog(
      title: 'REMOVE ITEM',
      body: 'Remove ${item.sku} from bin $_currentBin?',
      confirmLabel: 'REMOVE',
      destructive: true,
    );
    if (confirm != true) {
      setState(() {}); // re-render to restore dismissed item
      return;
    }
    setState(() => _busy = true);
    try {
      final api = context.read<WmsApiClient>();
      await api.removeSkuFromBin(binId: _currentBinId, sku: item.sku);
      setState(() {
        _busy = false;
        _storedContents.remove(item);
      });
    } catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          // restore item if delete failed
          if (!_storedContents.contains(item)) _storedContents.add(item);
        });
        _showError('Remove failed: $e');
      }
    }
  }

  // ── Add bin / item buttons ────────────────────────────────────────────────

  Future<void> _tapAddBin({bool camera = false}) async {
    setState(() => _awaitingBinScan = true);
    if (camera) {
      final code = await _scanWithCamera('Scan bin label');
      if (code != null && code.isNotEmpty && mounted) {
        await _handleBinScan(code);
      } else {
        _scanFocus.requestFocus();
      }
    } else {
      _scanFocus.requestFocus();
    }
  }

  Future<void> _tapAddItem({bool camera = false}) async {
    if (!_binActive) return;
    setState(() => _awaitingBinScan = false);
    if (camera) {
      final code = await _scanWithCamera('Scan item barcode');
      if (code != null && code.isNotEmpty && mounted) {
        await _handleItemScan(code);
      } else {
        _scanFocus.requestFocus();
      }
    } else {
      _scanFocus.requestFocus();
    }
  }

  Future<String?> _scanWithCamera(String title) async {
    // Unlock orientation for camera
    await SystemChrome.setPreferredOrientations([
      DeviceOrientation.portraitUp,
      DeviceOrientation.landscapeLeft,
      DeviceOrientation.landscapeRight,
    ]);
    try {
      return await openCameraBarcodeScanner(context, title: title);
    } finally {
      await SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp]);
    }
  }

  // ── Reset for next entry ──────────────────────────────────────────────────

  void _resetForNextEntry() {
    setState(() {
      _currentBin      = '';
      _currentBinId    = '';
      _binActive       = false;
      _storedContents  = [];
      _awaitingBinScan = true;
    });
    _scanFocus.requestFocus();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  void _flashSuccess() {
    setState(() => _flashOk = true);
    Future.delayed(const Duration(milliseconds: 450), () {
      if (mounted) setState(() => _flashOk = false);
    });
  }

  void _showError(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  Future<bool?> _showCreateBinDialog(String code) => showDialog<bool>(
    context: context,
    builder: (ctx) {
      final isDark   = Theme.of(ctx).brightness == Brightness.dark;
      final textMain = isDark ? const Color(0xFFE0ECEC) : AppColors.textMain;
      return AlertDialog(
        title: Text('BIN NOT FOUND',
          style: GoogleFonts.manrope(fontWeight: FontWeight.w800, color: textMain)),
        content: Text('Bin $code does not exist in WMS.\nCreate it now?',
          style: GoogleFonts.manrope(color: textMain)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false),
            child: Text('CANCEL', style: GoogleFonts.manrope(color: AppColors.textMuted))),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: AppColors.primary),
            onPressed: () => Navigator.pop(ctx, true),
            child: Text('CREATE', style: GoogleFonts.manrope(fontWeight: FontWeight.w800))),
        ],
      );
    },
  );

  Future<bool?> _showConfirmDialog({
    required String title,
    required String body,
    required String confirmLabel,
    bool destructive = false,
  }) => showDialog<bool>(
    context: context,
    builder: (ctx) {
      final isDark   = Theme.of(ctx).brightness == Brightness.dark;
      final textMain = isDark ? const Color(0xFFE0ECEC) : AppColors.textMain;
      return AlertDialog(
        title: Text(title,
          style: GoogleFonts.manrope(fontWeight: FontWeight.w800, color: textMain)),
        content: Text(body, style: GoogleFonts.manrope(color: textMain)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false),
            child: Text('CANCEL', style: GoogleFonts.manrope(color: AppColors.textMuted))),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: destructive ? Colors.red.shade700 : AppColors.primary),
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(confirmLabel,
              style: GoogleFonts.manrope(fontWeight: FontWeight.w800))),
        ],
      );
    },
  );

  // ── Build ─────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    final isDark     = Theme.of(context).brightness == Brightness.dark;
    final bg         = isDark ? const Color(0xFF111A1A) : _surface;
    final bgLow      = isDark ? const Color(0xFF1C2828) : _surfaceLow;
    final bgMid      = isDark ? const Color(0xFF243030) : _surfaceMid;
    final mainColor  = isDark ? const Color(0xFFE0ECEC) : AppColors.textMain;
    final mutedColor = isDark ? const Color(0xFF7A9090) : AppColors.textMuted;
    final tealDark   = isDark ? _tealDarkDk  : _tealDark;
    final tealLight  = isDark ? _tealLightDk : _tealLight;

    return Scaffold(
      backgroundColor: bg,
      resizeToAvoidBottomInset: false,
      appBar: _buildAppBar(isDark: isDark, mainColor: mainColor),
      body: Column(
        children: [
          // ── Hidden hardware-wedge receiver ──────────────────────────────
          Offstage(
            offstage: true,
            child: TextField(
              controller: _hiddenCtrl,
              focusNode: _scanFocus,
              autofocus: true,
              onSubmitted: _onScanSubmit,
            ),
          ),

          if (_busy)
            const LinearProgressIndicator(minHeight: 2),

          if (_flashOk)
            const LinearProgressIndicator(
              value: 1,
              backgroundColor: Color(0xFFD1FAE5),
              color: Color(0xFF34D399),
              minHeight: 3,
            ),

          // ── Scan mode hint ──────────────────────────────────────────────
          _ScanModeHint(
            awaitingBin: _awaitingBinScan,
            binActive: _binActive,
            isDark: isDark,
            mutedColor: mutedColor,
          ),

          // ── Fixed top: bin info ─────────────────────────────────────────
          _BinInfoBlock(
            binCode: _currentBin,
            isActive: _binActive,
            isDark: isDark,
            bgLow: bgLow,
            bg: bg,
            mainColor: mainColor,
            mutedColor: mutedColor,
          ),

          // ── Fixed header: STORED ITEMS ──────────────────────────────────
          _StoredItemsHeader(
            total: _storedTotal,
            itemCount: _storedContents.length,
            mainColor: mainColor,
            mutedColor: mutedColor,
          ),

          // ── Scrollable items list ───────────────────────────────────────
          Expanded(
            child: _storedContents.isEmpty
                ? _EmptyItemsPlaceholder(bgLow: bgLow, mutedColor: mutedColor)
                : ListView.builder(
                    padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                    itemCount: _storedContents.length,
                    itemBuilder: (context, i) {
                      final item = _storedContents[i];
                      return Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: Dismissible(
                          key: ValueKey('${item.sku}_$i'),
                          direction: DismissDirection.startToEnd,
                          confirmDismiss: (_) async {
                            await _onDeleteItem(item);
                            return false; // we handle removal ourselves
                          },
                          background: Container(
                            alignment: Alignment.centerLeft,
                            padding: const EdgeInsets.only(left: 20),
                            decoration: BoxDecoration(
                              color: Colors.red.shade600,
                              borderRadius: BorderRadius.circular(6),
                            ),
                            child: const Icon(Icons.delete_outline, color: Colors.white, size: 26),
                          ),
                          child: _StoredItemRow(
                            item: item,
                            bgLow: bgLow,
                            mainColor: mainColor,
                            onTap: () {
                              Navigator.push(context, MaterialPageRoute(
                                builder: (_) => EpcDetailScreen(
                                  sku: item.sku,
                                  description: item.description,
                                  binCode: _currentBin,
                                  customSkuId: item.customSkuId,
                                  initialEpcs: item.epcs,
                                ),
                              ));
                            },
                          ),
                        ),
                      );
                    },
                  ),
          ),

          // ── Fixed bottom controls ───────────────────────────────────────
          _BottomControlsBlock(
            isDark: isDark,
            bg: bg,
            bgMid: bgMid,
            mainColor: mainColor,
            mutedColor: mutedColor,
            tealDark: tealDark,
            tealLight: tealLight,
            binActive: _binActive,
            onCleanBin: _onCleanBin,
            onUndoClean: _onUndoClean,
            onAddBin: () => _tapAddBin(),
            onAddBinCamera: () => _tapAddBin(camera: true),
            onAddItem: () => _tapAddItem(),
            onAddItemCamera: () => _tapAddItem(camera: true),
            onNextEntry: _resetForNextEntry,
          ),

          // ── Bottom navigation ───────────────────────────────────────────
          _BottomNavBar(isDark: isDark, bgLow: bgLow),
        ],
      ),
    );
  }

  // ── AppBar ────────────────────────────────────────────────────────────────

  PreferredSizeWidget _buildAppBar({
    required bool isDark,
    required Color mainColor,
  }) {
    final wmsTeal = isDark ? const Color(0xFF4DB6AC) : AppColors.primary;
    final barBg = isDark ? const Color(0xFF111A1A) : _surface;
    return AppBar(
      backgroundColor: barBg,
      elevation: 0,
      surfaceTintColor: Colors.transparent,
      automaticallyImplyLeading: false,
      titleSpacing: 12,
      title: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          GestureDetector(
            onTap: () {
              Navigator.of(context).popUntil((r) => r.isFirst);
              DashboardScreen.scaffoldKey.currentState?.openDrawer();
            },
            child: ClipOval(
              child: Image.asset(
                'assets/carbon_logo.png',
                width: 36,
                height: 36,
                fit: BoxFit.cover,
              ),
            ),
          ),
          const SizedBox(width: 8),
          Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                'Carbon',
                style: GoogleFonts.manrope(
                  fontSize: 18,
                  fontWeight: FontWeight.w800,
                  letterSpacing: -0.3,
                  color: mainColor,
                ),
              ),
              WmsText(color: wmsTeal, fontSize: 18),
            ],
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 7),
            child: Text('/',
              style: TextStyle(fontSize: 15, fontWeight: FontWeight.w400, color: mainColor)),
          ),
          Expanded(
            child: Text(
              'BIN ASSIGN',
              style: GoogleFonts.manrope(
                fontSize: 16,
                fontWeight: FontWeight.w700,
                letterSpacing: 0.6,
                color: wmsTeal,
              ),
            ),
          ),
          // Gear icon → settings
          IconButton(
            icon: Icon(Icons.settings_outlined, color: mainColor, size: 22),
            onPressed: () async {
              await Navigator.push(context, MaterialPageRoute(
                builder: (_) => const BinAssignSettingsScreen(),
              ));
              _loadSettings();
            },
          ),
        ],
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCAN MODE HINT — shows what scanner is waiting for
// ═══════════════════════════════════════════════════════════════════════════════

class _ScanModeHint extends StatelessWidget {
  const _ScanModeHint({
    required this.awaitingBin,
    required this.binActive,
    required this.isDark,
    required this.mutedColor,
  });

  final bool  awaitingBin;
  final bool  binActive;
  final bool  isDark;
  final Color mutedColor;

  @override
  Widget build(BuildContext context) {
    final label = awaitingBin ? 'SCAN BIN' : 'SCAN ITEM';
    final color = awaitingBin
        ? (isDark ? const Color(0xFF4DB6AC) : AppColors.primary)
        : mutedColor;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 6, 16, 0),
      child: Row(
        children: [
          Container(
            width: 8, height: 8,
            decoration: BoxDecoration(color: color, shape: BoxShape.circle),
          ),
          const SizedBox(width: 8),
          Text(
            label,
            style: GoogleFonts.spaceGrotesk(
              fontSize: 11,
              fontWeight: FontWeight.w700,
              letterSpacing: 2.0,
              color: color,
            ),
          ),
        ],
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// BIN INFO BLOCK — fixed at top
// ═══════════════════════════════════════════════════════════════════════════════

class _BinInfoBlock extends StatelessWidget {
  const _BinInfoBlock({
    required this.binCode,
    required this.isActive,
    required this.isDark,
    required this.bgLow,
    required this.bg,
    required this.mainColor,
    required this.mutedColor,
  });

  final String binCode;
  final bool   isActive;
  final bool   isDark;
  final Color  bgLow;
  final Color  bg;
  final Color  mainColor;
  final Color  mutedColor;

  String get _locationLine {
    final p = binCode.split(RegExp(r'[-_]'));
    if (p.length < 4) return binCode.isNotEmpty ? binCode : 'AISLE | ZONE | SHELF | SIDE';
    return 'AISLE ${p[0]} | ZONE ${p[1]} | SHELF ${p[2]} | SIDE ${p[3]}';
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
      child: Center(
        child: IntrinsicWidth(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(
                    'CURRENT BIN LOCATION',
                    style: GoogleFonts.spaceGrotesk(
                      fontSize: 11,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 2.0,
                      color: mutedColor,
                    ),
                  ),
                  _StatusBadge(active: isActive),
                ],
              ),
              const SizedBox(height: 6),
              Container(
                padding: const EdgeInsets.fromLTRB(20, 12, 20, 14),
                decoration: BoxDecoration(
                  color: bgLow,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.center,
                  children: [
                    if (isActive)
                      Text(
                        binCode,
                        textAlign: TextAlign.center,
                        style: GoogleFonts.spaceGrotesk(
                          fontSize: 42,
                          fontWeight: FontWeight.w800,
                          color: AppColors.primary,
                          letterSpacing: 1.2,
                        ),
                      )
                    else
                      Container(
                        width: double.infinity,
                        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 18),
                        decoration: BoxDecoration(
                          color: bg,
                          borderRadius: BorderRadius.circular(40),
                          border: Border.all(color: AppColors.primary, width: 2),
                        ),
                        child: Text(
                          '',
                          textAlign: TextAlign.center,
                          style: GoogleFonts.spaceGrotesk(
                            fontSize: 28,
                            fontWeight: FontWeight.w700,
                            color: AppColors.primary,
                          ),
                        ),
                      ),
                    const SizedBox(height: 4),
                    Text(
                      _locationLine,
                      textAlign: TextAlign.center,
                      style: GoogleFonts.spaceGrotesk(
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                        color: mutedColor,
                        letterSpacing: 0.5,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _StatusBadge extends StatelessWidget {
  const _StatusBadge({required this.active});
  final bool active;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
      decoration: BoxDecoration(
        color: active ? AppColors.primary : AppColors.textMuted,
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(
        active ? 'ACTIVE' : 'INACTIVE',
        style: GoogleFonts.manrope(
          fontSize: 11,
          fontWeight: FontWeight.w800,
          letterSpacing: 1.0,
          color: Colors.white,
        ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STORED ITEMS HEADER — fixed
// ═══════════════════════════════════════════════════════════════════════════════

class _StoredItemsHeader extends StatelessWidget {
  const _StoredItemsHeader({
    required this.total,
    required this.itemCount,
    required this.mainColor,
    required this.mutedColor,
  });

  final int   total;
  final int   itemCount;
  final Color mainColor;
  final Color mutedColor;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(
            'STORED ITEMS',
            style: GoogleFonts.manrope(
              fontSize: 18,
              fontWeight: FontWeight.w800,
              letterSpacing: 0.2,
              color: mainColor,
            ),
          ),
          Text(
            '$itemCount ITEMS TOTAL',
            style: GoogleFonts.spaceGrotesk(
              fontSize: 15,
              fontWeight: FontWeight.w600,
              color: mutedColor,
              letterSpacing: 0.5,
            ),
          ),
        ],
      ),
    );
  }
}

class _EmptyItemsPlaceholder extends StatelessWidget {
  const _EmptyItemsPlaceholder({required this.bgLow, required this.mutedColor});
  final Color bgLow;
  final Color mutedColor;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(vertical: 28),
        decoration: BoxDecoration(
          color: bgLow,
          borderRadius: BorderRadius.circular(8),
        ),
        child: Text(
          'SCAN BIN TO BEGIN',
          textAlign: TextAlign.center,
          style: GoogleFonts.spaceGrotesk(
            fontSize: 12,
            fontWeight: FontWeight.w700,
            letterSpacing: 1.4,
            color: mutedColor,
          ),
        ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STORED ITEM ROW — swipeable
// ═══════════════════════════════════════════════════════════════════════════════

class _StoredItemRow extends StatelessWidget {
  const _StoredItemRow({
    required this.item,
    required this.bgLow,
    required this.mainColor,
    required this.onTap,
  });

  final _StoredItem item;
  final Color  bgLow;
  final Color  mainColor;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        decoration: BoxDecoration(
          color: bgLow,
          borderRadius: BorderRadius.circular(6),
        ),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'SKU:  ${item.sku}',
                    style: GoogleFonts.spaceGrotesk(
                      fontSize: 16,
                      fontWeight: FontWeight.w700,
                      color: mainColor,
                    ),
                  ),
                  if (item.description.isNotEmpty) ...[
                    const SizedBox(height: 3),
                    Text(
                      item.description,
                      style: GoogleFonts.manrope(
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                        color: const Color(0xFF171D1D),
                      ),
                    ),
                  ],
                ],
              ),
            ),
            const Icon(Icons.chevron_right, color: AppColors.textMuted, size: 18),
            const SizedBox(width: 4),
            Text(
              'x${item.qty}',
              style: GoogleFonts.manrope(
                fontSize: 24,
                fontWeight: FontWeight.w800,
                color: AppColors.primary,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ASSIGN POPUP — color scope selection
// ═══════════════════════════════════════════════════════════════════════════════

class _AssignPopup extends StatefulWidget {
  const _AssignPopup({
    required this.sku,
    required this.title,
    required this.colorCode,
    required this.colorLabel,
    required this.matrixId,
    required this.sheetBg,
    required this.btnMid,
    required this.textMain,
    required this.onAssignSingleColor,
    required this.onAssignAllColors,
    required this.onAssignSelectedColors,
    required this.api,
  });

  final String sku;
  final String title;
  final String colorCode;
  final String colorLabel;
  final String matrixId;
  final Color sheetBg;
  final Color btnMid;
  final Color textMain;
  final VoidCallback onAssignSingleColor;
  final VoidCallback onAssignAllColors;
  final void Function(List<String>) onAssignSelectedColors;
  final WmsApiClient api;

  @override
  State<_AssignPopup> createState() => _AssignPopupState();
}

class _AssignPopupState extends State<_AssignPopup> {
  bool _loadingColors = false;
  List<Map<String, dynamic>> _colorRows = [];
  final Set<String> _checkedSkus = {};
  bool _showColorPicker = false;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 24, 20, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('ASSIGN TO BIN',
              style: GoogleFonts.spaceGrotesk(
                fontSize: 11, fontWeight: FontWeight.w700,
                letterSpacing: 2.0, color: AppColors.textMuted)),
            const SizedBox(height: 6),
            Text(widget.sku,
              style: GoogleFonts.spaceGrotesk(
                fontSize: 20, fontWeight: FontWeight.w700, color: widget.textMain)),
            if (widget.title.isNotEmpty) ...[
              const SizedBox(height: 2),
              Text(widget.title,
                style: GoogleFonts.manrope(
                  fontSize: 13, color: AppColors.textMuted)),
            ],
            const SizedBox(height: 20),

            // ASSIGN ONLY THIS COLOR
            FilledButton(
              onPressed: widget.onAssignSingleColor,
              style: FilledButton.styleFrom(
                backgroundColor: AppColors.primary,
                padding: const EdgeInsets.symmetric(vertical: 18),
                shape: const RoundedRectangleBorder(borderRadius: BorderRadius.all(Radius.circular(4))),
              ),
              child: Text('ONLY ${widget.colorLabel}',
                style: GoogleFonts.manrope(fontWeight: FontWeight.w800, fontSize: 14)),
            ),
            const SizedBox(height: 10),

            // ASSIGN ALL COLORS
            FilledButton(
              onPressed: widget.onAssignAllColors,
              style: FilledButton.styleFrom(
                backgroundColor: widget.btnMid,
                foregroundColor: widget.textMain,
                padding: const EdgeInsets.symmetric(vertical: 18),
                shape: const RoundedRectangleBorder(borderRadius: BorderRadius.all(Radius.circular(4))),
              ),
              child: Text('ASSIGN ALL COLORS',
                style: GoogleFonts.manrope(fontWeight: FontWeight.w700, fontSize: 14,
                  color: widget.textMain)),
            ),
            const SizedBox(height: 10),

            // PICK SPECIFIC COLORS
            OutlinedButton(
              onPressed: _loadingColors ? null : _toggleColorPicker,
              style: OutlinedButton.styleFrom(
                padding: const EdgeInsets.symmetric(vertical: 14),
                shape: const RoundedRectangleBorder(borderRadius: BorderRadius.all(Radius.circular(4))),
                side: BorderSide(color: AppColors.primary.withValues(alpha: 0.5)),
              ),
              child: _loadingColors
                  ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2))
                  : Text('PICK COLORS…',
                      style: GoogleFonts.manrope(fontWeight: FontWeight.w700, fontSize: 13,
                        color: AppColors.primary)),
            ),

            // Color checkboxes (expanded when opened)
            if (_showColorPicker && _colorRows.isNotEmpty) ...[
              const SizedBox(height: 12),
              ..._colorRows.map((row) {
                final sku = row['sku']?.toString() ?? row['customSku']?.toString() ?? '';
                final label = row['description']?.toString() ?? row['title']?.toString() ?? sku;
                final checked = _checkedSkus.contains(sku);
                return CheckboxListTile(
                  dense: true,
                  value: checked,
                  onChanged: (v) => setState(() {
                    if (v == true) { _checkedSkus.add(sku); } else { _checkedSkus.remove(sku); }
                  }),
                  title: Text(label, style: GoogleFonts.manrope(fontSize: 13, color: widget.textMain)),
                  subtitle: Text(sku, style: GoogleFonts.spaceGrotesk(fontSize: 11, color: AppColors.textMuted)),
                  activeColor: AppColors.primary, // ignore: deprecated_member_use
                  contentPadding: EdgeInsets.zero,
                );
              }),
              if (_checkedSkus.isNotEmpty)
                FilledButton(
                  onPressed: () => widget.onAssignSelectedColors(_checkedSkus.toList()),
                  style: FilledButton.styleFrom(
                    backgroundColor: AppColors.primary,
                    padding: const EdgeInsets.symmetric(vertical: 14),
                    shape: const RoundedRectangleBorder(borderRadius: BorderRadius.all(Radius.circular(4))),
                  ),
                  child: Text('ASSIGN ${_checkedSkus.length} SELECTED',
                    style: GoogleFonts.manrope(fontWeight: FontWeight.w800, fontSize: 14)),
                ),
            ],
          ],
        ),
      ),
    );
  }

  Future<void> _toggleColorPicker() async {
    if (_showColorPicker) {
      setState(() => _showColorPicker = false);
      return;
    }
    if (_colorRows.isNotEmpty) {
      setState(() => _showColorPicker = true);
      return;
    }
    setState(() => _loadingColors = true);
    try {
      final rows = await widget.api.fetchCatalogByMatrixId(widget.matrixId);
      setState(() {
        _colorRows = rows;
        _loadingColors = false;
        _showColorPicker = rows.isNotEmpty;
      });
    } catch (_) {
      setState(() => _loadingColors = false);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// BOTTOM CONTROLS — fixed: Clean & Empty + Add Bin / Add Item
// ═══════════════════════════════════════════════════════════════════════════════

class _BottomControlsBlock extends StatelessWidget {
  const _BottomControlsBlock({
    required this.isDark,
    required this.bg,
    required this.bgMid,
    required this.mainColor,
    required this.mutedColor,
    required this.tealDark,
    required this.tealLight,
    required this.binActive,
    required this.onCleanBin,
    required this.onUndoClean,
    required this.onAddBin,
    required this.onAddBinCamera,
    required this.onAddItem,
    required this.onAddItemCamera,
    required this.onNextEntry,
  });

  final bool  isDark;
  final Color bg;
  final Color bgMid;
  final Color mainColor;
  final Color mutedColor;
  final Color tealDark;
  final Color tealLight;
  final bool  binActive;
  final VoidCallback onCleanBin;
  final VoidCallback onUndoClean;
  final VoidCallback onAddBin;
  final VoidCallback onAddBinCamera;
  final VoidCallback onAddItem;
  final VoidCallback onAddItemCamera;
  final VoidCallback onNextEntry;

  @override
  Widget build(BuildContext context) {
    return Container(
      color: bg,
      padding: const EdgeInsets.fromLTRB(16, 6, 16, 0),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          // ── CLEAN & EMPTY BIN ─────────────────────────────────────────
          Container(
            decoration: BoxDecoration(
              color: bgMid,
              borderRadius: BorderRadius.circular(6),
            ),
            child: Row(
              children: [
                _IconTapZone(
                  onTap: onCleanBin,
                  child: const Icon(Icons.cleaning_services_outlined,
                    color: AppColors.textMuted, size: 22),
                ),
                Expanded(
                  child: InkWell(
                    onTap: onCleanBin,
                    child: Padding(
                      padding: const EdgeInsets.symmetric(vertical: 14),
                      child: Text(
                        'CLEAN & EMPTY BIN',
                        textAlign: TextAlign.center,
                        style: GoogleFonts.manrope(
                          fontSize: 14,
                          fontWeight: FontWeight.w800,
                          letterSpacing: 1.0,
                          color: mainColor,
                        ),
                      ),
                    ),
                  ),
                ),
                _IconTapZone(
                  onTap: onUndoClean,
                  child: const Icon(Icons.undo_rounded,
                    color: AppColors.textMuted, size: 22),
                ),
              ],
            ),
          ),
          const SizedBox(height: 8),
          // ── READY FOR NEXT ENTRY ──────────────────────────────────────
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(
                  'READY FOR NEXT ENTRY',
                  style: GoogleFonts.spaceGrotesk(
                    fontSize: 11,
                    fontWeight: FontWeight.w700,
                    letterSpacing: 2.0,
                    color: mutedColor,
                  ),
                ),
                if (binActive)
                  GestureDetector(
                    onTap: onNextEntry,
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                      decoration: BoxDecoration(
                        color: AppColors.primary.withValues(alpha: 0.12),
                        borderRadius: BorderRadius.circular(4),
                      ),
                      child: Text(
                        'RESET',
                        style: GoogleFonts.manrope(
                          fontSize: 11,
                          fontWeight: FontWeight.w800,
                          letterSpacing: 1.0,
                          color: AppColors.primary,
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ),
          // ── ADD BIN + ADD ITEM ────────────────────────────────────────
          Row(
            children: [
              Expanded(
                child: _DualActionButton(
                  label: 'ADD BIN',
                  mainIcon: Icons.warehouse_outlined,
                  color: tealDark,
                  enabled: true,
                  onMain: onAddBin,
                  onCamera: onAddBinCamera,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: _DualActionButton(
                  label: 'ADD ITEM',
                  mainIcon: Icons.add_circle_outline,
                  color: binActive ? tealLight : AppColors.textMuted.withValues(alpha: 0.4),
                  enabled: binActive,
                  onMain: onAddItem,
                  onCamera: onAddItemCamera,
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
        ],
      ),
    );
  }
}

class _DualActionButton extends StatelessWidget {
  const _DualActionButton({
    required this.label,
    required this.mainIcon,
    required this.color,
    required this.enabled,
    required this.onMain,
    required this.onCamera,
  });

  final String       label;
  final IconData     mainIcon;
  final Color        color;
  final bool         enabled;
  final VoidCallback onMain;
  final VoidCallback onCamera;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(6),
      ),
      child: Row(
        children: [
          Expanded(
            child: InkWell(
              onTap: enabled ? onMain : null,
              borderRadius: const BorderRadius.horizontal(left: Radius.circular(6)),
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 16),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(mainIcon, color: Colors.white, size: 20),
                    const SizedBox(width: 8),
                    Text(
                      label,
                      style: GoogleFonts.manrope(
                        fontSize: 14,
                        fontWeight: FontWeight.w800,
                        color: Colors.white,
                        letterSpacing: 0.5,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
          Container(width: 1, height: 36, color: Colors.white24),
          _IconTapZone(
            onTap: enabled ? onCamera : () {},
            child: const Icon(Icons.photo_camera_outlined, color: Colors.white, size: 20),
          ),
        ],
      ),
    );
  }
}

class _IconTapZone extends StatelessWidget {
  const _IconTapZone({required this.onTap, required this.child});
  final VoidCallback onTap;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
        child: child,
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// BOTTOM NAV BAR
// ═══════════════════════════════════════════════════════════════════════════════

class _BottomNavBar extends StatelessWidget {
  const _BottomNavBar({required this.isDark, required this.bgLow});
  final bool  isDark;
  final Color bgLow;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: bgLow,
        border: Border(
          top: BorderSide(
            color: isDark ? Colors.white12 : Colors.black.withValues(alpha: 0.06),
            width: 1,
          ),
        ),
      ),
      child: SafeArea(
        top: false,
        child: SizedBox(
          height: 60,
          child: Row(
            children: [
              _NavItem(icon: Icons.dashboard_outlined,               label: 'DASH',  active: false, onTap: () => Navigator.of(context).maybePop()),
              _NavItem(icon: Icons.inventory_2_outlined,             label: 'STOCK', active: false, onTap: () {}),
              _NavItem(icon: Icons.precision_manufacturing_outlined, label: 'OPS',   active: false, onTap: () {}),
              _NavItem(icon: Icons.qr_code_scanner,                  label: 'TAGS',  active: true,  onTap: () {}),
            ],
          ),
        ),
      ),
    );
  }
}

class _NavItem extends StatelessWidget {
  const _NavItem({
    required this.icon,
    required this.label,
    required this.active,
    required this.onTap,
  });

  final IconData icon;
  final String   label;
  final bool     active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final color = active ? AppColors.primary : AppColors.textMuted;
    return Expanded(
      child: InkWell(
        onTap: onTap,
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(icon, color: color, size: 22),
            const SizedBox(height: 3),
            Text(
              label,
              style: GoogleFonts.manrope(
                fontSize: 10,
                fontWeight: active ? FontWeight.w800 : FontWeight.w600,
                color: color,
                letterSpacing: 0.5,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
