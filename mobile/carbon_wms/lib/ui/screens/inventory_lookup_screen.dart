import 'dart:async';
import 'dart:convert';

import 'package:carbon_wms/hardware/rfid_tag_read.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/hardware/rfid_vendor_channel.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/mobile_permissions.dart';
import 'package:carbon_wms/services/epc_tenant_sync.dart';
import 'package:carbon_wms/services/mobile_settings_repository.dart';
import 'package:carbon_wms/services/scan_sounds.dart';
import 'package:carbon_wms/ui/screens/locate_tag_screen.dart';
import 'package:carbon_wms/ui/screens/geiger_search_screen.dart';
import 'package:carbon_wms/ui/widgets/camera_barcode_scanner.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';

/// Item Lookup — scan/type an EPC · UPC · SKU and get a centred product card
/// (image, name, SKU, on-hand, retail, current bin) plus a one-tap Geiger
/// LOCATE for chips. Rebuilt to the approved Item-Lookup-Redesign.html mockup.
///
/// Scanning model (handheld trigger drives ONE engine at a time):
///   • BARCODE mode (default) — trigger fires the 2D imager → UPC/hang-tag.
///   • RFID mode — trigger fires the UHF radio → nearest chip's EPC.
/// The on-screen toggle picks the mode (remembered per device); the camera
/// always scans a barcode and the keyboard always works.
class InventoryLookupScreen extends StatefulWidget {
  const InventoryLookupScreen({super.key});

  @override
  State<InventoryLookupScreen> createState() => _InventoryLookupScreenState();
}

enum _Mode { barcode, rfid }

class _InventoryLookupScreenState extends State<InventoryLookupScreen> {
  // ── mockup palette ──────────────────────────────────────────────────────────
  static const Color _ink = Color(0xFF171D1D);
  static const Color _slate = Color(0xFF3F4A4A);
  static const Color _muted = Color(0xFF8A9090);
  static const Color _teal = Color(0xFF1B7D7D);
  static const Color _green = Color(0xFF2A8E2A);
  static const Color _red = Color(0xFFD9534F);
  static const Color _surface = Color(0xFFF5F7F7);
  static const Color _card = Color(0xFFECECEC);
  static const Color _tileBg = Color(0xFFEEF4F3);
  static const Color _border2 = Color(0xFFBCC9C9);
  static const Color _border = Color(0xFFD7DEDE);

  static const String _modeKey = 'inventory_lookup_trigger_mode_v1';
  static const String _recentKey = 'inventory_lookup_recent_v1';

  static final RegExp _epc24 = RegExp(r'^[0-9A-F]{24}$');
  static final RegExp _hexBody = RegExp(r'^[0-9A-F]{4,}$');
  static final RegExp _digits = RegExp(r'^[0-9]{6,}$');

  final _ctrl = TextEditingController();

  _Mode _mode = _Mode.barcode;
  _LookupRow? _row;
  bool _busy = false;
  String? _err;

  /// Typeahead suggestions while typing (catalog matches to pick from).
  List<Map<String, dynamic>> _suggest = [];
  Timer? _suggestTimer;

  /// RFID read power (dBm) — live slider in RFID mode. Default 10.
  int _powerDbm = 10;

  /// Last few looked-up codes (client-side, no network) for one-tap rerun.
  List<_Recent> _recent = [];

  StreamSubscription<String>? _barcodeSub;
  StreamSubscription<RfidTagRead>? _tagSub;
  StreamSubscription<String>? _triggerSub;

  // RFID single-read capture (strongest-RSSI tag during a trigger pull).
  bool _rfidReading = false;
  String? _nearestEpc;
  int? _nearestRssi;
  Timer? _rfidWindow;

  RfidManager? _rfid;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      await _loadPrefs();
      if (!mounted) return;
      context.read<RfidManager>().scanContext = 'INVENTORY_LOOKUP';
      _wireStreams();
      await _armMode(_mode);
      if (mounted) setState(() {});
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _rfid ??= context.read<RfidManager>();
  }

  @override
  void dispose() {
    _rfidWindow?.cancel();
    _suggestTimer?.cancel();
    _barcodeSub?.cancel();
    _tagSub?.cancel();
    _triggerSub?.cancel();
    final r = _rfid;
    if (r != null) {
      unawaited(r.pauseScanning());
      unawaited(r.setSessionPowerOverrideDbm(null));
    }
    // Hand the next screen a ready 2D imager.
    unawaited(RfidVendorChannel.open2dBarcode());
    _ctrl.dispose();
    super.dispose();
  }

  // ── prefs ───────────────────────────────────────────────────────────────────
  Future<void> _loadPrefs() async {
    final prefs = await SharedPreferences.getInstance();
    final m = prefs.getString(_modeKey);
    _mode = m == 'rfid' ? _Mode.rfid : _Mode.barcode;
    final raw = prefs.getString(_recentKey);
    if (raw != null && raw.isNotEmpty) {
      try {
        final list = (jsonDecode(raw) as List).cast<Map<String, dynamic>>();
        _recent = list
            .map((e) => _Recent(
                  code: (e['code'] ?? '').toString(),
                  kind: (e['kind'] ?? 'SKU').toString(),
                ))
            .where((r) => r.code.isNotEmpty)
            .toList();
      } catch (_) {
        _recent = [];
      }
    }
  }

  Future<void> _saveMode() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_modeKey, _mode == _Mode.rfid ? 'rfid' : 'barcode');
  }

  Future<void> _pushRecent(String code, String kind) async {
    _recent.removeWhere((r) => r.code == code);
    _recent.insert(0, _Recent(code: code, kind: kind));
    if (_recent.length > 6) _recent = _recent.sublist(0, 6);
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(
      _recentKey,
      jsonEncode(_recent.map((r) => {'code': r.code, 'kind': r.kind}).toList()),
    );
  }

  // ── scanner wiring ────────────────────────────────────────────────────────────
  void _wireStreams() {
    _barcodeSub?.cancel();
    _barcodeSub = RfidVendorChannel.hardwareBarcodeStream().listen((raw) {
      if (!mounted || _mode != _Mode.barcode) return;
      final code = raw.trim();
      if (code.isNotEmpty) unawaited(_performLookup(code));
    }, onError: (_) {});

    _tagSub?.cancel();
    _tagSub = RfidVendorChannel.tagReadStream().listen((read) {
      if (_mode != _Mode.rfid || !_rfidReading) return;
      final epc = read.epcHex24.toUpperCase();
      if (epc.length != 24) return;
      final rssi = read.rssi;
      final stronger = _nearestEpc == null ||
          (rssi != null && (_nearestRssi == null || rssi > _nearestRssi!));
      if (stronger) {
        _nearestEpc = epc;
        if (rssi != null) _nearestRssi = rssi;
      }
    }, onError: (_) {});

    _triggerSub?.cancel();
    _triggerSub = RfidVendorChannel.hardwareTriggerStream().listen((event) {
      if (_mode != _Mode.rfid) return; // barcode is handled natively
      if (event == 'down' && !_busy) unawaited(_rfidSingleRead());
    }, onError: (_) {});
  }

  Future<void> _armMode(_Mode mode) async {
    try {
      if (mode == _Mode.barcode) {
        await RfidVendorChannel.scannerDisableTriggerRelay();
        await RfidVendorChannel.disableRfidFunctionMode();
        await RfidVendorChannel.open2dBarcode();
        await RfidVendorChannel.scannerEnableTriggerRelay();
        await RfidVendorChannel.setZebraTriggerMode2D();
      } else {
        await RfidVendorChannel.scannerDisableTriggerRelay();
        await RfidVendorChannel.close2dBarcode();
        await RfidVendorChannel.enableRfidFunctionMode();
        await RfidVendorChannel.setZebraTriggerModeRfid();
        await _applyPower();
      }
    } catch (_) {
      /* optional — mode best-effort across vendors */
    }
  }

  Future<void> _toggleMode(_Mode mode) async {
    if (_mode == mode) return;
    setState(() => _mode = mode);
    await _saveMode();
    await _armMode(mode);
    try {
      HapticFeedback.selectionClick();
    } catch (_) {}
  }

  Future<void> _rfidSingleRead() async {
    if (_rfidReading) return;
    _rfidWindow?.cancel();
    _nearestEpc = null;
    _nearestRssi = null;
    setState(() => _rfidReading = true);
    // No beep on trigger-pull — only beep when a tag is actually read (below).
    try {
      await RfidVendorChannel.startZebraInventory();
    } catch (_) {}
    try {
      await RfidVendorChannel.startChainwayInventory();
    } catch (_) {}
    // Single-shot window — collect the strongest tag, then resolve it.
    _rfidWindow = Timer(const Duration(milliseconds: 700), () async {
      try {
        await RfidVendorChannel.stopZebraInventory();
      } catch (_) {}
      try {
        await RfidVendorChannel.stopChainwayInventory();
      } catch (_) {}
      if (!mounted) return;
      setState(() => _rfidReading = false);
      final epc = _nearestEpc;
      if (epc != null) {
        // Beep only when a chip was actually read.
        try {
          ScanSounds.instance.play(ScanCue.success);
        } catch (_) {}
        unawaited(_performLookup(epc));
      } else {
        setState(() {
          _row = null;
          _err = 'No chip detected — aim closer and pull again.';
        });
      }
    });
  }

  // ── lookup ──────────────────────────────────────────────────────────────────
  Future<void> _onCamera() async {
    final code = await openCameraBarcodeScanner(context, title: 'SCAN BARCODE');
    if (!mounted || code == null || code.trim().isEmpty) return;
    await _performLookup(code.trim());
  }

  String _kindOf(String cleaned) {
    if (_epc24.hasMatch(cleaned)) return 'EPC';
    if (_digits.hasMatch(cleaned)) return 'UPC';
    return 'SKU';
  }

  String? _epcProfileHint(TenantEpcProfile p) =>
      '${p.name} · prefix ${p.epcPrefix} · item @${p.itemStartBit}+${p.itemLength} · serial @${p.serialStartBit}+${p.serialLength}';

  /// Debounced typeahead — show catalog matches to pick from while typing.
  void _onType(String v) {
    final t = v.trim();
    _suggestTimer?.cancel();
    if (t.length < 2) {
      if (_suggest.isNotEmpty) setState(() => _suggest = []);
      return;
    }
    _suggestTimer = Timer(const Duration(milliseconds: 280), () async {
      if (!mounted) return;
      try {
        final res =
            await context.read<WmsApiClient>().fetchCatalogGrid(q: t, limit: 14);
        if (!mounted) return;
        setState(() {
          _suggest = (res['rows'] as List?)
                  ?.whereType<Map<String, dynamic>>()
                  .toList() ??
              [];
          _row = null;
          _err = null;
        });
      } catch (_) {/* keep last suggestions */}
    });
  }

  Widget _suggestList() {
    return ListView.separated(
      padding: EdgeInsets.fromLTRB(16.w, 6.h, 16.w, 16.h),
      itemCount: _suggest.length,
      separatorBuilder: (_, __) => SizedBox(height: 8.h),
      itemBuilder: (_, i) {
        final r = _suggest[i];
        final sku = (r['sku'] ?? '').toString();
        final desc = [r['name'], r['color'], r['size']]
            .map((e) => (e ?? '').toString().trim())
            .where((e) => e.isNotEmpty)
            .join(' · ')
            .toUpperCase();
        final qty = (r['active_epc_count'] as num?)?.toInt() ?? 0;
        return GestureDetector(
          onTap: () {
            FocusScope.of(context).unfocus();
            setState(() => _suggest = []);
            unawaited(_performLookup(sku));
          },
          child: Container(
            color: _card,
            padding: EdgeInsets.symmetric(horizontal: 12.w, vertical: 12.h),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(sku,
                          style: GoogleFonts.robotoMono(
                              fontSize: 16.sp,
                              fontWeight: FontWeight.w700,
                              color: _ink)),
                      if (desc.isNotEmpty) ...[
                        SizedBox(height: 3.h),
                        Text(desc,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: GoogleFonts.manrope(
                                fontSize: 14.sp,
                                fontWeight: FontWeight.w600,
                                color: _slate)),
                      ],
                    ],
                  ),
                ),
                SizedBox(width: 10.w),
                Text('$qty',
                    style: GoogleFonts.spaceGrotesk(
                        fontSize: 18.sp,
                        fontWeight: FontWeight.w800,
                        color: _teal)),
              ],
            ),
          ),
        );
      },
    );
  }

  /// Strip the "Carbon" brand word from a display string (operator request).
  /// When the field is *only* the brand (e.g. vendor == "CARBON"), nothing is
  /// left → fall back to the em-dash placeholder rather than echo the brand.
  String _stripBrand(String s) {
    final cleaned = s
        .replaceAll(RegExp(r'\bcarbon\b', caseSensitive: false), '')
        .replaceAll(RegExp(r'\s+'), ' ')
        .trim();
    return cleaned.isNotEmpty ? cleaned : '—';
  }

  /// $XX for whole-dollar prices, $XX.XX when there are cents.
  String _fmtPrice(String raw) {
    if (raw.trim().isEmpty) return '—';
    final n = double.tryParse(raw.replaceAll('\$', '').trim());
    if (n == null) return raw.startsWith('\$') ? raw : '\$$raw';
    return n == n.truncateToDouble()
        ? '\$${n.toInt()}'
        : '\$${n.toStringAsFixed(2)}';
  }

  Future<void> _performLookup(String input) async {
    final raw = input.trim().toUpperCase();
    if (raw.isEmpty) return;
    _ctrl.text = raw;
    _suggestTimer?.cancel();
    setState(() {
      _busy = true;
      _err = null;
      _suggest = [];
    });

    final cleaned = raw.replaceAll(RegExp(r'\s'), '');
    final isEpc = _epc24.hasMatch(cleaned);
    final profiles = context.read<MobileSettingsRepository>().epcProfiles;
    final prof = _hexBody.hasMatch(cleaned)
        ? matchingEpcProfile(cleaned, profiles)
        : null;

    try {
      final api = context.read<WmsApiClient>();
      final map = await api.catalogGridSearchFirstRow(raw);
      if (!mounted) return;

      if (map != null) {
        var bin = '';
        if (isEpc) {
          try {
            final detail = await api.fetchItemDetailByEpc(cleaned);
            final item = detail?['item'];
            if (item is Map<String, dynamic>) {
              final bc = item['bin_code']?.toString().trim();
              if (bc != null && bc.isNotEmpty) bin = bc;
            }
          } catch (_) {/* optional enrichment */}
        }
        final upc =
            (map['sku_upc'] ?? map['matrix_upc'])?.toString().trim() ?? '';
        final sku = map['sku']?.toString().trim() ?? '';
        if (!mounted) return;
        setState(() {
          _row = _LookupRow(
            code: raw,
            isEpc: isEpc,
            sku: sku.isNotEmpty ? sku : upc,
            name: _stripBrand(map['name']?.toString().trim() ?? ''),
            upc: upc,
            vendor: _stripBrand(map['vendor']?.toString().trim() ?? ''),
            color: map['color']?.toString().trim() ?? '',
            size: map['size']?.toString().trim() ?? '',
            price: map['retail_price']?.toString().trim() ?? '',
            // On-hand = LIVE EPC count from the catalog, NOT the Lightspeed
            // on-hand total.
            quantity: ((map['active_epc_count'] as num?)?.toInt() ?? 0).toString(),
            bin: bin,
            epcHint: prof != null ? _epcProfileHint(prof) : null,
          );
          _busy = false;
        });
        await _pushRecent(raw, _kindOf(cleaned));
        if (mounted) setState(() {});
        return;
      }

      setState(() {
        _row = null;
        _err = prof != null
            ? 'No catalog row for this scan. The chip decoded (${prof.name}) but isn\'t in the catalog yet.'
            : 'No catalog match. Sync handheld settings (EPC profiles) or try the SKU / UPC.';
        _busy = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _row = null;
        _err = 'Lookup failed — check network and login.';
        _busy = false;
      });
    }
  }

  void _clear() {
    _ctrl.clear();
    setState(() {
      _row = null;
      _err = null;
    });
  }

  void _locate() {
    final r = _row;
    if (r == null || !r.isEpc) return;
    final epc = r.code.replaceAll(RegExp(r'\s'), '');
    Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder: (_) => LocateTagScreen(
          targetEpc: epc,
          targetBin: r.bin.isEmpty ? null : r.bin,
          targetSku: r.sku.isEmpty ? null : r.sku,
          targetName: r.name.isEmpty ? null : r.name,
          targetColor: r.color.isEmpty ? null : r.color,
          targetSize: r.size.isEmpty ? null : r.size,
        ),
      ),
    );
  }

  // ── build ───────────────────────────────────────────────────────────────────
  @override
  Widget build(BuildContext context) {
    return CarbonScaffold(
      pageTitle: 'ITEM LOOKUP',
      body: ColoredBox(
        color: _surface,
        child: Column(
          children: [
            _searchBar(),
            Expanded(
              child: _busy
                  ? const Center(child: CircularProgressIndicator(color: _teal))
                  : _suggest.isNotEmpty
                      ? _suggestList()
                      : _row != null
                          ? _result(_row!)
                          : _err != null
                              ? _notFound(_err!)
                              : _idle(),
            ),
            if (_mode == _Mode.rfid) _powerSlider(),
            _bottomBar(),
          ],
        ),
      ),
    );
  }

  Widget _searchBar() {
    return Padding(
      padding: EdgeInsets.fromLTRB(16.w, 14.h, 16.w, 10.h),
      child: Row(
        children: [
          Expanded(
            child: Container(
              decoration: BoxDecoration(
                color: Colors.white,
                border: Border.all(color: _border2, width: 1.5),
              ),
              padding: EdgeInsets.symmetric(horizontal: 12.w),
              child: Row(
                children: [
                  Icon(LucideIcons.search, size: 23.sp, color: _muted),
                  SizedBox(width: 9.w),
                  Expanded(
                    child: TextField(
                      controller: _ctrl,
                      onChanged: _onType,
                      onSubmitted: (v) => unawaited(_performLookup(v)),
                      textInputAction: TextInputAction.search,
                      style: GoogleFonts.robotoMono(
                        fontSize: 17.sp,
                        fontWeight: FontWeight.w700,
                        color: _ink,
                      ),
                      decoration: InputDecoration(
                        filled: false,
                        fillColor: Colors.transparent,
                        border: InputBorder.none,
                        enabledBorder: InputBorder.none,
                        focusedBorder: InputBorder.none,
                        isCollapsed: true,
                        contentPadding: EdgeInsets.symmetric(vertical: 16.h),
                        hintText: 'Scan or type EPC · UPC · SKU',
                        hintStyle: GoogleFonts.manrope(
                          fontSize: 16.sp,
                          fontWeight: FontWeight.w700,
                          color: _muted,
                        ),
                      ),
                    ),
                  ),
                  if (_ctrl.text.isNotEmpty)
                    GestureDetector(
                      onTap: _clear,
                      child: Icon(Icons.close, size: 19.sp, color: _muted),
                    ),
                ],
              ),
            ),
          ),
          SizedBox(width: 8.w),
          GestureDetector(
            onTap: _onCamera,
            child: Container(
              width: 52.w,
              height: 52.w,
              decoration: BoxDecoration(
                color: Colors.white,
                border: Border.all(color: _border2, width: 1.5),
              ),
              child: Icon(LucideIcons.camera, size: 24.sp, color: _teal),
            ),
          ),
        ],
      ),
    );
  }

  /// Bottom bar: BARCODE · (refresh) · RFID. Refresh starts a fresh 2D session.
  Widget _bottomBar() {
    Widget seg(_Mode m, IconData icon, String label) {
      final on = _mode == m;
      return Expanded(
        child: GestureDetector(
          onTap: () => _toggleMode(m),
          child: Container(
            height: 48.h,
            alignment: Alignment.center,
            color: on ? _teal : Colors.white,
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(icon, size: 18.sp, color: on ? Colors.white : _muted),
                SizedBox(width: 8.w),
                Text(
                  label,
                  style: GoogleFonts.spaceGrotesk(
                    fontSize: 14.sp,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 0.8,
                    color: on ? Colors.white : _muted,
                  ),
                ),
              ],
            ),
          ),
        ),
      );
    }

    return SafeArea(
      top: false,
      child: Container(
        color: _surface,
        padding: EdgeInsets.fromLTRB(16.w, 8.h, 16.w, 12.h),
        child: DecoratedBox(
          decoration:
              BoxDecoration(border: Border.all(color: _border2, width: 1.5)),
          child: Row(
            children: [
              seg(_Mode.barcode, Icons.barcode_reader, 'BARCODE'),
              Container(width: 1.5.w, color: _border2),
              GestureDetector(
                onTap: _newSession,
                child: Container(
                  width: 58.w,
                  height: 48.h,
                  color: Colors.white,
                  alignment: Alignment.center,
                  child: Icon(LucideIcons.refreshCw, size: 22.sp, color: _teal),
                ),
              ),
              Container(width: 1.5.w, color: _border2),
              seg(_Mode.rfid, LucideIcons.radio, 'RFID'),
            ],
          ),
        ),
      ),
    );
  }

  /// Live read-power slider — only shown in RFID mode. Default 10 dBm.
  Widget _powerSlider() {
    return Container(
      color: _surface,
      padding: EdgeInsets.fromLTRB(16.w, 4.h, 16.w, 0),
      child: Row(
        children: [
          Text('POWER',
              style: GoogleFonts.spaceGrotesk(
                  fontSize: 11.sp,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 1.0,
                  color: _muted)),
          Expanded(
            child: Slider(
              value: _powerDbm.toDouble(),
              min: 0,
              max: 30,
              divisions: 30,
              activeColor: _teal,
              label: '$_powerDbm dBm',
              onChanged: (v) => setState(() => _powerDbm = v.round()),
              onChangeEnd: (_) => unawaited(_applyPower()),
            ),
          ),
          SizedBox(width: 4.w),
          SizedBox(
            width: 56.w,
            child: Text('$_powerDbm dBm',
                textAlign: TextAlign.right,
                style: GoogleFonts.robotoMono(
                    fontSize: 13.sp, fontWeight: FontWeight.w700, color: _ink)),
          ),
        ],
      ),
    );
  }

  /// Refresh — clear the result and start a fresh BARCODE (2D-scan) session.
  void _newSession() {
    _ctrl.clear();
    setState(() {
      _row = null;
      _err = null;
      _suggest = [];
    });
    if (_mode != _Mode.barcode) {
      unawaited(_toggleMode(_Mode.barcode));
    } else {
      unawaited(_armMode(_Mode.barcode));
    }
  }

  Future<void> _applyPower() async {
    try {
      await _rfid?.setSessionPowerOverrideDbm(_powerDbm);
    } catch (_) {}
    try {
      await RfidVendorChannel.setAntennaPowerDbm(_powerDbm);
    } catch (_) {}
  }

  // ── states ────────────────────────────────────────────────────────────────────
  Widget _idle() {
    return ListView(
      padding: EdgeInsets.fromLTRB(16.w, 8.h, 16.w, 24.h),
      children: [
        SizedBox(height: 18.h),
        Center(
          child: Container(
            width: 108.w,
            height: 108.w,
            decoration: const BoxDecoration(
                color: Color(0xFFEAF3F2), shape: BoxShape.circle),
            child: Icon(
              _rfidReading
                  ? LucideIcons.radio
                  : (_mode == _Mode.rfid
                      ? LucideIcons.radio
                      : Icons.barcode_reader),
              size: 50.sp,
              color: _teal,
            ),
          ),
        ),
        SizedBox(height: 16.h),
        Text(
          _rfidReading ? 'Reading chip…' : 'Pull the trigger to scan',
          textAlign: TextAlign.center,
          style: GoogleFonts.spaceGrotesk(
              fontSize: 20.sp, fontWeight: FontWeight.w800, color: _ink),
        ),
        SizedBox(height: 8.h),
        Padding(
          padding: EdgeInsets.symmetric(horizontal: 30.w),
          child: Text(
            _mode == _Mode.rfid
                ? 'The trigger reads a chip (EPC). Flip the toggle to BARCODE for a printed tag. The camera and keyboard work too.'
                : 'The trigger reads a barcode (UPC / hang-tag). Flip the toggle to RFID to read a chip. The camera and keyboard work too.',
            textAlign: TextAlign.center,
            style: GoogleFonts.manrope(
                fontSize: 15.sp, fontWeight: FontWeight.w600, color: _muted),
          ),
        ),
      ],
    );
  }

  Widget _result(_LookupRow r) {
    final desc = [r.color, r.size]
        .map((e) => e.trim())
        .where((e) => e.isNotEmpty)
        .toList();
    final price = _fmtPrice(r.price);
    // Role-gated field visibility (e.g. employees may not see price/vendor/qty).
    final perms = context.read<MobilePermissions>();
    final showPrice = perms.showField(FieldFlags.showRetailPrice);
    final showVendor = perms.showField(FieldFlags.showVendor);
    final showOnHand = perms.showField(FieldFlags.showOnHand);
    return ListView(
      padding: EdgeInsets.fromLTRB(16.w, 14.h, 16.w, 24.h),
      children: [
        // hero — bigger image on the LEFT, item info to its right (left-aligned)
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 128.w,
              height: 128.w,
              decoration: BoxDecoration(
                color: const Color(0xFFEAF0F0),
                borderRadius: BorderRadius.circular(6.r),
                border: Border.all(color: _border),
              ),
              child: Icon(Icons.image_outlined, size: 56.sp, color: _muted),
            ),
            SizedBox(width: 14.w),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    r.name,
                    style: GoogleFonts.spaceGrotesk(
                        fontSize: 22.sp,
                        fontWeight: FontWeight.w800,
                        color: _ink,
                        height: 1.15),
                  ),
                  SizedBox(height: 6.h),
                  Text(
                    r.sku,
                    style: GoogleFonts.robotoMono(
                        fontSize: 16.sp,
                        fontWeight: FontWeight.w700,
                        color: _teal),
                  ),
                  if (r.upc.isNotEmpty) ...[
                    SizedBox(height: 4.h),
                    Text(
                      'UPC ${r.upc}',
                      style: GoogleFonts.robotoMono(
                          fontSize: 13.sp,
                          fontWeight: FontWeight.w600,
                          color: _muted),
                    ),
                  ],
                  if (r.vendor.isNotEmpty && showVendor) ...[
                    SizedBox(height: 4.h),
                    Text(
                      r.vendor.toUpperCase(),
                      style: GoogleFonts.manrope(
                          fontSize: 12.sp,
                          fontWeight: FontWeight.w600,
                          color: _muted),
                    ),
                  ],
                  if (desc.isNotEmpty) ...[
                    SizedBox(height: 10.h),
                    Wrap(
                      spacing: 7.w,
                      runSpacing: 7.h,
                      children: [for (final d in desc) _chip(d.toUpperCase())],
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
        SizedBox(height: 14.h),
        // tiles (role-gated: hide ON HAND / RETAIL per field visibility)
        if (showOnHand || showPrice)
          Row(
            children: [
              if (showOnHand)
                _tile('ON HAND', r.quantity.isEmpty ? '—' : r.quantity,
                    color: _green),
              if (showOnHand && showPrice) SizedBox(width: 10.w),
              if (showPrice) _tile('RETAIL', price, color: _ink),
            ],
          ),
        if (showOnHand || showPrice) SizedBox(height: 14.h),
        // location
        _locationBlock(r),
        SizedBox(height: 14.h),
        // identifiers
        _identifiers(r),
        if (r.epcHint != null && r.epcHint!.isNotEmpty) ...[
          SizedBox(height: 12.h),
          Text(
            r.epcHint!,
            textAlign: TextAlign.center,
            style: GoogleFonts.robotoMono(
                fontSize: 11.5.sp, fontWeight: FontWeight.w500, color: _muted),
          ),
        ],
      ],
    );
  }

  Widget _chip(String t) => Container(
        padding: EdgeInsets.symmetric(horizontal: 14.w, vertical: 7.h),
        decoration: BoxDecoration(
          color: const Color(0xFFECF1F1),
          border: Border.all(color: _border),
        ),
        child: Text(
          t,
          style: GoogleFonts.spaceGrotesk(
              fontSize: 13.sp, fontWeight: FontWeight.w800, color: _slate),
        ),
      );

  Widget _tile(String label, String value, {required Color color}) {
    return Expanded(
      child: Container(
        height: 82.h,
        color: _tileBg,
        alignment: Alignment.center,
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text(
              label,
              style: GoogleFonts.manrope(
                fontSize: 12.sp,
                fontWeight: FontWeight.w800,
                letterSpacing: 0.6,
                color: _muted,
              ),
            ),
            SizedBox(height: 3.h),
            Text(
              value,
              style: GoogleFonts.spaceGrotesk(
                fontSize: 34.sp,
                fontWeight: FontWeight.w700,
                letterSpacing: -1,
                height: 1.0,
                color: color,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _locationBlock(_LookupRow r) {
    return Container(
      width: double.infinity,
      color: Colors.white,
      padding: EdgeInsets.fromLTRB(14.w, 16.h, 14.w, 16.h),
      child: Column(
        children: [
          Text(
            'CURRENT BIN',
            style: GoogleFonts.spaceGrotesk(
              fontSize: 12.sp,
              fontWeight: FontWeight.w800,
              letterSpacing: 1.6,
              color: _muted,
            ),
          ),
          SizedBox(height: 6.h),
          if (r.isEpc && r.bin.isNotEmpty)
            Text(
              r.bin,
              textAlign: TextAlign.center,
              style: GoogleFonts.robotoMono(
                  fontSize: 32.sp, fontWeight: FontWeight.w700, color: _ink),
            )
          else
            Padding(
              padding: EdgeInsets.symmetric(vertical: 6.h),
              child: Text(
                r.isEpc
                    ? 'No bin on file for this chip'
                    : 'Scan the chip to pinpoint a bin',
                textAlign: TextAlign.center,
                style: GoogleFonts.manrope(
                    fontSize: 16.sp,
                    fontWeight: FontWeight.w600,
                    color: _muted),
              ),
            ),
          SizedBox(height: 14.h),
          SizedBox(
            height: 56.h,
            width: double.infinity,
            child: r.isEpc
                ? FilledButton.icon(
                    onPressed: _locate,
                    style: FilledButton.styleFrom(
                      backgroundColor: _teal,
                      foregroundColor: Colors.white,
                      shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(2.r)),
                      textStyle: GoogleFonts.spaceGrotesk(
                          fontSize: 16.sp,
                          fontWeight: FontWeight.w800,
                          letterSpacing: 0.8),
                    ),
                    icon: Icon(Icons.sensors, size: 22.sp),
                    label: const Text('LOCATE TAG · GEIGER'),
                  )
                : FilledButton.icon(
                    // SKU/UPC has many units — Geiger any of them (nearest).
                    onPressed: () => Navigator.of(context).push<void>(
                      MaterialPageRoute<void>(
                        builder: (_) => GeigerSearchScreen(
                            initialQuery: r.sku.isNotEmpty ? r.sku : r.upc),
                      ),
                    ),
                    style: FilledButton.styleFrom(
                      backgroundColor: _teal,
                      foregroundColor: Colors.white,
                      shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(2.r)),
                      textStyle: GoogleFonts.spaceGrotesk(
                          fontSize: 16.sp,
                          fontWeight: FontWeight.w800,
                          letterSpacing: 0.8),
                    ),
                    icon: Icon(Icons.sensors, size: 22.sp),
                    label: const Text('LOCATE  ·  GEIGER'),
                  ),
          ),
        ],
      ),
    );
  }

  Widget _identifiers(_LookupRow r) {
    final rows = <List<String>>[
      if (r.isEpc) ['EPC', r.code] else ['SCANNED', r.code],
      ['SKU', r.sku],
      if (r.upc.isNotEmpty) ['UPC', r.upc],
    ];
    return Container(
      decoration: BoxDecoration(
        color: Colors.white,
        border: Border.all(color: _border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: EdgeInsets.fromLTRB(14.w, 12.h, 14.w, 8.h),
            child: Text(
              'IDENTIFIERS',
              style: GoogleFonts.spaceGrotesk(
                fontSize: 11.sp,
                fontWeight: FontWeight.w800,
                letterSpacing: 1.6,
                color: _muted,
              ),
            ),
          ),
          for (final kv in rows)
            Container(
              padding: EdgeInsets.symmetric(horizontal: 14.w, vertical: 11.h),
              decoration: const BoxDecoration(
                border: Border(top: BorderSide(color: Color(0xFFECF1F1))),
              ),
              child: Row(
                children: [
                  Text(
                    kv[0],
                    style: GoogleFonts.spaceGrotesk(
                      fontSize: 12.sp,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 0.8,
                      color: _slate,
                    ),
                  ),
                  SizedBox(width: 12.w),
                  Expanded(
                    child: Text(
                      kv[1].isEmpty ? '—' : kv[1],
                      textAlign: TextAlign.right,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: GoogleFonts.robotoMono(
                          fontSize: 15.sp,
                          fontWeight: FontWeight.w700,
                          color: _ink),
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Widget _notFound(String msg) {
    return ListView(
      padding: EdgeInsets.fromLTRB(30.w, 40.h, 30.w, 24.h),
      children: [
        Center(
          child: Container(
            width: 96.w,
            height: 96.w,
            decoration: const BoxDecoration(
                color: Color(0xFFFDECEA), shape: BoxShape.circle),
            child: Icon(Icons.search_off, size: 44.sp, color: _red),
          ),
        ),
        SizedBox(height: 16.h),
        Text(
          'No catalog match',
          textAlign: TextAlign.center,
          style: GoogleFonts.spaceGrotesk(
              fontSize: 21.sp, fontWeight: FontWeight.w800, color: _ink),
        ),
        SizedBox(height: 14.h),
        Center(
          child: Container(
            color: _card,
            padding: EdgeInsets.symmetric(horizontal: 13.w, vertical: 9.h),
            child: Text(
              _ctrl.text.isEmpty ? '—' : _ctrl.text,
              style: GoogleFonts.robotoMono(
                  fontSize: 15.sp, fontWeight: FontWeight.w700, color: _slate),
            ),
          ),
        ),
        SizedBox(height: 14.h),
        Text(
          msg,
          textAlign: TextAlign.center,
          style: GoogleFonts.manrope(
              fontSize: 14.sp, fontWeight: FontWeight.w600, color: _muted),
        ),
        SizedBox(height: 18.h),
        Center(
          child: SizedBox(
            height: 50.h,
            child: OutlinedButton.icon(
              onPressed: _ctrl.text.isEmpty
                  ? null
                  : () => unawaited(_performLookup(_ctrl.text)),
              style: OutlinedButton.styleFrom(
                backgroundColor: Colors.white,
                foregroundColor: _teal,
                side: const BorderSide(color: _teal, width: 1.5),
                shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(2.r)),
                padding: EdgeInsets.symmetric(horizontal: 26.w),
                textStyle: GoogleFonts.spaceGrotesk(
                    fontSize: 15.sp,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 0.8),
              ),
              icon: Icon(Icons.refresh, size: 20.sp),
              label: const Text('RETRY'),
            ),
          ),
        ),
      ],
    );
  }
}

class _Recent {
  const _Recent({required this.code, required this.kind});
  final String code;
  final String kind; // EPC | UPC | SKU
}

class _LookupRow {
  const _LookupRow({
    required this.code,
    required this.isEpc,
    required this.sku,
    required this.name,
    required this.bin,
    this.upc = '',
    this.vendor = '',
    this.color = '',
    this.size = '',
    this.price = '',
    this.quantity = '',
    this.epcHint,
  });

  final String code;
  final bool isEpc;
  final String sku;
  final String name;
  final String bin;
  final String upc;
  final String vendor;
  final String color;
  final String size;
  final String price;
  final String quantity;
  final String? epcHint;
}
