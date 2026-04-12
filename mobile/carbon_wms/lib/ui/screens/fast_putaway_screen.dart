import 'dart:async';

import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/handheld_device_identity.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/widgets/camera_barcode_scanner.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart' show WmsText;
import 'package:carbon_wms/ui/screens/dashboard_screen.dart' show DashboardScreen;

// ── Palette ───────────────────────────────────────────────────────────────────
const Color _surface    = Color(0xFFFFFFFF);
const Color _surfaceLow = Color(0xFFF3F3F4);
const Color _surfaceMid = Color(0xFFEEEEEE);

// Two teal variants used in action buttons
const Color _tealDark   = Color(0xFF1B7D7D); // ADD BIN (matches AppColors.primary light)
const Color _tealLight  = Color(0xFF2BA3A3); // ADD ITEM (lighter teal)

// Dark-mode equivalents
const Color _tealDarkDk  = Color(0xFF1B7D7D);
const Color _tealLightDk = Color(0xFF4DB6AC);

/// Sample data shown in design/preview mode before real data is wired.
const _kSampleBin = '2-B-03-L';
const _kSampleItems = <Map<String, dynamic>>[
  {'sku': '112225207S', 'description': 'TYLER SHIRT BLACK S', 'qty': 24},
  {'sku': '112225207M', 'description': 'TYLER SHIRT BLACK M', 'qty': 150},
  {'sku': '112225207L', 'description': 'TYLER SHIRT BLACK L', 'qty': 50},
  {'sku': '112225207M', 'description': 'TYLER SHIRT BLACK M', 'qty': 150},
  {'sku': '112225207L', 'description': 'TYLER SHIRT BLACK L', 'qty': 50},
  {'sku': '112225207XL','description': 'TYLER SHIRT BLACK XL','qty': 30},
  {'sku': '112225207XS','description': 'TYLER SHIRT BLACK XS','qty': 12},
];

/// Bin Assign — fast 2D putaway with hardware wedge, camera, or manual entry.
class FastPutawayScreen extends StatefulWidget {
  const FastPutawayScreen({super.key});

  @override
  State<FastPutawayScreen> createState() => _FastPutawayScreenState();
}

enum _PutawayPhase { scanItem, scanBin }

class _FastPutawayScreenState extends State<FastPutawayScreen> {
  _PutawayPhase _phase = _PutawayPhase.scanItem;
  final _scanFocus  = FocusNode();
  final _hiddenCtrl = TextEditingController();

  String _pendingSku  = ''; // used by color-scope modal
  String _currentBin  = _kSampleBin; // design preview: pre-filled
  bool   _busy        = false;
  bool   _flashOk     = false;

  String _scopeForBin = 'all_colors';
  String _skuForBin   = '';

  List<Map<String, dynamic>> _storedContents = List.of(_kSampleItems);
  int get _storedTotal => _storedContents.fold(0, (sum, e) => sum + ((e['qty'] as int?) ?? 0));

  bool get _binActive => _currentBin.isNotEmpty;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _scanFocus.requestFocus();
    });
  }

  @override
  void dispose() {
    _hiddenCtrl.dispose();
    _scanFocus.dispose();
    super.dispose();
  }

  Future<bool> _isCameraSource() async {
    final p = await SharedPreferences.getInstance();
    return (p.getString('wms_scanner_source_v1') ?? 'hardware') == 'camera';
  }

  Future<String?> _maybeCameraScan(String title) async {
    if (!await _isCameraSource()) return null;
    if (!mounted) return null;
    return openCameraBarcodeScanner(context, title: title);
  }

  String? _parseColorHint(String sku) {
    final parts = sku.split(RegExp(r'[-_/]'));
    if (parts.length < 2) return null;
    return parts.last.trim().toUpperCase();
  }

  // ── Scan handlers ─────────────────────────────────────────────────────────

  Future<void> _onItemSubmit(String raw) async {
    final sku = raw.trim();
    if (sku.isEmpty) return;
    _hiddenCtrl.clear();
    final hint = _parseColorHint(sku) ?? sku;
    if (!mounted) return;
    final isDark   = Theme.of(context).brightness == Brightness.dark;
    final sheetBg  = isDark ? const Color(0xFF1C2828) : _surface;
    final btnMid   = isDark ? const Color(0xFF243030) : _surfaceMid;
    final textMain = isDark ? const Color(0xFFE0ECEC) : AppColors.textMain;
    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: sheetBg,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(4)),
      ),
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 24, 20, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('COLOR SCOPE',
                style: GoogleFonts.spaceGrotesk(fontSize: 11, fontWeight: FontWeight.w700,
                  letterSpacing: 2.0, color: AppColors.textMuted)),
              const SizedBox(height: 6),
              Text(sku,
                style: GoogleFonts.spaceGrotesk(fontSize: 20, fontWeight: FontWeight.w700, color: textMain)),
              const SizedBox(height: 20),
              FilledButton(
                onPressed: () {
                  Navigator.pop(ctx);
                  _scopeForBin = 'all_colors';
                  _skuForBin   = sku;
                  setState(() { _pendingSku = sku; _phase = _PutawayPhase.scanBin; });
                  WidgetsBinding.instance.addPostFrameCallback((_) => _scanFocus.requestFocus());
                },
                style: FilledButton.styleFrom(
                  backgroundColor: AppColors.primary, foregroundColor: Colors.white,
                  padding: const EdgeInsets.symmetric(vertical: 18),
                  shape: const RoundedRectangleBorder(borderRadius: BorderRadius.all(Radius.circular(4))),
                ),
                child: Text('ASSIGN ALL COLORS',
                  style: GoogleFonts.manrope(fontWeight: FontWeight.w800, fontSize: 14)),
              ),
              const SizedBox(height: 10),
              FilledButton(
                onPressed: () {
                  Navigator.pop(ctx);
                  _scopeForBin = 'single_color';
                  _skuForBin   = sku;
                  setState(() { _pendingSku = sku; _phase = _PutawayPhase.scanBin; });
                  WidgetsBinding.instance.addPostFrameCallback((_) => _scanFocus.requestFocus());
                },
                style: FilledButton.styleFrom(
                  backgroundColor: btnMid, foregroundColor: textMain,
                  padding: const EdgeInsets.symmetric(vertical: 18),
                  shape: const RoundedRectangleBorder(borderRadius: BorderRadius.all(Radius.circular(4))),
                ),
                child: Text('ONLY THIS COLOR · $hint',
                  style: GoogleFonts.manrope(fontWeight: FontWeight.w700, fontSize: 14)),
              ),
            ],
          ),
        ),
      ),
    );
    if (mounted) _scanFocus.requestFocus();
  }

  Future<void> _onBinSubmit(String raw) async {
    final bin = raw.trim().toUpperCase();
    if (bin.isEmpty || _skuForBin.isEmpty) return;
    _hiddenCtrl.clear();
    setState(() => _busy = true);
    try {
      final api      = context.read<WmsApiClient>();
      final deviceId = await HandheldDeviceIdentity.primaryDeviceIdForServer();
      final result   = await api.postPutawayAssign(
        deviceId:   deviceId,
        binCode:    bin,
        skuScanned: _skuForBin,
        scope:      _scopeForBin,
      );
      if (!mounted) return;
      final contents = result['storedContents'];
      final List<Map<String, dynamic>> items = contents is List
          ? contents.map<Map<String, dynamic>>((e) => Map<String, dynamic>.from(e as Map)).toList()
          : <Map<String, dynamic>>[];

      setState(() {
        _busy           = false;
        _flashOk        = true;
        _currentBin     = bin;
        _storedContents = items;
        _phase          = _PutawayPhase.scanItem;
        _pendingSku     = '';
        _skuForBin      = '';
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
    setState(() { _phase = _PutawayPhase.scanBin; _pendingSku = ''; });
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final code = await _maybeCameraScan('Scan bin label');
      if (code != null && code.isNotEmpty && mounted) {
        await _onBinSubmit(code);
      } else {
        _scanFocus.requestFocus();
      }
    });
  }

  void _addNewItem() {
    setState(() { _phase = _PutawayPhase.scanItem; _pendingSku = ''; });
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final code = await _maybeCameraScan('Scan item barcode');
      if (code != null && code.isNotEmpty && mounted) {
        await _onItemSubmit(code);
      } else {
        _scanFocus.requestFocus();
      }
    });
  }

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
      appBar: _buildAppBar(isDark: isDark, mainColor: mainColor, mutedColor: mutedColor),
      body: Column(
        children: [
          // ── Hidden hardware-wedge receiver ──────────────────────────────
          Offstage(
            offstage: true,
            child: TextField(
              controller: _hiddenCtrl,
              focusNode: _scanFocus,
              autofocus: true,
              onSubmitted: (v) {
                if (_phase == _PutawayPhase.scanItem) {
                  unawaited(_onItemSubmit(v));
                } else {
                  unawaited(_onBinSubmit(v));
                }
              },
            ),
          ),

          // ── Busy overlay ────────────────────────────────────────────────
          if (_busy)
            const LinearProgressIndicator(minHeight: 2),

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
                      final sku  = item['sku']  as String? ?? '—';
                      final desc = item['description'] as String? ?? '';
                      final qty  = item['qty']  as int? ?? item['quantity'] as int? ?? 0;
                      return Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: _StoredItemRow(
                          sku: sku,
                          description: desc,
                          quantity: qty,
                          bgLow: bgLow,
                          mainColor: mainColor,
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
            onCleanBin: () {/* wire later */},
            onUndoClean: () {/* wire later */},
            onAddBin: _addNewBin,
            onAddBinCamera: () async {
              final code = await openCameraBarcodeScanner(context, title: 'Scan bin label');
              if (code != null && code.isNotEmpty && mounted) unawaited(_onBinSubmit(code));
            },
            onAddItem: _addNewItem,
            onAddItemCamera: () async {
              final code = await openCameraBarcodeScanner(context, title: 'Scan item barcode');
              if (code != null && code.isNotEmpty && mounted) unawaited(_onItemSubmit(code));
            },
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
          Text(
            'BIN ASSIGN',
            style: GoogleFonts.manrope(
              fontSize: 12,
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

class _BinInfoBlock extends StatelessWidget {
  const _BinInfoBlock({
    required this.binCode,
    required this.pendingSku,
    required this.isActive,
    required this.isDark,
    required this.bgLow,
    required this.bg,
    required this.mainColor,
    required this.mutedColor,
  });

  final String binCode;
  final String pendingSku;
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
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 8, 16, 0),
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 16),
      decoration: BoxDecoration(
        color: bgLow,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Label row
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
          const SizedBox(height: 10),
          // Bin code — big teal text when active, input-style box when inactive
          if (isActive)
            Text(
              binCode,
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
            style: GoogleFonts.spaceGrotesk(
              fontSize: 12,
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
              fontSize: 15,
              fontWeight: FontWeight.w800,
              letterSpacing: 0.2,
              color: mainColor,
            ),
          ),
          Text(
            '$itemCount ITEMS TOTAL',
            style: GoogleFonts.spaceGrotesk(
              fontSize: 12,
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
          'TRIGGER OR TAP TO ADD ITEM',
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
  final int    quantity;
  final Color  bgLow;
  final Color  mainColor;

  @override
  Widget build(BuildContext context) {
    return Container(
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
                  'SKU:  $sku',
                  style: GoogleFonts.spaceGrotesk(
                    fontSize: 14,
                    fontWeight: FontWeight.w700,
                    color: mainColor,
                  ),
                ),
                if (description.isNotEmpty) ...[
                  const SizedBox(height: 3),
                  Text(
                    description,
                    style: GoogleFonts.manrope(
                      fontSize: 12,
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
    required this.onCleanBin,
    required this.onUndoClean,
    required this.onAddBin,
    required this.onAddBinCamera,
    required this.onAddItem,
    required this.onAddItemCamera,
  });

  final bool  isDark;
  final Color bg;
  final Color bgMid;
  final Color mainColor;
  final Color mutedColor;
  final Color tealDark;
  final Color tealLight;
  final VoidCallback onCleanBin;
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
              borderRadius: BorderRadius.circular(6),
            ),
            child: Row(
              children: [
                // Broom icon — left tap zone
                _IconTapZone(
                  onTap: onCleanBin,
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
          // ── READY FOR NEXT ENTRY ──────────────────────────────────────
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text(
                'READY FOR NEXT ENTRY',
                style: GoogleFonts.spaceGrotesk(
                  fontSize: 11,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 2.0,
                  color: mutedColor,
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
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: _DualActionButton(
                  label: 'ADD ITEM',
                  mainIcon: Icons.add_circle_outline,
                  color: tealLight,
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

/// A button with a main tap zone + an embedded camera icon tap zone on the right.
class _DualActionButton extends StatelessWidget {
  const _DualActionButton({
    required this.label,
    required this.mainIcon,
    required this.color,
    required this.onMain,
    required this.onCamera,
  });

  final String      label;
  final IconData    mainIcon;
  final Color       color;
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
          // Main label tap zone
          Expanded(
            child: InkWell(
              onTap: onMain,
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
              _NavItem(icon: Icons.dashboard_outlined,            label: 'DASH',  active: false, onTap: () => Navigator.of(context).maybePop()),
              _NavItem(icon: Icons.inventory_2_outlined,          label: 'STOCK', active: false, onTap: () {}),
              _NavItem(icon: Icons.precision_manufacturing_outlined, label: 'OPS', active: false, onTap: () {}),
              _NavItem(icon: Icons.qr_code_scanner,              label: 'TAGS',  active: true,  onTap: () {}),
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
