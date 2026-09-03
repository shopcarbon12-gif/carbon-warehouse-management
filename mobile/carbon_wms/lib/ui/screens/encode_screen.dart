import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/hardware/rfid_tag_read.dart';
import 'package:carbon_wms/hardware/rfid_vendor_channel.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/handheld_device_identity.dart';
import 'package:carbon_wms/services/lan_zpl_printer.dart';
import 'package:carbon_wms/services/mobile_settings_repository.dart';
import 'package:carbon_wms/services/scan_sounds.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/widgets/camera_barcode_scanner.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';
import 'package:carbon_wms/ui/widgets/rfid_power_slider.dart';
import 'package:carbon_wms/hardware/hardware_trigger.dart';

/// Handheld Encode — single-tag commissioning flow, redesigned 2026-06 on the
/// Encode & Print design system (approved mockup):
///
///   Step 1 (SKU):   barcode-first SKU pick (2D imager stays armed while you
///                   type; a scan overrides any typed text + auto-submits).
///                   Optional "Print also a non-RFID label?" toggle (OFF by
///                   default) decides whether the PRINT step exists.
///   Step 2 (Encode): the radio scans CONTINUOUSLY + SILENTLY; a hero readout
///                   shows the nearest tag (EPC + signal meter + decoded id).
///                   One trigger pull = mint EPC → write chip → AUTO-CONFIRM
///                   (re-read & verify). On a verified write the new EPC is
///                   promoted LIVE (in-stock) and the old EPC is permanently
///                   deleted from the catalog (encode-finalize).
///   Step 3 (Print): ONLY when the toggle is on — print the non-RFID label to
///                   the Zebra "NON-RFID PRINTER" (192.168.1.220) over TCP 9100.
///
/// Reads bypass [RfidManager]'s visibility filters and listen directly to
/// [RfidVendorChannel.tagReadStream].
class EncodeScreen extends StatefulWidget {
  const EncodeScreen({super.key, this.cloudGeigerResolveEpc});

  /// When opened from Cloud + Geiger → Take an Action, this is the EPC the
  /// handheld was sent. After we encode that specific tag we POST to
  /// /api/handheld/epc-queue to dismiss the drop. Null on every other path.
  final String? cloudGeigerResolveEpc;

  @override
  State<EncodeScreen> createState() => _EncodeScreenState();
}

enum _Step { sku, encode, printing, done, error }

// ── Encode-screen design system palette ─────────────────────────────────
const Color _kErrorRed = Color(0xFFD9534F);
const Color _kSuccessGreen = Color(0xFF2A8E2A);
const Color _kSuccessBg = Color(0xFFD6F5E6);
const Color _kAmber = Color(0xFFE08A2C);
// Result cards use a white fill (operator preference — no grey square inside
// the container). Kept as a named constant so all result cards stay in sync.
const Color _kCardGrey = Color(0xFFFFFFFF);
const Color _kTrayBg = Color(0xFFF4F7F7);
const Color _kTealLight = Color(0xFF2BA3A3);
const Color _kTextMuted = Color(0xFF8A9090);
const Color _kTextSlate = Color(0xFF3F4A4A);
const Color _kBorder = Color(0xFFD7DEDE);
const Color _kHair = Color(0x14000000);
const Color _kBtnDisabled = Color(0xFFBCC9C9);
const Color _kErrBg = Color(0xFFFFF4F4);
const Color _kPrimaryDk = Color(0xFF0F5757);
const String _kPrinterName = 'NON-RFID PRINTER';

class _EncodeScreenState extends State<EncodeScreen> {
  static const Duration _searchDebounce = Duration(milliseconds: 300);
  static const int _minQueryLen = 2;
  static const Duration _autoConfirmWindow = Duration(seconds: 2);

  RfidManager? _rfid;
  StreamSubscription<String>? _barcodeSub;
  StreamSubscription<RfidTagRead>? _tagSub;
  StreamSubscription<String>? _triggerSub;
  final ScanSounds _sounds = ScanSounds.instance;

  // SKU search
  final TextEditingController _searchCtrl = TextEditingController();
  Timer? _debounce;
  String _query = '';
  bool _searchLoading = false;
  String? _searchError;
  List<Map<String, dynamic>> _results = [];
  Map<String, dynamic>? _selectedSku;

  // Optional print (OFF by default).
  bool _printLabel = false;

  // flow
  _Step _step = _Step.sku;
  bool _busy = false;
  bool _scanning = false;
  int _powerDbm = 30;

  /// 0 = minting EPC, 1 = writing chip, 2 = auto-confirming (re-read).
  int _encodeStage = 0;

  // live nearest tag (Step 2)
  String? _nearestEpc;
  int? _nearestRssi;

  String? _newEpc;
  String? _printErr; // null = printed OK (or print skipped), else failure reason
  String? _errText;

  // Decoded info for the live nearest tag.
  Map<String, dynamic>? _nearestInfo;
  String? _infoEpc;
  Timer? _lookupTimer;

  // Post-encode status (LIVE by default on a confirmed encode).
  static const _statusOptions = <(String, String)>[
    ('in-stock', 'LIVE'),
    ('unknown', 'UNKNOWN'),
    ('tag_killed', 'TAG KILLED'),
  ];
  String _doneStatus = 'in-stock';
  bool _statusSaved = true;
  bool _savingStatus = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted) return;
      context.read<RfidManager>().scanContext = 'RE_ENCODE';
      _powerDbm = 20; // Encode default antenna power (per-screen)
      unawaited(_sounds.init());
      _wireStreams();
      await _armBarcodeMode();
      if (mounted) setState(() {});
    });
  }

  void _wireStreams() {
    // Barcode (2D) — only while picking a SKU. The imager stays armed while
    // the operator types; a scan overrides any typed text and auto-submits.
    _barcodeSub?.cancel();
    _barcodeSub = RfidVendorChannel.hardwareBarcodeStream().listen((raw) {
      if (!mounted || _step != _Step.sku) return;
      final code = raw.trim();
      if (code.isEmpty) return;
      if (RegExp(r'^[0-9A-F]{24}$').hasMatch(code.toUpperCase())) return; // ignore EPC reads
      _onBarcode(code);
    }, onError: (_) {});

    // RFID reads — captured live while Step 2 is scanning (not during encode).
    _tagSub?.cancel();
    _tagSub = RfidVendorChannel.tagReadStream().listen((read) {
      if (_step != _Step.encode || !_scanning || _busy) return;
      final epc = read.epcHex24;
      if (epc.length != 24) return;
      final rssi = read.rssi;
      final stronger =
          _nearestEpc == null || (rssi != null && (_nearestRssi == null || rssi > _nearestRssi!));
      if (stronger && mounted) {
        setState(() {
          _nearestEpc = epc.toUpperCase();
          if (rssi != null) _nearestRssi = rssi;
        });
        _scheduleNearestLookup();
      }
    }, onError: (_) {});

    // Trigger — commits the encode in Step 2.
    _triggerSub?.cancel();
    _triggerSub = hardwareTriggerFor(this).listen((event) {
      if (event == 'down' && _step == _Step.encode && !_busy) {
        unawaited(_runEncode());
      }
    }, onError: (_) {});
  }

  Future<void> _armBarcodeMode() async {
    // Fully leave RFID mode first. Without disableRfidFunctionMode() the
    // scanner service stays in RFID-trigger mode after an encode (armRfidMode
    // enabled it), so the trigger keeps firing the radio and the 2D laser never
    // lights when we return to the SKU step — the operator had to leave the
    // whole screen to recover. Mirrors the Item-Lookup barcode arm.
    await _rfid?.stopLocateScanning();
    await RfidVendorChannel.scannerDisableTriggerRelay();
    await RfidVendorChannel.disableRfidFunctionMode();
    await RfidVendorChannel.open2dBarcode();
    await RfidVendorChannel.scannerEnableTriggerRelay();
    await RfidVendorChannel.setZebraTriggerMode2D();
    unawaited(_sounds.setTagBeepSuppressed(false));
  }

  Future<void> _armRfidMode() async {
    _powerDbm = context.read<MobileSettingsRepository>().config.transferOutAntennaPower;
    await RfidVendorChannel.scannerDisableTriggerRelay();
    await RfidVendorChannel.close2dBarcode();
    await RfidVendorChannel.enableRfidFunctionMode();
    await RfidVendorChannel.setZebraTriggerModeRfid();
    unawaited(_sounds.setTagBeepSuppressed(true));
    await RfidVendorChannel.setAntennaPowerDbm(_powerDbm);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _rfid ??= context.read<RfidManager>();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _lookupTimer?.cancel();
    _searchCtrl.dispose();
    unawaited(_barcodeSub?.cancel());
    unawaited(_tagSub?.cancel());
    unawaited(_triggerSub?.cancel());
    unawaited(_rfid?.stopLocateScanning());
    _sounds.stopAll();
    unawaited(_sounds.setTagBeepSuppressed(false));
    unawaited(RfidVendorChannel.scannerDisableTriggerRelay());
    unawaited(RfidVendorChannel.close2dBarcode());
    unawaited(RfidVendorChannel.enableRfidFunctionMode());
    unawaited(RfidVendorChannel.setZebraTriggerModeRfid());
    super.dispose();
  }

  // ── Step 1: SKU selection (barcode + manual) ────────────────────────────
  /// Scan a SKU/UPC with the device camera and resolve it exactly like a
  /// hardware barcode scan.
  Future<void> _onCamera() async {
    final code = await openCameraBarcodeScanner(context, title: 'SCAN SKU');
    if (!mounted || code == null || code.trim().isEmpty) return;
    await _onBarcode(code.trim());
  }

  Future<void> _onBarcode(String code) async {
    _searchCtrl.text = code;
    _searchCtrl.selection = TextSelection.collapsed(offset: code.length);
    setState(() {
      _query = code;
      _searchLoading = true;
      _searchError = null;
      _results = [];
    });
    try {
      final rows = await _search(code);
      if (!mounted || _step != _Step.sku) return;
      final exact = rows.firstWhere(
        (r) => _digits(r['upc']) == _digits(code) || '${r['sku']}'.toUpperCase() == code.toUpperCase(),
        orElse: () => <String, dynamic>{},
      );
      if (exact.isNotEmpty) {
        await _pickSku(exact);
      } else if (rows.length == 1) {
        await _pickSku(rows.first);
      } else {
        setState(() {
          _results = rows;
          _searchLoading = false;
          if (rows.isEmpty) _searchError = 'No match for "$code" — type to search.';
        });
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _searchLoading = false;
        _searchError = 'Lookup failed: $e';
      });
    }
  }

  void _onSearchChanged(String value) {
    _debounce?.cancel();
    final trimmed = value.trim();
    if (trimmed.length < _minQueryLen) {
      if (_results.isNotEmpty || _query.isNotEmpty) {
        setState(() {
          _query = '';
          _results = [];
          _searchError = null;
        });
      }
      return;
    }
    _debounce = Timer(_searchDebounce, () async {
      if (!mounted || trimmed == _query) return;
      setState(() {
        _query = trimmed;
        _searchLoading = true;
        _searchError = null;
        _results = [];
      });
      try {
        final rows = await _search(trimmed);
        if (!mounted) return;
        setState(() {
          _results = rows;
          _searchLoading = false;
        });
      } catch (e) {
        if (!mounted) return;
        setState(() {
          _searchLoading = false;
          _searchError = 'Search failed: $e';
        });
      }
    });
  }

  Future<List<Map<String, dynamic>>> _search(String q) async {
    final res = await context.read<WmsApiClient>().fetchCatalogGrid(q: q, page: 1, limit: 100);
    return (res['rows'] as List?)?.whereType<Map<String, dynamic>>().toList() ?? [];
  }

  String _digits(dynamic v) => (v?.toString() ?? '').replaceAll(RegExp(r'[^0-9]'), '');

  Future<void> _pickSku(Map<String, dynamic> row) async {
    setState(() {
      _selectedSku = row;
      _results = [];
      _query = '';
      _searchCtrl.clear();
      _searchError = null;
    });
    await _goEncode();
  }

  Future<void> _goEncode() async {
    await _armRfidMode();
    if (!mounted) return;
    setState(() {
      _step = _Step.encode;
      // Force the scan latch open so the SAME-SKU re-arm below always starts a
      // fresh radio session — see _startScan's clean-restart note.
      _scanning = false;
      _nearestEpc = null;
      _nearestRssi = null;
      _nearestInfo = null;
      _infoEpc = null;
      _newEpc = null;
      _printErr = null;
      _encodeStage = 0;
    });
    await _startScan();
  }

  Future<void> _startScan() async {
    if (_scanning) return;
    // Clean stop→settle→start. On a FRESH entry the radio comes straight from
    // barcode mode so a plain start arms fine. But on the DONE → SAME SKU
    // re-arm we're right after a chip write: performWriteEpc power-cycles the
    // tag (setCW(0)/setPower(5)/setCW(1)) and the auto-confirm start/stop can
    // leave the native inventory latch (`scanning.getAndSet`) or the antenna PA
    // gate stale, so the next plain startInventory silently produces zero reads
    // — the operator sees "the RFID scanner won't trigger" for the same SKU.
    // An explicit stop first guarantees the native latch is cleared (and the
    // SDK path re-runs engageAntennaPaGate on the following start), so the
    // radio always re-arms.
    try {
      await _rfid?.stopLocateScanning();
    } catch (_) {}
    await Future<void>.delayed(const Duration(milliseconds: 60));
    try {
      await _rfid?.startLocateScanning();
    } catch (_) {/* simulated reads still arrive via the stream */}
    unawaited(_sounds.setTagBeepSuppressed(true));
    if (!mounted) return;
    setState(() => _scanning = true);
  }

  Future<void> _stopScan() async {
    if (!_scanning) return;
    try {
      await _rfid?.stopLocateScanning();
    } catch (_) {}
    if (!mounted) return;
    setState(() => _scanning = false);
  }

  /// Unconditional radio stop + beep silence. The native write resumes
  /// inventory on exit, and [_stopScan] is gated on [_scanning]; this forces
  /// the radio idle so the per-tag beep can't run until dispose.
  Future<void> _forceStopRadio() async {
    _scanning = false;
    try {
      await _rfid?.stopLocateScanning();
    } catch (_) {}
    unawaited(_sounds.setTagBeepSuppressed(true));
    if (mounted) setState(() {});
  }

  Future<void> _goSku() async {
    await _stopScan();
    await _armBarcodeMode();
    if (!mounted) return;
    setState(() {
      _selectedSku = null;
      _nearestEpc = null;
      _nearestRssi = null;
      _nearestInfo = null;
      _infoEpc = null;
      _newEpc = null;
      _printErr = null;
      _errText = null;
      _encodeStage = 0;
      _searchCtrl.clear();
      _query = '';
      _results = [];
      _searchError = null;
      _step = _Step.sku;
    });
  }

  void _scheduleNearestLookup() {
    final epc = _nearestEpc;
    if (epc == null || epc == _infoEpc) return;
    _lookupTimer?.cancel();
    _lookupTimer = Timer(const Duration(milliseconds: 350), () async {
      if (!mounted || _step != _Step.encode || _nearestEpc != epc) return;
      try {
        final rows = await context.read<WmsApiClient>().lookupEpcs([epc]);
        if (!mounted || _nearestEpc != epc) return;
        setState(() {
          _infoEpc = epc;
          _nearestInfo = rows.isNotEmpty ? rows.first : null;
        });
      } catch (_) {/* best-effort */}
    });
  }

  // ── Step 2: commit = write + auto-confirm ───────────────────────────────
  void _fail(String msg) {
    unawaited(_forceStopRadio());
    if (!mounted) return;
    setState(() {
      _busy = false;
      _step = _Step.error;
    });
    _errText = msg;
  }

  Future<void> _runEncode() async {
    final sku = _selectedSku;
    if (sku == null || _busy) return;
    final oldEpc = _nearestEpc;
    if (oldEpc == null) {
      _sounds.play(ScanCue.error);
      return; // hint already tells the operator to bring a tag closer
    }
    final customSku = sku['sku']?.toString() ?? '';
    if (customSku.isEmpty) {
      _fail('Selected SKU is missing its code.');
      return;
    }
    final api = context.read<WmsApiClient>();
    setState(() {
      _busy = true;
      _encodeStage = 0; // minting
      _newEpc = null;
      _errText = null;
    });
    _sounds.play(ScanCue.start);
    await _stopScan();

    Map<String, dynamic> resolved;
    try {
      resolved = await api.postEncodeResolveAndClaim(customSku: customSku, oldEpc: oldEpc);
    } on WmsApiException catch (e) {
      _fail(e.statusCode == 404 ? 'SKU not in catalog.' : 'Encode-claim failed (HTTP ${e.statusCode}).');
      return;
    } catch (_) {
      _fail('Encode-claim failed (network).');
      return;
    }

    final newEpc = (resolved['epc'] as String?)?.toUpperCase() ?? '';
    final customSkuId = resolved['customSkuId']?.toString() ?? '';
    if (newEpc.length != 24 || customSkuId.isEmpty) {
      _fail('Bad encode response from server.');
      return;
    }
    if (!mounted) return;
    setState(() => _encodeStage = 1); // writing

    bool written = false;
    try {
      written = await RfidVendorChannel.writeEpcTag(targetEpc: oldEpc, newEpc: newEpc);
    } catch (_) {
      written = false;
    }
    if (!written) {
      await _forceStopRadio();
      _sounds.play(ScanCue.error);
      _fail('Chip write/verify failed — tag NOT encoded. Re-present the tag and pull again.');
      return;
    }

    // AUTO-CONFIRM — re-read the chip to prove it now broadcasts the new EPC.
    // writeEpcTag already verifies internally; this is the operator-visible
    // confirm beat. Best-effort: a timeout doesn't fail the encode (the write
    // was verified), it just means the tag drifted out of range post-write.
    if (!mounted) return;
    setState(() => _encodeStage = 2); // auto-confirming
    await _autoConfirm(newEpc);
    await _forceStopRadio();

    try {
      // promoteNew:true → new EPC goes LIVE (in-stock); old EPC's items row is
      // permanently DELETED (removed from catalog + defective). Audit keeps
      // the old→new mapping.
      await api.postEncodeFinalize(newEpc: newEpc, oldEpc: oldEpc, promoteNew: true);
    } catch (_) {/* chip written; finalize is best-effort */}
    _sounds.play(ScanCue.success);

    // Cloud + Geiger auto-resolve.
    final resolveEpc = widget.cloudGeigerResolveEpc?.trim().toUpperCase();
    if (resolveEpc != null && resolveEpc == oldEpc.toUpperCase()) {
      unawaited(_dismissCloudGeiger(resolveEpc));
    }

    if (!mounted) return;
    setState(() {
      _newEpc = newEpc;
      _doneStatus = 'in-stock';
      _statusSaved = true;
      _savingStatus = false;
    });

    // Step 3 — print the companion non-RFID label ONLY when the toggle is on.
    if (!_printLabel) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _step = _Step.done;
        _printErr = null;
      });
      return;
    }

    setState(() {
      _step = _Step.printing;
    });
    String? printErr;
    try {
      final label = await api.getNonRfidLabel(customSkuId: customSkuId);
      final zpl = label['zpl']?.toString() ?? '';
      final host = label['printer_host']?.toString() ?? '192.168.1.220';
      final port = (label['printer_port'] as num?)?.toInt() ?? 9100;
      final uri = label['printer_uri']?.toString() ?? 'PSTPRNT';
      if (zpl.isEmpty) {
        printErr = 'No label ZPL returned.';
      } else {
        printErr = await LanZplPrinter.send(host: host, port: port, uri: uri, zpl: zpl);
      }
    } catch (e) {
      printErr = 'Label fetch failed: $e';
    }
    if (!mounted) return;
    setState(() {
      _busy = false;
      _step = _Step.done;
      _printErr = printErr;
    });
  }

  /// Brief re-read looking for [newEpc]. Returns when seen or after the window.
  Future<bool> _autoConfirm(String newEpc) async {
    final seen = Completer<bool>();
    StreamSubscription<RfidTagRead>? sub;
    sub = RfidVendorChannel.tagReadStream().listen((r) {
      if (r.epcHex24.toUpperCase() == newEpc && !seen.isCompleted) seen.complete(true);
    }, onError: (_) {});
    try {
      await _rfid?.startLocateScanning();
    } catch (_) {}
    unawaited(_sounds.setTagBeepSuppressed(true));
    final ok = await seen.future
        .timeout(_autoConfirmWindow, onTimeout: () => false)
        .catchError((_) => false);
    await sub.cancel();
    return ok;
  }

  Future<void> _saveDoneStatus() async {
    final epc = _newEpc;
    if (epc == null || _statusSaved || _savingStatus) return;
    final api = context.read<WmsApiClient>();
    setState(() => _savingStatus = true);
    try {
      await api.postBulkStatus(epcs: [epc], targetStatus: _doneStatus);
      if (!mounted) return;
      setState(() {
        _statusSaved = true;
        _savingStatus = false;
      });
      _sounds.play(ScanCue.success);
    } catch (_) {
      if (!mounted) return;
      setState(() => _savingStatus = false);
      _sounds.play(ScanCue.error);
    }
  }

  void _setDoneStatus(String v) {
    if (v == _doneStatus) return;
    setState(() {
      _doneStatus = v;
      _statusSaved = false;
    });
  }

  Future<void> _dismissCloudGeiger(String epc) async {
    try {
      final api = context.read<WmsApiClient>();
      final deviceId = await HandheldDeviceIdentity.primaryDeviceIdForServer();
      await api.dismissEpcQueueItems(deviceId: deviceId, epcs: [epc]);
    } catch (_) {/* best-effort */}
  }

  // ── render ──────────────────────────────────────────────────────────────
  @override
  Widget build(BuildContext context) {
    final showPower = (_step == _Step.encode && !_busy) || _step == _Step.error;
    return CarbonScaffold(
      pageTitle: 'ENCODE',
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _buildSteps(),
            _buildStepHint(),
            Expanded(child: _buildBody()),
            if (showPower) const RfidPowerSlider(defaultDbm: 20),
            _buildToolbar(),
          ],
        ),
      ),
    );
  }

  /// Step states. PRINT step only exists when the label toggle is on.
  List<(String, String)> _stepStates() {
    // returns [(label, state)] — state: done | active | idle | err
    if (_printLabel) {
      switch (_step) {
        case _Step.sku:
          return const [('SKU', 'active'), ('ENCODE', 'idle'), ('PRINT', 'idle')];
        case _Step.encode:
          return const [('SKU', 'done'), ('ENCODE', 'active'), ('PRINT', 'idle')];
        case _Step.printing:
          return const [('SKU', 'done'), ('ENCODE', 'done'), ('PRINT', 'active')];
        case _Step.done:
          return const [('SKU', 'done'), ('ENCODE', 'done'), ('PRINT', 'done')];
        case _Step.error:
          return const [('SKU', 'done'), ('ENCODE', 'err'), ('PRINT', 'idle')];
      }
    }
    switch (_step) {
      case _Step.sku:
        return const [('SKU', 'active'), ('ENCODE', 'idle')];
      case _Step.encode:
        return const [('SKU', 'done'), ('ENCODE', 'active')];
      case _Step.printing:
      case _Step.done:
        return const [('SKU', 'done'), ('ENCODE', 'done')];
      case _Step.error:
        return const [('SKU', 'done'), ('ENCODE', 'err')];
    }
  }

  Widget _buildSteps() {
    final st = _stepStates();

    Widget cell(int i) {
      final (label, s) = st[i];
      final accent = s == 'done'
          ? _kSuccessGreen
          : s == 'active'
              ? AppColors.primary
              : s == 'err'
                  ? _kErrorRed
                  : _kBtnDisabled;
      final bg = s == 'done'
          ? _kSuccessGreen
          : s == 'err'
              ? _kErrorRed
              : s == 'active'
                  ? AppColors.primary.withValues(alpha: 0.08)
                  : Colors.white;
      final fg = (s == 'done' || s == 'err') ? Colors.white : accent;
      final glyph = s == 'done'
          ? '✓'
          : s == 'err'
              ? '!'
              : '${i + 1}';
      return Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 36.w,
            height: 36.w,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: bg,
              shape: BoxShape.circle,
              border: Border.all(color: accent, width: 2),
            ),
            child: Text(glyph,
                style: GoogleFonts.spaceGrotesk(fontSize: 15.sp, fontWeight: FontWeight.w700, color: fg)),
          ),
          SizedBox(height: 5.h),
          Text(label,
              style: GoogleFonts.spaceGrotesk(
                  fontSize: 11.sp,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 0.6,
                  color: s == 'idle' ? _kTextMuted : accent)),
        ],
      );
    }

    Widget bar(int i) => Expanded(
          child: Container(
            margin: EdgeInsets.only(top: 17.w),
            height: 2,
            color: st[i].$2 == 'done' ? _kSuccessGreen : _kBtnDisabled,
          ),
        );

    final children = <Widget>[];
    for (var i = 0; i < st.length; i++) {
      children.add(cell(i));
      if (i < st.length - 1) children.add(bar(i));
    }
    return Container(
      color: Colors.white,
      padding: EdgeInsets.fromLTRB(18.w, 12.h, 18.w, 4.h),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: children),
    );
  }

  String _hintText() {
    switch (_step) {
      case _Step.sku:
        return 'Scan the product barcode — or type to search';
      case _Step.encode:
        if (_busy) {
          return _encodeStage >= 2 ? 'Written — auto-confirming the new tag…' : 'Hold the tag steady…';
        }
        return _nearestEpc == null
            ? 'Bring a tag close — pull the trigger to encode it'
            : 'Tag in range — pull the trigger to encode';
      case _Step.printing:
        return 'Confirmed ✓ — printing the label';
      case _Step.done:
        return 'All done — encode another or start a new item';
      case _Step.error:
        return 'Encode failed — re-present the tag and try again';
    }
  }

  Widget _buildStepHint() {
    final isErr = _step == _Step.error;
    return Container(
      color: Colors.white,
      padding: EdgeInsets.fromLTRB(18.w, 8.h, 18.w, 12.h),
      child: Text(
        _hintText(),
        textAlign: TextAlign.center,
        style: GoogleFonts.spaceGrotesk(
            fontSize: 12.sp, fontWeight: FontWeight.w600, color: isErr ? _kErrorRed : _kTextSlate),
      ),
    );
  }

  Widget _buildBody() {
    switch (_step) {
      case _Step.sku:
        return _skuPane();
      case _Step.encode:
        return _busy ? _encodingBody() : _encodeBody();
      case _Step.printing:
        return _printingBody();
      case _Step.done:
        return _doneBody();
      case _Step.error:
        return _errorBody();
    }
  }

  // ── Step 1 body ─────────────────────────────────────────────────────────
  Widget _skuPane() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: EdgeInsets.fromLTRB(16.w, 16.h, 16.w, 6.h),
          child: Stack(
            clipBehavior: Clip.none,
            children: [
              Container(
                decoration: BoxDecoration(
                  color: Colors.white,
                  border: Border.all(color: AppColors.primary, width: 2),
                  borderRadius: BorderRadius.circular(2.r),
                ),
                padding: EdgeInsets.symmetric(horizontal: 14.w, vertical: 12.h),
                child: Row(
                  children: [
                    Expanded(
                      child: TextField(
                        controller: _searchCtrl,
                        onChanged: _onSearchChanged,
                        decoration: const InputDecoration(
                          isCollapsed: true,
                          filled: false,
                          fillColor: Colors.transparent,
                          border: InputBorder.none,
                          enabledBorder: InputBorder.none,
                          focusedBorder: InputBorder.none,
                          disabledBorder: InputBorder.none,
                          contentPadding: EdgeInsets.zero,
                          hintText: 'scan barcode - or search',
                        ),
                        style: GoogleFonts.robotoMono(fontSize: 17.sp, fontWeight: FontWeight.w700, color: AppColors.textMain),
                      ),
                    ),
                    GestureDetector(
                      onTap: _onCamera,
                      behavior: HitTestBehavior.opaque,
                      child: Padding(
                        padding: EdgeInsets.only(left: 8.w),
                        child: Icon(Icons.photo_camera_outlined, size: 22.sp, color: AppColors.primary),
                      ),
                    ),
                  ],
                ),
              ),
              Positioned(
                top: -9.h,
                left: 12.w,
                child: Container(
                  color: Colors.white,
                  padding: EdgeInsets.symmetric(horizontal: 6.w),
                  child: Text('Search item',
                      style: GoogleFonts.spaceGrotesk(
                          fontSize: 11.sp, fontWeight: FontWeight.w700, letterSpacing: 0.6, color: _kTextSlate)),
                ),
              ),
              Positioned(
                top: -9.h,
                right: 12.w,
                child: Container(
                  decoration: BoxDecoration(color: AppColors.primary, borderRadius: BorderRadius.circular(3.r)),
                  padding: EdgeInsets.symmetric(horizontal: 8.w, vertical: 1.h),
                  child: Text('2D',
                      style: GoogleFonts.spaceGrotesk(
                          fontSize: 10.sp, fontWeight: FontWeight.w800, letterSpacing: 1.2, color: Colors.white)),
                ),
              ),
            ],
          ),
        ),
        if (_searchLoading) const LinearProgressIndicator(minHeight: 2),
        Expanded(child: _skuResults()),
        _printToggle(),
      ],
    );
  }

  Widget _printToggle() {
    return GestureDetector(
      onTap: () => setState(() => _printLabel = !_printLabel),
      behavior: HitTestBehavior.opaque,
      child: Container(
        margin: EdgeInsets.fromLTRB(16.w, 0, 16.w, 8.h),
        padding: EdgeInsets.symmetric(horizontal: 12.w, vertical: 12.h),
        decoration: BoxDecoration(
          color: Colors.white,
          border: Border.all(color: _kBorder),
          borderRadius: BorderRadius.circular(2.r),
        ),
        child: Row(
          children: [
            Icon(Icons.print_outlined, size: 24.sp, color: _kTextSlate),
            SizedBox(width: 8.w),
            Expanded(
              child: Text('Print also a non-RFID label?',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  softWrap: false,
                  style: GoogleFonts.spaceGrotesk(
                      fontSize: 15.5.sp, fontWeight: FontWeight.w700, color: AppColors.textMain)),
            ),
            SizedBox(width: 8.w),
            _MiniToggle(on: _printLabel),
          ],
        ),
      ),
    );
  }

  Widget _skuResults() {
    if (_searchError != null) {
      return Center(
        child: Padding(
          padding: EdgeInsets.symmetric(horizontal: 28.w),
          child: Text(_searchError!,
              textAlign: TextAlign.center, style: GoogleFonts.manrope(color: _kErrorRed, fontSize: 12.sp)),
        ),
      );
    }
    if (_results.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.qr_code_scanner, size: 40.sp, color: const Color(0xFF8FA1A1)),
            SizedBox(height: 12.h),
            Text('Pull the trigger to scan a barcode,\nor type above to search.',
                textAlign: TextAlign.center,
                style: GoogleFonts.manrope(color: const Color(0xFF6D7979), fontSize: 12.sp)),
          ],
        ),
      );
    }
    return Container(
      margin: EdgeInsets.fromLTRB(16.w, 12.h, 16.w, 8.h),
      decoration: BoxDecoration(color: Colors.white, border: Border.all(color: _kBorder), borderRadius: BorderRadius.circular(2.r)),
      child: ListView.separated(
        padding: EdgeInsets.zero,
        itemCount: _results.length,
        separatorBuilder: (_, __) => const Divider(height: 1, thickness: 1, color: Color(0xFFF0F2F2)),
        itemBuilder: (_, i) => _skuRow(_results[i]),
      ),
    );
  }

  Widget _skuRow(Map<String, dynamic> row) {
    final sku = row['sku']?.toString() ?? '';
    final desc = [row['name'], row['color'], row['size']]
        .map((e) => e?.toString() ?? '')
        .where((e) => e.trim().isNotEmpty)
        .join(' · ')
        .toUpperCase();
    return InkWell(
      onTap: () => _pickSku(row),
      child: Padding(
        padding: EdgeInsets.fromLTRB(16.w, 12.h, 16.w, 12.h),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(sku.isEmpty ? '—' : sku,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: GoogleFonts.robotoMono(fontSize: 17.sp, fontWeight: FontWeight.w700, color: AppColors.primary)),
            if (desc.isNotEmpty) ...[
              SizedBox(height: 3.h),
              Text(desc,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: GoogleFonts.manrope(fontSize: 14.sp, fontWeight: FontWeight.w700, color: AppColors.textMain)),
            ],
          ],
        ),
      ),
    );
  }

  // ── shared target card ──────────────────────────────────────────────────
  Widget _targetCard() {
    final s = _selectedSku;
    if (s == null) return const SizedBox.shrink();
    final desc = [s['name'], s['color'], s['size']]
        .map((e) => e?.toString() ?? '')
        .where((e) => e.trim().isNotEmpty)
        .join(' · ')
        .toUpperCase();
    return Container(
      margin: EdgeInsets.fromLTRB(16.w, 8.h, 16.w, 0),
      padding: EdgeInsets.fromLTRB(12.w, 9.h, 12.w, 9.h),
      decoration: BoxDecoration(
        color: AppColors.primary.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(6.r),
        border: const Border(left: BorderSide(color: AppColors.primary, width: 4)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text('TARGET SKU',
                  style: GoogleFonts.spaceGrotesk(
                      fontSize: 10.sp, fontWeight: FontWeight.w800, letterSpacing: 1.4, color: _kPrimaryDk)),
              if (_printLabel)
                Container(
                  decoration: BoxDecoration(color: AppColors.primary, borderRadius: BorderRadius.circular(3.r)),
                  padding: EdgeInsets.symmetric(horizontal: 7.w, vertical: 1.h),
                  child: Text('PRINT LABEL',
                      style: GoogleFonts.spaceGrotesk(
                          fontSize: 9.sp, fontWeight: FontWeight.w800, letterSpacing: 1, color: Colors.white)),
                ),
            ],
          ),
          SizedBox(height: 2.h),
          Text('${s['sku'] ?? ''}',
              style: GoogleFonts.robotoMono(fontSize: 15.sp, fontWeight: FontWeight.w700, color: AppColors.textMain)),
          if (desc.isNotEmpty)
            Text(desc, style: GoogleFonts.manrope(fontSize: 12.sp, fontWeight: FontWeight.w700, color: _kTextSlate)),
        ],
      ),
    );
  }

  // ── Step 2 body: hero live readout ──────────────────────────────────────
  int _signalBars() {
    final r = _nearestRssi;
    if (_nearestEpc == null || r == null) return 0;
    if (r >= -45) return 5;
    if (r >= -55) return 4;
    if (r >= -65) return 3;
    if (r >= -75) return 2;
    return 1;
  }

  Widget _signalMeter() {
    final bars = _signalBars();
    final color = bars >= 4 ? AppColors.primary : (bars >= 1 ? _kAmber : _kBtnDisabled);
    const heights = [10.0, 16.0, 22.0, 28.0, 34.0];
    return Padding(
      padding: EdgeInsets.symmetric(vertical: 8.h),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.end,
        children: List.generate(5, (i) {
          return Container(
            margin: EdgeInsets.symmetric(horizontal: 2.w),
            width: 7.w,
            height: heights[i].h,
            decoration: BoxDecoration(
              color: i < bars ? color : _kBtnDisabled.withValues(alpha: 0.5),
              borderRadius: BorderRadius.circular(1.r),
            ),
          );
        }),
      ),
    );
  }

  Widget _encodeBody() {
    final hasTag = _nearestEpc != null;
    final bars = _signalBars();
    final proximity = !hasTag
        ? 'no tag in range'
        : '${_nearestRssi ?? '—'} dBm · ${bars >= 4 ? 'very close' : bars >= 3 ? 'close' : bars >= 2 ? 'near' : 'far'}';
    return SingleChildScrollView(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _targetCard(),
          Container(
            margin: EdgeInsets.fromLTRB(16.w, 16.h, 16.w, 8.h),
            decoration: BoxDecoration(color: Colors.white, border: Border.all(color: _kBorder), borderRadius: BorderRadius.circular(10.r)),
            child: Column(
              children: [
                Container(
                  width: double.infinity,
                  color: _kTrayBg,
                  padding: EdgeInsets.symmetric(horizontal: 14.w, vertical: 8.h),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Text(hasTag ? 'NEAREST TAG (LIVE)' : 'NEAREST TAG',
                          style: GoogleFonts.spaceGrotesk(
                              fontSize: 10.sp, fontWeight: FontWeight.w800, letterSpacing: 1.4, color: _kTextMuted)),
                      Row(
                        children: [
                          Container(width: 8.w, height: 8.w, decoration: const BoxDecoration(color: AppColors.primary, shape: BoxShape.circle)),
                          SizedBox(width: 6.w),
                          Text(hasTag ? (bars >= 4 ? 'STRONG' : 'WEAK') : 'SCANNING',
                              style: GoogleFonts.spaceGrotesk(fontSize: 10.sp, fontWeight: FontWeight.w800, color: AppColors.primary)),
                        ],
                      ),
                    ],
                  ),
                ),
                Padding(
                  padding: EdgeInsets.fromLTRB(10.w, hasTag ? 16.h : 24.h, 10.w, 4.h),
                  child: Text(hasTag ? _nearestEpc! : '— — —',
                      textAlign: TextAlign.center,
                      style: GoogleFonts.robotoMono(
                          fontSize: hasTag ? 18.sp : 22.sp,
                          fontWeight: FontWeight.w700,
                          color: hasTag ? AppColors.primary : _kTextMuted)),
                ),
                _signalMeter(),
                Text(proximity, style: GoogleFonts.robotoMono(fontSize: 11.sp, color: _kTextMuted)),
                _decodedInfo(),
                SizedBox(height: 10.h),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _decodedInfo() {
    final info = _nearestInfo;
    if (_nearestEpc == null || info == null) return const SizedBox.shrink();
    if (info['valid'] != true) {
      return Padding(
        padding: EdgeInsets.only(top: 6.h),
        child: Text('fails formula — not a Carbon tag', style: GoogleFonts.manrope(fontSize: 11.sp, color: _kTextMuted)),
      );
    }
    final sku = info['sku']?.toString() ?? '';
    final desc = [info['productName'], info['color'], info['size']]
        .map((e) => e?.toString() ?? '')
        .where((e) => e.trim().isNotEmpty)
        .join(' · ');
    final status = info['status']?.toString() ?? '';
    return Container(
      margin: EdgeInsets.fromLTRB(12.w, 6.h, 12.w, 0),
      padding: EdgeInsets.only(top: 10.h),
      decoration: const BoxDecoration(border: Border(top: BorderSide(color: _kHair))),
      child: Column(
        children: [
          if (sku.isNotEmpty)
            Text(sku,
                textAlign: TextAlign.center,
                style: GoogleFonts.robotoMono(fontSize: 14.sp, fontWeight: FontWeight.w700, color: AppColors.textMain)),
          if (desc.isNotEmpty)
            Text(desc.toUpperCase(),
                textAlign: TextAlign.center,
                style: GoogleFonts.manrope(fontSize: 12.sp, fontWeight: FontWeight.w700, color: _kTextSlate)),
          if (status.isNotEmpty)
            Text('current status: $status', style: GoogleFonts.manrope(fontSize: 10.sp, color: _kTextMuted)),
        ],
      ),
    );
  }

  // ── Step 2 body: encode in progress (write + auto-confirm) ───────────────
  Widget _encodingBody() {
    Widget tick(String label, String state) {
      final Color bg;
      final Color fg;
      final String glyph;
      if (state == 'done') {
        bg = _kSuccessGreen;
        fg = Colors.white;
        glyph = '✓';
      } else if (state == 'now') {
        bg = AppColors.primary;
        fg = Colors.white;
        glyph = '●';
      } else {
        bg = const Color(0xFFEEEEEE);
        fg = _kTextMuted;
        glyph = '';
      }
      final txtColor = state == 'done'
          ? AppColors.textMain
          : state == 'now'
              ? AppColors.primary
              : _kTextMuted;
      return Padding(
        padding: EdgeInsets.symmetric(vertical: 6.h),
        child: Row(
          children: [
            Container(
              width: 28.w,
              height: 28.w,
              alignment: Alignment.center,
              decoration: BoxDecoration(color: bg, shape: BoxShape.circle),
              child: Text(glyph, style: TextStyle(fontSize: 15.sp, color: fg, fontWeight: FontWeight.w800)),
            ),
            SizedBox(width: 14.w),
            Text(label, style: GoogleFonts.spaceGrotesk(fontSize: 16.5.sp, fontWeight: FontWeight.w700, color: txtColor)),
          ],
        ),
      );
    }

    final mintState = _encodeStage >= 1 ? 'done' : 'now';
    final writeState = _encodeStage >= 2 ? 'done' : (_encodeStage == 1 ? 'now' : 'wait');
    final confirmState = _encodeStage >= 2 ? 'now' : 'wait';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _targetCard(),
        Expanded(
          child: Padding(
            padding: EdgeInsets.symmetric(horizontal: 36.w),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                SizedBox(
                  width: 54.w,
                  height: 54.w,
                  child: const CircularProgressIndicator(strokeWidth: 5, color: AppColors.primary),
                ),
                SizedBox(height: 24.h),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    tick('Mint new EPC', mintState),
                    tick('Write chip', writeState),
                    tick('Auto-confirm — re-read & verify', confirmState),
                  ],
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }

  // ── Step 3 body: printing ───────────────────────────────────────────────
  Widget _printingBody() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _doneBand('Chip confirmed ✓', 'New EPC verified on the chip', _kSuccessBg, _kSuccessGreen, const Color(0xFF2C6B46)),
        SizedBox(height: 16.h),
        Container(
          margin: EdgeInsets.symmetric(horizontal: 16.w),
          padding: EdgeInsets.all(14.w),
          decoration: BoxDecoration(color: _kTrayBg, border: Border.all(color: _kBorder), borderRadius: BorderRadius.circular(10.r)),
          child: Row(
            children: [
              Icon(Icons.print_outlined, size: 34.sp, color: _kTextSlate),
              SizedBox(width: 12.w),
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Printing non-RFID label…',
                      style: GoogleFonts.spaceGrotesk(fontSize: 16.sp, fontWeight: FontWeight.w700, color: AppColors.textMain)),
                  SizedBox(height: 3.h),
                  Text('192.168.1.220:9100', style: GoogleFonts.robotoMono(fontSize: 12.5.sp, color: _kTextMuted)),
                ],
              ),
            ],
          ),
        ),
        SizedBox(height: 26.h),
        const Center(child: CircularProgressIndicator(strokeWidth: 5, color: AppColors.primary)),
      ],
    );
  }

  // ── Done body ─────────────────────────────────────────────────────────
  Widget _doneBody() {
    final printedOk = !_printLabel || _printErr == null;
    final s = _selectedSku;
    final sku = s?['sku']?.toString() ?? '';
    final desc = [s?['name'], s?['color'], s?['size']]
        .map((e) => e?.toString() ?? '')
        .where((e) => e.trim().isNotEmpty)
        .join(' · ')
        .toUpperCase();
    return SingleChildScrollView(
      child: Padding(
        padding: EdgeInsets.fromLTRB(16.w, 12.h, 16.w, 12.h),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _doneBand(
              _printLabel ? 'Encoded ✓ & label printed' : 'Encoded ✓ & LIVE',
              _printLabel ? 'Tag committed · label sent to "$_kPrinterName"' : 'Tag committed · new EPC is LIVE',
              printedOk ? _kSuccessBg : _kErrBg,
              printedOk ? _kSuccessGreen : _kErrorRed,
              printedOk ? const Color(0xFF2C6B46) : const Color(0xFFA23B38),
              inset: false,
            ),
            // ITEM ENCODED
            Container(
              margin: EdgeInsets.only(top: 12.h),
              padding: EdgeInsets.fromLTRB(14.w, 11.h, 14.w, 11.h),
              decoration: BoxDecoration(
                color: _kCardGrey,
                borderRadius: BorderRadius.circular(8.r),
                border: const Border(left: BorderSide(color: _kSuccessGreen, width: 4)),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('ITEM ENCODED',
                      style: GoogleFonts.spaceGrotesk(fontSize: 10.sp, fontWeight: FontWeight.w800, letterSpacing: 1.4, color: _kTextMuted)),
                  SizedBox(height: 2.h),
                  Text(sku.isEmpty ? '—' : sku,
                      style: GoogleFonts.robotoMono(fontSize: 18.sp, fontWeight: FontWeight.w700, color: AppColors.textMain)),
                  if (desc.isNotEmpty)
                    Text(desc, style: GoogleFonts.manrope(fontSize: 12.5.sp, fontWeight: FontWeight.w700, color: _kTextSlate)),
                ],
              ),
            ),
            // NEW / OLD EPC
            Container(
              margin: EdgeInsets.only(top: 12.h),
              padding: EdgeInsets.fromLTRB(14.w, 12.h, 14.w, 12.h),
              decoration: BoxDecoration(color: _kCardGrey, borderRadius: BorderRadius.circular(8.r)),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('NEW EPC',
                      style: GoogleFonts.spaceGrotesk(fontSize: 9.sp, fontWeight: FontWeight.w800, letterSpacing: 1.2, color: _kTextMuted)),
                  Text(_newEpc ?? '—',
                      style: GoogleFonts.robotoMono(fontSize: 16.sp, fontWeight: FontWeight.w700, color: AppColors.textMain)),
                  SizedBox(height: 6.h),
                  Text('OLD EPC',
                      style: GoogleFonts.spaceGrotesk(fontSize: 9.sp, fontWeight: FontWeight.w800, letterSpacing: 1.2, color: _kTextMuted)),
                  Text(_nearestEpc ?? '—',
                      style: GoogleFonts.robotoMono(fontSize: 15.sp, fontWeight: FontWeight.w700, color: _kTextMuted)),
                  SizedBox(height: 5.h),
                  Text('Permanently deleted from all records (catalog · items · defective).',
                      style: GoogleFonts.manrope(fontSize: 10.5.sp, color: _kTextMuted)),
                ],
              ),
            ),
            _doneStatusTray(),
            if (_printLabel)
              Container(
                margin: EdgeInsets.only(top: 12.h),
                padding: EdgeInsets.symmetric(horizontal: 14.w, vertical: 10.h),
                decoration: BoxDecoration(
                    color: _printErr == null ? _kSuccessBg : _kErrBg, borderRadius: BorderRadius.circular(6.r)),
                child: Text(
                  _printErr == null ? '✓ Label printed to "$_kPrinterName"' : '✗ ${_printErr!} — fix the printer and reprint',
                  style: GoogleFonts.spaceGrotesk(
                      fontSize: 12.5.sp, fontWeight: FontWeight.w700, color: _printErr == null ? _kSuccessGreen : _kErrorRed),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _doneStatusTray() {
    final Color saveBg;
    final Color saveFg;
    final String saveLabel;
    if (_savingStatus) {
      saveBg = _kBtnDisabled;
      saveFg = Colors.white;
      saveLabel = 'SAVING…';
    } else if (_statusSaved) {
      saveBg = _kSuccessGreen;
      saveFg = Colors.white;
      saveLabel = 'SAVED';
    } else {
      saveBg = _kAmber;
      saveFg = Colors.white;
      saveLabel = 'SAVE';
    }
    return Container(
      margin: EdgeInsets.only(top: 12.h),
      padding: EdgeInsets.symmetric(horizontal: 14.w, vertical: 10.h),
      decoration: BoxDecoration(color: _kTrayBg, borderRadius: BorderRadius.circular(8.r)),
      child: Row(
        children: [
          Text('STATUS',
              style: GoogleFonts.spaceGrotesk(fontSize: 10.sp, fontWeight: FontWeight.w800, letterSpacing: 1.4, color: _kTextMuted)),
          SizedBox(width: 10.w),
          Expanded(
            child: Container(
              decoration: BoxDecoration(color: Colors.white, border: Border.all(color: _kBorder), borderRadius: BorderRadius.circular(4.r)),
              padding: EdgeInsets.symmetric(horizontal: 10.w),
              child: DropdownButtonHideUnderline(
                child: DropdownButton<String>(
                  isExpanded: true,
                  isDense: true,
                  value: _doneStatus,
                  items: _statusOptions
                      .map((o) => DropdownMenuItem<String>(
                            value: o.$1,
                            child: Text(o.$2,
                                style: GoogleFonts.spaceGrotesk(fontSize: 14.sp, fontWeight: FontWeight.w800, color: AppColors.textMain)),
                          ))
                      .toList(),
                  onChanged: _savingStatus ? null : (v) => v == null ? null : _setDoneStatus(v),
                ),
              ),
            ),
          ),
          SizedBox(width: 10.w),
          SizedBox(
            height: 36.h,
            child: Material(
              color: saveBg,
              borderRadius: BorderRadius.circular(4.r),
              child: InkWell(
                borderRadius: BorderRadius.circular(4.r),
                onTap: (_statusSaved || _savingStatus) ? null : () => _saveDoneStatus(),
                child: Container(
                  constraints: BoxConstraints(minWidth: 90.w),
                  alignment: Alignment.center,
                  padding: EdgeInsets.symmetric(horizontal: 16.w),
                  child: Text(saveLabel,
                      style: GoogleFonts.spaceGrotesk(fontSize: 13.sp, fontWeight: FontWeight.w800, letterSpacing: 1.2, color: saveFg)),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  // ── Error body ────────────────────────────────────────────────────────
  Widget _errorBody() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _targetCard(),
        Container(
          margin: EdgeInsets.fromLTRB(16.w, 10.h, 16.w, 0),
          padding: EdgeInsets.all(16.w),
          decoration: BoxDecoration(color: _kErrBg, border: Border.all(color: _kErrorRed), borderRadius: BorderRadius.circular(10.r)),
          child: Column(
            children: [
              Text('⚠ Chip write/verify failed',
                  textAlign: TextAlign.center,
                  style: GoogleFonts.spaceGrotesk(fontSize: 17.sp, fontWeight: FontWeight.w700, color: _kErrorRed)),
              SizedBox(height: 4.h),
              Text(
                _errText ?? 'Tag was NOT encoded. Bring the tag closer (or raise power) and pull again.',
                textAlign: TextAlign.center,
                style: GoogleFonts.manrope(fontSize: 12.5.sp, fontWeight: FontWeight.w600, color: const Color(0xFFA23B38)),
              ),
            ],
          ),
        ),
        SizedBox(height: 18.h),
        Center(
          child: Container(
            decoration: BoxDecoration(color: _kErrorRed.withValues(alpha: 0.14), borderRadius: BorderRadius.circular(4.r)),
            padding: EdgeInsets.symmetric(horizontal: 12.w, vertical: 6.h),
            child: Text('FAILED',
                style: GoogleFonts.spaceGrotesk(fontSize: 11.sp, fontWeight: FontWeight.w800, letterSpacing: 1.2, color: _kErrorRed)),
          ),
        ),
      ],
    );
  }

  Widget _doneBand(String big, String small, Color bg, Color fg, Color smallFg, {bool inset = true}) {
    return Container(
      margin: inset ? EdgeInsets.fromLTRB(16.w, 10.h, 16.w, 0) : EdgeInsets.zero,
      padding: EdgeInsets.all(16.w),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(10.r)),
      child: Column(
        children: [
          Text(big, textAlign: TextAlign.center, style: GoogleFonts.spaceGrotesk(fontSize: 18.sp, fontWeight: FontWeight.w700, color: fg)),
          SizedBox(height: 3.h),
          Text(small, textAlign: TextAlign.center, style: GoogleFonts.manrope(fontSize: 12.5.sp, fontWeight: FontWeight.w600, color: smallFg)),
        ],
      ),
    );
  }

  // ── bottom toolbar ──────────────────────────────────────────────────────
  Widget _buildToolbar() {
    final List<Widget> buttons;
    switch (_step) {
      case _Step.sku:
        return const SizedBox.shrink();
      case _Step.encode:
        if (_busy) {
          buttons = [Expanded(child: _tbButton(label: 'WORKING…', bg: _kBtnDisabled, onTap: null))];
        } else {
          buttons = [
            Expanded(flex: 14, child: _tbButton(label: 'CHANGE SKU', icon: Icons.swap_horiz, bg: _kTealLight, onTap: _goSku)),
            SizedBox(width: 10.w),
            Expanded(flex: 16, child: _tbButton(label: 'ENCODE & VERIFY', icon: Icons.bolt, bg: AppColors.primary, onTap: () => _runEncode())),
          ];
        }
        break;
      case _Step.printing:
        buttons = [Expanded(child: _tbButton(label: 'PRINTING…', bg: _kBtnDisabled, onTap: null))];
        break;
      case _Step.done:
        buttons = [
          Expanded(child: _tbButton(label: 'SAME SKU', icon: Icons.repeat, bg: AppColors.primary, onTap: _goEncode)),
          SizedBox(width: 10.w),
          Expanded(child: _tbButton(label: 'NEW ITEM', icon: Icons.qr_code_scanner, bg: Colors.white, fg: AppColors.primary, outlined: true, onTap: _goSku)),
        ];
        break;
      case _Step.error:
        buttons = [
          Expanded(flex: 14, child: _tbButton(label: 'CHANGE SKU', icon: Icons.swap_horiz, bg: _kTealLight, onTap: _goSku)),
          SizedBox(width: 10.w),
          Expanded(flex: 16, child: _tbButton(label: 'TRY AGAIN', icon: Icons.refresh, bg: _kAmber, onTap: _goEncode)),
        ];
        break;
    }
    return Container(
      decoration: const BoxDecoration(
        color: Colors.white,
        boxShadow: [BoxShadow(color: Color(0x14000000), offset: Offset(0, -6), blurRadius: 20)],
      ),
      padding: EdgeInsets.fromLTRB(12.w, 12.h, 12.w, 12.h),
      child: Row(children: buttons),
    );
  }

  Widget _tbButton({
    required String label,
    required Color bg,
    required VoidCallback? onTap,
    IconData? icon,
    Color fg = Colors.white,
    bool outlined = false,
  }) {
    return SizedBox(
      height: 56.h,
      child: Material(
        color: bg,
        borderRadius: BorderRadius.circular(3.r),
        shape: outlined
            ? RoundedRectangleBorder(borderRadius: BorderRadius.circular(3.r), side: const BorderSide(color: AppColors.primary, width: 1.5))
            : null,
        child: InkWell(
          borderRadius: BorderRadius.circular(3.r),
          onTap: onTap,
          child: Container(
            alignment: Alignment.center,
            padding: EdgeInsets.symmetric(horizontal: 8.w),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              mainAxisSize: MainAxisSize.min,
              children: [
                if (icon != null) ...[
                  Icon(icon, color: fg, size: 24.sp),
                  SizedBox(width: 8.w),
                ],
                Flexible(
                  child: Text(label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      softWrap: false,
                      style: GoogleFonts.spaceGrotesk(fontSize: 14.5.sp, fontWeight: FontWeight.w800, letterSpacing: 0.4, color: fg)),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Small on/off pill for the print toggle.
class _MiniToggle extends StatelessWidget {
  const _MiniToggle({required this.on});
  final bool on;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 46.w,
      height: 26.h,
      decoration: BoxDecoration(
        color: on ? AppColors.primary : const Color(0xFFCDD7D7),
        borderRadius: BorderRadius.circular(13.r),
      ),
      child: AnimatedAlign(
        duration: const Duration(milliseconds: 150),
        alignment: on ? Alignment.centerRight : Alignment.centerLeft,
        child: Container(
          margin: EdgeInsets.all(3.w),
          width: 20.w,
          height: 20.w,
          decoration: const BoxDecoration(color: Colors.white, shape: BoxShape.circle),
        ),
      ),
    );
  }
}
