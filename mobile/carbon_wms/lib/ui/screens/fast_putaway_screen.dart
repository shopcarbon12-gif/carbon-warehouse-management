import 'dart:async';

import 'package:flutter/foundation.dart' show defaultTargetPlatform, kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart'
    show DeviceOrientation, EventChannel, SystemChrome, SystemUiOverlayStyle;
import 'package:google_fonts/google_fonts.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:carbon_wms/hardware/rfid_vendor_channel.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/handheld_device_identity.dart';
import 'package:carbon_wms/services/mobile_settings_repository.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/widgets/camera_barcode_scanner.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart' show WmsText;
import 'package:carbon_wms/ui/screens/bin_assign_settings_screen.dart';
import 'package:carbon_wms/ui/screens/epc_detail_screen.dart';
import 'package:carbon_wms/ui/screens/handheld_settings_screen.dart';
import 'package:carbon_wms/ui/screens/inventory_lookup_screen.dart';
import 'package:carbon_wms/ui/screens/transfer_slips_screen.dart';
import 'package:carbon_wms/ui/screens/encode_suite_screens.dart';
import 'package:carbon_wms/ui/widgets/carbon_app_drawer.dart';

// ── Palette ───────────────────────────────────────────────────────────────────
const Color _surface = Color(0xFFFFFFFF);
const Color _surfaceLow = Color(0xFFF3F3F4);
const Color _surfaceMid = Color(0xFFEEEEEE);

// Two teal variants used in action buttons
const Color _tealDark =
    Color(0xFF1B7D7D); // ADD BIN (matches AppColors.primary light)
const Color _tealLight = Color(0xFF2BA3A3); // ADD ITEM (lighter teal)

// Dark-mode equivalents
const Color _tealDarkDk = Color(0xFF1B7D7D);
const Color _tealLightDk = Color(0xFF4DB6AC);

// ── SKU Parsing ───────────────────────────────────────────────────────────────

class _SkuParts {
  final String raw,
      base,
      colorCode,
      sizeCode,
      searchKeySpecific,
      searchKeyAllColors;
  const _SkuParts({
    required this.raw,
    required this.base,
    required this.colorCode,
    required this.sizeCode,
    required this.searchKeySpecific,
    required this.searchKeyAllColors,
  });

  static _SkuParts parse(String sku) {
    final s = sku.trim().toUpperCase();
    if (s.startsWith('C') && s.length >= 9) {
      final base = s.substring(0, 9);
      final color = s.length >= 11 ? s.substring(9, 11) : '';
      final size = s.length > 11 ? s.substring(11) : '';
      return _SkuParts(
        raw: s,
        base: base,
        colorCode: color,
        sizeCode: size,
        searchKeySpecific: s.length >= 11 ? s.substring(0, 11) : s,
        searchKeyAllColors: base,
      );
    } else if (s.length >= 7) {
      final base = s.substring(0, 7);
      final color = s.length >= 9 ? s.substring(7, 9) : '';
      final size = s.length > 9 ? s.substring(9) : '';
      return _SkuParts(
        raw: s,
        base: base,
        colorCode: color,
        sizeCode: size,
        searchKeySpecific: s.length >= 9 ? s.substring(0, 9) : s,
        searchKeyAllColors: base,
      );
    }
    return _SkuParts(
      raw: s,
      base: s,
      colorCode: '',
      sizeCode: '',
      searchKeySpecific: s,
      searchKeyAllColors: s,
    );
  }
}

// ── Stored Item model ─────────────────────────────────────────────────────────

class _StoredItem {
  const _StoredItem({
    required this.sku,
    required this.description,
    required this.qty,
    required this.epcs,
  });

  final String sku;
  final String description;
  final int qty;
  final List<String> epcs;

  static _StoredItem fromMap(Map<String, dynamic> m) {
    final rawEpcs = m['epcs'];
    final epcs = rawEpcs is List
        ? rawEpcs.map((e) => e.toString()).toList()
        : <String>[];
    return _StoredItem(
      sku: m['sku']?.toString() ?? '',
      description: m['description']?.toString() ?? '',
      qty: m['qty'] as int? ?? m['quantity'] as int? ?? epcs.length,
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
  final _scaffoldKey = GlobalKey<ScaffoldState>();
  final _scanFocus = FocusNode();
  final _hiddenCtrl = TextEditingController();
  StreamSubscription<dynamic>? _hardwareBarcodeSub;

  String _pendingSku = '';
  String _currentBin = '';
  String _currentBinId = '';
  bool _binActive = false;
  bool _busy = false;
  bool _flashOk = false;
  bool _awaitingBinScan = true;

  String _scannerSource = 'hardware';
  bool _manualMode = false;
  bool _manualBin = false;
  bool _manualAddItem = false;
  bool _externalScanner = false;
  bool _cameraEnabled = true;

  String _scopeForBin = 'all_colors';
  String _skuForBin = '';
  String? _userEmail;

  List<_StoredItem> _storedContents = [];
  List<_StoredItem> _undoSnapshot = [];
  bool _showUndo = false;
  DateTime _ignoreScansUntil = DateTime.fromMillisecondsSinceEpoch(0);

  int get _storedTotal => _storedContents.fold(0, (sum, e) => sum + e.qty);
  bool get _shouldUseHardwareScanner =>
      _scannerSource == 'hardware' || _externalScanner;

  void _resetForNextEntry() {
    setState(() {
      _currentBin = '';
      _currentBinId = '';
      _binActive = false;
      _storedContents = [];
      _awaitingBinScan = true;
    });
    _scanFocus.requestFocus();
  }

  Future<void> _load() async {
    final p = await SharedPreferences.getInstance();
    if (!mounted) return;
    setState(() {
      _scannerSource = p.getString('wms_scanner_source_v1') ?? 'hardware';
      _manualMode = p.getBool('bin_assign_manual_mode') ?? false;
      _manualBin = p.getBool('bin_assign_manual_bin') ?? false;
      _manualAddItem = p.getBool('bin_assign_manual_add_item') ?? false;
      _externalScanner = p.getBool('bin_assign_external_scanner') ?? false;
      _cameraEnabled = p.getBool('bin_assign_camera_enabled') ?? true;
    });
    _syncHardwareBarcodeStream();
    if (_shouldUseHardwareScanner) {
      unawaited(RfidVendorChannel.scannerEnableTriggerRelay());
    }
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _load();
      _loadUserEmail();
      _resetForNextEntry();
    });
  }

  @override
  void dispose() {
    _hardwareBarcodeSub?.cancel();
    unawaited(RfidVendorChannel.scannerDisableTriggerRelay());
    unawaited(_stopHardware2dScan());
    _hardwareBarcodeSub = null;
    _hiddenCtrl.dispose();
    _scanFocus.dispose();
    super.dispose();
  }

  /// Hardware wedge + OEM scan broadcasts (see [CarbonHardwareBarcodeRelay] on Android).
  void _dispatchScanLine(String raw) {
    final v = raw.trim();
    if (v.isEmpty || !mounted || _busy) return;
    if (DateTime.now().isBefore(_ignoreScansUntil)) return;
    final normalized = v.toUpperCase().replaceAll(RegExp(r'[^A-Z0-9]'), '');
    final blockedNoise = <String>{
      'START',
      'STOP',
      'TIMEOUT',
      'TRIGGER',
      'KEYDOWN',
      'KEYUP',
      'SCANNING',
      'SCAN',
      'NULL',
      'NUL',
    };
    if (blockedNoise.contains(normalized)) return;
    if (_awaitingBinScan && normalized.length < 5) return;
    unawaited(_stopHardware2dScan());
    if (_awaitingBinScan) {
      unawaited(_handleBinScan(v));
    } else {
      unawaited(_onItemSubmit(v));
    }
  }

  Future<void> _stopHardware2dScan() async {
    if (!_shouldUseHardwareScanner) return;
    await RfidVendorChannel.scannerStop2d();
  }

  void _syncHardwareBarcodeStream() {
    _hardwareBarcodeSub?.cancel();
    _hardwareBarcodeSub = null;
    if (kIsWeb || defaultTargetPlatform != TargetPlatform.android) return;
    final useHw = _shouldUseHardwareScanner;
    if (!useHw) {
      unawaited(RfidVendorChannel.scannerDisableTriggerRelay());
      return;
    }
    unawaited(RfidVendorChannel.scannerEnableTriggerRelay());
    _hardwareBarcodeSub = const EventChannel('carbon_wms/hardware_barcode')
        .receiveBroadcastStream()
        .listen(
      (dynamic e) {
        if (!mounted || _busy) return;
        _dispatchScanLine(e?.toString() ?? '');
      },
      onError: (_) {},
    );
  }

  Future<void> _loadUserEmail() async {
    final api = context.read<WmsApiClient>();
    final email = await api.getSavedLoginEmail();
    if (mounted) setState(() => _userEmail = email);
  }

  void _toggleDrawer() {
    final state = _scaffoldKey.currentState;
    if (state != null && state.isDrawerOpen) {
      Navigator.of(context).pop();
    } else {
      state?.openDrawer();
    }
  }

  Widget _buildDrawer() {
    return CarbonAppDrawer(
      userEmail: _userEmail,
      onSettings: () {
        Navigator.pop(context);
        Navigator.push(
          context,
          MaterialPageRoute<void>(
            builder: (_) => const HandheldSettingsScreen(),
          ),
        );
      },
      onRefresh: () async {
        Navigator.pop(context);
        final messenger = ScaffoldMessenger.of(context);
        messenger.showSnackBar(
          const SnackBar(
            content: Text('Syncing settings...'),
            duration: Duration(seconds: 1),
          ),
        );
        final api = context.read<WmsApiClient>();
        final repo = context.read<MobileSettingsRepository>();
        final id = await HandheldDeviceIdentity.primaryDeviceIdForServer();
        await repo.syncFromServer(api, deviceId: id);
        if (!mounted) return;
        messenger.showSnackBar(
          const SnackBar(
            content: Text('Settings refreshed.'),
            duration: Duration(seconds: 2),
          ),
        );
      },
    );
  }

  // ── Camera with orientation unlock ───────────────────────────────────────

  Future<String?> _scanWithCamera(String title) async {
    await SystemChrome.setPreferredOrientations([
      DeviceOrientation.portraitUp,
      DeviceOrientation.landscapeLeft,
      DeviceOrientation.landscapeRight,
    ]);
    try {
      if (!mounted) return null;
      return await openCameraBarcodeScanner(context, title: title);
    } finally {
      await SystemChrome.setPreferredOrientations(
          [DeviceOrientation.portraitUp]);
    }
  }

  Future<String?> _maybeCameraScan(String title) async {
    if (_scannerSource != 'camera') return null;
    if (!mounted) return null;
    return _scanWithCamera(title);
  }

  // ── Bin Formatting ────────────────────────────────────────────────────────

  String _formatBinCode(String raw) {
    final s = raw.trim().toUpperCase().replaceAll(RegExp(r'[-\s]'), '');
    if (s.length == 5) {
      // e.g. '2B03L' → '2-B-03-L'
      return '${s[0]}-${s[1]}-${s.substring(2, 4)}-${s[4]}';
    }
    return raw.trim().toUpperCase();
  }

  String _normalizeBinForCompare(String raw) =>
      raw.trim().toUpperCase().replaceAll(RegExp(r'[^A-Z0-9]'), '');

  // ── Bin Scan Handler ──────────────────────────────────────────────────────

  Future<void> _handleBinScan(String raw) async {
    final code = _formatBinCode(raw);
    final normalized = _normalizeBinForCompare(code);
    if (normalized.length < 3) {
      // Ignore accidental short trigger noise.
      _hiddenCtrl.clear();
      return;
    }
    _hiddenCtrl.clear();
    setState(() => _busy = true);
    try {
      final api = context.read<WmsApiClient>();
      final bins = await api.fetchBins();
      final want = _normalizeBinForCompare(code);
      final match = bins.cast<Map<String, dynamic>?>().firstWhere(
            (b) =>
                b != null &&
                _normalizeBinForCompare(b['code']?.toString() ?? '') == want,
            orElse: () => null,
          );
      if (!mounted) return;
      if (match != null) {
        await _confirmBin(match['id']?.toString() ?? '', code);
      } else {
        _showCreateBinDialog(code);
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Bin lookup failed: $e')));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _confirmBin(String binId, String code) async {
    final api = context.read<WmsApiClient>();
    final contents = await api.fetchBinContents(binId);
    final List<_StoredItem> items = contents
        .whereType<Map>()
        .map<_StoredItem>(
            (e) => _StoredItem.fromMap(Map<String, dynamic>.from(e)))
        .toList();
    if (!mounted) return;
    setState(() {
      _currentBin = _formatBinCode(code);
      _currentBinId = binId;
      _binActive = true;
      _awaitingBinScan = false;
      _storedContents = items;
    });
    _scanFocus.requestFocus();
  }

  void _showCreateBinDialog(String code) {
    final ctrl = TextEditingController(text: code);
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        shape: const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
        title: const Text('Bin not found'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('This bin does not exist. Would you like to add it?'),
            const SizedBox(height: 12),
            TextField(
              controller: ctrl,
              decoration: const InputDecoration(labelText: 'Bin code'),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () {
              Navigator.pop(ctx);
              if (mounted) _scanFocus.requestFocus();
            },
            child: const Text('CANCEL'),
          ),
          FilledButton(
            onPressed: () async {
              final newCode = ctrl.text.trim().toUpperCase();
              Navigator.pop(ctx);
              if (newCode.isEmpty) return;
              setState(() => _busy = true);
              try {
                final api = context.read<WmsApiClient>();
                final result = await api.createBin(newCode);
                if (!mounted) return;
                final binId = result['id']?.toString() ?? '';
                setState(() {
                  _currentBin = newCode;
                  _currentBinId = binId;
                  _binActive = true;
                  _awaitingBinScan = false;
                  _storedContents = [];
                });
              } catch (e) {
                if (mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                      SnackBar(content: Text('Create bin failed: $e')));
                }
              } finally {
                if (mounted) {
                  setState(() => _busy = false);
                  _scanFocus.requestFocus();
                }
              }
            },
            style: FilledButton.styleFrom(
              shape:
                  const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
            ),
            child: const Text('CREATE'),
          ),
        ],
      ),
    );
  }

  // ── Assignment helpers ────────────────────────────────────────────────────

  Future<void> _doAssign(
      {required String skuScanned, required String scope}) async {
    final api = context.read<WmsApiClient>();
    final deviceId = await HandheldDeviceIdentity.primaryDeviceIdForServer();
    await api.postPutawayAssign(
      deviceId: deviceId,
      binCode: _currentBin,
      skuScanned: skuScanned,
      scope: scope,
    );
  }

  Future<void> _refreshContents() async {
    if (_currentBinId.isEmpty) return;
    final api = context.read<WmsApiClient>();
    final contents = await api.fetchBinContents(_currentBinId);
    final items = contents
        .whereType<Map>()
        .map<_StoredItem>(
            (e) => _StoredItem.fromMap(Map<String, dynamic>.from(e)))
        .toList();
    if (mounted) setState(() => _storedContents = items);
  }

  // ── Clean / Undo / Auto-Empty / Swipe-Delete ─────────────────────────────

  Future<void> _onCleanBin() async {
    if (!_binActive || _currentBin.isEmpty) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        shape: const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
        title: const Text('Clean & Empty Bin?'),
        content: Text('Remove all items from bin $_currentBin?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('CANCEL'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              shape:
                  const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
            ),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('CLEAN'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() => _busy = true);
    try {
      final snapshot = List<_StoredItem>.from(_storedContents);
      await context.read<WmsApiClient>().postCleanBinByCode(_currentBin);
      if (!mounted) return;
      setState(() {
        _undoSnapshot = snapshot;
        _storedContents = [];
        _showUndo = true;
        _busy = false;
      });
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          duration: const Duration(seconds: 8),
          content: const Text('Bin cleaned.'),
          action: SnackBarAction(
            label: 'UNDO',
            onPressed: () => unawaited(_onUndoClean()),
          ),
        ),
      );
    } catch (e) {
      if (mounted) {
        setState(() => _busy = false);
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Clean failed: $e')));
      }
    }
  }

  Future<void> _onDeleteBin() async {
    if (!_binActive || _currentBinId.isEmpty) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        shape: const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
        title: const Text('Delete Bin?'),
        content: Text(
          'This will permanently delete bin $_currentBin and all its contents from the system.\n\nThis action can be undone with the undo button.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('CANCEL'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: const Color(0xFFEF4444),
              shape:
                  const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
            ),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('DELETE BIN'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() => _busy = true);
    try {
      final snapshot = List<_StoredItem>.from(_storedContents);
      final deletedBin = _currentBin;
      final deletedBinId = _currentBinId;
      await context.read<WmsApiClient>().deleteBin(_currentBinId);
      if (!mounted) return;
      setState(() {
        _undoSnapshot = snapshot;
        _showUndo = true;
        _busy = false;
      });
      _resetForNextEntry();
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          duration: const Duration(seconds: 8),
          content: Text('Bin $deletedBin deleted.'),
          action: SnackBarAction(
            label: 'UNDO',
            onPressed: () =>
                unawaited(_onUndoDeleteBin(deletedBin, deletedBinId, snapshot)),
          ),
        ),
      );
    } catch (e) {
      if (mounted) {
        setState(() => _busy = false);
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Delete failed: $e')));
      }
    }
  }

  Future<void> _onUndoDeleteBin(
      String binCode, String binId, List<_StoredItem> snapshot) async {
    setState(() => _busy = true);
    try {
      final api = context.read<WmsApiClient>();
      // Re-create the bin
      await api.createBin(binCode);
      // Re-assign all items
      final deviceId = await HandheldDeviceIdentity.primaryDeviceIdForServer();
      for (final item in snapshot) {
        await api.postPutawayAssign(
          deviceId: deviceId,
          binCode: binCode,
          skuScanned: item.sku,
          scope: 'single_color',
        );
      }
      if (!mounted) return;
      // Re-confirm the bin
      await _handleBinScan(binCode);
      setState(() => _busy = false);
    } catch (e) {
      if (mounted) {
        setState(() => _busy = false);
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Undo failed: $e')));
      }
    }
  }

  Future<void> _onUndoClean() async {
    if (_undoSnapshot.isEmpty || _currentBin.isEmpty) return;
    setState(() => _busy = true);
    try {
      final api = context.read<WmsApiClient>();
      final deviceId = await HandheldDeviceIdentity.primaryDeviceIdForServer();
      for (final item in _undoSnapshot) {
        await api.postPutawayAssign(
          deviceId: deviceId,
          binCode: _currentBin,
          skuScanned: item.sku,
          scope: 'single_color',
        );
      }
      await _refreshContents();
      if (mounted)
        setState(() {
          _showUndo = false;
          _undoSnapshot = [];
        });
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Undo failed: $e')));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _checkAutoEmptyRule(List<_StoredItem> items) {
    if (items.isNotEmpty && items.every((item) => item.qty == 0)) {
      unawaited(() async {
        try {
          await context.read<WmsApiClient>().postCleanBinByCode(_currentBin);
          if (mounted) _resetForNextEntry();
        } catch (_) {}
      }());
    }
  }

  Future<void> _onSwipeDeleteItem(_StoredItem item) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        shape: const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
        title: const Text('Remove item?'),
        content: Text('Remove ${item.sku} from bin $_currentBin?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('CANCEL'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: Colors.red,
              shape:
                  const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
            ),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('REMOVE'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() => _busy = true);
    try {
      await context
          .read<WmsApiClient>()
          .removeSkuFromBin(_currentBin, item.sku);
      await _refreshContents();
      if (mounted) _checkAutoEmptyRule(_storedContents);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Remove failed: $e')));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  // ── Assign Dialog — Popup 1 ───────────────────────────────────────────────

  void _showAssignDialog({
    required String itemName,
    required _SkuParts skuParts,
    required String matrixId,
  }) {
    bool addAnother = false;
    showDialog<void>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setSt) => AlertDialog(
          shape: const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
          title: const Text('Assign to bin?'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text('Would you like to assign $itemName to this bin?'),
              CheckboxListTile(
                value: addAnother,
                onChanged: (v) => setSt(() => addAnother = v ?? false),
                title: const Text('Add another item?'),
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx),
              child: const Text('NO'),
            ),
            FilledButton(
              style: FilledButton.styleFrom(
                shape: const RoundedRectangleBorder(
                    borderRadius: BorderRadius.zero),
              ),
              onPressed: () async {
                Navigator.pop(ctx);
                setState(() => _busy = true);
                try {
                  await _doAssign(
                      skuScanned: skuParts.searchKeySpecific,
                      scope: 'single_color');
                  await _refreshContents();
                } catch (e) {
                  if (mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(
                        SnackBar(content: Text('Assign failed: $e')));
                  }
                } finally {
                  if (mounted) setState(() => _busy = false);
                }
                if (mounted && addAnother)
                  _showNextProductDialog(skuParts, matrixId);
                if (mounted) _scanFocus.requestFocus();
              },
              child: const Text('YES'),
            ),
          ],
        ),
      ),
    );
  }

  // ── Next Product Dialog — Popup 2 ─────────────────────────────────────────

  void _showNextProductDialog(_SkuParts skuParts, String matrixId) {
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        shape: const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
        title: const Text('Next item'),
        content: const Text('Same product different color, or new product?'),
        actions: [
          TextButton(
            onPressed: () {
              Navigator.pop(ctx);
              if (mounted) _scanFocus.requestFocus();
            },
            child: const Text('NEW PRODUCT'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              shape:
                  const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
            ),
            onPressed: () {
              Navigator.pop(ctx);
              _showSameProductColorsDialog(skuParts, matrixId);
            },
            child: const Text('SAME PRODUCT'),
          ),
        ],
      ),
    );
  }

  // ── Same Product Color Picker — fetches matrix rows ───────────────────────

  void _showSameProductColorsDialog(_SkuParts skuParts, String matrixId) {
    // checked set and available rows are shared across FutureBuilder + actions
    final checked = <int>{};
    List<Map<String, dynamic>> availableRows = [];

    showDialog<void>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setSt) => AlertDialog(
          shape: const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
          title: const Text('Select colors to assign'),
          content: SizedBox(
            width: double.maxFinite,
            child: FutureBuilder<List<dynamic>>(
              future:
                  context.read<WmsApiClient>().fetchCatalogMatrixRows(matrixId),
              builder: (ctx2, snap) {
                if (snap.connectionState != ConnectionState.done) {
                  return const Padding(
                    padding: EdgeInsets.all(24),
                    child: Center(child: CircularProgressIndicator()),
                  );
                }
                final rows = snap.data ?? [];
                final assignedKeys =
                    _storedContents.map((e) => e.sku.toUpperCase()).toSet();
                availableRows = rows
                    .whereType<Map>()
                    .map<Map<String, dynamic>>(
                        (e) => Map<String, dynamic>.from(e))
                    .where((r) {
                  final sku = r['custom_sku']?.toString().toUpperCase() ??
                      r['sku']?.toString().toUpperCase() ??
                      '';
                  final parts = _SkuParts.parse(sku);
                  return !assignedKeys
                      .contains(parts.searchKeySpecific.toUpperCase());
                }).toList();

                if (availableRows.isEmpty) {
                  return const Text(
                      'All colors are already assigned to this bin.');
                }

                return SingleChildScrollView(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: availableRows.asMap().entries.map((entry) {
                      final i = entry.key;
                      final row = entry.value;
                      final sku = row['custom_sku']?.toString() ??
                          row['sku']?.toString() ??
                          '';
                      final parts = _SkuParts.parse(sku);
                      final label = '${parts.colorCode}'
                          '${parts.sizeCode.isNotEmpty ? " · ${parts.sizeCode}" : ""}';
                      return CheckboxListTile(
                        dense: true,
                        value: checked.contains(i),
                        onChanged: (v) => setSt(() {
                          if (v == true) {
                            checked.add(i);
                          } else {
                            checked.remove(i);
                          }
                        }),
                        title: Text(
                          label.isNotEmpty ? label : sku,
                          style: const TextStyle(fontSize: 13),
                        ),
                        subtitle:
                            Text(sku, style: const TextStyle(fontSize: 11)),
                      );
                    }).toList(),
                  ),
                );
              },
            ),
          ),
          actions: [
            TextButton(
              onPressed: () {
                Navigator.pop(ctx);
                if (mounted) _scanFocus.requestFocus();
              },
              child: const Text('CANCEL'),
            ),
            FilledButton(
              style: FilledButton.styleFrom(
                shape: const RoundedRectangleBorder(
                    borderRadius: BorderRadius.zero),
              ),
              onPressed: () async {
                Navigator.pop(ctx);
                setState(() => _busy = true);
                try {
                  final selectedRows = checked
                      .where((i) => i < availableRows.length)
                      .map((i) => availableRows[i])
                      .toList();
                  for (final row in selectedRows) {
                    final sku = row['custom_sku']?.toString() ??
                        row['sku']?.toString() ??
                        '';
                    if (sku.isEmpty) continue;
                    final parts = _SkuParts.parse(sku);
                    await _doAssign(
                      skuScanned: parts.searchKeySpecific,
                      scope: 'single_color',
                    );
                  }
                  await _refreshContents();
                } catch (e) {
                  if (mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(
                        SnackBar(content: Text('Color assign failed: $e')));
                  }
                } finally {
                  if (mounted) {
                    setState(() => _busy = false);
                    _showNextProductDialog(skuParts, matrixId);
                  }
                }
              },
              child: const Text('ASSIGN'),
            ),
          ],
        ),
      ),
    );
  }

  // ── Scan handlers ─────────────────────────────────────────────────────────

  Future<void> _onItemSubmit(String raw) async {
    if (!_binActive) return; // guard: bin must be active
    final sku = raw.trim();
    if (sku.isEmpty) return;
    _hiddenCtrl.clear();
    setState(() => _busy = true);
    try {
      final skuParts = _SkuParts.parse(sku);
      final api = context.read<WmsApiClient>();
      final row =
          await api.catalogGridSearchFirstRow(skuParts.searchKeySpecific);
      if (!mounted) return;
      final itemName = row?['title']?.toString() ??
          row?['description']?.toString() ??
          skuParts.raw;
      final matrixId =
          row?['matrix_id']?.toString() ?? row?['matrixId']?.toString() ?? '';
      setState(() {
        _pendingSku = sku;
        _busy = false;
      });
      _showAssignDialog(
          itemName: itemName, skuParts: skuParts, matrixId: matrixId);
    } catch (e) {
      if (mounted) {
        setState(() => _busy = false);
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Item lookup failed: $e')));
      }
    }
  }

  Future<void> _onBinSubmit(String raw) async {
    final bin = raw.trim().toUpperCase();
    if (bin.isEmpty || _skuForBin.isEmpty) return;
    _hiddenCtrl.clear();
    setState(() => _busy = true);
    try {
      final api = context.read<WmsApiClient>();
      final deviceId = await HandheldDeviceIdentity.primaryDeviceIdForServer();
      final result = await api.postPutawayAssign(
        deviceId: deviceId,
        binCode: bin,
        skuScanned: _skuForBin,
        scope: _scopeForBin,
      );
      if (!mounted) return;
      final contents = result['storedContents'];
      final List<_StoredItem> items = contents is List
          ? contents
              .whereType<Map>()
              .map<_StoredItem>(
                  (e) => _StoredItem.fromMap(Map<String, dynamic>.from(e)))
              .toList()
          : <_StoredItem>[];

      setState(() {
        _busy = false;
        _flashOk = true;
        _currentBin = bin;
        _binActive = true;
        _awaitingBinScan = false;
        _storedContents = items;
        _pendingSku = '';
        _skuForBin = '';
      });
      await Future<void>.delayed(const Duration(milliseconds: 450));
      if (mounted) setState(() => _flashOk = false);
    } catch (e) {
      if (mounted) {
        setState(() => _busy = false);
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Putaway failed: $e')));
      }
    }
    if (mounted) _scanFocus.requestFocus();
  }

  void _addNewBin() {
    setState(() {
      _awaitingBinScan = true;
      _pendingSku = '';
    });
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final code = await _maybeCameraScan('SCAN BIN LOCATION');
      if (code != null && code.isNotEmpty && mounted) {
        await _handleBinScan(code);
      } else {
        _scanFocus.requestFocus();
      }
    });
  }

  void _addNewItem() {
    setState(() {
      _awaitingBinScan = false;
      _pendingSku = '';
    });
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final code = await _maybeCameraScan('SCAN ITEM');
      if (code != null && code.isNotEmpty && mounted) {
        await _onItemSubmit(code);
      } else {
        _scanFocus.requestFocus();
      }
    });
  }

  Future<void> _openSettings() async {
    await Navigator.push(
      context,
      MaterialPageRoute<void>(
        builder: (_) => const BinAssignSettingsScreen(),
      ),
    );
    if (mounted) {
      await _load();
      _hiddenCtrl.clear();
      _ignoreScansUntil =
          DateTime.now().add(const Duration(milliseconds: 1800));
      FocusScope.of(context).unfocus();
      _scanFocus.requestFocus();
    }
  }

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final bg = isDark ? const Color(0xFF111A1A) : _surface;
    final bgLow = isDark ? const Color(0xFF1C2828) : _surfaceLow;
    final bgMid = isDark ? const Color(0xFF243030) : _surfaceMid;
    final mainColor = isDark ? const Color(0xFFE0ECEC) : AppColors.textMain;
    final mutedColor = isDark ? const Color(0xFF7A9090) : AppColors.textMuted;
    final tealDark = isDark ? _tealDarkDk : _tealDark;
    final tealLight = isDark ? _tealLightDk : _tealLight;
    SystemChrome.setSystemUIOverlayStyle(
      const SystemUiOverlayStyle(
        statusBarColor: Colors.transparent,
        statusBarIconBrightness: Brightness.light,
        statusBarBrightness: Brightness.dark,
        systemNavigationBarColor: Color(0xFF2A2F2F),
        systemNavigationBarIconBrightness: Brightness.light,
        systemNavigationBarDividerColor: Color(0xFF2A2F2F),
        systemNavigationBarContrastEnforced: false,
      ),
    );

    return Scaffold(
      key: _scaffoldKey,
      drawerEnableOpenDragGesture: false,
      drawer: _buildDrawer(),
      backgroundColor: bg,
      resizeToAvoidBottomInset: false,
      appBar: _buildAppBar(
          isDark: isDark, mainColor: mainColor, mutedColor: mutedColor),
      body: GestureDetector(
        onTap: () {
          FocusScope.of(context).unfocus();
          if (_scannerSource == 'hardware' || _externalScanner) {
            WidgetsBinding.instance.addPostFrameCallback((_) {
              if (mounted) _scanFocus.requestFocus();
            });
          }
        },
        behavior: HitTestBehavior.translucent,
        child: Column(
          children: [
            // ── Hidden hardware-wedge receiver ──────────────────────────────
            Offstage(
              offstage: true,
              child: TextField(
                controller: _hiddenCtrl,
                focusNode: _scanFocus,
                autofocus: false,
                showCursor: false,
                enableIMEPersonalizedLearning: false,
                keyboardType: TextInputType.none,
                textInputAction: TextInputAction.done,
                onChanged: (v) {
                  if (!v.contains('\n') && !v.contains('\r')) return;
                  final line = v
                      .replaceAll('\r', '')
                      .split(RegExp(r'[\r\n]+'))
                      .first
                      .trim();
                  _hiddenCtrl.clear();
                  if (line.isNotEmpty) _dispatchScanLine(line);
                },
                onSubmitted: (v) {
                  final line = v
                      .replaceAll('\r', '')
                      .split(RegExp(r'[\r\n]+'))
                      .first
                      .trim();
                  _hiddenCtrl.clear();
                  if (line.isNotEmpty) _dispatchScanLine(line);
                },
              ),
            ),

            // ── Busy overlay ────────────────────────────────────────────────
            if (_busy) const LinearProgressIndicator(minHeight: 2),

            // ── Flash overlay ───────────────────────────────────────────────
            if (_flashOk)
              const LinearProgressIndicator(
                value: 1,
                backgroundColor: Color(0xFFD1FAE5),
                color: Color(0xFF34D399),
                minHeight: 3,
              ),

            // ── Fixed top: bin info ─────────────────────────────────────────
            _BinInfoBlock(
              binCode: _currentBin,
              pendingSku: _pendingSku,
              isActive: _binActive,
              isDark: isDark,
              bgLow: bgLow,
              bg: bg,
              mainColor: mainColor,
              mutedColor: mutedColor,
              manualBin: _manualBin,
              onManualBinSubmit: (code) => unawaited(_handleBinScan(code)),
              onBinDirectSelect: (id, code) => unawaited(_confirmBin(id, code)),
            ),

            // ── Fixed header: STORED ITEMS ──────────────────────────────────
            _StoredItemsHeader(
              total: _storedTotal,
              itemCount: _storedContents.length,
              mainColor: mainColor,
              mutedColor: mutedColor,
            ),

            // ── Items list or empty placeholder ─────────────────────────────
            if (_storedContents.where((e) => e.qty > 0).isEmpty) ...[
              _EmptyItemsPlaceholder(
                bgLow: bgLow,
                mutedColor: mutedColor,
                isManualMode: _manualAddItem,
                onManualInput: _manualAddItem
                    ? (sku) => unawaited(_onItemSubmit(sku))
                    : null,
              ),
              const Spacer(),
            ] else
              Expanded(
                child: ListView.builder(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                  itemCount: _storedContents.where((e) => e.qty > 0).length,
                  itemBuilder: (context, i) {
                    final visible =
                        _storedContents.where((e) => e.qty > 0).toList();
                    final item = visible[i];
                    return Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: Dismissible(
                        key: ValueKey(item.sku),
                        direction: DismissDirection.startToEnd,
                        confirmDismiss: (_) async {
                          await _onSwipeDeleteItem(item);
                          return false; // list is rebuilt via _refreshContents
                        },
                        background: Container(
                          color: Colors.red,
                          alignment: Alignment.centerLeft,
                          padding: const EdgeInsets.only(left: 20),
                          child: const Icon(Icons.delete_outline,
                              color: Colors.white, size: 26),
                        ),
                        child: GestureDetector(
                          onTap: () => Navigator.push(
                            context,
                            MaterialPageRoute<void>(
                              builder: (_) => EpcDetailScreen(
                                sku: item.sku,
                                description: item.description,
                                epcs: item.epcs,
                              ),
                            ),
                          ),
                          child: _StoredItemRow(
                            sku: item.sku,
                            description: item.description,
                            quantity: item.qty,
                            bgLow: bgLow,
                            mainColor: mainColor,
                          ),
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
              cameraEnabled: _cameraEnabled,
              onCleanBin: () => unawaited(_onCleanBin()),
              onDeleteBin: () => unawaited(_onDeleteBin()),
              onUndoClean: () => unawaited(_onUndoClean()),
              onAddBin: _addNewBin,
              onAddBinCamera: () async {
                final code = await _scanWithCamera('SCAN BIN LOCATION');
                if (code != null && code.isNotEmpty && mounted)
                  unawaited(_handleBinScan(code));
              },
              onAddItem: _addNewItem,
              onAddItemCamera: () async {
                final code = await _scanWithCamera('SCAN ITEM');
                if (code != null && code.isNotEmpty && mounted)
                  unawaited(_onItemSubmit(code));
              },
            ),

            // ── Bottom navigation ───────────────────────────────────────────
            _BottomNavBar(isDark: isDark, bgLow: bgLow),
          ],
        ),
      ),
    );
  }

  // ── AppBar ────────────────────────────────────────────────────────────────

  PreferredSizeWidget _buildAppBar({
    required bool isDark,
    required Color mainColor,
    required Color mutedColor,
  }) {
    final wmsTeal = isDark ? const Color(0xFF4DB6AC) : AppColors.primary;
    final barBg = isDark ? const Color(0xFF111A1A) : _surface;
    return AppBar(
      backgroundColor: barBg,
      elevation: 0,
      surfaceTintColor: Colors.transparent,
      automaticallyImplyLeading: false,
      titleSpacing: 12,
      actions: [
        IconButton(
          icon: Icon(Icons.settings_outlined, color: Colors.black, size: 28),
          onPressed: _openSettings,
        ),
      ],
      title: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          GestureDetector(
            onTap: _toggleDrawer,
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
                style: const TextStyle(
                    fontSize: 22,
                    fontWeight: FontWeight.w700,
                    color: Colors.black)),
          ),
          Text(
            'BIN ASSIGN',
            style: GoogleFonts.manrope(
              fontSize: 16,
              fontWeight: FontWeight.w700,
              letterSpacing: 0.6,
              color: wmsTeal,
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

class _BinInfoBlock extends StatefulWidget {
  const _BinInfoBlock({
    required this.binCode,
    required this.pendingSku,
    required this.isActive,
    required this.isDark,
    required this.bgLow,
    required this.bg,
    required this.mainColor,
    required this.mutedColor,
    this.manualBin = false,
    this.onManualBinSubmit,
    this.onBinDirectSelect,
  });

  final String binCode;
  final String pendingSku;
  final bool isActive;
  final bool isDark;
  final Color bgLow;
  final Color bg;
  final Color mainColor;
  final Color mutedColor;
  final bool manualBin;
  final ValueChanged<String>? onManualBinSubmit;
  final void Function(String id, String code)? onBinDirectSelect;

  @override
  State<_BinInfoBlock> createState() => _BinInfoBlockState();
}

class _BinInfoBlockState extends State<_BinInfoBlock> {
  final _binCtrl = TextEditingController();
  final _focusNode = FocusNode();
  List<Map<String, dynamic>> _allBins = [];
  List<Map<String, dynamic>> _filteredBins = [];
  bool _showDropdown = false;
  bool _binsLoaded = false;

  @override
  void initState() {
    super.initState();
    _binCtrl.addListener(_onTextChanged);
    _focusNode.addListener(_onFocusChanged);
  }

  @override
  void dispose() {
    _binCtrl.removeListener(_onTextChanged);
    _focusNode.removeListener(_onFocusChanged);
    _binCtrl.dispose();
    _focusNode.dispose();
    super.dispose();
  }

  void _onFocusChanged() {
    if (_focusNode.hasFocus && !_binsLoaded) {
      _loadBins();
    }
    if (!_focusNode.hasFocus) {
      setState(() => _showDropdown = false);
    }
  }

  Future<void> _loadBins() async {
    try {
      final api = context.read<WmsApiClient>();
      final bins = await api.fetchBins();
      if (mounted) {
        setState(() {
          _allBins = bins.cast<Map<String, dynamic>>();
          _binsLoaded = true;
          _filterBins();
        });
      }
    } catch (_) {}
  }

  void _onTextChanged() {
    _filterBins();
  }

  void _filterBins() {
    final query = _binCtrl.text.trim().toUpperCase();
    if (query.isEmpty) {
      setState(() {
        _filteredBins = _allBins.take(8).toList();
        _showDropdown = _focusNode.hasFocus;
      });
    } else {
      final matches = _allBins
          .where((b) {
            final code = (b['code']?.toString() ?? '').toUpperCase();
            return code.contains(query);
          })
          .take(8)
          .toList();
      setState(() {
        _filteredBins = matches;
        _showDropdown = _focusNode.hasFocus;
      });
    }
  }

  void _selectBin(Map<String, dynamic> bin) {
    final code = bin['code']?.toString() ?? '';
    final id = bin['id']?.toString() ?? '';
    _focusNode.unfocus();
    setState(() => _showDropdown = false);
    _binCtrl.clear();
    widget.onBinDirectSelect?.call(id, code);
  }

  String get _locationLine {
    final p = widget.binCode.split(RegExp(r'[-_]'));
    if (p.length < 4)
      return widget.binCode.isNotEmpty
          ? widget.binCode
          : 'AISLE | ZONE | SHELF | SIDE';
    return 'AISLE ${p[0]} | ZONE ${p[1]} | SHELF ${p[2]} | SIDE ${p[3]}';
  }

  void _onVerify() {
    final code = _binCtrl.text.trim();
    if (code.isEmpty) return;
    _focusNode.unfocus();
    setState(() => _showDropdown = false);
    widget.onManualBinSubmit?.call(code);
    _binCtrl.clear();
  }

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: () => _focusNode.unfocus(),
      behavior: HitTestBehavior.translucent,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Label and badge OUTSIDE the box
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(
                  'CURRENT BIN LOCATION',
                  style: GoogleFonts.spaceGrotesk(
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                    letterSpacing: 2.0,
                    color: widget.mutedColor,
                  ),
                ),
                _StatusBadge(active: widget.isActive),
              ],
            ),
          ),
          // Box with bin code and location
          Column(
            children: [
              Container(
                margin: const EdgeInsets.fromLTRB(16, 0, 16, 0),
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.zero,
                  border: Border.all(color: AppColors.primary, width: 2),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (widget.isActive)
                      Center(
                        child: Padding(
                          padding: const EdgeInsets.fromLTRB(16, 14, 16, 0),
                          child: Text(
                            widget.binCode,
                            style: GoogleFonts.spaceGrotesk(
                              fontSize: 42,
                              fontWeight: FontWeight.w800,
                              color: AppColors.primary,
                              letterSpacing: 1.2,
                            ),
                          ),
                        ),
                      )
                    else if (widget.manualBin)
                      Theme(
                        data: Theme.of(context).copyWith(
                          inputDecorationTheme:
                              const InputDecorationTheme(filled: false),
                        ),
                        child: TextField(
                          controller: _binCtrl,
                          focusNode: _focusNode,
                          style: GoogleFonts.spaceGrotesk(
                            fontSize: 28,
                            fontWeight: FontWeight.w700,
                            color: AppColors.primary,
                          ),
                          decoration: InputDecoration(
                            hintText: 'Enter bin code...',
                            hintStyle: TextStyle(
                                color: Colors.grey.shade400, fontSize: 16),
                            contentPadding: const EdgeInsets.symmetric(
                                horizontal: 14, vertical: 18),
                            border: InputBorder.none,
                          ),
                          textCapitalization: TextCapitalization.characters,
                          onSubmitted: (_) => _onVerify(),
                        ),
                      )
                    else
                      // Empty placeholder — same height as text input
                      const SizedBox(
                        width: double.infinity,
                        height: 60,
                      ),
                    const SizedBox(height: 4),
                    Center(
                      child: Padding(
                        padding: const EdgeInsets.only(bottom: 10),
                        child: Text(
                          _locationLine,
                          style: GoogleFonts.spaceGrotesk(
                            fontSize: 14,
                            fontWeight: FontWeight.w600,
                            color: widget.mutedColor,
                            letterSpacing: 0.5,
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              // Dropdown search results
              if (widget.manualBin && _showDropdown)
                Container(
                  margin: const EdgeInsets.fromLTRB(16, 0, 16, 0),
                  constraints: const BoxConstraints(maxHeight: 240),
                  decoration: BoxDecoration(
                    color: Colors.white,
                    border: Border.all(
                        color: AppColors.primary.withValues(alpha: 0.3)),
                    boxShadow: [
                      BoxShadow(
                        color: Colors.black.withValues(alpha: 0.1),
                        blurRadius: 8,
                        offset: const Offset(0, 4),
                      ),
                    ],
                  ),
                  child: ListView.separated(
                    shrinkWrap: true,
                    padding: EdgeInsets.zero,
                    itemCount: _filteredBins.length + 1,
                    separatorBuilder: (_, __) =>
                        Divider(height: 1, color: Colors.grey.shade200),
                    itemBuilder: (_, i) {
                      // First item is always "Add new bin"
                      if (i == 0) {
                        final typed = _binCtrl.text.trim();
                        return InkWell(
                          onTap: () {
                            if (typed.isNotEmpty) {
                              _focusNode.unfocus();
                              setState(() => _showDropdown = false);
                              widget.onManualBinSubmit?.call(typed);
                              _binCtrl.clear();
                            }
                          },
                          child: Padding(
                            padding: const EdgeInsets.symmetric(
                                horizontal: 14, vertical: 12),
                            child: Row(
                              children: [
                                Icon(Icons.add_circle_outline,
                                    size: 18, color: AppColors.primary),
                                const SizedBox(width: 10),
                                Text(
                                  typed.isEmpty
                                      ? 'Add new bin'
                                      : 'Add new bin "$typed"',
                                  style: GoogleFonts.spaceGrotesk(
                                    fontSize: 15,
                                    fontWeight: FontWeight.w700,
                                    color: AppColors.primary,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        );
                      }
                      final bin = _filteredBins[i - 1];
                      final code = bin['code']?.toString() ?? '';
                      final query = _binCtrl.text.trim().toUpperCase();
                      return InkWell(
                        onTap: () => _selectBin(bin),
                        child: Padding(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 14, vertical: 12),
                          child: Row(
                            children: [
                              Icon(Icons.inventory_2_outlined,
                                  size: 18, color: AppColors.primary),
                              const SizedBox(width: 10),
                              Expanded(
                                child: _HighlightText(
                                  text: code,
                                  query: query,
                                  style: GoogleFonts.spaceGrotesk(
                                    fontSize: 15,
                                    fontWeight: FontWeight.w600,
                                    color: AppColors.textMain,
                                  ),
                                  highlightStyle: GoogleFonts.spaceGrotesk(
                                    fontSize: 15,
                                    fontWeight: FontWeight.w800,
                                    color: AppColors.primary,
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ),
                      );
                    },
                  ),
                ),
            ],
          ),
        ],
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
        borderRadius: BorderRadius.zero,
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

class _HighlightText extends StatelessWidget {
  const _HighlightText({
    required this.text,
    required this.query,
    required this.style,
    required this.highlightStyle,
  });
  final String text;
  final String query;
  final TextStyle style;
  final TextStyle highlightStyle;

  @override
  Widget build(BuildContext context) {
    if (query.isEmpty) return Text(text, style: style);
    final upper = text.toUpperCase();
    final idx = upper.indexOf(query);
    if (idx < 0) return Text(text, style: style);
    return Text.rich(TextSpan(children: [
      if (idx > 0) TextSpan(text: text.substring(0, idx), style: style),
      TextSpan(
          text: text.substring(idx, idx + query.length), style: highlightStyle),
      if (idx + query.length < text.length)
        TextSpan(text: text.substring(idx + query.length), style: style),
    ]));
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

  final int total;
  final int itemCount;
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
              fontSize: 15,
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

class _EmptyItemsPlaceholder extends StatefulWidget {
  const _EmptyItemsPlaceholder({
    required this.bgLow,
    required this.mutedColor,
    this.isManualMode = false,
    this.onManualInput,
  });
  final Color bgLow;
  final Color mutedColor;
  final bool isManualMode;
  final Function(String)? onManualInput;

  @override
  State<_EmptyItemsPlaceholder> createState() => _EmptyItemsPlaceholderState();
}

class _EmptyItemsPlaceholderState extends State<_EmptyItemsPlaceholder> {
  late TextEditingController _controller;
  final _focusNode = FocusNode();
  Timer? _debounce;
  List<Map<String, dynamic>> _results = [];
  bool _showDropdown = false;
  bool _searching = false;

  @override
  void initState() {
    super.initState();
    _controller = TextEditingController();
    _controller.addListener(_onTextChanged);
    _focusNode.addListener(_onFocusChanged);
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _controller.removeListener(_onTextChanged);
    _focusNode.removeListener(_onFocusChanged);
    _controller.dispose();
    _focusNode.dispose();
    super.dispose();
  }

  void _onFocusChanged() {
    if (!_focusNode.hasFocus) {
      // Delay to allow tap on dropdown item to register
      Future.delayed(const Duration(milliseconds: 200), () {
        if (mounted && !_focusNode.hasFocus) {
          setState(() => _showDropdown = false);
        }
      });
    }
  }

  void _onTextChanged() {
    _debounce?.cancel();
    final q = _controller.text.trim();
    if (q.length < 3) {
      setState(() {
        _results = [];
        _showDropdown = false;
      });
      return;
    }
    _debounce = Timer(const Duration(milliseconds: 350), () => _doSearch(q));
  }

  Future<void> _doSearch(String q) async {
    if (!mounted) return;
    setState(() => _searching = true);
    try {
      final api = context.read<WmsApiClient>();
      final rows = await api.catalogSearch(q, limit: 10);
      if (!mounted) return;
      setState(() {
        _results = rows;
        _showDropdown = true;
        _searching = false;
      });
    } catch (_) {
      if (mounted) setState(() => _searching = false);
    }
  }

  void _selectResult(Map<String, dynamic> row) {
    final sku = row['custom_sku']?.toString() ?? row['sku']?.toString() ?? '';
    if (sku.isEmpty) return;
    _focusNode.unfocus();
    setState(() {
      _showDropdown = false;
      _results = [];
    });
    _controller.clear();
    widget.onManualInput?.call(sku);
  }

  @override
  Widget build(BuildContext context) {
    const double itemRowHeight = 74;

    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: double.infinity,
            height: itemRowHeight,
            decoration: BoxDecoration(
              color: widget.bgLow,
              borderRadius: BorderRadius.zero,
            ),
            child: widget.isManualMode
                ? Center(
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 12),
                      child: TextField(
                        controller: _controller,
                        focusNode: _focusNode,
                        decoration: InputDecoration(
                          labelText: 'Search item',
                          hintText: 'Name, UPC, SKU, or Asset ID...',
                          border: const OutlineInputBorder(
                              borderRadius: BorderRadius.zero),
                          enabledBorder: const OutlineInputBorder(
                              borderRadius: BorderRadius.zero),
                          focusedBorder: OutlineInputBorder(
                              borderRadius: BorderRadius.zero,
                              borderSide: BorderSide(
                                  color: AppColors.primary, width: 2)),
                          contentPadding: const EdgeInsets.symmetric(
                              horizontal: 16, vertical: 10),
                          isDense: true,
                          suffixIcon: _searching
                              ? const Padding(
                                  padding: EdgeInsets.all(12),
                                  child: SizedBox(
                                      width: 16,
                                      height: 16,
                                      child: CircularProgressIndicator(
                                          strokeWidth: 2)),
                                )
                              : null,
                        ),
                        onSubmitted: (v) {
                          if (v.isNotEmpty) {
                            _focusNode.unfocus();
                            setState(() {
                              _showDropdown = false;
                              _results = [];
                            });
                            _controller.clear();
                            widget.onManualInput?.call(v);
                          }
                        },
                      ),
                    ),
                  )
                : Center(
                    child: Text(
                      'TRIGGER OR TAP TO ADD ITEM',
                      textAlign: TextAlign.center,
                      style: GoogleFonts.spaceGrotesk(
                        fontSize: 12,
                        fontWeight: FontWeight.w700,
                        letterSpacing: 1.4,
                        color: widget.mutedColor,
                      ),
                    ),
                  ),
          ),
          // Search results dropdown
          if (widget.isManualMode && _showDropdown && _results.isNotEmpty)
            Container(
              width: double.infinity,
              constraints: const BoxConstraints(maxHeight: 240),
              decoration: BoxDecoration(
                color: Colors.white,
                border:
                    Border.all(color: AppColors.primary.withValues(alpha: 0.3)),
                boxShadow: [
                  BoxShadow(
                    color: Colors.black.withValues(alpha: 0.1),
                    blurRadius: 8,
                    offset: const Offset(0, 4),
                  ),
                ],
              ),
              child: ListView.separated(
                shrinkWrap: true,
                padding: EdgeInsets.zero,
                itemCount: _results.length,
                separatorBuilder: (_, __) =>
                    Divider(height: 1, color: Colors.grey.shade200),
                itemBuilder: (_, i) {
                  final row = _results[i];
                  final sku = row['custom_sku']?.toString() ??
                      row['sku']?.toString() ??
                      '';
                  final name = row['title']?.toString() ??
                      row['description']?.toString() ??
                      '';
                  return InkWell(
                    onTap: () => _selectResult(row),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 14, vertical: 10),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            sku,
                            style: GoogleFonts.spaceGrotesk(
                              fontSize: 14,
                              fontWeight: FontWeight.w700,
                              color: AppColors.primary,
                            ),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                          if (name.isNotEmpty) ...[
                            const SizedBox(height: 2),
                            Text(
                              name,
                              style: GoogleFonts.manrope(
                                fontSize: 12,
                                color: AppColors.textMuted,
                              ),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ],
                        ],
                      ),
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

// ═══════════════════════════════════════════════════════════════════════════════
// STORED ITEM ROW
// ═══════════════════════════════════════════════════════════════════════════════

class _StoredItemRow extends StatelessWidget {
  const _StoredItemRow({
    required this.sku,
    required this.description,
    required this.quantity,
    required this.bgLow,
    required this.mainColor,
  });

  final String sku;
  final String description;
  final int quantity;
  final Color bgLow;
  final Color mainColor;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
      decoration: BoxDecoration(
        color: bgLow,
        borderRadius: BorderRadius.zero,
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'SKU:  $sku',
                  style: GoogleFonts.spaceGrotesk(
                    fontSize: 16,
                    fontWeight: FontWeight.w700,
                    color: mainColor,
                  ),
                ),
                if (description.isNotEmpty) ...[
                  const SizedBox(height: 4),
                  Text(
                    description,
                    style: GoogleFonts.manrope(
                      fontSize: 14,
                      color: AppColors.textMuted,
                    ),
                  ),
                ],
              ],
            ),
          ),
          Text(
            'x$quantity',
            style: GoogleFonts.manrope(
              fontSize: 24,
              fontWeight: FontWeight.w800,
              color: AppColors.primary,
            ),
          ),
        ],
      ),
    );
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
    required this.cameraEnabled,
    required this.onCleanBin,
    required this.onDeleteBin,
    required this.onUndoClean,
    required this.onAddBin,
    required this.onAddBinCamera,
    required this.onAddItem,
    required this.onAddItemCamera,
  });

  final bool isDark;
  final Color bg;
  final Color bgMid;
  final Color mainColor;
  final Color mutedColor;
  final Color tealDark;
  final Color tealLight;
  final bool binActive;
  final bool cameraEnabled;
  final VoidCallback onCleanBin;
  final VoidCallback onDeleteBin;
  final VoidCallback onUndoClean;
  final VoidCallback onAddBin;
  final VoidCallback onAddBinCamera;
  final VoidCallback onAddItem;
  final VoidCallback onAddItemCamera;

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
              borderRadius: BorderRadius.zero,
            ),
            child: Row(
              children: [
                // Broom icon — DELETE bin completely
                _IconTapZone(
                  onTap: onDeleteBin,
                  child: const Icon(
                    Icons.cleaning_services_outlined,
                    color: AppColors.textMuted,
                    size: 22,
                  ),
                ),
                // Center label — main clean action
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
                // Undo icon — right tap zone (different behaviour)
                _IconTapZone(
                  onTap: onUndoClean,
                  child: const Icon(
                    Icons.undo_rounded,
                    color: AppColors.textMuted,
                    size: 22,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 8),
          // ── Status label ──────────────────────────────────────────────
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Align(
              alignment: Alignment.centerLeft,
              child: binActive
                  ? Text(
                      'READY FOR NEXT ENTRY',
                      style: GoogleFonts.spaceGrotesk(
                        fontSize: 14,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 2.0,
                        color: mutedColor,
                      ),
                    )
                  : Text(
                      'TRIGGER TO ADD BIN',
                      style: GoogleFonts.spaceGrotesk(
                        fontSize: 14,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 2.0,
                        color: Colors.red,
                      ),
                    ),
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
                  onMain: onAddBin,
                  onCamera: onAddBinCamera,
                  showCamera: cameraEnabled,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: _DualActionButton(
                  label: 'ADD ITEM',
                  mainIcon: Icons.add_circle_outline,
                  color: tealLight,
                  onMain: binActive ? onAddItem : () {},
                  onCamera: binActive ? onAddItemCamera : () {},
                  showCamera: cameraEnabled,
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

/// A button with a main tap zone + an embedded camera icon tap zone on the right.
class _DualActionButton extends StatelessWidget {
  const _DualActionButton({
    required this.label,
    required this.mainIcon,
    required this.color,
    required this.onMain,
    required this.onCamera,
    this.showCamera = true,
  });

  final String label;
  final IconData mainIcon;
  final Color color;
  final VoidCallback onMain;
  final VoidCallback onCamera;
  final bool showCamera;

  @override
  Widget build(BuildContext context) {
    return Container(
      color: color,
      child: Row(
        children: [
          // Main label tap zone
          Expanded(
            child: InkWell(
              onTap: onMain,
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
          if (showCamera) ...[
            // Vertical divider
            Container(width: 1, height: 36, color: Colors.white24),
            // Camera tap zone
            _IconTapZone(
              onTap: onCamera,
              child: const Icon(
                Icons.photo_camera_outlined,
                color: Colors.white,
                size: 20,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// Small square tap zone for icons inside composite buttons.
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
  final bool isDark;
  final Color bgLow;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: bgLow,
        border: Border(
          top: BorderSide(
            color:
                isDark ? Colors.white12 : Colors.black.withValues(alpha: 0.06),
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
              _NavItem(
                  icon: Icons.dashboard_outlined,
                  label: 'DASH',
                  active: false,
                  onTap: () => Navigator.of(context).maybePop()),
              _NavItem(
                  icon: Icons.inventory_2_outlined,
                  label: 'STOCK',
                  active: false,
                  onTap: () {
                    Navigator.of(context).push(MaterialPageRoute<void>(
                        builder: (_) => const InventoryLookupScreen()));
                  }),
              _NavItem(
                  icon: Icons.precision_manufacturing_outlined,
                  label: 'OPS',
                  active: false,
                  onTap: () {
                    Navigator.of(context).push(MaterialPageRoute<void>(
                        builder: (_) => const TransferSlipsScreen()));
                  }),
              _NavItem(
                  icon: Icons.qr_code_scanner,
                  label: 'TAGS',
                  active: false,
                  onTap: () {
                    Navigator.of(context).push(MaterialPageRoute<void>(
                        builder: (_) =>
                            const EncodeSuiteScreen(initialTab: 0)));
                  }),
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
  final String label;
  final bool active;
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
