import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/hardware/rfid_vendor_channel.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/handheld_device_identity.dart';
import 'package:carbon_wms/services/mobile_permissions.dart';
import 'package:carbon_wms/services/scan_sounds.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/widgets/camera_barcode_scanner.dart' show openCameraBarcodeScanner;
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';

/// Clean Bin — scan a bin barcode → review its current contents → clear all
/// in-stock assignments (`POST /api/mobile/clean-bin`, audited). Rebuilt
/// 2026-06 to mirror the Bin Assign (Fast Putaway) UI: a big bin-location box,
/// the bin's items listed (so the operator sees what's about to be removed),
/// and a CLEAN & EMPTY bar with Undo + Refresh.
class CleanBinScreen extends StatefulWidget {
  const CleanBinScreen({super.key});

  @override
  State<CleanBinScreen> createState() => _CleanBinScreenState();
}

const Color _kSlate = Color(0xFF6A7575);
const Color _kRed = Color(0xFFBF2E2E);
const Color _kSuccess = Color(0xFF2A8E2A);
// Item rows use a white fill (operator preference — no grey square inside the
// container).
const Color _kCard = Color(0xFFFFFFFF);
const Color _kMuted = Color(0xFF8A9090);

class _CleanItem {
  const _CleanItem({required this.sku, required this.desc, required this.qty});
  final String sku;
  final String desc;
  final int qty;

  static _CleanItem fromMap(Map<String, dynamic> m) {
    final name = m['description']?.toString() ?? '';
    final color = (m['color_code'] ?? m['color'] ?? '').toString();
    final size = (m['size'] ?? '').toString();
    final rawEpcs = m['epcs'];
    final epcCount = rawEpcs is List ? rawEpcs.length : 0;
    final desc = [name, color, size].where((e) => e.trim().isNotEmpty).join(' · ').toUpperCase();
    return _CleanItem(
      sku: m['sku']?.toString() ?? '',
      desc: desc,
      qty: m['qty'] as int? ?? m['quantity'] as int? ?? epcCount,
    );
  }
}

class _CleanBinScreenState extends State<CleanBinScreen> {
  final TextEditingController _binCtrl = TextEditingController();
  final FocusNode _binFocus = FocusNode();
  StreamSubscription<String>? _barcodeSub;

  List<Map<String, dynamic>> _binsCache = const [];
  String _currentBin = '';
  String _currentBinId = '';
  String _locationLine = '';
  bool _binActive = false;
  List<_CleanItem> _contents = [];

  bool _busy = false;
  List<String> _undoSkus = const [];
  String? _status;
  bool _cleared = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      // Arm the 2D imager so a hardware trigger pull scans a bin label.
      unawaited(RfidVendorChannel.open2dBarcode());
      unawaited(RfidVendorChannel.scannerEnableTriggerRelay());
      unawaited(RfidVendorChannel.setZebraTriggerMode2D());
      _barcodeSub = RfidVendorChannel.hardwareBarcodeStream().listen((raw) {
        final code = raw.trim();
        if (code.isEmpty) return;
        unawaited(_handleBin(code));
      }, onError: (_) {});
      // Warm the bin cache.
      try {
        final bins = await context.read<WmsApiClient>().fetchBins();
        if (mounted) setState(() => _binsCache = bins.cast<Map<String, dynamic>>());
      } catch (_) {}
      if (mounted) _binFocus.requestFocus();
    });
  }

  @override
  void dispose() {
    unawaited(_barcodeSub?.cancel());
    _binCtrl.dispose();
    _binFocus.dispose();
    // Restore RFID-trigger mode for the next screen.
    unawaited(RfidVendorChannel.scannerDisableTriggerRelay());
    unawaited(RfidVendorChannel.close2dBarcode());
    unawaited(RfidVendorChannel.enableRfidFunctionMode());
    unawaited(RfidVendorChannel.setZebraTriggerModeRfid());
    super.dispose();
  }

  String _formatBinCode(String raw) {
    final s = raw.trim().toUpperCase().replaceAll(RegExp(r'[-\s]'), '');
    if (s.length == 5) {
      return '${s[0]}-${s[1]}-${s.substring(2, 4)}-${s[4]}';
    }
    return raw.trim().toUpperCase();
  }

  String _norm(String raw) => raw.trim().toUpperCase().replaceAll(RegExp(r'[^A-Z0-9]'), '');

  // ── Bin resolve + load contents ─────────────────────────────────────────
  Future<void> _handleBin(String raw) async {
    final code = _formatBinCode(raw);
    final want = _norm(code);
    if (want.length < 3) return;
    _binCtrl.clear();
    setState(() {
      _busy = true;
      _status = null;
      _cleared = false;
    });
    try {
      final api = context.read<WmsApiClient>();
      List<Map<String, dynamic>> bins = _binsCache;
      if (bins.isEmpty) {
        bins = (await api.fetchBins()).cast<Map<String, dynamic>>();
        _binsCache = bins;
      }
      Map<String, dynamic>? match = _matchBin(bins, want);
      // Cache-miss → one live refresh before declaring unknown.
      if (match == null) {
        bins = (await api.fetchBins()).cast<Map<String, dynamic>>();
        _binsCache = bins;
        match = _matchBin(bins, want);
      }
      if (!mounted) return;
      if (match == null) {
        setState(() {
          _busy = false;
          _status = 'Bin "$code" not found in this location.';
        });
        return;
      }
      final binId = match['id']?.toString() ?? '';
      final loc = (match['location_name'] ?? match['location_code'] ?? '').toString();
      setState(() {
        _currentBin = code;
        _currentBinId = binId;
        _locationLine = loc;
        _binActive = true;
        _undoSkus = const [];
      });
      await _loadContents();
    } catch (e) {
      if (mounted) setState(() => _status = 'Bin lookup failed: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Map<String, dynamic>? _matchBin(List<Map<String, dynamic>> bins, String want) {
    for (final b in bins) {
      if (_norm(b['code']?.toString() ?? '') == want) return b;
    }
    return null;
  }

  Future<void> _loadContents() async {
    if (_currentBinId.isEmpty) return;
    try {
      final rows = await context.read<WmsApiClient>().fetchBinContents(_currentBinId);
      if (!mounted) return;
      setState(() {
        _contents = rows
            .whereType<Map<String, dynamic>>()
            .map((e) => _CleanItem.fromMap(e))
            .where((c) => c.qty > 0)
            .toList();
      });
    } catch (_) {/* leave prior contents */}
  }

  // ── Clean + undo ────────────────────────────────────────────────────────
  Future<void> _clean() async {
    if (!_binActive || _currentBin.isEmpty || _busy) return;
    // RBAC: roles without the clean-empty-bin action can't run this.
    if (!context
        .read<MobilePermissions>()
        .canDo(ScreenIds.cleanBin, 'clean_empty_bin')) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Not allowed')),
      );
      return;
    }
    if (_contents.isEmpty) {
      setState(() => _status = 'Bin $_currentBin is already empty.');
      return;
    }
    final total = _contents.fold<int>(0, (s, c) => s + c.qty);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        shape: const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
        title: Text('Clean & empty bin $_currentBin?'),
        content: Text(
            'Removes all $total in-stock assignment(s) from this bin. This is audited and can be undone.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('CANCEL')),
          FilledButton(
            style: FilledButton.styleFrom(
                backgroundColor: _kRed,
                shape: const RoundedRectangleBorder(borderRadius: BorderRadius.zero)),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('CLEAN'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() => _busy = true);
    try {
      final snapshot = _contents.map((c) => c.sku).toList();
      final j = await context.read<WmsApiClient>().postCleanBinByCode(_currentBin);
      final cleared = j['cleared'];
      if (!mounted) return;
      setState(() {
        _undoSkus = snapshot;
        _contents = [];
        _cleared = true;
        _status = 'Cleared $cleared item(s) from $_currentBin.';
      });
      // Success cue — the bin was cleaned & emptied (operator request).
      try {
        ScanSounds.instance.play(ScanCue.success);
      } catch (_) {}
    } catch (e) {
      if (mounted) setState(() => _status = 'Clean failed: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _undo() async {
    if (_undoSkus.isEmpty || _currentBin.isEmpty || _busy) return;
    setState(() => _busy = true);
    try {
      final api = context.read<WmsApiClient>();
      final deviceId = await HandheldDeviceIdentity.primaryDeviceIdForServer();
      for (final sku in _undoSkus) {
        await api.postPutawayAssign(
          deviceId: deviceId,
          binCode: _currentBin,
          skuScanned: sku,
          scope: 'single_color_all_sizes',
        );
      }
      await _loadContents();
      if (!mounted) return;
      setState(() {
        _undoSkus = const [];
        _cleared = false;
        _status = 'Undo — items restored to $_currentBin.';
      });
    } catch (e) {
      if (mounted) setState(() => _status = 'Undo failed: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _scanCamera() async {
    final code = await openCameraBarcodeScanner(context, title: 'Scan bin label');
    if (!mounted || code == null || code.isEmpty) return;
    await _handleBin(code);
  }

  void _changeBin() {
    setState(() {
      _currentBin = '';
      _currentBinId = '';
      _locationLine = '';
      _binActive = false;
      _contents = [];
      _undoSkus = const [];
      _cleared = false;
      _status = null;
    });
    _binFocus.requestFocus();
  }

  // ── build ─────────────────────────────────────────────────────────────
  @override
  Widget build(BuildContext context) {
    final armed = _binActive && _contents.isNotEmpty;
    final totalEpcs = _contents.fold<int>(0, (s, c) => s + c.qty);
    return CarbonScaffold(
      pageTitle: 'CLEAN BIN',
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (_busy) const LinearProgressIndicator(minHeight: 2),
            // Offstage wedge receiver so a manual keyboard-wedge scan lands.
            Offstage(
              offstage: true,
              child: TextField(
                controller: _binCtrl,
                focusNode: _binFocus,
                autofocus: false,
                onSubmitted: (v) => unawaited(_handleBin(v)),
              ),
            ),
            _binBlock(),
            _itemsHeader(totalEpcs),
            Expanded(child: _binActive ? _contentsList() : _emptyState()),
            _cleanBar(armed),
            _statusLine(),
            _scanButton(),
          ],
        ),
      ),
    );
  }

  Widget _binBlock() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: EdgeInsets.fromLTRB(16.w, 8.h, 16.w, 10.h),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text('CURRENT BIN LOCATION',
                  style: GoogleFonts.spaceGrotesk(
                      fontSize: 13.sp, fontWeight: FontWeight.w700, letterSpacing: 2, color: _kMuted)),
              _badge(),
            ],
          ),
        ),
        Container(
          margin: EdgeInsets.symmetric(horizontal: 16.w),
          decoration: BoxDecoration(color: Colors.white, border: Border.all(color: AppColors.primary, width: 2)),
          padding: EdgeInsets.symmetric(horizontal: 14.w, vertical: 12.h),
          child: _binActive
              ? GestureDetector(
                  onTap: _changeBin,
                  behavior: HitTestBehavior.opaque,
                  child: Column(
                    children: [
                      Text(_currentBin,
                          textAlign: TextAlign.center,
                          style: GoogleFonts.spaceGrotesk(
                              fontSize: 38.sp, fontWeight: FontWeight.w800, color: AppColors.primary, letterSpacing: 1.2)),
                      if (_locationLine.isNotEmpty)
                        Padding(
                          padding: EdgeInsets.only(top: 4.h),
                          child: Text(_locationLine,
                              style: GoogleFonts.spaceGrotesk(
                                  fontSize: 13.sp, fontWeight: FontWeight.w600, color: _kMuted)),
                        ),
                      Text('tap to change',
                          style: GoogleFonts.manrope(fontSize: 10.sp, color: _kMuted)),
                    ],
                  ),
                )
              : TextField(
                  controller: _binCtrl,
                  focusNode: _binFocus,
                  textCapitalization: TextCapitalization.characters,
                  decoration: InputDecoration(
                    isCollapsed: true,
                    filled: false,
                    fillColor: Colors.transparent,
                    border: InputBorder.none,
                    enabledBorder: InputBorder.none,
                    focusedBorder: InputBorder.none,
                    disabledBorder: InputBorder.none,
                    hintText: 'Enter or scan a bin…',
                    hintStyle: GoogleFonts.spaceGrotesk(fontSize: 18.sp, color: const Color(0xFFB9C4C4), fontWeight: FontWeight.w700),
                  ),
                  style: GoogleFonts.spaceGrotesk(fontSize: 26.sp, fontWeight: FontWeight.w800, color: AppColors.primary),
                  onSubmitted: (v) => unawaited(_handleBin(v)),
                ),
        ),
      ],
    );
  }

  Widget _badge() {
    final (txt, bg, fg) = _cleared
        ? ('CLEANED', const Color(0xFFE2E9E9), _kMuted)
        : _binActive
            ? ('ACTIVE', const Color(0xFFD6F5E6), _kSuccess)
            : ('IDLE', const Color(0xFFE2E9E9), _kMuted);
    return Container(
      padding: EdgeInsets.symmetric(horizontal: 10.w, vertical: 4.h),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(2.r)),
      child: Text(txt,
          style: GoogleFonts.spaceGrotesk(fontSize: 10.sp, fontWeight: FontWeight.w800, letterSpacing: 1.2, color: fg)),
    );
  }

  Widget _itemsHeader(int totalEpcs) {
    return Padding(
      padding: EdgeInsets.fromLTRB(16.w, 14.h, 16.w, 8.h),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Text('ITEMS IN BIN',
              style: GoogleFonts.spaceGrotesk(fontSize: 13.sp, fontWeight: FontWeight.w800, letterSpacing: 2, color: AppColors.textMain)),
          Text(_binActive ? '${_contents.length} SKUs · $totalEpcs EPCs' : '—',
              style: GoogleFonts.spaceGrotesk(fontSize: 12.sp, fontWeight: FontWeight.w700, color: _kMuted)),
        ],
      ),
    );
  }

  Widget _emptyState() {
    return Center(
      child: Padding(
        padding: EdgeInsets.symmetric(horizontal: 34.w),
        child: Text(
          'Scan a bin to see what\'s in it, then clean it.',
          textAlign: TextAlign.center,
          style: GoogleFonts.spaceGrotesk(fontSize: 15.sp, fontWeight: FontWeight.w700, color: _kMuted),
        ),
      ),
    );
  }

  Widget _contentsList() {
    if (_contents.isEmpty) {
      return Center(
        child: Text(_cleared ? 'Bin is now empty.' : 'No items in this bin.',
            style: GoogleFonts.spaceGrotesk(fontSize: 14.sp, fontWeight: FontWeight.w700, color: _kMuted)),
      );
    }
    return ListView.separated(
      padding: EdgeInsets.fromLTRB(16.w, 0, 16.w, 4.h),
      itemCount: _contents.length,
      separatorBuilder: (_, __) => SizedBox(height: 8.h),
      itemBuilder: (_, i) {
        final c = _contents[i];
        return Container(
          color: _kCard,
          padding: EdgeInsets.symmetric(horizontal: 14.w, vertical: 12.h),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(c.sku,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: GoogleFonts.spaceGrotesk(fontSize: 16.sp, fontWeight: FontWeight.w800, color: AppColors.textMain)),
                    if (c.desc.isNotEmpty)
                      Padding(
                        padding: EdgeInsets.only(top: 4.h),
                        child: Text(c.desc,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: GoogleFonts.manrope(fontSize: 14.sp, fontWeight: FontWeight.w700, color: AppColors.textMain)),
                      ),
                  ],
                ),
              ),
              SizedBox(width: 10.w),
              Text('×${c.qty}',
                  style: GoogleFonts.spaceGrotesk(fontSize: 22.sp, fontWeight: FontWeight.w800, color: AppColors.primary)),
            ],
          ),
        );
      },
    );
  }

  Widget _cleanBar(bool armed) {
    final bg = armed ? _kRed : _kSlate;
    final canUndo = _undoSkus.isNotEmpty;
    return Container(
      margin: EdgeInsets.fromLTRB(16.w, 6.h, 16.w, 0),
      color: bg,
      child: Row(
        children: [
          _barIcon(Icons.undo_rounded, canUndo ? _undo : null, dim: !canUndo),
          Expanded(
            child: InkWell(
              onTap: armed ? _clean : null,
              child: Padding(
                padding: EdgeInsets.symmetric(vertical: 14.h),
                child: Text('CLEAN & EMPTY BIN',
                    textAlign: TextAlign.center,
                    style: GoogleFonts.manrope(
                        fontSize: 14.sp, fontWeight: FontWeight.w800, letterSpacing: 1, color: Colors.white)),
              ),
            ),
          ),
          _barIcon(Icons.refresh_rounded, _binActive ? () => unawaited(_loadContents()) : null),
        ],
      ),
    );
  }

  Widget _barIcon(IconData icon, VoidCallback? onTap, {bool dim = false}) {
    return InkWell(
      onTap: onTap,
      child: SizedBox(
        width: 50.w,
        height: 50.h,
        child: Icon(icon, color: Colors.white.withValues(alpha: dim ? 0.4 : 1), size: 22.sp),
      ),
    );
  }

  Widget _statusLine() {
    final msg = _status ??
        (_binActive
            ? 'REVIEW — THEN CLEAN TO REMOVE ALL'
            : 'TRIGGER OR TAP SCAN BIN');
    final color = _status != null
        ? (_cleared ? _kSuccess : AppColors.primary)
        : _binActive
            ? _kMuted
            : _kRed;
    return Padding(
      padding: EdgeInsets.fromLTRB(18.w, 8.h, 18.w, 6.h),
      child: Text(msg,
          style: GoogleFonts.spaceGrotesk(
              fontSize: 12.5.sp, fontWeight: FontWeight.w800, letterSpacing: 1.4, color: color)),
    );
  }

  Widget _scanButton() {
    return Padding(
      padding: EdgeInsets.fromLTRB(16.w, 0, 16.w, 12.h),
      child: SizedBox(
        height: 52.h,
        child: Row(
          children: [
            Expanded(
              child: Material(
                color: const Color(0xFF0F5757),
                child: InkWell(
                  onTap: _scanCamera,
                  child: Center(
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(Icons.warehouse_outlined, color: Colors.white, size: 22.sp),
                        SizedBox(width: 10.w),
                        Text('SCAN BIN',
                            style: GoogleFonts.spaceGrotesk(
                                fontSize: 15.sp, fontWeight: FontWeight.w800, letterSpacing: 1, color: Colors.white)),
                      ],
                    ),
                  ),
                ),
              ),
            ),
            SizedBox(
              width: 56.w,
              child: Material(
                color: const Color(0xFF0A4A4A),
                child: InkWell(
                  onTap: _scanCamera,
                  child: SizedBox(
                    height: 52.h,
                    child: Icon(Icons.photo_camera_outlined, color: Colors.white, size: 22.sp),
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
