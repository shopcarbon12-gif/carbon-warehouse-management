import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/hardware/rfid_vendor_channel.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/lan_zpl_printer.dart';
import 'package:carbon_wms/services/scan_sounds.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/screens/inventory_catalog_screen.dart'
    show CatalogRowCard;
import 'package:carbon_wms/ui/widgets/camera_barcode_scanner.dart'
    show openCameraBarcodeScanner;
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';

/// Handheld Print screen — replaces the legacy 3-tab EncodeSuiteScreen
/// "Print" tab. Visual conventions copied from Bin Assign:
///
///   • Square containers, no rounded corners.
///   • Manrope weights for labels, Space Grotesk for monospaced/SKU rows.
///   • Two equal-width buttons at the bottom (camera left, action right),
///     same height + shadow Bin Assign uses.
///   • The catalog row above is the SAME [CatalogRowCard] the Encode and
///     Status Change screens use — qty hidden, full-row tap with InkWell
///     splash for select feedback.
///
/// Print pipeline: `POST /api/rfid/commission` (defaults to printer
/// 192.168.1.3:80, URI PSTPRNT, both server-side). Mobile sends
/// `customSkuId`, `qty`, `addToInventory`. The "Add tag to inventory?"
/// checkbox controls `addToInventory`; checked → `status='in-stock'` so
/// the EPCs land in active inventory immediately, unchecked →
/// `status='pending_visibility'` so labels print but the rows don't
/// count until a fixed reader confirms visibility.
class PrintScreen extends StatefulWidget {
  const PrintScreen({super.key});

  @override
  State<PrintScreen> createState() => _PrintScreenState();
}

class _PrintScreenState extends State<PrintScreen> {
  static const Duration _searchDebounce = Duration(milliseconds: 300);
  static const int _minQueryLen = 2;
  static const int _qtyMin = 1;
  static const int _qtyMax = 50;

  // ── search ────────────────────────────────────────────────────────────
  final TextEditingController _searchCtrl = TextEditingController();
  Timer? _debounce;
  String _query = '';
  bool _searchLoading = false;
  String? _searchError;
  List<Map<String, dynamic>> _searchResults = [];
  StreamSubscription<String>? _barcodeSub;

  // ── selection + form state ────────────────────────────────────────────
  // Multi-select pool — operator builds it by tapping catalog rows.
  // Tapping the same row again deselects (toggle). The qty stepper
  // applies to EVERY selected SKU, so the print loop runs N×qty tags
  // total. Chip row above the qty stepper renders the current pool
  // and supports per-SKU removal (tap chip → remove).
  final List<Map<String, dynamic>> _selectedSkus = [];
  int _qty = 1;
  bool _addToInventory = false;

  // qty editor
  bool _qtyEditing = false;
  final TextEditingController _qtyCtrl = TextEditingController(text: '1');
  final FocusNode _qtyFocus = FocusNode();

  // ── print run state ───────────────────────────────────────────────────
  bool _printing = false;
  String? _printError;

  @override
  void initState() {
    super.initState();
    unawaited(ScanSounds.instance.init());
    // Bin-Assign-style 2D mode on entry: trigger fires the imager so a
    // hardware barcode pull fills the search box, the same way Bin Assign
    // captures bin codes.
    unawaited(RfidVendorChannel.open2dBarcode());
    unawaited(RfidVendorChannel.scannerEnableTriggerRelay());
    unawaited(RfidVendorChannel.setZebraTriggerMode2D());

    _barcodeSub = RfidVendorChannel.hardwareBarcodeStream().listen((raw) {
      if (!mounted) return;
      final code = raw.trim();
      if (code.isEmpty) return;
      // EPC-shaped reads aren't useful for search → ignore.
      if (RegExp(r'^[0-9A-F]{24}$').hasMatch(code.toUpperCase())) return;
      _searchCtrl.text = code;
      _searchCtrl.selection =
          TextSelection.collapsed(offset: _searchCtrl.text.length);
      _onSearchChanged(code);
    }, onError: (_) {});
  }

  @override
  void dispose() {
    _debounce?.cancel();
    unawaited(_barcodeSub?.cancel());
    _searchCtrl.dispose();
    _qtyCtrl.dispose();
    _qtyFocus.dispose();
    // Restore RFID-trigger mode for the next screen, like Encode does.
    unawaited(RfidVendorChannel.scannerDisableTriggerRelay());
    unawaited(RfidVendorChannel.close2dBarcode());
    unawaited(RfidVendorChannel.enableRfidFunctionMode());
    unawaited(RfidVendorChannel.setZebraTriggerModeRfid());
    super.dispose();
  }

  // ── search ────────────────────────────────────────────────────────────
  void _onSearchChanged(String value) {
    _debounce?.cancel();
    final trimmed = value.trim();
    if (trimmed.length < _minQueryLen) {
      if (_searchResults.isNotEmpty || _query.isNotEmpty) {
        setState(() {
          _query = '';
          _searchResults = [];
          _searchError = null;
        });
      }
      return;
    }
    _debounce = Timer(_searchDebounce, () {
      if (!mounted) return;
      if (trimmed == _query) return;
      setState(() => _query = trimmed);
      unawaited(_runSearch());
    });
  }

  Future<void> _runSearch() async {
    if (_query.isEmpty) return;
    setState(() {
      _searchLoading = true;
      _searchError = null;
      _searchResults = [];
    });
    try {
      final api = context.read<WmsApiClient>();
      final res = await api.fetchCatalogGrid(q: _query, page: 1, limit: 100);
      if (!mounted) return;
      final rows = (res['rows'] as List?)
              ?.whereType<Map<String, dynamic>>()
              .toList() ??
          [];
      setState(() {
        _searchResults = rows;
        _searchLoading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _searchLoading = false;
        _searchError = 'Search failed: $e';
      });
    }
  }

  // ── selection ─────────────────────────────────────────────────────────
  // Toggle: tap a catalog row to add it to the print pool, tap the
  // same row (or its chip above the qty stepper) to remove it.
  bool _isSelected(Map<String, dynamic> row) {
    final id = row['custom_sku_id']?.toString() ?? '';
    if (id.isEmpty) return false;
    return _selectedSkus.any((m) =>
        (m['custom_sku_id']?.toString() ?? '') == id);
  }

  void _toggleSku(Map<String, dynamic> row) {
    final id = row['custom_sku_id']?.toString() ?? '';
    if (id.isEmpty) return;
    setState(() {
      _printError = null;
      final i = _selectedSkus.indexWhere((m) =>
          (m['custom_sku_id']?.toString() ?? '') == id);
      if (i >= 0) {
        _selectedSkus.removeAt(i);
      } else {
        _selectedSkus.add(row);
      }
    });
  }

  void _removeSelectedById(String customSkuId) {
    if (customSkuId.isEmpty) return;
    setState(() {
      _selectedSkus.removeWhere((m) =>
          (m['custom_sku_id']?.toString() ?? '') == customSkuId);
    });
  }

  // ── qty stepper ───────────────────────────────────────────────────────
  void _setQty(int v) {
    final clamped = v.clamp(_qtyMin, _qtyMax);
    setState(() {
      _qty = clamped;
      _qtyCtrl.text = clamped.toString();
      _qtyCtrl.selection =
          TextSelection.collapsed(offset: _qtyCtrl.text.length);
    });
  }

  void _beginQtyEdit() {
    setState(() => _qtyEditing = true);
    _qtyCtrl.selection = TextSelection(
      baseOffset: 0,
      extentOffset: _qtyCtrl.text.length,
    );
    Future<void>.delayed(const Duration(milliseconds: 30), () {
      if (mounted) _qtyFocus.requestFocus();
    });
  }

  void _commitQtyEdit() {
    final n = int.tryParse(_qtyCtrl.text.trim()) ?? _qty;
    setState(() => _qtyEditing = false);
    _setQty(n);
    _qtyFocus.unfocus();
  }

  // ── camera scan ───────────────────────────────────────────────────────
  Future<void> _onCameraTap() async {
    await SystemChrome.setPreferredOrientations([
      DeviceOrientation.portraitUp,
      DeviceOrientation.landscapeLeft,
      DeviceOrientation.landscapeRight,
    ]);
    try {
      if (!mounted) return;
      final code = await openCameraBarcodeScanner(
        context,
        title: 'SCAN PRODUCT',
      );
      if (!mounted || code == null || code.trim().isEmpty) return;
      _searchCtrl.text = code.trim();
      _onSearchChanged(code.trim());
    } finally {
      await SystemChrome.setPreferredOrientations(
          [DeviceOrientation.portraitUp]);
    }
  }

  // ── print action ──────────────────────────────────────────────────────
  // Multi-SKU print loop. For each selected SKU we hit
  // /api/rfid/commission with the same qty. The server skips its own
  // print (cloud → LAN printer is unroutable) and returns the rendered
  // ZPL + printer host/port; we send the ZPL straight to the printer
  // over raw TCP from the handheld via [LanZplPrinter]. We keep going
  // through the rest of the pool even if one SKU fails — the operator
  // gets a single tally at the end.
  Future<void> _onPrintTap() async {
    if (_selectedSkus.isEmpty || _printing) return;
    final api = context.read<WmsApiClient>();
    final messenger = ScaffoldMessenger.of(context);
    setState(() {
      _printing = true;
      _printError = null;
    });
    final totalSkus = _selectedSkus.length;
    final perSkuQty = _qty;
    final totalTags = totalSkus * perSkuQty;
    messenger.showSnackBar(SnackBar(
      content: Text(
        'Printing $totalTags tag${totalTags == 1 ? '' : 's'}…',
      ),
      duration: const Duration(seconds: 2),
    ));
    int printedTags = 0;
    final List<String> failures = [];
    try {
      for (final sku in List<Map<String, dynamic>>.from(_selectedSkus)) {
        final customSkuId = sku['custom_sku_id']?.toString() ?? '';
        final skuLabel = sku['sku']?.toString() ?? customSkuId;
        if (customSkuId.isEmpty) {
          failures.add('$skuLabel: missing custom_sku_id');
          continue;
        }
        try {
          final res = await api.postRfidCommission(
            customSkuId: customSkuId,
            qty: perSkuQty,
            addToInventory: _addToInventory,
          );
          if (!mounted) return;
          final insertedRaw = res['inserted'];
          final inserted =
              insertedRaw is List ? insertedRaw.length : perSkuQty;
          // Cloud-skip path: server returns ZPL + printer info, we TCP
          // it ourselves on port 9100.
          final printerOk = res['printer_ok'] == true;
          if (printerOk) {
            printedTags += inserted;
            continue;
          }
          final zpl = res['zpl']?.toString() ?? '';
          final host = res['printer_host']?.toString() ?? '';
          // Server returns the printer port + uri it would use for its
          // own (cloud-side) print attempt. We mirror those exactly so
          // the handheld targets the same endpoint a desktop browser
          // would. Default 80/PSTPRNT matches Zebra ZD500R stock setup.
          // 1.2.47 hardcoded port 9100 raw TCP, which a lot of printers
          // either disable or reach via a different code path — prints
          // appeared successful at the socket layer but nothing came
          // out of the printer. 1.2.48 lets the server's wiring drive.
          final port = (res['printer_port'] as num?)?.toInt() ?? 80;
          final uri = res['printer_uri']?.toString() ?? 'PSTPRNT';
          if (zpl.isEmpty || host.isEmpty) {
            failures.add(
                '$skuLabel: ${res['printer_error']?.toString() ?? 'no zpl'}');
            continue;
          }
          final tcpErr = await LanZplPrinter.send(
            host: host,
            port: port,
            uri: uri,
            zpl: zpl,
          );
          if (tcpErr == null) {
            printedTags += inserted;
          } else {
            failures.add('$skuLabel: $tcpErr');
          }
        } catch (e) {
          failures.add('$skuLabel: $e');
        }
      }
      if (!mounted) return;
      if (failures.isEmpty) {
        ScanSounds.instance.play(ScanCue.success);
        messenger.hideCurrentSnackBar();
        messenger.showSnackBar(SnackBar(
          content: Text(
            'Printed $printedTags tag${printedTags == 1 ? '' : 's'} ✓',
          ),
          duration: const Duration(seconds: 2),
        ));
        setState(() {
          _selectedSkus.clear();
          _qty = 1;
          _qtyCtrl.text = '1';
          _addToInventory = false;
        });
      } else {
        ScanSounds.instance.play(ScanCue.error);
        setState(() {
          _printError = printedTags == 0
              ? 'Print failed: ${failures.join(' · ')}'
              : 'Printed $printedTags · failed: ${failures.join(' · ')}';
        });
      }
    } finally {
      if (mounted) setState(() => _printing = false);
    }
  }

  // ── ui ────────────────────────────────────────────────────────────────
  bool get _canPrint =>
      _selectedSkus.isNotEmpty && _qty >= _qtyMin && !_printing;

  @override
  Widget build(BuildContext context) {
    return CarbonScaffold(
      pageTitle: 'PRINT',
      body: SafeArea(
        top: false,
        child: Column(
          children: [
            // ── search row ───────────────────────────────────────────
            Padding(
              padding: EdgeInsets.fromLTRB(20.w, 12.h, 20.w, 8.h),
              child: _SearchBar(
                controller: _searchCtrl,
                onChanged: _onSearchChanged,
                onClear: () {
                  _searchCtrl.clear();
                  _onSearchChanged('');
                },
              ),
            ),
            Padding(
              padding: EdgeInsets.fromLTRB(20.w, 0, 20.w, 8.h),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  _query.isEmpty
                      ? 'TYPE OR 2D-SCAN A PRODUCT'
                      : (_searchLoading
                          ? 'SEARCHING…'
                          : '${_searchResults.length} RESULTS'),
                  style: GoogleFonts.spaceGrotesk(
                    fontSize: 11.sp,
                    fontWeight: FontWeight.w700,
                    letterSpacing: 1.4,
                    color: const Color(0xFF6D7979),
                  ),
                ),
              ),
            ),
            if (_searchError != null)
              Padding(
                padding: EdgeInsets.fromLTRB(20.w, 4.h, 20.w, 4.h),
                child: Text(
                  _searchError!,
                  style: GoogleFonts.manrope(
                    fontSize: 12.sp,
                    fontWeight: FontWeight.w700,
                    color: const Color(0xFFBF2E2E),
                  ),
                ),
              ),

            // ── catalog rows (search results — multi-select) ─────────
            Expanded(
              child: _query.isEmpty
                  ? const _SearchEmptyHint()
                  : _searchLoading && _searchResults.isEmpty
                      ? const Center(child: CircularProgressIndicator())
                      : _searchResults.isEmpty
                          ? Center(
                              child: Padding(
                                padding: EdgeInsets.all(24.r),
                                child: Text(
                                  'No matches for "$_query".',
                                  textAlign: TextAlign.center,
                                  style: GoogleFonts.manrope(
                                    fontSize: 14.sp,
                                    fontWeight: FontWeight.w700,
                                    color: const Color(0xFF5A6464),
                                  ),
                                ),
                              ),
                            )
                          : ListView.separated(
                              padding:
                                  EdgeInsets.fromLTRB(20.w, 0, 20.w, 12.h),
                              itemCount: _searchResults.length,
                              separatorBuilder: (_, __) =>
                                  SizedBox(height: 12.h),
                              itemBuilder: (_, i) {
                                final r = _searchResults[i];
                                final selected = _isSelected(r);
                                return CatalogRowCard(
                                  row: r,
                                  showQty: false,
                                  selected: selected,
                                  onTap: () => _toggleSku(r),
                                  onQtyTap: () => _toggleSku(r),
                                );
                              },
                            ),
            ),

            // ── chips: SKUs currently in the print pool ──────────────
            // Visible only once the operator has selected at least one
            // SKU. Chip tap → remove. Lets the operator search a new
            // query without losing track of what's already queued.
            if (_selectedSkus.isNotEmpty)
              _SelectedChipsRow(
                selected: _selectedSkus,
                onRemove: _removeSelectedById,
              ),

            // ── error banner (mid-print failure) ─────────────────────
            if (_printError != null)
              Padding(
                padding: EdgeInsets.fromLTRB(20.w, 0, 20.w, 8.h),
                child: Container(
                  width: double.infinity,
                  color: const Color(0xFFFCE7E7),
                  padding: EdgeInsets.symmetric(
                      horizontal: 12.w, vertical: 10.h),
                  child: Text(
                    _printError!,
                    style: GoogleFonts.manrope(
                      fontSize: 12.sp,
                      fontWeight: FontWeight.w700,
                      color: const Color(0xFFBF2E2E),
                    ),
                  ),
                ),
              ),

            // ── add-to-inventory checkbox ────────────────────────────
            // Sits above the qty stepper per operator preference: the
            // policy ("are these tags going live in inventory?") is the
            // bigger commitment, so it's the first decision the operator
            // makes; qty is the trivial number underneath.
            _CheckboxRow(
              label: 'Add tag to inventory?',
              checked: _addToInventory,
              onChanged: (v) => setState(() => _addToInventory = v),
            ),

            // ── qty stepper ──────────────────────────────────────────
            _QtyStepper(
              qty: _qty,
              min: _qtyMin,
              max: _qtyMax,
              editing: _qtyEditing,
              controller: _qtyCtrl,
              focusNode: _qtyFocus,
              onMinus: () => _setQty(_qty - 1),
              onPlus: () => _setQty(_qty + 1),
              onTapNumber: _beginQtyEdit,
              onSubmit: _commitQtyEdit,
            ),

            // ── bottom action row: camera + print ────────────────────
            Padding(
              padding: EdgeInsets.fromLTRB(16.w, 6.h, 16.w, 12.h),
              child: Row(
                children: [
                  Expanded(
                    child: _BottomActionButton(
                      label: 'CAM',
                      icon: LucideIcons.camera,
                      onTap: _printing ? null : _onCameraTap,
                      filled: false,
                    ),
                  ),
                  SizedBox(width: 8.w),
                  Expanded(
                    flex: 2,
                    child: _BottomActionButton(
                      label: _printing ? 'PRINTING…' : 'PRINT',
                      icon: LucideIcons.printer,
                      onTap: _canPrint ? _onPrintTap : null,
                      filled: true,
                      busy: _printing,
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

// ═════════════════════════════════════════════════════════════════════════
// Search bar — same shape as Bin Assign / Encode
// ═════════════════════════════════════════════════════════════════════════

class _SearchBar extends StatelessWidget {
  const _SearchBar({
    required this.controller,
    required this.onChanged,
    required this.onClear,
  });

  final TextEditingController controller;
  final ValueChanged<String> onChanged;
  final VoidCallback onClear;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: const BoxDecoration(
        color: Color(0xFFF0F5F4),
        borderRadius: BorderRadius.zero,
      ),
      child: Padding(
        padding: EdgeInsets.symmetric(horizontal: 12.w),
        child: Row(
          children: [
            Icon(Icons.search, size: 22.sp, color: const Color(0xFF6D7979)),
            SizedBox(width: 10.w),
            Expanded(
              child: TextField(
                controller: controller,
                onChanged: onChanged,
                autofocus: false,
                textInputAction: TextInputAction.search,
                style: GoogleFonts.spaceGrotesk(
                  fontSize: 15.sp,
                  fontWeight: FontWeight.w600,
                  color: AppColors.textMain,
                ),
                decoration: InputDecoration(
                  border: InputBorder.none,
                  isCollapsed: true,
                  contentPadding: EdgeInsets.symmetric(vertical: 16.h),
                  hintText: 'EPC · SKU · UPC · NAME',
                  hintStyle: GoogleFonts.spaceGrotesk(
                    fontSize: 13.sp,
                    fontWeight: FontWeight.w600,
                    letterSpacing: 1.2,
                    color: const Color(0xFF6D7979),
                  ),
                ),
              ),
            ),
            if (controller.text.isNotEmpty)
              GestureDetector(
                onTap: onClear,
                child: Padding(
                  padding: EdgeInsets.symmetric(horizontal: 6.w),
                  child: Icon(Icons.close,
                      size: 20.sp, color: const Color(0xFF6D7979)),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _SearchEmptyHint extends StatelessWidget {
  const _SearchEmptyHint();
  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: EdgeInsets.all(24.r),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(LucideIcons.printer,
                size: 48.sp, color: const Color(0xFFBCC9C9)),
            SizedBox(height: 12.h),
            Text(
              'PICK A PRODUCT',
              textAlign: TextAlign.center,
              style: GoogleFonts.spaceGrotesk(
                fontSize: 13.sp,
                fontWeight: FontWeight.w800,
                letterSpacing: 1.6,
                color: const Color(0xFF5A6464),
              ),
            ),
            SizedBox(height: 6.h),
            Text(
              'Type, 2D-scan, or use the camera button.',
              textAlign: TextAlign.center,
              style: GoogleFonts.manrope(
                fontSize: 12.sp,
                fontWeight: FontWeight.w600,
                color: const Color(0xFF6D7979),
                height: 1.4,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ═════════════════════════════════════════════════════════════════════════
// Selected-SKU chips row — horizontally scrollable strip of teal chips,
// one per SKU in the print pool. Tap a chip to remove that SKU. Sits
// above the qty stepper so the operator can keep searching while still
// seeing what's queued. The previous design pinned a single big SKU
// panel here; multi-select needs a denser layout.
// ═════════════════════════════════════════════════════════════════════════

class _SelectedChipsRow extends StatelessWidget {
  const _SelectedChipsRow({
    required this.selected,
    required this.onRemove,
  });

  final List<Map<String, dynamic>> selected;
  final ValueChanged<String> onRemove;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(16.w, 4.h, 16.w, 4.h),
      child: Container(
        width: double.infinity,
        color: const Color(0xFFEEF4F3),
        padding: EdgeInsets.symmetric(horizontal: 10.w, vertical: 8.h),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              '${selected.length} SELECTED · TAP TO REMOVE',
              style: GoogleFonts.spaceGrotesk(
                fontSize: 10.sp,
                fontWeight: FontWeight.w800,
                letterSpacing: 1.4,
                color: const Color(0xFF3D4949),
              ),
            ),
            SizedBox(height: 6.h),
            SizedBox(
              height: 28.h,
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                itemCount: selected.length,
                separatorBuilder: (_, __) => SizedBox(width: 6.w),
                itemBuilder: (_, i) {
                  final row = selected[i];
                  final id = row['custom_sku_id']?.toString() ?? '';
                  final sku = row['sku']?.toString() ?? '';
                  final color = row['color']?.toString() ?? '';
                  final size = row['size']?.toString() ?? '';
                  final label = [
                    if (sku.isNotEmpty) sku,
                    if (color.isNotEmpty) color,
                    if (size.isNotEmpty) size,
                  ].join(' · ');
                  return GestureDetector(
                    onTap: () => onRemove(id),
                    child: Container(
                      padding: EdgeInsets.symmetric(
                          horizontal: 10.w, vertical: 4.h),
                      color: AppColors.primary,
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            label.isEmpty ? id : label,
                            style: GoogleFonts.spaceGrotesk(
                              fontSize: 11.sp,
                              fontWeight: FontWeight.w700,
                              letterSpacing: 0.6,
                              color: Colors.white,
                            ),
                          ),
                          SizedBox(width: 6.w),
                          Icon(
                            Icons.close,
                            size: 14.sp,
                            color: Colors.white.withValues(alpha: 0.92),
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
      ),
    );
  }
}

// ═════════════════════════════════════════════════════════════════════════
// Qty stepper — - [N] +. Tap N to edit manually with the soft keyboard.
// ═════════════════════════════════════════════════════════════════════════

class _QtyStepper extends StatelessWidget {
  const _QtyStepper({
    required this.qty,
    required this.min,
    required this.max,
    required this.editing,
    required this.controller,
    required this.focusNode,
    required this.onMinus,
    required this.onPlus,
    required this.onTapNumber,
    required this.onSubmit,
  });

  final int qty;
  final int min;
  final int max;
  final bool editing;
  final TextEditingController controller;
  final FocusNode focusNode;
  final VoidCallback onMinus;
  final VoidCallback onPlus;
  final VoidCallback onTapNumber;
  final VoidCallback onSubmit;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(16.w, 4.h, 16.w, 4.h),
      child: Container(
        color: const Color(0xFFEEF4F3),
        padding: EdgeInsets.symmetric(horizontal: 12.w, vertical: 8.h),
        child: Row(
          children: [
            Text(
              'TAG QUANTITY',
              style: GoogleFonts.spaceGrotesk(
                fontSize: 11.sp,
                fontWeight: FontWeight.w800,
                letterSpacing: 1.4,
                color: const Color(0xFF3D4949),
              ),
            ),
            const Spacer(),
            _StepBtn(
              icon: Icons.remove,
              enabled: qty > min && !editing,
              onTap: onMinus,
            ),
            SizedBox(width: 8.w),
            // Editable number cell. While not in edit-mode it's a flat
            // square that opens the keyboard on tap. While editing the
            // square hosts a single-line numeric TextField.
            GestureDetector(
              onTap: editing ? null : onTapNumber,
              child: Container(
                width: 70.w,
                height: 38.h,
                alignment: Alignment.center,
                color: Colors.white,
                child: editing
                    ? TextField(
                        controller: controller,
                        focusNode: focusNode,
                        keyboardType: TextInputType.number,
                        textInputAction: TextInputAction.done,
                        textAlign: TextAlign.center,
                        autofocus: true,
                        inputFormatters: [
                          FilteringTextInputFormatter.digitsOnly,
                          LengthLimitingTextInputFormatter(4),
                        ],
                        decoration: const InputDecoration(
                          border: InputBorder.none,
                          isCollapsed: true,
                          contentPadding:
                              EdgeInsets.symmetric(vertical: 6),
                        ),
                        onSubmitted: (_) => onSubmit(),
                        onEditingComplete: onSubmit,
                        style: GoogleFonts.spaceGrotesk(
                          fontSize: 18.sp,
                          fontWeight: FontWeight.w800,
                          color: AppColors.textMain,
                        ),
                      )
                    : Text(
                        qty.toString(),
                        style: GoogleFonts.spaceGrotesk(
                          fontSize: 18.sp,
                          fontWeight: FontWeight.w800,
                          color: AppColors.textMain,
                        ),
                      ),
              ),
            ),
            SizedBox(width: 8.w),
            _StepBtn(
              icon: Icons.add,
              enabled: qty < max && !editing,
              onTap: onPlus,
            ),
          ],
        ),
      ),
    );
  }
}

class _StepBtn extends StatelessWidget {
  const _StepBtn({
    required this.icon,
    required this.enabled,
    required this.onTap,
  });
  final IconData icon;
  final bool enabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final fg = enabled ? Colors.white : Colors.white.withValues(alpha: 0.5);
    final bg = enabled ? AppColors.primary : const Color(0xFFBCC9C9);
    return GestureDetector(
      onTap: enabled ? onTap : null,
      child: Container(
        width: 38.w,
        height: 38.h,
        alignment: Alignment.center,
        color: bg,
        child: Icon(icon, size: 22.sp, color: fg),
      ),
    );
  }
}

// ═════════════════════════════════════════════════════════════════════════
// Single-row checkbox (label on the left, square check on the right)
// ═════════════════════════════════════════════════════════════════════════

class _CheckboxRow extends StatelessWidget {
  const _CheckboxRow({
    required this.label,
    required this.checked,
    required this.onChanged,
  });

  final String label;
  final bool checked;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(16.w, 0, 16.w, 4.h),
      child: Material(
        color: const Color(0xFFEEF4F3),
        child: InkWell(
          onTap: () => onChanged(!checked),
          child: Padding(
            padding: EdgeInsets.symmetric(horizontal: 12.w, vertical: 12.h),
            child: Row(
              children: [
                Icon(
                  checked
                      ? Icons.check_box_rounded
                      : Icons.check_box_outline_blank_rounded,
                  size: 22.sp,
                  color: checked
                      ? AppColors.primary
                      : const Color(0xFF3D4949),
                ),
                SizedBox(width: 10.w),
                Expanded(
                  child: Text(
                    label,
                    style: GoogleFonts.manrope(
                      fontSize: 13.sp,
                      fontWeight: FontWeight.w700,
                      color: AppColors.textMain,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

// ═════════════════════════════════════════════════════════════════════════
// Bottom action button — same shape Bin Assign uses (square, shadow, icon
// + label). When [filled] is false the button is grey/outline-style.
// ═════════════════════════════════════════════════════════════════════════

class _BottomActionButton extends StatelessWidget {
  const _BottomActionButton({
    required this.label,
    required this.icon,
    required this.onTap,
    required this.filled,
    this.busy = false,
  });

  final String label;
  final IconData icon;
  final VoidCallback? onTap;
  final bool filled;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final enabled = onTap != null;
    final Color bg;
    final Color fg;
    if (!enabled) {
      bg = const Color(0xFFBCC9C9);
      fg = Colors.white.withValues(alpha: 0.85);
    } else if (filled) {
      bg = AppColors.primary;
      fg = Colors.white;
    } else {
      bg = const Color(0xFFEEF4F3);
      fg = const Color(0xFF3D4949);
    }
    return GestureDetector(
      onTap: enabled ? onTap : null,
      child: Container(
        height: 56.h,
        decoration: BoxDecoration(
          color: bg,
          boxShadow: filled
              ? const [
                  BoxShadow(
                    color: Color(0x24000000),
                    blurRadius: 14,
                    offset: Offset(0, 6),
                  ),
                ]
              : null,
        ),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            if (busy)
              SizedBox(
                width: 18.sp,
                height: 18.sp,
                child: CircularProgressIndicator(
                  strokeWidth: 2.0,
                  valueColor: AlwaysStoppedAnimation<Color>(fg),
                ),
              )
            else
              Icon(icon, size: 20.sp, color: fg),
            SizedBox(width: 8.w),
            Text(
              label,
              style: GoogleFonts.manrope(
                fontSize: 14.sp,
                fontWeight: FontWeight.w800,
                letterSpacing: 1.6,
                color: fg,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
