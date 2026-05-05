import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/hardware/rfid_vendor_channel.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
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
  Map<String, dynamic>? _selectedSku;
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
  void _selectSku(Map<String, dynamic> row) {
    setState(() {
      _selectedSku = row;
      _printError = null;
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
  Future<void> _onPrintTap() async {
    final sku = _selectedSku;
    if (sku == null || _printing) return;
    final customSkuId = sku['custom_sku_id']?.toString() ?? '';
    if (customSkuId.isEmpty) {
      setState(() => _printError = 'SKU is missing custom_sku_id');
      ScanSounds.instance.play(ScanCue.error);
      return;
    }
    final api = context.read<WmsApiClient>();
    final messenger = ScaffoldMessenger.of(context);
    setState(() {
      _printing = true;
      _printError = null;
    });
    messenger.showSnackBar(SnackBar(
      content: Text('Printing $_qty tag${_qty == 1 ? '' : 's'}…'),
      duration: const Duration(seconds: 2),
    ));
    try {
      final res = await api.postRfidCommission(
        customSkuId: customSkuId,
        qty: _qty,
        addToInventory: _addToInventory,
      );
      if (!mounted) return;
      final inserted = (res['inserted'] as num?)?.toInt();
      final printerOk = res['printer_ok'] == true;
      if (printerOk) {
        ScanSounds.instance.play(ScanCue.success);
        messenger.hideCurrentSnackBar();
        messenger.showSnackBar(SnackBar(
          content: Text(
            inserted == null
                ? 'Printed $_qty tag${_qty == 1 ? '' : 's'} ✓'
                : 'Printed $inserted tag${inserted == 1 ? '' : 's'} ✓',
          ),
          duration: const Duration(seconds: 2),
        ));
        // Reset form for the next print run.
        setState(() {
          _selectedSku = null;
          _qty = 1;
          _qtyCtrl.text = '1';
          _addToInventory = false;
        });
      } else {
        ScanSounds.instance.play(ScanCue.error);
        final err = res['printer_error']?.toString() ?? 'Printer rejected';
        setState(() => _printError = 'Printer: $err');
      }
    } catch (e) {
      if (!mounted) return;
      ScanSounds.instance.play(ScanCue.error);
      setState(() => _printError = '$e');
    } finally {
      if (mounted) setState(() => _printing = false);
    }
  }

  // ── ui ────────────────────────────────────────────────────────────────
  bool get _canPrint =>
      _selectedSku != null && _qty >= _qtyMin && !_printing;

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

            // ── catalog rows (or selected SKU pinned at top) ─────────
            Expanded(
              child: _selectedSku != null
                  ? _SelectedSkuPanel(
                      row: _selectedSku!,
                      onDeselect: () => setState(() => _selectedSku = null),
                    )
                  : _query.isEmpty
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
                                  padding: EdgeInsets.fromLTRB(
                                      20.w, 0, 20.w, 12.h),
                                  itemCount: _searchResults.length,
                                  separatorBuilder: (_, __) =>
                                      SizedBox(height: 12.h),
                                  itemBuilder: (_, i) {
                                    final r = _searchResults[i];
                                    return CatalogRowCard(
                                      row: r,
                                      showQty: false,
                                      onTap: () => _selectSku(r),
                                      onQtyTap: () => _selectSku(r),
                                    );
                                  },
                                ),
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

            // ── add-to-inventory checkbox ────────────────────────────
            _CheckboxRow(
              label: 'Add tag to inventory?',
              checked: _addToInventory,
              onChanged: (v) => setState(() => _addToInventory = v),
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
// Selected-SKU pinned panel (replaces the result list once a SKU is picked)
// ═════════════════════════════════════════════════════════════════════════

class _SelectedSkuPanel extends StatelessWidget {
  const _SelectedSkuPanel({required this.row, required this.onDeselect});

  final Map<String, dynamic> row;
  final VoidCallback onDeselect;

  @override
  Widget build(BuildContext context) {
    final sku = row['sku']?.toString() ?? '';
    final name = row['name']?.toString() ?? '';
    final color = row['color']?.toString() ?? '';
    final size = row['size']?.toString() ?? '';
    final priceStr = row['retail_price']?.toString();
    final price = double.tryParse(priceStr ?? '');
    final priceText =
        (price != null && price > 0) ? '\$${price.toStringAsFixed(2)}' : '';
    final desc = [
      if (name.isNotEmpty) name,
      if (color.isNotEmpty) color,
      if (size.isNotEmpty) size,
    ].join(' · ');

    return ListView(
      padding: EdgeInsets.fromLTRB(20.w, 0, 20.w, 0),
      children: [
        Container(
          width: double.infinity,
          color: AppColors.primary,
          padding: EdgeInsets.fromLTRB(16.w, 14.h, 12.w, 14.h),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.baseline,
                      textBaseline: TextBaseline.alphabetic,
                      children: [
                        Expanded(
                          child: Text(
                            sku.isEmpty ? 'SKU: —' : 'SKU: $sku',
                            style: GoogleFonts.robotoMono(
                              fontSize: 17.sp,
                              fontWeight: FontWeight.w800,
                              color: Colors.white,
                            ),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                        if (priceText.isNotEmpty) ...[
                          SizedBox(width: 8.w),
                          Text(
                            priceText,
                            style: GoogleFonts.manrope(
                              fontSize: 13.sp,
                              fontWeight: FontWeight.w800,
                              color: Colors.white,
                            ),
                          ),
                        ],
                      ],
                    ),
                    if (desc.isNotEmpty) ...[
                      SizedBox(height: 4.h),
                      Text(
                        desc,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: GoogleFonts.manrope(
                          fontSize: 13.sp,
                          fontWeight: FontWeight.w700,
                          color: Colors.white.withValues(alpha: 0.92),
                        ),
                      ),
                    ],
                  ],
                ),
              ),
              SizedBox(width: 8.w),
              GestureDetector(
                onTap: onDeselect,
                behavior: HitTestBehavior.opaque,
                child: Container(
                  padding:
                      EdgeInsets.symmetric(horizontal: 10.w, vertical: 6.h),
                  decoration: BoxDecoration(
                    color: Colors.white.withValues(alpha: 0.18),
                    borderRadius: BorderRadius.circular(2.r),
                  ),
                  child: Text(
                    'CHANGE',
                    style: GoogleFonts.spaceGrotesk(
                      fontSize: 10.sp,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 1.4,
                      color: Colors.white,
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ],
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
