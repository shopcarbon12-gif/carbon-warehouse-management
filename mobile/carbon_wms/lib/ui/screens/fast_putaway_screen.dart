import 'dart:async';

import 'package:flutter/foundation.dart' show defaultTargetPlatform, kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:flutter/services.dart'
    show DeviceOrientation, EventChannel, SystemChrome, SystemUiOverlayStyle,
        TextEditingValue, TextInputFormatter, TextSelection;
import 'package:google_fonts/google_fonts.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:carbon_wms/hardware/rfid_vendor_channel.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/handheld_device_identity.dart';
import 'package:carbon_wms/services/mobile_settings_repository.dart';
import 'package:carbon_wms/services/scan_sounds.dart';
import 'package:carbon_wms/services/mobile_permissions.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/guards/permission_guard.dart';
import 'package:carbon_wms/ui/widgets/camera_barcode_scanner.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart' show WmsText;
import 'package:carbon_wms/services/bin_assign_session.dart';
import 'package:carbon_wms/ui/screens/bin_assign_settings_screen.dart';
import 'package:carbon_wms/ui/screens/epc_detail_screen.dart';
import 'package:carbon_wms/ui/screens/handheld_settings_screen.dart';
import 'package:carbon_wms/ui/screens/inventory_catalog_screen.dart';
import 'package:carbon_wms/ui/screens/geiger_search_screen.dart';
import 'package:carbon_wms/ui/screens/print_screen.dart';
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
//
// Carbon's custom-SKU layout (matches the catalog wording in
// `bin-assign-spec.html`):
//
//                ┌── base ──┐┌── color ──┐┌── size ──┐
//   modern (C-prefix):   C12345678         B8           L
//                       (9 chars)        (2 chars)   (rest)
//   legacy:              1234567           B8           L
//                       (7 chars)        (2 chars)   (rest)
//
// `baseColor` = base + color  (the matrix+colour scope used by the server's
// `single_color_all_sizes` putaway endpoint — assigning all sizes of one
// colour). `base` alone is the matrix scope (every colour, every size).
//
// Backwards-compatible getters [searchKeySpecific] and [sizeCode] mirror the
// pre-1.2.23 field names so other code paths (assign dialog, undo, etc.)
// continue to compile while we phase the new spec terminology in.

class _SkuParts {
  const _SkuParts({
    required this.raw,
    required this.base,
    required this.colorCode,
    required this.size,
    required this.baseColor,
  });

  /// Full input from the operator (uppercased, trimmed). Includes size if scanned.
  final String raw;

  /// Matrix-only key — every colour, every size.
  final String base;

  /// Two-character colour code (when present).
  final String colorCode;

  /// Size suffix (length varies per product line). Spec wording.
  final String size;

  /// `base` + `colorCode` — every size of one colour. The matrix+colour
  /// putaway scope. Spec wording.
  final String baseColor;

  /// Backwards-compatible alias for [baseColor]. Prefer [baseColor] in new code.
  String get searchKeySpecific => baseColor;

  /// Backwards-compatible alias for [size]. Prefer [size] in new code.
  String get sizeCode => size;

  /// Backwards-compatible alias for [base]. Prefer [base] in new code.
  String get searchKeyAllColors => base;

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
        size: size,
        baseColor: s.length >= 11 ? s.substring(0, 11) : s,
      );
    } else if (s.length >= 7) {
      final base = s.substring(0, 7);
      final color = s.length >= 9 ? s.substring(7, 9) : '';
      final size = s.length > 9 ? s.substring(9) : '';
      return _SkuParts(
        raw: s,
        base: base,
        colorCode: color,
        size: size,
        baseColor: s.length >= 9 ? s.substring(0, 9) : s,
      );
    }
    return _SkuParts(
      raw: s,
      base: s,
      colorCode: '',
      size: '',
      baseColor: s,
    );
  }
}

// ── Stored Item model ─────────────────────────────────────────────────────────
//
// One row in the bin's stored-items list. Mirrors the server response shape
// from `lib/queries/locations.ts:listBinContentsGrouped`. The server filters
// to `items.status = 'in-stock'` so anything we receive here is a "live"
// (catalog-sellable) EPC — see `lib/server/wms-status-to-label-name.ts`.

class _StoredItem {
  const _StoredItem({
    required this.sku,
    required this.description,
    required this.colorCode,
    required this.size,
    required this.qty,
    required this.epcs,
  });

  /// Full custom SKU, e.g. `C12345678B8L`.
  final String sku;

  /// Matrix description (the human item name), e.g. `Slim Fit Jeans`.
  final String description;

  /// Two-letter colour code from the custom SKU, e.g. `B8`.
  final String colorCode;

  /// Size suffix from the custom SKU, e.g. `L` or `32W`.
  final String size;

  /// Live EPC count for this SKU in this bin (`status = 'in-stock'` only).
  final int qty;

  /// Live EPC list for the row-tap → EPC detail screen.
  final List<String> epcs;

  static _StoredItem fromMap(Map<String, dynamic> m) {
    final rawEpcs = m['epcs'];
    final epcs = rawEpcs is List
        ? rawEpcs.map((e) => e.toString()).toList()
        : <String>[];
    return _StoredItem(
      sku: m['sku']?.toString() ?? '',
      description: m['description']?.toString() ?? '',
      colorCode: (m['color_code'] ?? m['color'] ?? '').toString(),
      size: (m['size'] ?? '').toString(),
      qty: m['qty'] as int? ?? m['quantity'] as int? ?? epcs.length,
      epcs: epcs,
    );
  }
}

/// User's resolution to the multi-bin prompt fired by [_doAssign] when the
/// preview shows EPCs of the scanned SKU sitting in some other bin.
enum _MoveOrAddChoice {
  /// Move every matching EPC (including those already in other bins) here.
  move,

  /// Leave existing assignments alone; only place homeless EPCs here.
  add,

  /// Operator backed out — assign nothing.
  cancel,
}

/// What [_doAssign] actually did, so callers can tell the operator the
/// difference between "assigned 5 items", "no EPCs exist for this SKU",
/// "you cancelled at the move/add prompt", and "everything is already
/// placed elsewhere".
enum _AssignOutcomeKind { success, zeroUpdated, noEpcsFound, cancelled }

class _AssignOutcome {
  const _AssignOutcome({
    required this.updated,
    required this.outcome,
    this.inThisBin = 0,
    this.inOtherCount = 0,
    this.firstOtherBin,
  });
  final int updated;
  final _AssignOutcomeKind outcome;
  /// When [outcome] is `zeroUpdated`, these explain WHY no rows changed
  /// — surfaced in the snackbar so the operator can tell whether the
  /// items are already in this bin (correct no-op), still in other bins
  /// (because ADD was picked instead of MOVE), or completely unmatched.
  final int inThisBin;
  final int inOtherCount;
  final String? firstOtherBin;
}

class _AssignSnapshot {
  const _AssignSnapshot({
    required this.binCode,
    required this.binId,
    required this.skuAssigned,
    required this.itemName,
  });

  final String binCode;
  final String binId;
  final String skuAssigned;
  final String itemName;
}

/// Bin Assign — fast 2D putaway with hardware wedge, camera, or manual entry.
///
/// Scanner policy: 2D barcode only — hardware wedge / external BT scanner /
/// camera / manual keyboard. The screen does not subscribe to the EPC tag
/// stream, so any stray RFID reads from the warm SDK session have nowhere
/// to land. Hardware trigger drives `scanner.start2d` /
/// `carbon_wms/hardware_barcode` broadcasts via [CarbonHardwareBarcodeRelay].
///
/// 1.2.20 regression note: 1.2.19 added `disableRfidFunctionMode()` +
/// `open2dBarcode()` on entry to "harden" against EPC injection. On C72E
/// MTK firmware that broadcast set includes `CLOSE_BARCODE_RFID`, which
/// closes the BARCODE+RFID composite in com.rscja.scanner — trigger pulls
/// then no longer fire the 2D imager. `open2dBarcode()` only sends
/// `ACTION_2DS_ENABLE` / `BARCODEUNLOCKSCANKEY` and does not reopen the
/// composite. Reverted to the 1.2.18 behavior (no scanner-state
/// broadcasts on entry).
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
  bool _flashOk = false; // turned on for 5s after a successful end-of-session.
  bool _awaitingBinScan = true;

  /// True only between a session ending ("Add another item? NO" or auto-empty)
  /// and the operator's next physical scan. Drives the bottom status label
  /// (grey "READY FOR NEXT ENTRY" vs. red "TRIGGER TO ADD ITEM"), per spec
  /// answer #1.
  bool _readyForNextEntry = false;
  Timer? _flashTimer;

  String _scannerSource = 'hardware';
  bool _manualBin = false;
  bool _manualAddItem = false;
  bool _externalScanner = false;
  bool _cameraEnabled = true;

  /// Multi-items mode (persisted, default OFF). OFF = scan bin → scan item →
  /// assign immediately → advance to next bin. ON = full add-another flow.
  bool _multiItems = false;

  /// Captured in didChangeDependencies so dispose can clear any lingering
  /// SnackBar (e.g. the 8s "Bin cleaned · UNDO"). SnackBars live on the
  /// app-wide messenger and otherwise bleed onto the next screen.
  ScaffoldMessengerState? _messenger;

  String? _userEmail;

  List<_StoredItem> _storedContents = [];
  List<_StoredItem> _undoSnapshot = [];
  // Cached bin list, refreshed in _load() and after createBin. The previous
  // implementation hit `api.fetchBins()` on every scan, which is ~300–600 ms
  // on Samsung + RFD8500 and was the dominant source of the perceived lag
  // between trigger pull and the bin code appearing.
  List<Map<String, dynamic>> _binsCache = const [];
  bool _binsCacheLoading = false;
  // Last successful assign — surfaced via the undo button after _resetForNextEntry().
  _AssignSnapshot? _lastAssignSnapshot;
  DateTime _ignoreScansUntil = DateTime.fromMillisecondsSinceEpoch(0);

  int get _storedTotal => _storedContents.fold(0, (sum, e) => sum + e.qty);
  bool get _shouldUseHardwareScanner =>
      _scannerSource == 'hardware' || _externalScanner;

  /// Hard reset — clears the bin entirely. Used when leaving the screen,
  /// after a delete-bin, or when the operator chooses "Refresh session".
  void _resetForNextEntry() {
    _flashTimer?.cancel();
    _flashTimer = null;
    setState(() {
      _currentBin = '';
      _currentBinId = '';
      _binActive = false;
      _storedContents = [];
      _awaitingBinScan = true;
      _readyForNextEntry = false;
      _flashOk = false;
      _multiItems = false; // fresh start = single-item default
    });
    _scanFocus.requestFocus();
  }

  /// Operator tapped "Refresh session". Beyond clearing bin/items, this
  /// MUST return the screen to the **default** state: manual mode OFF,
  /// 2D scanner re-armed (trigger pull fires the imager again), no
  /// leftover bin code or staged item rows.
  ///
  /// Order matters:
  ///   1. Disable manual mode in the session — sub-options cascade off,
  ///      and resetVersion bumps so the listener wipes our local copies.
  ///   2. Re-assert hardware mode: enable trigger relay + put the radio
  ///      in 2D mode (Zebra trigger + Chainway). Same calls _load() runs
  ///      on first entry — explicitly run them again because the screen
  ///      may have been flipped to manual scanner-source while in manual
  ///      mode.
  ///   3. Clear all on-screen state via the existing reset path.
  void _resetToDefaultMode() {
    BinAssignSession.setManualMode(false);
    setState(() {
      _manualBin = BinAssignSession.manualBin;
      _manualAddItem = BinAssignSession.manualAddItem;
      _externalScanner = BinAssignSession.externalScanner;
      _scannerSource = 'hardware';
    });
    // Re-arm the 2D imager / Zebra 2D trigger. _load() does the same on
    // entry; mirroring it here so refresh is a true "back to defaults."
    _syncHardwareBarcodeStream();
    unawaited(RfidVendorChannel.scannerEnableTriggerRelay());
    unawaited(RfidVendorChannel.setZebraTriggerMode2D());
    unawaited(_wakeCameraImagerOnce());
    _resetForNextEntry();
  }

  /// End-of-session — keeps the bin showing (per spec answer #6/#10) and
  /// flips the bottom label to grey "READY FOR NEXT ENTRY". Plays the
  /// success cue (same as Re-encode) and shows a 5-second green flash bar
  /// at the top per spec answer #7. Next physical scan re-triggers a bin
  /// scan even if the worker is "still on" the same bin code.
  void _triggerEndOfSession() {
    ScanSounds.instance.play(ScanCue.success);
    _flashTimer?.cancel();
    setState(() {
      _readyForNextEntry = true;
      _awaitingBinScan = true; // next scan must be a bin
      _flashOk = true;
      _multiItems = false; // next session starts single-item by default
    });
    _flashTimer = Timer(const Duration(seconds: 5), () {
      if (!mounted) return;
      setState(() => _flashOk = false);
      _flashTimer = null;
    });
    _scanFocus.requestFocus();
  }

  // Multi-items is a per-session choice, not persisted: it always starts OFF
  // and resets to OFF when a session ends (so the next bin begins single-mode).
  void _setMultiItems(bool v) {
    setState(() => _multiItems = v);
  }

  Future<void> _load() async {
    final p = await SharedPreferences.getInstance();
    if (!mounted) return;
    setState(() {
      _scannerSource = p.getString('wms_scanner_source_v1') ?? 'hardware';
      // Manual-mode flags are now in-memory (BinAssignSession) — they
      // survive navigation but reset on app kill, so a fresh login
      // never inherits the previous operator's manual state.
      _manualBin = BinAssignSession.manualBin;
      _manualAddItem = BinAssignSession.manualAddItem;
      _externalScanner = BinAssignSession.externalScanner;
      _cameraEnabled = p.getBool('bin_assign_camera_enabled') ?? true;
    });
    _syncHardwareBarcodeStream();
    if (_shouldUseHardwareScanner) {
      unawaited(RfidVendorChannel.scannerEnableTriggerRelay());
    }
    // Hard-lock RFID on this screen (spec answer #19). The radio cannot be
    // shut down via setPower(0) on the C72E MTK firmware — that wedges the
    // chip (CarbonChainwayRfidController.kt:165). Instead we defensively
    // halt any inventory loop that might still be running from a prior
    // screen. Combined with not subscribing to the EPC stream (this file
    // never calls RfidVendorChannel.tagReadStream), this prevents a tag
    // read from ever reaching Bin Assign code paths.
    unawaited(RfidVendorChannel.stopChainwayInventory());
    // RFD8500: physically flip the trigger to fire the 2D imager. Mirrors what
    // the Chainway path achieves via scannerEnableTriggerRelay above.
    unawaited(RfidVendorChannel.setZebraTriggerMode2D());
    // Wake the C72E camera-bound 2D imager. After a fresh install, the OEM
    // scanner service can come back from MainActivity's UART-acquire kill
    // without grabbing its camera handle, so the user's first trigger pull
    // on Bin Assign produces no laser. Walking through open2dBarcode + a
    // brief STARTSCAN/STOPSCAN forces CameraService::connect on entry to
    // this screen (1.2.33 fired this on app start, but that unlocked the
    // trigger key globally and made the laser fire on the login screen —
    // see MainActivity.kt for the regression note).
    unawaited(_wakeCameraImagerOnce());
    // Pre-warm the success cue so the end-of-session beep is sub-ms.
    unawaited(ScanSounds.instance.init());
    // Pre-load the bin list so the first trigger pull doesn't pay the
    // fetchBins round-trip (~300–600 ms on Samsung + RFD8500).
    unawaited(_refreshBinsCache());
  }

  Future<void> _refreshBinsCache() async {
    if (_binsCacheLoading) return;
    _binsCacheLoading = true;
    try {
      final api = context.read<WmsApiClient>();
      final bins = await api.fetchBins();
      if (!mounted) return;
      _binsCache = bins.cast<Map<String, dynamic>>();
    } catch (_) {
      // Cache miss is non-fatal — _handleBinScan falls back to a live fetch.
    } finally {
      _binsCacheLoading = false;
    }
  }

  Future<void> _wakeCameraImagerOnce() async {
    if (kIsWeb || defaultTargetPlatform != TargetPlatform.android) return;
    if (!_shouldUseHardwareScanner) return;
    try {
      // Imager wake-up. Delays trimmed 150 → 80ms (2026-06-05) so the
      // scanner is ready sooner on entry; the 2D engine boots well within
      // 80ms on RFD8500. Best-effort — never blocks the screen.
      await RfidVendorChannel.open2dBarcode();
      await Future<void>.delayed(const Duration(milliseconds: 80));
      await RfidVendorChannel.scannerStart2d();
      await Future<void>.delayed(const Duration(milliseconds: 80));
      await RfidVendorChannel.scannerStop2d();
    } catch (_) {
      /* best-effort: imager wake-up never blocks the screen */
    }
  }

  @override
  void initState() {
    super.initState();
    // Operator-asked behaviour: when manual mode is toggled OFF in the
    // settings screen, the bin assign screen should come back fresh
    // (no leftover bin code or staged items). BinAssignSession bumps
    // resetVersion on every disable; we listen and re-run the reset.
    BinAssignSession.resetVersion.addListener(_onManualModeReset);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _load();
      _loadUserEmail();
      _resetForNextEntry();
    });
  }

  void _onManualModeReset() {
    if (!mounted) return;
    // Re-pull the manual flags from session AND wipe any in-progress
    // bin / staged items. Same path as the screen's own "Refresh
    // session" button — operator gets a clean slate.
    setState(() {
      _manualBin = BinAssignSession.manualBin;
      _manualAddItem = BinAssignSession.manualAddItem;
      _externalScanner = BinAssignSession.externalScanner;
    });
    _resetForNextEntry();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _messenger = ScaffoldMessenger.of(context);
  }

  @override
  void dispose() {
    // Drop any lingering SnackBar (e.g. "Bin cleaned · UNDO") so it doesn't
    // hang over the next screen.
    _messenger?.clearSnackBars();
    BinAssignSession.resetVersion.removeListener(_onManualModeReset);
    _flashTimer?.cancel();
    _flashTimer = null;
    _hardwareBarcodeSub?.cancel();
    unawaited(RfidVendorChannel.scannerDisableTriggerRelay());
    // RFD8500: restore the trigger to RFID mode so the next screen
    // (Count / Re-encode) gets UHF on trigger pull immediately.
    unawaited(RfidVendorChannel.setZebraTriggerModeRfid());
    unawaited(_stopHardware2dScan());
    _hardwareBarcodeSub = null;
    _hiddenCtrl.dispose();
    _scanFocus.dispose();
    super.dispose();
  }

  /// Hardware wedge + OEM scan broadcasts (see [CarbonHardwareBarcodeRelay] on Android).
  ///
  /// Routing rules (spec answer #11):
  ///   - awaiting bin   → always _handleBinScan
  ///   - bin active     → if the payload is bin-shaped (5 chars after
  ///                       normalisation) treat it as a swap attempt;
  ///                       otherwise treat it as an item.
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
    // Length gate ONLY filters obvious typing fragments (1–2 chars). Real
    // bin codes can be 3–4 chars (e.g. "1A", "X7C") and the prior `<5`
    // gate silently swallowed those whenever an RFD8500 decoded a short
    // bin label — operators saw beep+green but no bin appeared in the
    // app. The blockedNoise list above already drops keypress-name
    // strings (`SCAN`, `START`, etc.).
    if (_awaitingBinScan && normalized.length < 3) return;
    unawaited(_stopHardware2dScan());
    if (_awaitingBinScan) {
      unawaited(_handleBinScan(v));
    } else if (normalized.length == 5) {
      // Bin-shaped scan in mid-session → bin swap or refresh-session error.
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

    // Trigger relay (whether the physical trigger pull fires the 2D laser)
    // respects the user's Scanner Source preference: only enable it when the
    // user picked Hardware (or toggled External scanner on).
    final useHwTrigger = _shouldUseHardwareScanner;
    if (useHwTrigger) {
      unawaited(RfidVendorChannel.scannerEnableTriggerRelay());
    } else {
      unawaited(RfidVendorChannel.scannerDisableTriggerRelay());
    }

    // EventChannel subscription is UNCONDITIONAL. If the user's preference is
    // "camera" or "manual" but a hardware scanner happens to decode anyway —
    // because the trigger is physical and CoreScanner/the OEM broadcast path
    // is always live — those bytes should still reach the screen, not be
    // silently swallowed. Pre-1.2.35 this gate caused bin/item scans to
    // disappear with no UI feedback whenever the pref defaulted to camera.
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
    final wasBinActive = _binActive;
    setState(() => _busy = true);
    try {
      final want = _normalizeBinForCompare(code);
      // Cache-first lookup. If the cache is empty (first run, eviction, or
      // a previous fetch failed) fall back to a live fetch — that path is
      // also what the create-bin flow refreshes into the cache.
      List<Map<String, dynamic>> bins = _binsCache;
      if (bins.isEmpty) {
        final api = context.read<WmsApiClient>();
        final live = await api.fetchBins();
        bins = live.cast<Map<String, dynamic>>();
        _binsCache = bins;
      }
      Map<String, dynamic>? match;
      for (final b in bins) {
        if (_normalizeBinForCompare(b['code']?.toString() ?? '') == want) {
          match = b;
          break;
        }
      }
      // Cache-miss fallback: a bin created on another device after our last
      // refresh wouldn't be in `_binsCache`. Re-fetch once before declaring
      // the bin unknown so we don't push the operator into "create bin?".
      if (match == null && _binsCache.isNotEmpty) {
        final api = context.read<WmsApiClient>();
        final live = await api.fetchBins();
        bins = live.cast<Map<String, dynamic>>();
        _binsCache = bins;
        for (final b in bins) {
          if (_normalizeBinForCompare(b['code']?.toString() ?? '') == want) {
            match = b;
            break;
          }
        }
      }
      if (!mounted) return;
      if (match != null) {
        // Known bin — confirm (or swap, if a different bin was already active).
        await _confirmBin(match['id']?.toString() ?? '', code);
      } else if (wasBinActive) {
        // Unknown bin code while another bin is active. Per spec answer
        // #11 we do NOT offer "create bin" here — that path requires the
        // operator to refresh the session first.
        _showRefreshSessionDialog(code);
      } else {
        // Unknown bin and no active session — normal "create bin?" flow.
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

  /// Mid-session unknown bin scan — operator must refresh the session
  /// before they can register a brand-new bin. Spec answer #11.
  void _showRefreshSessionDialog(String unknownCode) {
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        shape: const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
        title: const Text('Bin not in system'),
        content: Text(
          'Bin "$unknownCode" is not registered.\n\n'
          'Refresh the session to start fresh? '
          'On a fresh screen you can re-scan this code and will be asked '
          'whether to create the new bin.',
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
              shape:
                  const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
            ),
            onPressed: () {
              Navigator.pop(ctx);
              _resetForNextEntry();
            },
            child: const Text('REFRESH SESSION'),
          ),
        ],
      ),
    );
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
    _flashTimer?.cancel();
    _flashTimer = null;
    setState(() {
      _currentBin = _formatBinCode(code);
      _currentBinId = binId;
      _binActive = true;
      _awaitingBinScan = false;
      _storedContents = items;
      // Fresh bin confirmation always returns the screen to mid-session
      // (red "TRIGGER TO ADD ITEM"), even if we just came from
      // "READY FOR NEXT ENTRY".
      _readyForNextEntry = false;
      _flashOk = false;
    });
    _scanFocus.requestFocus();
  }

  void _showCreateBinDialog(String code) {
    // RBAC: roles without the create-bin action can't register new bins.
    if (!context
        .read<MobilePermissions>()
        .canDo(ScreenIds.fastPutaway, 'create_bin')) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Not allowed to create bins')),
      );
      return;
    }
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
            SizedBox(height: 12.h),
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
                // Keep the cache in sync so a second scan of this code goes
                // through the fast path instead of triggering a re-fetch.
                unawaited(_refreshBinsCache());
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

  /// Preview the SKU's distribution, optionally prompt the operator when the
  /// stock is split across bins, then run the actual assign call.
  ///
  /// Returns an [_AssignOutcome] that callers use to surface clear feedback:
  /// the previous void+silent assign hid both "0 items found" and "user
  /// cancelled at the move/add prompt" behind an indistinguishable success.
  Future<_AssignOutcome> _doAssign({
    required String skuScanned,
    required String scope,
    bool allowMoveOrAddPrompt = true,
  }) async {
    final api = context.read<WmsApiClient>();
    final deviceId = await HandheldDeviceIdentity.primaryDeviceIdForServer();

    String mode = 'homeless_only';
    // Preview state captured for the snackbar — when the assign returns
    // updated=0 we want the operator to see WHY (already in this bin /
    // still in other bins / picked ADD instead of MOVE). Pre-1.2.45 the
    // generic "every matching EPC is already placed" message hid all three
    // failure modes behind one string.
    int previewInThisBin = 0;
    int previewInOtherCount = 0;
    String? previewFirstOtherBin;

    if (allowMoveOrAddPrompt) {
      try {
        final preview = await api.previewPutawayAssign(
          deviceId: deviceId,
          binCode: _currentBin,
          skuScanned: skuScanned,
          scope: scope,
        );
        final inOtherRaw = preview['inOtherBins'];
        final inOther = inOtherRaw is List
            ? inOtherRaw
                .whereType<Map>()
                .map((m) => Map<String, dynamic>.from(m))
                .where((m) =>
                    (m['binCode']?.toString().isNotEmpty ?? false) &&
                    (m['qty'] is num ? (m['qty'] as num).toInt() > 0 : false))
                .toList()
            : <Map<String, dynamic>>[];
        final homeless = (preview['homeless'] as num?)?.toInt() ?? 0;
        final totalMatching =
            (preview['totalMatching'] as num?)?.toInt() ?? 0;
        previewInThisBin = (preview['inThisBin'] as num?)?.toInt() ?? 0;
        previewInOtherCount =
            inOther.fold<int>(0, (a, m) => a + ((m['qty'] as num).toInt()));
        previewFirstOtherBin =
            inOther.isNotEmpty ? inOther.first['binCode']?.toString() : null;

        if (totalMatching == 0) {
          // No EPCs at all for this SKU. Likely the matrix isn't commissioned
          // yet, or the user scanned a barcode that doesn't map to a custom_sku.
          return const _AssignOutcome(
            updated: 0,
            outcome: _AssignOutcomeKind.noEpcsFound,
          );
        }

        if (inOther.isNotEmpty) {
          final choice = await _askMoveOrAddDialog(
            inOtherBins: inOther,
            homeless: homeless,
          );
          if (!mounted) {
            return const _AssignOutcome(
              updated: 0,
              outcome: _AssignOutcomeKind.cancelled,
            );
          }
          if (choice == null || choice == _MoveOrAddChoice.cancel) {
            // 1.2.47: CANCEL button is gone, but the operator can still
            // dismiss the dialog by tapping outside (Android system back
            // gesture). Treat dismissal as "stay mid-session" — same
            // outcome the explicit CANCEL button used to produce.
            return const _AssignOutcome(
              updated: 0,
              outcome: _AssignOutcomeKind.cancelled,
            );
          }
          mode = choice == _MoveOrAddChoice.move ? 'all' : 'homeless_only';
        }
      } catch (e) {
        // If preview fails (network blip, server hasn't shipped the new
        // endpoint yet, etc.), fall through to the legacy assign with
        // homeless_only — same behaviour as pre-1.2.38.
        debugPrint('[bin-assign] preview failed, falling back: $e');
      }
    }

    final res = await api.postPutawayAssign(
      deviceId: deviceId,
      binCode: _currentBin,
      skuScanned: skuScanned,
      scope: scope,
      mode: mode,
    );
    final updated = (res['updated'] as num?)?.toInt() ?? 0;
    return _AssignOutcome(
      updated: updated,
      outcome: updated > 0
          ? _AssignOutcomeKind.success
          : _AssignOutcomeKind.zeroUpdated,
      inThisBin: previewInThisBin,
      inOtherCount: previewInOtherCount,
      firstOtherBin: previewFirstOtherBin,
    );
  }

  Future<_MoveOrAddChoice?> _askMoveOrAddDialog({
    required List<Map<String, dynamic>> inOtherBins,
    required int homeless,
  }) {
    final binSummary = inOtherBins
        .map((m) => '${m['binCode']} (${m['qty']})')
        .join(', ');
    // CANCEL was removed in 1.2.47 per operator request — every dismissal
    // route landed back at "0 items" snackbar noise. Force a decision:
    // either MOVE the items here or ADD this bin to their existing
    // multi-bin list. Tapping outside the dialog falls through to null
    // → mid-session no-op, same as cancel was before.
    return showDialog<_MoveOrAddChoice>(
      context: context,
      builder: (ctx) => AlertDialog(
        shape: const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
        title: const Text('Item already in another bin'),
        content: Text(
          'This SKU is currently in: $binSummary.\n\n'
          'MOVE — pull every EPC out of those bins and into $_currentBin.\n'
          'ADD — also list these EPCs in $_currentBin (multi-bin); '
          'their original bin keeps them for qty totals.'
          '${homeless > 0 ? '\n\n$homeless unassigned EPC${homeless == 1 ? '' : 's'} will be placed here either way.' : ''}',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, _MoveOrAddChoice.add),
            child: const Text('ADD'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              shape:
                  const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
            ),
            onPressed: () => Navigator.pop(ctx, _MoveOrAddChoice.move),
            child: const Text('MOVE'),
          ),
        ],
      ),
    );
  }

  void _surfaceAssignOutcome(_AssignOutcome out, {required String sku}) {
    if (!mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    switch (out.outcome) {
      case _AssignOutcomeKind.success:
        // Silent — the bin contents list update is the confirmation.
        return;
      case _AssignOutcomeKind.cancelled:
        return;
      case _AssignOutcomeKind.noEpcsFound:
        messenger.showSnackBar(SnackBar(
          content: Text(
              'No EPCs found for $sku. Has the product been commissioned?'),
          duration: const Duration(seconds: 4),
        ));
        return;
      case _AssignOutcomeKind.zeroUpdated:
        // Tailored message based on what preview saw, so the operator
        // can tell which of the three "0 updated" cases they're in:
        //   1) items already in THIS bin — correct no-op
        //   2) items still in OTHER bins (operator picked ADD, not MOVE)
        //   3) something else (e.g. status filter excludes them)
        String message;
        if (out.inThisBin > 0 && out.inOtherCount == 0) {
          message =
              '$sku already in this bin (${out.inThisBin} EPC${out.inThisBin == 1 ? '' : 's'}).';
        } else if (out.inOtherCount > 0) {
          final where = out.firstOtherBin != null
              ? 'in bin ${out.firstOtherBin}'
              : 'in other bins';
          message =
              '$sku still $where (${out.inOtherCount} EPC${out.inOtherCount == 1 ? '' : 's'}). Re-scan and choose MOVE to relocate.';
        } else {
          message =
              '0 items assigned — every matching EPC is already placed.';
        }
        messenger.showSnackBar(SnackBar(
          content: Text(message),
          duration: const Duration(seconds: 5),
        ));
        return;
    }
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
        _lastAssignSnapshot = null;
        _storedContents = [];
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
        _lastAssignSnapshot = null;
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
      // Keep the cache fresh so the recreated bin is reachable through the
      // fast lookup path immediately.
      unawaited(_refreshBinsCache());
      // Re-assign all items
      final deviceId = await HandheldDeviceIdentity.primaryDeviceIdForServer();
      for (final item in snapshot) {
        await api.postPutawayAssign(
          deviceId: deviceId,
          binCode: binCode,
          skuScanned: item.sku,
          scope: 'single_color_all_sizes',
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
          scope: 'single_color_all_sizes',
        );
      }
      await _refreshContents();
      if (mounted) {
        setState(() {
          _undoSnapshot = [];
        });
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Undo failed: $e')));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Bottom-bar undo button. Most-recent reversible action wins:
  /// assign session → two-stage confirmation → remove SKU from bin.
  /// Otherwise falls through to the existing clean-bin undo.
  void _onUndoTap() {
    final assignSnap = _lastAssignSnapshot;
    if (assignSnap != null) {
      _showUndoAssignFirst(assignSnap);
      return;
    }
    if (_undoSnapshot.isNotEmpty) {
      unawaited(_onUndoClean());
      return;
    }
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text('Nothing to undo'),
        duration: Duration(seconds: 2),
      ),
    );
  }

  void _showUndoAssignFirst(_AssignSnapshot snap) {
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        shape: const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
        title: const Text('Reverse last assign?'),
        content: Text(
          'You assigned ${snap.itemName.isNotEmpty ? snap.itemName : snap.skuAssigned} '
          '(SKU ${snap.skuAssigned}) to bin ${snap.binCode}.\n\n'
          'Reverse this action?',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('NO'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              shape:
                  const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
            ),
            onPressed: () {
              Navigator.pop(ctx);
              _showUndoAssignConfirm(snap);
            },
            child: const Text('YES'),
          ),
        ],
      ),
    );
  }

  void _showUndoAssignConfirm(_AssignSnapshot snap) {
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        shape: const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
        title: const Text('Confirm undo'),
        content: const Text(
          'This action cannot be reversed. Are you sure?',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('CANCEL'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: const Color(0xFFEF4444),
              shape:
                  const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
            ),
            onPressed: () async {
              Navigator.pop(ctx);
              await _executeUndoAssign(snap);
            },
            child: const Text('YES, DELETE'),
          ),
        ],
      ),
    );
  }

  Future<void> _executeUndoAssign(_AssignSnapshot snap) async {
    setState(() => _busy = true);
    try {
      await context
          .read<WmsApiClient>()
          .removeSkuFromBin(snap.binCode, snap.skuAssigned);
      if (!mounted) return;
      setState(() {
        _lastAssignSnapshot = null;
        _busy = false;
      });
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
              'Reversed: ${snap.skuAssigned} removed from ${snap.binCode}.'),
          duration: const Duration(seconds: 3),
        ),
      );
    } catch (e) {
      if (mounted) {
        setState(() => _busy = false);
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Undo failed: $e')));
      }
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

  // ── Assign Flow — popup chain (spec answers #2 #3 #4 #5 #7) ─────────────────
  //
  // Top-level entry: [_runAssignFlow]. Step-by-step:
  //
  //   1. "Assign <item> to bin?"            YES / NO
  //         NO  → _triggerEndOfSession (label = grey READY FOR NEXT ENTRY)
  //         YES → server assign(scope=single_color_all_sizes) + refresh →
  //                 step 2.
  //   2. "Add another item?"                YES / NO
  //         NO  → _triggerEndOfSession.
  //         YES → step 3.
  //   3. "Same product different colour or new product?"
  //         (skipped automatically when every colour of this matrix is
  //          already assigned to the bin — go straight to step 4.)
  //         NEW  → _enterMidSessionForNewItem (red TRIGGER TO ADD ITEM,
  //                  refocus scanner, do NOT trigger end-of-session).
  //         SAME → step 4.
  //   4. Multi-colour picker — list every colour not yet in this bin.
  //         CANCEL → mid-session refocus.
  //         CONFIRM(selected) → assign every colour in series, refresh,
  //                 then loop back to step 2.
  //
  Future<void> _runAssignFlow({
    required String itemName,
    required _SkuParts skuParts,
    required String matrixId,
  }) async {
    // RBAC: read-only roles can't assign items to bins.
    if (!context.read<MobilePermissions>().canEdit(ScreenIds.fastPutaway)) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Read-only access')),
      );
      return;
    }
    // Pre-flight: gate on 0-EPC SKUs. Without this check the assign popup
    // looked like an honest YES/NO question even when no RFID tags had ever
    // been commissioned for the SKU — clicking YES then surfaced the
    // misleading "0 items assigned" snackbar (1.2.38 regression noticed by
    // the operator: "if i scanned an item that means i have it in my hand").
    // If the user genuinely has stock with no tags, the right move is to
    // commission tags first, not to silently no-op an assign.
    final api = context.read<WmsApiClient>();
    Map<String, dynamic>? preview;
    try {
      final deviceId = await HandheldDeviceIdentity.primaryDeviceIdForServer();
      preview = await api.previewPutawayAssign(
        deviceId: deviceId,
        binCode: _currentBin,
        skuScanned: skuParts.baseColor,
        scope: 'single_color_all_sizes',
      );
    } catch (_) {
      // Older server (no /putaway-preview endpoint) — fall through and
      // let the legacy assign path do its thing. Same behaviour as 1.2.37.
    }
    if (!mounted) return;
    if (preview != null) {
      final total = (preview['totalMatching'] as num?)?.toInt() ?? 0;
      if (total == 0) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(
              'No RFID tags exist for $itemName. Commission tags first.'),
          duration: const Duration(seconds: 5),
        ));
        _enterMidSessionForNewItem();
        return;
      }
    }

    // Default (multi-items OFF): no questions — assign the scanned item to the
    // bin straight away (single_color_all_sizes), then end the session so the
    // next scan starts a fresh bin. The add-another / colour-picker flow below
    // only runs when multi-items mode is ON.
    if (!_multiItems) {
      final ok = await _performAssign(
        skuScanned: skuParts.baseColor,
        itemName: itemName,
        binCode: _currentBin,
        binId: _currentBinId,
      );
      if (!mounted) return;
      if (ok) {
        _triggerEndOfSession();
      } else {
        _scanFocus.requestFocus();
      }
      return;
    }

    // Step 1 — assign popup
    final assignYes = await _askAssignDialog(itemName: itemName);
    if (!mounted) return;
    if (assignYes != true) {
      // NO / dismiss path — pre-1.2.43 this called _triggerEndOfSession
      // which plays the success cue + green flash bar (the operator
      // reported "huh?! it gave me a yellow bar and made a success
      // sound when I said NO"). NO means "don't assign right now"; we
      // stay mid-session, drop focus back to the scanner, and wait for
      // the next product scan. No sound, no flash.
      _enterMidSessionForNewItem();
      return;
    }
    final binCodeAtAssign = _currentBin;
    final binIdAtAssign = _currentBinId;
    final firstAssignOk = await _performAssign(
      skuScanned: skuParts.baseColor,
      itemName: itemName,
      binCode: binCodeAtAssign,
      binId: binIdAtAssign,
    );
    if (!mounted) return;
    if (!firstAssignOk) {
      _scanFocus.requestFocus();
      return;
    }
    // Step 3 — same product, other colours? (restored 2026-06-05) The operator
    // just assigned ONE colour; offer to add the SAME item's remaining colours
    // to this same bin via the (intact) colour picker — no re-scan needed.
    final otherColours =
        await _askSameProductOtherColoursDialog(itemName: itemName);
    if (!mounted) return;
    if (otherColours == true) {
      final picked =
          await _showColorPicker(matrixId: matrixId, base: skuParts.base);
      if (!mounted) return;
      if (picked != null && picked.isNotEmpty) {
        await _performMultiColourAssign(
          base: skuParts.base,
          colours: picked,
          itemName: itemName,
        );
        if (!mounted) return;
      }
    }

    // Step 4 — keep going or wrap up. YES → stay on THIS bin and wait for the
    // next item scan, which re-runs this whole flow so the operator can pile
    // several items into one bin. NO → end the session.
    final addAnother = await _askAddAnotherItemDialog();
    if (!mounted) return;
    if (addAnother == true) {
      _enterMidSessionForNewItem();
    } else {
      _triggerEndOfSession();
    }
  }

  /// Step 3 of the multi-item assign flow — after assigning one colour, ask
  /// whether the operator wants to add the SAME product's other colours to the
  /// same bin. YES routes into [_showColorPicker] → [_performMultiColourAssign].
  Future<bool?> _askSameProductOtherColoursDialog({required String itemName}) {
    return showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        shape: const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
        title: const Text('Same product, other colours?'),
        content: Text(
            "Add other colours of $itemName to this bin? You'll pick which colours next."),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('NO'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('PICK COLOURS'),
          ),
        ],
      ),
    );
  }

  Future<bool?> _askAssignDialog({required String itemName}) {
    return showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        shape: const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
        title: const Text('Assign to bin?'),
        content: Text('Would you like to assign $itemName to this bin?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('NO'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              shape:
                  const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
            ),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('YES'),
          ),
        ],
      ),
    );
  }

  Future<bool?> _askAddAnotherItemDialog() {
    return showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        shape: const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
        title: const Text('Add another item?'),
        content: const Text(
          'You can keep assigning more items to this bin, '
          'or wrap up and return to the bin overview.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('NO'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              shape:
                  const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
            ),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('YES'),
          ),
        ],
      ),
    );
  }

  /// Returns the list of two-letter colour codes the operator confirmed,
  /// or null if they cancelled. Empty list means "I picked nothing — close".
  Future<List<String>?> _showColorPicker({
    required String matrixId,
    required String base,
  }) async {
    if (matrixId.isEmpty) {
      // No matrix → fall back to canceling. The catalog couldn't resolve
      // the matrix from the scanned SKU; the operator can pick "new
      // product" and scan something else.
      return null;
    }
    setState(() => _busy = true);
    List<Map<String, dynamic>> rows;
    try {
      rows =
          await context.read<WmsApiClient>().fetchCustomSkusByMatrix(matrixId);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Colour list lookup failed: $e')));
      }
      return null;
    } finally {
      if (mounted) setState(() => _busy = false);
    }
    if (!mounted) return null;
    // Already-assigned colour codes for this bin (compared against
    // _StoredItem.colorCode which is `cs.color_code`). Filter them out so
    // the picker only shows colours we still need to assign.
    final assignedColours = _storedContents
        .where((s) => s.qty > 0)
        .map((s) => s.colorCode.toUpperCase())
        .toSet();
    final candidateColours = <String>{};
    for (final r in rows) {
      final c = (r['color_code'] ?? r['color'] ?? '').toString().toUpperCase();
      if (c.isEmpty) continue;
      if (assignedColours.contains(c)) continue;
      candidateColours.add(c);
    }
    if (candidateColours.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('All colours of this product are already in the bin.'),
          duration: Duration(seconds: 3),
        ),
      );
      return null;
    }

    // Show EVERY colour of this product that isn't already in the bin so the
    // operator can always pick one. A previous homeless-only pre-filter
    // (preview each colour, keep only `homeless > 0`) hid colours whose items
    // sit in other bins — when none qualified it returned null with a brief
    // snackbar, which the operator experienced as "I can't choose the colour".
    // If a picked colour has no homeless items, _performMultiColourAssign
    // already reports that via its "0 items assigned…" result snackbar.
    final ordered = candidateColours.toList()..sort();
    final selected = <String>{};
    return showDialog<List<String>>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setLocal) => AlertDialog(
          shape: const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
          title: const Text('Pick colours to assign'),
          content: SizedBox(
            width: double.maxFinite,
            child: ListView.builder(
              shrinkWrap: true,
              itemCount: ordered.length,
              itemBuilder: (_, i) {
                final c = ordered[i];
                final on = selected.contains(c);
                return CheckboxListTile(
                  value: on,
                  onChanged: (v) {
                    setLocal(() {
                      if (v == true) {
                        selected.add(c);
                      } else {
                        selected.remove(c);
                      }
                    });
                  },
                  title: Text(c),
                  subtitle: Text('all sizes of $base$c'),
                  controlAffinity: ListTileControlAffinity.leading,
                );
              },
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx, null),
              child: const Text('CANCEL'),
            ),
            FilledButton(
              style: FilledButton.styleFrom(
                shape: const RoundedRectangleBorder(
                    borderRadius: BorderRadius.zero),
              ),
              onPressed: selected.isEmpty
                  ? null
                  : () => Navigator.pop(ctx, selected.toList()..sort()),
              child: const Text('YES'),
            ),
          ],
        ),
      ),
    );
  }

  /// Returns true if at least one colour of [matrixId] has no assignment in
  /// the current bin. Used by the popup chain to skip "same product" when
  /// everything is already in the bin.

  /// Mid-session "ready for the next item" state — bin still active, scanner
  /// re-armed, label red "TRIGGER TO ADD ITEM" (per spec answers #5 and #1).
  void _enterMidSessionForNewItem() {
    setState(() {
      _readyForNextEntry = false;
      _awaitingBinScan = false; // next physical scan should be an item
      _pendingSku = '';
    });
    _scanFocus.requestFocus();
  }

  /// Single-SKU server assign + contents refresh + last-assign snapshot.
  /// Returns true if items were actually moved (updated > 0). Returns false
  /// for every other outcome (cancelled, zero updated, missing EPCs, error)
  /// so callers can drop back to mid-session without firing the success cue.
  Future<bool> _performAssign({
    required String skuScanned,
    required String itemName,
    required String binCode,
    required String binId,
  }) async {
    setState(() => _busy = true);
    try {
      final outcome = await _doAssign(
        skuScanned: skuScanned,
        scope: 'single_color_all_sizes',
      );
      _surfaceAssignOutcome(outcome, sku: skuScanned);
      await _refreshContents();
      if (!mounted) return false;
      if (outcome.outcome != _AssignOutcomeKind.success) return false;
      setState(() {
        _lastAssignSnapshot = _AssignSnapshot(
          binCode: binCode,
          binId: binId,
          skuAssigned: skuScanned,
          itemName: itemName,
        );
        _undoSnapshot = [];
      });
      return true;
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Assign failed: $e')));
      }
      return false;
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Spec answer #3 — assign every colour the operator picked, one per
  /// server call (each is `single_color_all_sizes` so all sizes flow with
  /// the colour). Returns true if every colour assigned successfully.
  Future<bool> _performMultiColourAssign({
    required String base,
    required List<String> colours,
    required String itemName,
  }) async {
    if (colours.isEmpty) return false;
    setState(() => _busy = true);
    final binCode = _currentBin;
    final binId = _currentBinId;
    try {
      int totalUpdated = 0;
      for (final c in colours) {
        // Multi-colour batch is a deliberate operator choice from the picker
        // (which already filters out colours sitting in this bin). Suppress
        // the per-colour Move/Add prompt so the batch isn't 5 dialogs deep —
        // we always run homeless_only here.
        final outcome = await _doAssign(
          skuScanned: '$base$c',
          scope: 'single_color_all_sizes',
          allowMoveOrAddPrompt: false,
        );
        totalUpdated += outcome.updated;
      }
      await _refreshContents();
      if (!mounted) return false;
      if (totalUpdated == 0) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(
              '0 items assigned across ${colours.length} colour${colours.length == 1 ? '' : 's'} — every matching EPC may already be placed elsewhere.'),
          duration: const Duration(seconds: 4),
        ));
        return false;
      }
      setState(() {
        // Snapshot the final colour as the undoable assignment — operators
        // generally remember the last action they took; also matches the
        // single-undo behaviour the user signed off on (spec answer #9).
        final lastSku = '$base${colours.last}';
        _lastAssignSnapshot = _AssignSnapshot(
          binCode: binCode,
          binId: binId,
          skuAssigned: lastSku,
          itemName: itemName,
        );
        _undoSnapshot = [];
      });
      return true;
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Multi-colour assign failed: $e')));
      }
      return false;
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  // ── Scan handlers ─────────────────────────────────────────────────────────

  /// Spec answer #17 — manual entry / scan routing:
  ///
  ///   Full SKU with size       → strip → assign popup (single SKU)
  ///   Exact base+colour (9/11) → assign popup (single SKU, all sizes)
  ///   Base only (7 / 9 chars)  → multi-colour picker (every colour, all
  ///                               sizes — no per-colour confirmation)
  ///   Partial / name / desc    → not handled here; the dropdown in the
  ///                               EmptyItemsPlaceholder calls back into
  ///                               this method with a parsed SKU.
  ///
  /// The catalog grid lookup runs once with the most-specific key we can
  /// build so we know the matrix id for any subsequent multi-colour work.
  Future<void> _onItemSubmit(String raw) async {
    if (!_binActive) return; // guard: bin must be active
    final sku = raw.trim();
    if (sku.isEmpty) return;
    _hiddenCtrl.clear();
    setState(() {
      _readyForNextEntry = false;
      _flashOk = false;
      _busy = true;
    });
    try {
      final skuParts = _SkuParts.parse(sku);
      final api = context.read<WmsApiClient>();
      // Search by base+colour when present, else by base alone — the latter
      // returns ANY one custom SKU under the matrix, which is enough to
      // resolve the matrix id and item name for the multi-colour picker.
      final searchKey = skuParts.baseColor.isNotEmpty
          ? skuParts.baseColor
          : skuParts.base;
      final row = await api.catalogGridSearchFirstRow(searchKey);
      if (!mounted) return;
      // Catalog grid actually returns `name` (matrix description) and `color`
      // (color_code) — pre-1.2.39 mobile read non-existent `title` /
      // `description` fields and silently fell back to the raw SKU, which
      // produced popups like "Assign C12345678B8 to bin?" instead of
      // "Assign Ace Jeans WH to bin?".
      final matrixName = row?['name']?.toString() ??
          row?['title']?.toString() ??
          row?['description']?.toString() ??
          '';
      final colorCode =
          row?['color']?.toString() ?? skuParts.colorCode;
      final displayLabel = [
        matrixName.trim(),
        colorCode.trim(),
      ].where((s) => s.isNotEmpty).join(' ');
      final itemName = displayLabel.isNotEmpty ? displayLabel : skuParts.raw;
      final matrixId =
          row?['matrix_id']?.toString() ?? row?['matrixId']?.toString() ?? '';
      setState(() {
        _pendingSku = sku;
        _busy = false;
      });
      // Base-only entry → straight to the multi-colour picker. Skip the
      // single-SKU assign popup (there's no colour to confirm yet).
      if (skuParts.colorCode.isEmpty) {
        final picked =
            await _showColorPicker(matrixId: matrixId, base: skuParts.base);
        if (!mounted) return;
        if (picked == null || picked.isEmpty) {
          _enterMidSessionForNewItem();
          return;
        }
        final ok = await _performMultiColourAssign(
          base: skuParts.base,
          colours: picked,
          itemName: itemName,
        );
        if (!mounted) return;
        if (ok) {
          _triggerEndOfSession();
        } else {
          _enterMidSessionForNewItem();
        }
        return;
      }
      // Otherwise the standard popup chain.
      await _runAssignFlow(
          itemName: itemName, skuParts: skuParts, matrixId: matrixId);
    } catch (e) {
      if (mounted) {
        setState(() => _busy = false);
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Item lookup failed: $e')));
      }
    }
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
    await context.pushGuarded<void>(
      ScreenIds.binAssignSettings,
      (_) => const BinAssignSettingsScreen(),
    );
    if (!mounted) return;
    await _load();
    if (!mounted) return;
    _hiddenCtrl.clear();
    _ignoreScansUntil =
        DateTime.now().add(const Duration(milliseconds: 1800));
    FocusScope.of(context).unfocus();
    _scanFocus.requestFocus();
  }

  @override
  Widget build(BuildContext context) {
    final perms = context.read<MobilePermissions>();
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
              multiItems: _multiItems,
              onMultiItemsChanged: _setMultiItems,
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
                binActive: _binActive,
                isManualMode: _manualAddItem,
                onManualInput: _manualAddItem
                    ? (sku) => unawaited(_onItemSubmit(sku))
                    : null,
              ),
              const Spacer(),
            ] else
              Expanded(
                child: ListView.builder(
                  padding: EdgeInsets.fromLTRB(16.w, 0.h, 16.w, 8.h),
                  itemCount: _storedContents.where((e) => e.qty > 0).length,
                  itemBuilder: (context, i) {
                    final visible =
                        _storedContents.where((e) => e.qty > 0).toList();
                    final item = visible[i];
                    return Padding(
                      padding: EdgeInsets.only(bottom: 8.h),
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
                          padding: EdgeInsets.only(left: 20.w),
                          child: Icon(Icons.delete_outline,
                              color: Colors.white, size: 26.sp),
                        ),
                        child: GestureDetector(
                          onTap: () => context.pushGuarded<void>(
                            ScreenIds.epcDetail,
                            (_) => EpcDetailScreen(
                              sku: item.sku,
                              description: item.description,
                              epcs: item.epcs,
                            ),
                          ),
                          child: _StoredItemRow(
                            sku: item.sku,
                            description: item.description,
                            colorCode: item.colorCode,
                            size: item.size,
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
              readyForNextEntry: _readyForNextEntry,
              cameraEnabled: _cameraEnabled,
              canCleanBin:
                  perms.canDo(ScreenIds.fastPutaway, 'clean_bin'),
              canDeleteBin:
                  perms.canDo(ScreenIds.fastPutaway, 'delete_bin'),
              onCleanBin: () => unawaited(_onCleanBin()),
              onDeleteBin: () => unawaited(_onDeleteBin()),
              onUndoClean: _onUndoTap,
              // Refresh — drops back to the "scan a bin" empty state without
              // touching DB rows. Same path the screen takes after a successful
              // assign or a delete-bin.
              onRefreshSession: _resetToDefaultMode,
              onAddBin: _addNewBin,
              onAddBinCamera: () async {
                final code = await _scanWithCamera('SCAN BIN LOCATION');
                if (code != null && code.isNotEmpty && mounted) {
                  unawaited(_handleBinScan(code));
                }
              },
              onAddItem: _addNewItem,
              onAddItemCamera: () async {
                final code = await _scanWithCamera('SCAN ITEM');
                if (code != null && code.isNotEmpty && mounted) {
                  unawaited(_onItemSubmit(code));
                }
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
          icon: Icon(Icons.settings_outlined, color: Colors.black, size: 28.sp),
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
                width: 36.w,
                height: 36.w,
                fit: BoxFit.cover,
              ),
            ),
          ),
          SizedBox(width: 8.w),
          Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                'Carbon',
                style: GoogleFonts.manrope(
                  fontSize: 18.sp,
                  fontWeight: FontWeight.w800,
                  letterSpacing: -0.3,
                  color: mainColor,
                ),
              ),
              WmsText(color: wmsTeal, fontSize: 18.sp),
            ],
          ),
          Padding(
            padding: EdgeInsets.symmetric(horizontal: 7.w),
            child: Text('/',
                style: TextStyle(
                    fontSize: 22.sp,
                    fontWeight: FontWeight.w700,
                    color: Colors.black)),
          ),
          Text(
            'BIN ASSIGN',
            style: GoogleFonts.manrope(
              fontSize: 16.sp,
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
    this.multiItems = false,
    this.onMultiItemsChanged,
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
  /// Multi-items mode: OFF (default) assigns a single scanned item to the bin
  /// immediately and advances to the next bin; ON keeps the full add-another /
  /// colour-picker flow on the same bin.
  final bool multiItems;
  final ValueChanged<bool>? onMultiItemsChanged;

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
    if (widget.manualBin && widget.isActive && widget.binCode.isNotEmpty) {
      _binCtrl.text = widget.binCode;
    }
    // Pre-load bins on mount so the dropdown has data the moment the
    // operator focuses the field. Previously it waited until the first
    // focus event AND the user reported "all I see is Add new bin" —
    // that happens when fetchBins throws (silently caught) and the
    // dropdown then has no rows beyond the "Add new" entry. Loading
    // eagerly + retrying-on-text-change keeps the dropdown populated.
    if (widget.manualBin) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _loadBins();
      });
    }
  }

  @override
  void didUpdateWidget(_BinInfoBlock oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.manualBin && widget.isActive) {
      if (widget.binCode != oldWidget.binCode &&
          _binCtrl.text != widget.binCode) {
        _binCtrl.value = TextEditingValue(
          text: widget.binCode,
          selection: TextSelection.collapsed(offset: widget.binCode.length),
        );
      }
    } else if (oldWidget.isActive && !widget.isActive && _binCtrl.text.isNotEmpty) {
      _binCtrl.clear();
    }
    // Manual mode just turned on (was off, now on) — load the bin list
    // so the dropdown is populated for the operator's first keystroke.
    if (widget.manualBin && !oldWidget.manualBin && !_binsLoaded) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _loadBins();
      });
    }
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
    } catch (_) {
      // Silently caught — but don't flip _binsLoaded so the next
      // keystroke / focus event triggers a retry. The previous version
      // also caught silently AND set _binsLoaded=true earlier in the
      // happy path only, so a single transient fetch failure left the
      // operator with an empty dropdown for the rest of the session.
    }
  }

  void _onTextChanged() {
    // If the initial load failed, retry once when the operator starts
    // typing — typically the bins endpoint is back by then.
    if (!_binsLoaded && _binCtrl.text.isNotEmpty) {
      unawaited(_loadBins());
    }
    _filterBins();
  }

  // Strip everything that isn't a letter/digit so the typed code (which the
  // hyphen formatter dashes — "6-B-03-R") matches the canonical stored code
  // ("6B03R"). Without this the dropdown looked slow/empty because almost
  // nothing matched once the dashes were inserted.
  static String _normCode(String s) =>
      s.toUpperCase().replaceAll(RegExp(r'[^A-Z0-9]'), '');

  void _filterBins() {
    final query = _normCode(_binCtrl.text);
    const int maxResults = 40;
    final List<Map<String, dynamic>> matches;
    if (query.isEmpty) {
      matches = _allBins.take(maxResults).toList();
    } else {
      matches = _allBins
          .where((b) => _normCode(b['code']?.toString() ?? '').contains(query))
          .take(maxResults)
          .toList();
    }
    setState(() {
      _filteredBins = matches;
      _showDropdown = _focusNode.hasFocus;
    });
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
    if (p.length < 4) {
      return widget.binCode.isNotEmpty
          ? widget.binCode
          : 'AISLE | ZONE | SHELF | SIDE';
    }
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
            padding: EdgeInsets.fromLTRB(16.w, 8.h, 16.w, 12.h),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(
                  'CURRENT BIN LOCATION',
                  style: GoogleFonts.spaceGrotesk(
                    fontSize: 13.sp,
                    fontWeight: FontWeight.w700,
                    letterSpacing: 2.0,
                    color: widget.mutedColor,
                  ),
                ),
                _MultiItemsToggle(
                  on: widget.multiItems,
                  onChanged: widget.onMultiItemsChanged,
                ),
              ],
            ),
          ),
          // Box with bin code and location
          Column(
            children: [
              Container(
                margin: EdgeInsets.fromLTRB(16.w, 0.h, 16.w, 0.h),
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.zero,
                  border: Border.all(color: AppColors.primary, width: 2.w),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (widget.isActive && !widget.manualBin)
                      Center(
                        child: Padding(
                          padding: EdgeInsets.fromLTRB(16.w, 14.h, 16.w, 0.h),
                          child: Text(
                            widget.binCode,
                            style: GoogleFonts.spaceGrotesk(
                              fontSize: 42.sp,
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
                          // Centered + big, so a manually-typed bin code reads
                          // the same as a 2D-scanned one in the box.
                          textAlign: TextAlign.center,
                          style: GoogleFonts.spaceGrotesk(
                            fontSize: 42.sp,
                            fontWeight: FontWeight.w800,
                            color: AppColors.primary,
                            letterSpacing: 1.2,
                          ),
                          decoration: InputDecoration(
                            hintText: 'Enter bin code...',
                            hintStyle: TextStyle(
                                color: Colors.grey.shade400, fontSize: 16.sp),
                            contentPadding: EdgeInsets.symmetric(
                                horizontal: 14.w, vertical: 18.h),
                            border: InputBorder.none,
                          ),
                          textCapitalization: TextCapitalization.characters,
                          // Live-format the typed text into the same shape a
                          // 2D scan produces (e.g. `6B03R` → `6-B-03-R`).
                          // Operator never types the hyphens; we insert them
                          // for visual parity with scanner-fed bins. Verify
                          // (_onVerify) still calls the parent's
                          // onManualBinSubmit which runs _formatBinCode again
                          // server-side — idempotent.
                          inputFormatters: [_BinCodeHyphenFormatter()],
                          onSubmitted: (_) => _onVerify(),
                        ),
                      )
                    else
                      // Empty placeholder — same height as text input
                      SizedBox(
                        width: double.infinity,
                        height: 60.h,
                      ),
                    SizedBox(height: 4.h),
                    Center(
                      child: Padding(
                        padding: EdgeInsets.only(bottom: 10.h),
                        child: Text(
                          _locationLine,
                          style: GoogleFonts.spaceGrotesk(
                            fontSize: 14.sp,
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
                  margin: EdgeInsets.fromLTRB(16.w, 0.h, 16.w, 0.h),
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
                        Divider(height: 1.h, color: Colors.grey.shade200),
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
                            padding: EdgeInsets.symmetric(
                                horizontal: 14.w, vertical: 12.h),
                            child: Row(
                              children: [
                                Icon(Icons.add_circle_outline,
                                    size: 18.sp, color: AppColors.primary),
                                SizedBox(width: 10.w),
                                Text(
                                  typed.isEmpty
                                      ? 'Add new bin'
                                      : 'Add new bin "$typed"',
                                  style: GoogleFonts.spaceGrotesk(
                                    fontSize: 15.sp,
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
                          padding: EdgeInsets.symmetric(
                              horizontal: 14.w, vertical: 12.h),
                          child: Row(
                            children: [
                              Icon(Icons.inventory_2_outlined,
                                  size: 18.sp, color: AppColors.primary),
                              SizedBox(width: 10.w),
                              Expanded(
                                child: _HighlightText(
                                  text: code,
                                  query: query,
                                  style: GoogleFonts.spaceGrotesk(
                                    fontSize: 15.sp,
                                    fontWeight: FontWeight.w600,
                                    color: AppColors.textMain,
                                  ),
                                  highlightStyle: GoogleFonts.spaceGrotesk(
                                    fontSize: 15.sp,
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

/// Live formatter for the manual-mode bin field. Strips spaces / hyphens
/// from the operator's typed input, uppercases, and re-inserts the
/// canonical hyphenated shape `D-L-DD-L` once the input reaches 5
/// alphanumerics (e.g. `6B03R` → `6-B-03-R`). Anything shorter or
/// longer is rendered raw-uppercased.
///
/// Mirrors `_formatBinCode` so a typed bin reads the same as one
/// scanned by the 2D imager. The cursor sticks to the end after every
/// keystroke — fine for this UX because the operator types left-to-
/// right and never edits the middle of a 5-char code.
class _BinCodeHyphenFormatter extends TextInputFormatter {
  static final RegExp _nonAlnum = RegExp(r'[^A-Za-z0-9]');

  @override
  TextEditingValue formatEditUpdate(
    TextEditingValue oldValue,
    TextEditingValue newValue,
  ) {
    final raw = newValue.text.replaceAll(_nonAlnum, '').toUpperCase();
    final formatted = raw.length == 5
        ? '${raw[0]}-${raw[1]}-${raw.substring(2, 4)}-${raw[4]}'
        : raw;
    if (formatted == newValue.text) return newValue;
    return TextEditingValue(
      text: formatted,
      selection: TextSelection.collapsed(offset: formatted.length),
    );
  }
}

/// MULTI ITEMS on/off toggle — replaces the old ACTIVE/INACTIVE badge in the
/// bin header. OFF (default) = scan bin → scan item → assign immediately →
/// next bin. ON = keep the full add-another / colour-picker flow on this bin.
class _MultiItemsToggle extends StatelessWidget {
  const _MultiItemsToggle({required this.on, required this.onChanged});
  final bool on;
  final ValueChanged<bool>? onChanged;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onChanged == null ? null : () => onChanged!(!on),
      behavior: HitTestBehavior.opaque,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            'MULTI ITEMS',
            style: GoogleFonts.manrope(
              fontSize: 10.sp,
              fontWeight: FontWeight.w800,
              letterSpacing: 1.0,
              color: AppColors.textMuted,
            ),
          ),
          SizedBox(width: 8.w),
          Container(
            padding: EdgeInsets.symmetric(horizontal: 12.w, vertical: 5.h),
            decoration: BoxDecoration(
              color: on ? AppColors.primary : AppColors.textMuted,
              borderRadius: BorderRadius.zero,
            ),
            child: Text(
              on ? 'ON' : 'OFF',
              style: GoogleFonts.manrope(
                fontSize: 11.sp,
                fontWeight: FontWeight.w800,
                letterSpacing: 1.0,
                color: Colors.white,
              ),
            ),
          ),
        ],
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
      padding: EdgeInsets.fromLTRB(16.w, 16.h, 16.w, 8.h),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(
            'STORED ITEMS',
            style: GoogleFonts.manrope(
              fontSize: 15.sp,
              fontWeight: FontWeight.w800,
              letterSpacing: 0.2,
              color: mainColor,
            ),
          ),
          Text(
            '$itemCount ITEMS TOTAL',
            style: GoogleFonts.spaceGrotesk(
              fontSize: 15.sp,
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
    required this.binActive,
    this.isManualMode = false,
    this.onManualInput,
  });
  final Color bgLow;
  final Color mutedColor;

  /// When false the placeholder shows "SCAN A BIN TO START"; when true and
  /// no items are stored yet it shows "TRIGGER OR TAP TO ADD ITEM" — per
  /// spec answer #16.
  final bool binActive;

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
      final rows = await api.catalogSearch(q, limit: 30);
      if (!mounted) return;
      // Spec answer #17 — dedupe to one row per item+colour. The catalog
      // returns one row per custom SKU (per-size) so a 5-colour 12-size
      // product surfaces as 60 rows; we collapse to 5 by `baseColor`.
      final byBaseColor = <String, Map<String, dynamic>>{};
      for (final r in rows) {
        final rawSku = r['sku']?.toString() ??
            r['custom_sku']?.toString() ??
            '';
        if (rawSku.isEmpty) continue;
        final key = _SkuParts.parse(rawSku).baseColor;
        if (key.isEmpty) continue;
        byBaseColor.putIfAbsent(key, () => r);
      }
      final deduped = byBaseColor.values.toList();
      setState(() {
        _results = deduped;
        _showDropdown = true;
        _searching = false;
      });
    } catch (_) {
      if (mounted) setState(() => _searching = false);
    }
  }

  void _selectResult(Map<String, dynamic> row) {
    final sku = row['sku']?.toString() ??
        row['custom_sku']?.toString() ??
        '';
    if (sku.isEmpty) return;
    _focusNode.unfocus();
    setState(() {
      _showDropdown = false;
      _results = [];
    });
    _controller.clear();
    // Pass the trimmed SKU (base + color, no size) — _onItemSubmit will parse
    // and show the assign dialog with the all-sizes/single-size scope choice.
    final trimmed = _SkuParts.parse(sku).searchKeySpecific;
    widget.onManualInput?.call(trimmed.isNotEmpty ? trimmed : sku);
  }

  @override
  Widget build(BuildContext context) {
    const double itemRowHeight = 74;

    return Padding(
      padding: EdgeInsets.fromLTRB(16.w, 0.h, 16.w, 8.h),
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
                      padding: EdgeInsets.symmetric(horizontal: 12.w),
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
                                  color: AppColors.primary, width: 2.w)),
                          contentPadding: EdgeInsets.symmetric(
                              horizontal: 16.w, vertical: 10.h),
                          isDense: true,
                          suffixIcon: _searching
                              ? Padding(
                                  padding: EdgeInsets.all(12.r),
                                  child: SizedBox(
                                      width: 16.w,
                                      height: 16.w,
                                      child: const CircularProgressIndicator(
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
                      widget.binActive
                          ? 'TRIGGER OR TAP TO ADD ITEM'
                          : 'SCAN A BIN TO START',
                      textAlign: TextAlign.center,
                      style: GoogleFonts.spaceGrotesk(
                        fontSize: 12.sp,
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
                    Divider(height: 1.h, color: Colors.grey.shade200),
                itemBuilder: (_, i) {
                  final row = _results[i];
                  final rawSku = row['sku']?.toString() ??
                      row['custom_sku']?.toString() ??
                      '';
                  // 11 chars for modern (C-prefix), 9 for legacy. Falls back
                  // to the raw value if the SKU is too short to parse.
                  final parsed = _SkuParts.parse(rawSku);
                  final displaySku = parsed.searchKeySpecific.isNotEmpty
                      ? parsed.searchKeySpecific
                      : rawSku;
                  final name = row['name']?.toString() ??
                      row['title']?.toString() ??
                      row['description']?.toString() ??
                      '';
                  final color = row['color']?.toString() ?? '';
                  final secondLine = [
                    if (name.isNotEmpty) name,
                    if (color.isNotEmpty) color,
                  ].join('  •  ');
                  return InkWell(
                    onTap: () => _selectResult(row),
                    child: Padding(
                      padding: EdgeInsets.symmetric(
                          horizontal: 14.w, vertical: 10.h),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            displaySku,
                            style: GoogleFonts.spaceGrotesk(
                              fontSize: 14.sp,
                              fontWeight: FontWeight.w700,
                              color: AppColors.primary,
                            ),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                          if (secondLine.isNotEmpty) ...[
                            SizedBox(height: 2.h),
                            Text(
                              secondLine,
                              style: GoogleFonts.manrope(
                                fontSize: 12.sp,
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
    required this.colorCode,
    required this.size,
    required this.quantity,
    required this.bgLow,
    required this.mainColor,
  });

  /// Full custom SKU, e.g. `C12345678B8L`.
  final String sku;

  /// Matrix / product name, e.g. `Slim Fit Jeans`.
  final String description;

  /// Two-letter colour code, e.g. `B8`.
  final String colorCode;

  /// Size, e.g. `L` or `32W`.
  final String size;

  /// Live EPC count for this row.
  final int quantity;

  final Color bgLow;
  final Color mainColor;

  @override
  Widget build(BuildContext context) {
    // Spec row layout — answer #7 in `bin-assign-spec.html`:
    //
    //   <custom-sku>  ·  <item description> (<colour> <size>)  ×N
    //
    // Top line: custom SKU (mono, primary). Bottom line: description with
    // the colour+size variant in muted parentheses, then qty pinned right.
    final variant = [
      if (colorCode.isNotEmpty) colorCode,
      if (size.isNotEmpty) size,
    ].join(' ');
    final variantSuffix = variant.isEmpty ? '' : ' ($variant)';
    return Container(
      padding: EdgeInsets.symmetric(horizontal: 16.w, vertical: 16.h),
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
                  sku,
                  style: GoogleFonts.spaceGrotesk(
                    fontSize: 16.sp,
                    fontWeight: FontWeight.w800,
                    color: mainColor,
                    letterSpacing: 0.5,
                  ),
                ),
                if (description.isNotEmpty || variantSuffix.isNotEmpty) ...[
                  SizedBox(height: 4.h),
                  // 2026-05-28: bigger + black description per operator design pass
                  Text(
                    '$description$variantSuffix'.trim(),
                    style: GoogleFonts.manrope(
                      fontSize: 15.sp,
                      fontWeight: FontWeight.w700,
                      color: AppColors.textMain,
                    ),
                  ),
                ],
              ],
            ),
          ),
          Text(
            '×$quantity',
            style: GoogleFonts.manrope(
              fontSize: 24.sp,
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
    required this.readyForNextEntry,
    required this.cameraEnabled,
    required this.canCleanBin,
    required this.canDeleteBin,
    required this.onCleanBin,
    required this.onDeleteBin,
    required this.onUndoClean,
    required this.onRefreshSession,
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

  /// True between an end-of-session and the operator's next physical scan.
  /// Drives the grey "READY FOR NEXT ENTRY" status label per spec answer #1.
  final bool readyForNextEntry;

  final bool cameraEnabled;
  /// RBAC: hide the CLEAN / DELETE bin controls when the role can't do them.
  final bool canCleanBin;
  final bool canDeleteBin;
  final VoidCallback onCleanBin;
  final VoidCallback onDeleteBin;
  final VoidCallback onUndoClean;
  /// Drops the session back to "scan a bin" — same path used after a
  /// successful assign. Operator hits this when they want to start over
  /// without un-doing past actions.
  final VoidCallback onRefreshSession;
  final VoidCallback onAddBin;
  final VoidCallback onAddBinCamera;
  final VoidCallback onAddItem;
  final VoidCallback onAddItemCamera;

  @override
  Widget build(BuildContext context) {
    return Container(
      color: bg,
      padding: EdgeInsets.fromLTRB(16.w, 6.h, 16.w, 0.h),
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
                // Broom icon — DELETE bin completely (RBAC: hidden when denied)
                if (canDeleteBin)
                  _IconTapZone(
                    onTap: onDeleteBin,
                    child: Icon(
                      Icons.cleaning_services_outlined,
                      color: AppColors.textMuted,
                      size: 22.sp,
                    ),
                  ),
                // Center label — main clean action (RBAC: hidden when denied)
                Expanded(
                  child: canCleanBin
                      ? InkWell(
                          onTap: onCleanBin,
                          child: Padding(
                            padding: EdgeInsets.symmetric(vertical: 14.h),
                            child: Text(
                              'CLEAN & EMPTY BIN',
                              textAlign: TextAlign.center,
                              style: GoogleFonts.manrope(
                                fontSize: 14.sp,
                                fontWeight: FontWeight.w800,
                                letterSpacing: 1.0,
                                color: mainColor,
                              ),
                            ),
                          ),
                        )
                      : const SizedBox.shrink(),
                ),
                // Undo icon — reverses the last reversible action.
                _IconTapZone(
                  onTap: onUndoClean,
                  child: Icon(
                    Icons.undo_rounded,
                    color: AppColors.textMuted,
                    size: 22.sp,
                  ),
                ),
                // Refresh icon — kicks the session back to the empty
                // "scan a bin" state without touching DB rows. Sits to the
                // right of Undo so the right edge of the row reads
                // "back-then-restart".
                _IconTapZone(
                  onTap: onRefreshSession,
                  child: Icon(
                    Icons.refresh_rounded,
                    color: AppColors.textMuted,
                    size: 22.sp,
                  ),
                ),
              ],
            ),
          ),
          SizedBox(height: 8.h),
          // ── Status label (spec answer #1) ─────────────────────────────
          //
          //   No bin            → red  "TRIGGER TO ADD BIN"
          //   Bin active, mid-  → red  "TRIGGER TO ADD ITEM"   (also shown
          //     session                  initially after bin confirm)
          //   Bin active, end-  → grey "READY FOR NEXT ENTRY"
          //     of-session
          //
          Padding(
            padding: EdgeInsets.only(bottom: 6.h),
            child: Align(
              alignment: Alignment.centerLeft,
              child: !binActive
                  ? Text(
                      'TRIGGER TO ADD BIN',
                      style: GoogleFonts.spaceGrotesk(
                        fontSize: 14.sp,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 2.0,
                        color: Colors.red,
                      ),
                    )
                  : readyForNextEntry
                      ? Text(
                          'READY FOR NEXT ENTRY',
                          style: GoogleFonts.spaceGrotesk(
                            fontSize: 14.sp,
                            fontWeight: FontWeight.w800,
                            letterSpacing: 2.0,
                            color: mutedColor,
                          ),
                        )
                      : Text(
                          'TRIGGER TO ADD ITEM',
                          style: GoogleFonts.spaceGrotesk(
                            fontSize: 14.sp,
                            fontWeight: FontWeight.w800,
                            letterSpacing: 2.0,
                            color: Colors.red,
                          ),
                        ),
            ),
          ),
          // ── ADD BIN + ADD ITEM ────────────────────────────────────────
          //
          // ADD BIN is never locked (spec answer #11/#12 — the camera path
          // is also the bin-swap path). ADD ITEM main + camera lock to 35%
          // opacity and ignore taps when no bin is confirmed (answer #13).
          //
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
              SizedBox(width: 12.w),
              Expanded(
                child: _DualActionButton(
                  label: 'ADD ITEM',
                  mainIcon: Icons.add_circle_outline,
                  color: tealLight,
                  onMain: onAddItem,
                  onCamera: onAddItemCamera,
                  showCamera: cameraEnabled,
                  locked: !binActive,
                ),
              ),
            ],
          ),
          SizedBox(height: 10.h),
        ],
      ),
    );
  }
}

/// A button with a main tap zone + an embedded camera icon tap zone on the right.
///
/// When [locked] is true the whole button drops to 35 % opacity and **both**
/// the main and camera tap zones become no-ops, per spec answer #13. Used on
/// the ADD ITEM button while no bin is confirmed.
class _DualActionButton extends StatelessWidget {
  const _DualActionButton({
    required this.label,
    required this.mainIcon,
    required this.color,
    required this.onMain,
    required this.onCamera,
    this.showCamera = true,
    this.locked = false,
  });

  final String label;
  final IconData mainIcon;
  final Color color;
  final VoidCallback onMain;
  final VoidCallback onCamera;
  final bool showCamera;
  final bool locked;

  @override
  Widget build(BuildContext context) {
    final mainTap = locked ? () {} : onMain;
    final cameraTap = locked ? () {} : onCamera;
    final body = Container(
      color: color,
      child: Row(
        children: [
          // Main label tap zone
          Expanded(
            child: InkWell(
              onTap: mainTap,
              child: Padding(
                padding: EdgeInsets.symmetric(vertical: 16.h),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(mainIcon, color: Colors.white, size: 20.sp),
                    SizedBox(width: 8.w),
                    Text(
                      label,
                      style: GoogleFonts.manrope(
                        fontSize: 14.sp,
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
            Container(width: 1.w, height: 36.h, color: Colors.white24),
            // Camera tap zone
            _IconTapZone(
              onTap: cameraTap,
              child: Icon(
                Icons.photo_camera_outlined,
                color: Colors.white,
                size: 20.sp,
              ),
            ),
          ],
        ],
      ),
    );
    return locked
        ? IgnorePointer(
            ignoring: true,
            child: Opacity(opacity: 0.35, child: body),
          )
        : body;
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
        padding: EdgeInsets.symmetric(horizontal: 16.w, vertical: 16.h),
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
            width: 1.w,
          ),
        ),
      ),
      child: SafeArea(
        top: false,
        child: SizedBox(
          height: 60.h,
          child: Row(
            children: [
              _NavItem(
                  icon: Icons.dashboard_outlined,
                  label: 'DASH',
                  active: false,
                  onTap: () => Navigator.of(context).maybePop()),
              _NavItem(
                  icon: Icons.menu_book_outlined,
                  label: 'CATALOG',
                  active: false,
                  onTap: () {
                    Navigator.of(context).push(MaterialPageRoute<void>(
                        builder: (_) => const InventoryCatalogScreen()));
                  }),
              _NavItem(
                  icon: Icons.radar,
                  label: 'FIND',
                  active: false,
                  onTap: () {
                    Navigator.of(context).push(MaterialPageRoute<void>(
                        builder: (_) => const GeigerSearchScreen()));
                  }),
              _NavItem(
                  icon: Icons.local_offer_outlined,
                  label: 'TAGS',
                  active: false,
                  onTap: () {
                    Navigator.of(context).push(MaterialPageRoute<void>(
                        builder: (_) => const PrintScreen(mode: PrintMode.rfid)));
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
            Icon(icon, color: color, size: 22.sp),
            SizedBox(height: 3.h),
            Text(
              label,
              style: GoogleFonts.manrope(
                fontSize: 10.sp,
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
