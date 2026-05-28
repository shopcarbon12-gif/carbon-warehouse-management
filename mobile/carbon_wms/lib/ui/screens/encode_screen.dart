import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/hardware/rfid_tag_read.dart';
import 'package:carbon_wms/hardware/rfid_vendor_channel.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/scan_sounds.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/screens/encode_test_tag_screen.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';

/// Handheld Encode flow (2026-05-28 redesign).
///
/// Phases:
///   1. SCAN     — Hold trigger, radio at 10 dBm, reads ANY EPCs in range
///                 (no status filter, no ingestEpcs routing). Recognized
///                 tags get full enrichment via /api/rfid/encode-resolve;
///                 unrecognized show just the EPC. Per-card trash.
///   2. PICK SKU — Search by SKU / UPC / name; tap to lock the target SKU.
///   3. ENCODE   — Single trigger pull writes a fresh SGTIN-96 EPC to
///                 each chip in the list (encode-claim → chip write).
///                 Server inserts the new items row with status='unknown'
///                 (the operator can re-check after the Test New Tag flow).
///   4. POST     — Each card gets a status dropdown (LIVE / TAG KILLED /
///                 UNKNOWN) with a save button (bulk-status) and a button
///                 to open the Test New Tag screen.
///
/// Reads bypass [RfidManager] and listen directly to
/// [RfidVendorChannel.tagReadStream] so the screen sees every EPC the
/// radio reports regardless of WMS visibility / ghost-filter state.
class EncodeScreen extends StatefulWidget {
  const EncodeScreen({super.key});

  @override
  State<EncodeScreen> createState() => _EncodeScreenState();
}

/// Standard error red used across the mobile (add_on_count uses the same).
const Color _kErrorRed = Color(0xFFD9534F);
const Color _kSuccessGreen = Color(0xFF2A8E2A);
const Color _kCardGrey = Color(0xFFECECEC);
const Color _kTrashRed = Color(0xFFBF2E2E);
const Color _kTealLight = Color(0xFF2BA3A3);
const Color _kTextMuted = Color(0xFF8A9090);
const Color _kTextSlate = Color(0xFF3F4A4A);
const Color _kPwrStripBg = Color(0xFFEEF4F3);
const Color _kTrayBg = Color(0xFFF4F7F7);
const Color _kHairline = Color(0x14000000);
const Color _kBtnDisabled = Color(0xFFBCC9C9);
const Color _kSaveDisabledBg = Color(0xFFE0E6E6);
const Color _kErrLineBg = Color(0xFFFFF4F4);
const Color _kPillOkBg = Color(0xFFD6F5E6);
const Color _kPillBadBg = Color(0x24D9534F); // ≈ rgba(217,83,79,0.14)
const Color _kPillQueuedBg = Color(0x268A9090);
const Color _kAmber = Color(0xFFE08A2C);

enum _Phase { scan, pickSku, encoding, post }

/// One scanned/encoded chip in the operator's working list.
class _Tag {
  _Tag({required this.oldEpc});

  /// EPC the chip was broadcasting when we first heard it.
  final String oldEpc;

  /// Server enrichment of [oldEpc]. null for foreign / undecodable tags.
  /// Populated asynchronously by [_EncodeScreenState._resolveTag] after
  /// the card is added to the list.
  Map<String, dynamic>? resolved;

  /// Set when /api/rfid/encode-claim returns a new EPC AND the chip
  /// write verifies post-power-cycle. Null until the encode pass runs
  /// and succeeds for this tag.
  String? newEpc;

  /// Set when the encode pass for THIS tag failed (write didn't verify,
  /// claim returned 4xx, etc.). Mutually exclusive with [newEpc].
  String? encodeError;

  /// Current items.status as the operator sees it after encode. Defaults
  /// to 'unknown' (matches the server's encode-claim insert). Operator
  /// can flip via dropdown + save button.
  String currentStatus = 'unknown';

  /// True when [currentStatus] has been persisted via bulk-status since
  /// the last change. Save button only enabled when this is false.
  bool statusSaved = true;

  /// Expanded card chrome (shows the 2-col key/value grid). Tap toggles.
  bool expanded = false;
}

class _EncodeScreenState extends State<EncodeScreen> {
  static const int _defaultPowerDbm = 1;
  // Slider bounds for THIS screen only (the global RfidPowerSlider stops at
  // kAntennaPowerDbmMax=30). Operator asked for 0-33 here so the encode
  // workspace can dial above the global cap when needed. Native clamps
  // internally — Chainway C72E hard-caps at 23 (thermal), Zebra RFD8500
  // at 30 — so a 33 here lands at the chip's real max.
  static const int _powerMinDbm = 0;
  static const int _powerMaxDbm = 33;
  static const Duration _powerDebounce = Duration(milliseconds: 250);
  static const Duration _searchDebounce = Duration(milliseconds: 300);
  static const int _minQueryLen = 2;

  _Phase _phase = _Phase.scan;

  // Power slider (local to this screen)
  int _powerDbm = _defaultPowerDbm;
  Timer? _powerPushTimer;

  // Phase 1
  final List<_Tag> _tags = [];
  bool _isScanning = false;
  final Set<String> _pendingResolve = <String>{};

  // Phase 2
  final TextEditingController _searchCtrl = TextEditingController();
  Timer? _searchDebounceTimer;
  String _query = '';
  bool _searchLoading = false;
  String? _searchError;
  List<Map<String, dynamic>> _searchResults = [];
  Map<String, dynamic>? _selectedSku;

  // Phase 3
  int _encodingIndex = -1;
  bool _encodePassDone = false;
  // True after the post-encode teardown ran, blocks further trigger pulls
  // from re-firing the encode loop (operator asked: "turn off automatically
  // the encode mode" once the pass completes).
  bool _encodeModeDisabled = false;

  // Phase banner / error toast
  String? _banner;

  // Streams
  StreamSubscription<RfidTagRead>? _tagSub;
  StreamSubscription<String>? _triggerSub;
  StreamSubscription<String>? _barcodeSub;

  @override
  void initState() {
    super.initState();
    unawaited(ScanSounds.instance.init());
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _activateScanPhase();
    });
  }

  @override
  void dispose() {
    _tagSub?.cancel();
    _triggerSub?.cancel();
    _barcodeSub?.cancel();
    _searchDebounceTimer?.cancel();
    _powerPushTimer?.cancel();
    _searchCtrl.dispose();
    // Stop any active inventory so the next screen doesn't inherit it.
    unawaited(RfidVendorChannel.stopChainwayInventory());
    unawaited(RfidVendorChannel.stopZebraInventory());
    // Also collapse the 2D imager — if the operator unmounts while
    // pickSku is still open, the imager would otherwise stay armed and
    // the next screen's trigger pull would fire a barcode scan instead
    // of whatever it expects.
    unawaited(RfidVendorChannel.scannerDisableTriggerRelay());
    unawaited(RfidVendorChannel.close2dBarcode());
    // Restore default RFID trigger mode for downstream screens.
    unawaited(RfidVendorChannel.setZebraTriggerModeRfid());
    super.dispose();
  }

  // ── Phase activation ──────────────────────────────────────────────────

  Future<void> _activateScanPhase() async {
    if (!mounted) return;
    setState(() {
      _phase = _Phase.scan;
      _banner = null;
    });
    // Kill any 2D imager mode the previous screen left armed.
    unawaited(RfidVendorChannel.scannerDisableTriggerRelay());
    unawaited(RfidVendorChannel.close2dBarcode());
    unawaited(RfidVendorChannel.enableRfidFunctionMode());
    unawaited(RfidVendorChannel.setZebraTriggerModeRfid());
    // Push the slider's current dBm to the chip on entry. Default is
    // _defaultPowerDbm (10) — close-range so a foreign tag in the next
    // bin can't accidentally join the list — but the operator can drag
    // the on-screen slider to anywhere in 0..33 dBm at any time.
    unawaited(RfidVendorChannel.setAntennaPowerDbm(_powerDbm));
    _attachTagAndTriggerStreams();
  }

  void _attachTagAndTriggerStreams() {
    _tagSub ??= RfidVendorChannel.tagReadStream().listen(_onRawTagRead);
    _triggerSub ??=
        RfidVendorChannel.hardwareTriggerStream().listen(_onTrigger);
  }

  // ── Trigger handling ──────────────────────────────────────────────────

  void _onTrigger(String event) {
    if (!mounted) return;
    // Edge: only act on 'down' for every phase. Operator asked for
    // pull-to-start / pull-to-stop on Phase 1 (toggle), and a single
    // pull to fire the encode loop in Phase 3. We never react to 'up'
    // so a quick double-tap can't get the radio out of sync.
    if (event != 'down') return;
    switch (_phase) {
      case _Phase.scan:
        // Toggle: first pull starts inventory, next pull stops it.
        if (_isScanning) {
          unawaited(_stopInventory());
        } else {
          unawaited(_startInventory());
        }
        break;
      case _Phase.pickSku:
        // Trigger does nothing while the operator is searching for the
        // target SKU. They use the text field + tap.
        break;
      case _Phase.encoding:
        // Single trigger pull fires the encode pass. _encodeModeDisabled
        // is flipped true in _runEncodePass's finally so a stray pull
        // after completion can't re-fire — operator asked the encode
        // mode to "turn off automatically" once the pass is done.
        if (_encodingIndex < 0 && !_encodePassDone && !_encodeModeDisabled) {
          unawaited(_runEncodePass());
        }
        break;
      case _Phase.post:
        // No trigger action in post-encode review. Operator uses the
        // per-card buttons.
        break;
    }
  }

  Future<void> _startInventory() async {
    if (_isScanning) return;
    if (!mounted) return;
    setState(() => _isScanning = true);
    try {
      ScanSounds.instance.play(ScanCue.start);
    } catch (_) {}
    try {
      await RfidVendorChannel.startChainwayInventory();
    } catch (_) {}
    try {
      await RfidVendorChannel.startZebraInventory();
    } catch (_) {}
  }

  Future<void> _stopInventory() async {
    if (!_isScanning) return;
    if (!mounted) return;
    setState(() => _isScanning = false);
    try {
      await RfidVendorChannel.stopChainwayInventory();
    } catch (_) {}
    try {
      await RfidVendorChannel.stopZebraInventory();
    } catch (_) {}
    try {
      ScanSounds.instance.play(ScanCue.stop);
    } catch (_) {}
  }

  // ── Phase 1: raw read + per-EPC enrichment ────────────────────────────

  void _onRawTagRead(RfidTagRead read) {
    if (!mounted) return;
    if (_phase != _Phase.scan) return;
    final epc = read.epcHex24;
    if (epc.length != 24) return;
    final exists = _tags.any((t) => t.oldEpc == epc);
    if (exists) return;
    final tag = _Tag(oldEpc: epc);
    setState(() => _tags.add(tag));
    // Fire the resolve in the background. If it fails, the card stays
    // as "unrecognized" — that's the right thing for foreign / orphan
    // tags the operator wants to encode anyway.
    unawaited(_resolveTag(tag));
  }

  Future<void> _resolveTag(_Tag tag) async {
    if (_pendingResolve.contains(tag.oldEpc)) return;
    _pendingResolve.add(tag.oldEpc);
    final api = context.read<WmsApiClient>();
    try {
      final r = await api.postEncodeResolve(tag.oldEpc);
      if (!mounted) return;
      // Server returns { status: 'known' | 'valid_orphan' | 'foreign',
      //                  item?: {...catalog fields} }
      final status = r['status']?.toString();
      final item = r['item'];
      if (status == 'known' && item is Map<String, dynamic>) {
        setState(() => tag.resolved = item);
      } else if (status == 'valid_orphan' || status == 'foreign') {
        // Decoded but no items row (or not our prefix) — keep card as EPC-only.
      }
    } catch (_) {
      // Best effort. Card stays as EPC-only.
    } finally {
      _pendingResolve.remove(tag.oldEpc);
    }
  }

  void _removeTag(_Tag tag) {
    setState(() => _tags.remove(tag));
  }

  void _toggleExpand(_Tag tag) {
    setState(() => tag.expanded = !tag.expanded);
  }

  // ── Phase 2: SKU search ───────────────────────────────────────────────

  void _onSearchChanged(String v) {
    _query = v.trim();
    _searchDebounceTimer?.cancel();
    if (_query.length < _minQueryLen) {
      setState(() {
        _searchResults = [];
        _searchError = null;
      });
      return;
    }
    _searchDebounceTimer = Timer(_searchDebounce, _runSearch);
  }

  Future<void> _runSearch() async {
    if (!mounted) return;
    final api = context.read<WmsApiClient>();
    setState(() {
      _searchLoading = true;
      _searchError = null;
    });
    try {
      final rows = await api.catalogSearch(_query, limit: 12);
      if (!mounted) return;
      setState(() {
        _searchResults = rows;
        _searchLoading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _searchResults = [];
        _searchError = '$e';
        _searchLoading = false;
      });
    }
  }

  void _selectSku(Map<String, dynamic> row) {
    // Leaving pickSku → close the 2D imager + restore RFID trigger so the
    // operator's next trigger pull fires the encode pass, not the imager.
    unawaited(_disableSearchScanner());
    setState(() {
      _selectedSku = row;
      _phase = _Phase.encoding;
      _encodingIndex = -1;
      _encodePassDone = false;
      _encodeModeDisabled = false;
      _banner = null;
    });
    // The 2D-imager setup briefly switched the radio config — push the
    // slider's dBm back so the encode runs at the operator's chosen power.
    unawaited(RfidVendorChannel.setAntennaPowerDbm(_powerDbm));
  }

  // ── Phase 3: sequential encode pass ───────────────────────────────────

  Future<void> _runEncodePass() async {
    final sku = _selectedSku;
    if (sku == null) return;
    final customSkuId = sku['custom_sku_id']?.toString() ??
        sku['id']?.toString() ??
        '';
    if (customSkuId.isEmpty) {
      setState(() => _banner = 'Selected SKU is missing custom_sku_id — pick again');
      return;
    }
    final api = context.read<WmsApiClient>();

    setState(() {
      _encodingIndex = 0;
      _banner = null;
    });

    for (var i = 0; i < _tags.length; i++) {
      if (!mounted) return;
      final tag = _tags[i];
      setState(() => _encodingIndex = i);

      // 1) Claim a new EPC server-side. Server allocates next serial +
      //    inserts items row at status='unknown' + (optionally) marks
      //    oldEpc as tag_killed when we pass it in.
      String? newEpc;
      try {
        final claim = await api.postEncodeClaim(
          customSkuId: customSkuId,
          oldEpc: tag.oldEpc,
        );
        newEpc = (claim['epc'] as String?)?.trim().toUpperCase();
        if (newEpc == null || newEpc.length != 24) {
          tag.encodeError = 'claim returned no EPC';
          try {
            ScanSounds.instance.play(ScanCue.error);
          } catch (_) {}
          continue;
        }
      } catch (e) {
        tag.encodeError = 'claim failed: $e';
        try {
          ScanSounds.instance.play(ScanCue.error);
        } catch (_) {}
        continue;
      }

      // 2) Physically write the chip. Native writeEpcOnce returns true
      //    only after a post-power-cycle verify read sees newEpc (or
      //    explicit verify success). Translating: if this returns true,
      //    the EEPROM committed; if false, the chip still broadcasts
      //    the old EPC.
      bool wrote = false;
      try {
        wrote = await RfidVendorChannel.writeEpcTag(
          targetEpc: tag.oldEpc,
          newEpc: newEpc,
        );
      } catch (e) {
        tag.encodeError = 'write threw: $e';
        wrote = false;
      }

      if (wrote) {
        tag.newEpc = newEpc;
        tag.encodeError = null;
        // Server inserted at 'unknown' — mirror that on the client so the
        // dropdown defaults correctly and the save button stays disabled
        // until the operator picks a different status.
        tag.currentStatus = 'unknown';
        tag.statusSaved = true;
        try {
          ScanSounds.instance.play(ScanCue.success);
        } catch (_) {}
      } else {
        tag.encodeError = 'write did not verify';
        try {
          ScanSounds.instance.play(ScanCue.error);
        } catch (_) {}
      }
      if (!mounted) return;
      setState(() {});
    }

    if (!mounted) return;
    // Post-pass teardown: tally results, turn off "encode mode" so any
    // remaining trigger pulls do nothing, surface a summary banner with
    // every EPC the operator just touched.
    final succeeded = _tags.where((t) => t.newEpc != null).toList();
    final failed = _tags.where((t) => t.encodeError != null).toList();
    final summary = StringBuffer()
      ..write('Encode complete · ')
      ..write('${succeeded.length} succeeded · ')
      ..write('${failed.length} failed');
    if (succeeded.isNotEmpty) {
      summary.write(
        '\nNew EPCs: ${succeeded.map((t) => t.newEpc).join(', ')}',
      );
    }
    if (failed.isNotEmpty) {
      summary.write(
        '\nFailed: ${failed.map((t) => t.oldEpc).join(', ')}',
      );
    }
    // Also stop the radio outright — between writes the chip wasn't doing
    // continuous inventory, but the trigger-relay (for the 2D imager) and
    // any background scan should be quiesced so the operator can step
    // back without firing anything.
    unawaited(RfidVendorChannel.stopChainwayInventory());
    unawaited(RfidVendorChannel.stopZebraInventory());
    setState(() {
      _encodingIndex = -1;
      _encodePassDone = true;
      _encodeModeDisabled = true;
      _phase = _Phase.post;
      _banner = summary.toString();
      _isScanning = false;
    });
  }

  // ── Phase 4: post-encode dropdown actions ─────────────────────────────

  void _setStatusForTag(_Tag tag, String next) {
    if (tag.currentStatus == next) return;
    setState(() {
      tag.currentStatus = next;
      tag.statusSaved = false;
    });
  }

  Future<void> _saveStatus(_Tag tag) async {
    final newEpc = tag.newEpc;
    if (newEpc == null) return;
    if (tag.statusSaved) return;
    final api = context.read<WmsApiClient>();
    setState(() => _banner = 'Saving ${tag.currentStatus}…');
    try {
      await api.postBulkStatus(
        epcs: [newEpc],
        targetStatus: tag.currentStatus,
      );
      if (!mounted) return;
      setState(() {
        tag.statusSaved = true;
        _banner = null;
      });
      try {
        ScanSounds.instance.play(ScanCue.success);
      } catch (_) {}
    } catch (e) {
      if (!mounted) return;
      setState(() => _banner = 'Save failed: $e');
      try {
        ScanSounds.instance.play(ScanCue.error);
      } catch (_) {}
    }
  }

  void _openTestNewTag(_Tag tag) {
    final newEpc = tag.newEpc;
    if (newEpc == null) return;
    Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder: (_) => EncodeTestTagScreen(expectedEpc: newEpc),
      ),
    );
  }

  /// State accent strip color for the 4 px left edge of a card.
  /// Teal during encode, green on success, red on failure, transparent otherwise.
  Color _resolveAccent(_Tag tag) {
    if (tag.encodeError != null) return _kErrorRed;
    if (tag.newEpc != null) return _kSuccessGreen;
    final idx = _tags.indexOf(tag);
    if (_encodingIndex == idx && _encodingIndex >= 0) return AppColors.primary;
    return Colors.transparent;
  }

  // ── Build ─────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return CarbonScaffold(
      pageTitle: 'ENCODE',
      bottomBar: _buildBottomBar(),
      body: ColoredBox(
        color: Colors.white,
        child: Column(
          children: [
            if (_banner != null)
              Padding(
                padding: EdgeInsets.fromLTRB(20.w, 8.h, 20.w, 0),
                child: Container(
                  width: double.infinity,
                  padding: EdgeInsets.symmetric(horizontal: 12.w, vertical: 10.h),
                  decoration: BoxDecoration(
                    color: const Color(0xFFFFF4E5),
                    border: Border.all(color: _kAmber),
                    borderRadius: BorderRadius.circular(4.r),
                  ),
                  child: Text(
                    _banner!,
                    style: GoogleFonts.spaceGrotesk(
                      fontSize: 12.sp,
                      fontWeight: FontWeight.w700,
                      color: const Color(0xFF8A4E12),
                    ),
                  ),
                ),
              ),
            if (_phase == _Phase.encoding && _selectedSku != null)
              Padding(
                padding: EdgeInsets.fromLTRB(20.w, 8.h, 20.w, 0),
                child: Container(
                  width: double.infinity,
                  padding: EdgeInsets.symmetric(horizontal: 12.w, vertical: 8.h),
                  decoration: BoxDecoration(
                    color: AppColors.primary.withValues(alpha: 0.10),
                    borderRadius: BorderRadius.circular(4.r),
                  ),
                  child: Text(
                    'TARGET: ${_skuSummary(_selectedSku!)}',
                    style: GoogleFonts.spaceGrotesk(
                      fontSize: 12.sp,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 0.8,
                      color: const Color(0xFF0F5757),
                    ),
                  ),
                ),
              ),
            Expanded(
              child: _phase == _Phase.pickSku
                  ? _buildPickSkuBody()
                  : _buildTagListBody(),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildBottomBar() {
    final showPwr = _phase == _Phase.scan || _phase == _Phase.encoding;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (showPwr)
          _EncodePowerSlider(
            powerDbm: _powerDbm,
            minDbm: _powerMinDbm,
            maxDbm: _powerMaxDbm,
            onChanged: _onPowerSliderChanged,
            onChangeEnd: _onPowerSliderEnded,
          ),
        _buildToolbar(),
      ],
    );
  }

  Widget _buildToolbar() {
    return Container(
      height: 88.h,
      decoration: const BoxDecoration(
        color: Colors.white,
        boxShadow: [
          BoxShadow(
            color: Color(0x14000000),
            offset: Offset(0, -8),
            blurRadius: 24,
          ),
        ],
      ),
      padding: EdgeInsets.symmetric(horizontal: 16.w, vertical: 8.h),
      child: Row(
        children: [
          Expanded(
            flex: 1,
            child: _ToolbarButton(
              label: 'REFRESH',
              icon: Icons.refresh,
              background: _kTealLight,
              onPressed: _resetToScan,
            ),
          ),
          SizedBox(width: 8.w),
          Expanded(
            flex: 2,
            child: _buildRightToolbarButton(),
          ),
        ],
      ),
    );
  }

  Widget _buildRightToolbarButton() {
    switch (_phase) {
      case _Phase.scan:
        final disabled = _tags.isEmpty || _isScanning;
        return _ToolbarButton(
          label: 'SEARCH SKU',
          icon: LucideIcons.search,
          background: disabled ? _kBtnDisabled : AppColors.primary,
          onPressed: disabled ? null : _goToPickSku,
        );
      case _Phase.pickSku:
        // Per spec: hide the right button while picking. Render a
        // zero-sized placeholder so the flex slot stays.
        return const SizedBox.shrink();
      case _Phase.encoding:
        return const SizedBox.shrink();
      case _Phase.post:
        return _ToolbarButton(
          label: 'NEW SESSION',
          icon: Icons.add,
          background: AppColors.primary,
          onPressed: _resetToScan,
        );
    }
  }

  Future<void> _resetToScan() async {
    // Tear down 2D imager mode if the pickSku phase enabled it, re-arm
    // RFID, clear the working list. The radio is left STOPPED and the
    // streams re-attached so the operator's next trigger pull starts
    // a fresh inventory pass — REFRESH should not be a hidden trigger.
    await _disableSearchScanner();
    await _stopInventory();
    if (!mounted) return;
    setState(() {
      _phase = _Phase.scan;
      _selectedSku = null;
      _searchCtrl.clear();
      _query = '';
      _searchResults = [];
      _searchError = null;
      _encodingIndex = -1;
      _encodePassDone = false;
      _encodeModeDisabled = false;
      _banner = null;
      _isScanning = false;
      _tags.clear();
    });
    // Re-assert RFID-only trigger mode + push the slider's dBm so the
    // radio is ready the moment the operator pulls the trigger, not
    // whatever the 2D-imager setup or post-encode teardown left it at.
    unawaited(RfidVendorChannel.scannerDisableTriggerRelay());
    unawaited(RfidVendorChannel.close2dBarcode());
    unawaited(RfidVendorChannel.enableRfidFunctionMode());
    unawaited(RfidVendorChannel.setZebraTriggerModeRfid());
    unawaited(RfidVendorChannel.setAntennaPowerDbm(_powerDbm));
    _attachTagAndTriggerStreams();
  }

  void _goToPickSku() {
    setState(() {
      _phase = _Phase.pickSku;
      _banner = null;
    });
    // Search-phase ergonomics: open the 2D imager + barcode broadcast so
    // a trigger pull or a separate hardware key scans a barcode straight
    // into the search field. Keep typing as an alternative (the text
    // field is autofocused in _buildPickSkuBody).
    unawaited(_stopInventory());
    unawaited(_enableSearchScanner());
  }

  // ── Power slider (0-33 dBm, debounced push to chip) ───────────────────

  /// Called on every Slider onChanged tick. Updates the visible value
  /// immediately so the label tracks the finger, but debounces the
  /// native chip push by [_powerDebounce]. Final value is also flushed
  /// on onChangeEnd so finger-up feels instant. Same coalesce pattern
  /// the global RfidPowerSlider uses (see project_pos_power_rate_limit
  /// memory for the why).
  void _onPowerSliderChanged(int dbm) {
    if (_powerDbm == dbm) return;
    setState(() => _powerDbm = dbm);
    _powerPushTimer?.cancel();
    _powerPushTimer = Timer(_powerDebounce, () => _pushPowerToChip(dbm));
  }

  void _onPowerSliderEnded(int dbm) {
    _powerPushTimer?.cancel();
    _pushPowerToChip(dbm);
  }

  void _pushPowerToChip(int dbm) {
    // Native controllers clamp internally — Chainway to 5..23, Zebra to
    // 0..30 — so a 33 here lands at whichever chip's actual max. We
    // still display 0..33 because the operator asked to see the full
    // theoretical band on this screen.
    unawaited(RfidVendorChannel.setAntennaPowerDbm(dbm));
  }

  // ── 2D imager wiring for the pickSku phase ────────────────────────────

  Future<void> _enableSearchScanner() async {
    // Chainway: enable the trigger-relay so a hardware trigger pull fires
    // the imager. Zebra: flip the sled's trigger from RFID to barcode.
    unawaited(RfidVendorChannel.scannerEnableTriggerRelay());
    unawaited(RfidVendorChannel.open2dBarcode());
    unawaited(RfidVendorChannel.setZebraTriggerMode2D());
    _barcodeSub ??=
        RfidVendorChannel.hardwareBarcodeStream().listen(_onBarcode);
  }

  Future<void> _disableSearchScanner() async {
    await _barcodeSub?.cancel();
    _barcodeSub = null;
    unawaited(RfidVendorChannel.scannerDisableTriggerRelay());
    unawaited(RfidVendorChannel.close2dBarcode());
    unawaited(RfidVendorChannel.setZebraTriggerModeRfid());
  }

  void _onBarcode(String raw) {
    if (!mounted) return;
    if (_phase != _Phase.pickSku) return;
    final v = raw.trim();
    if (v.isEmpty) return;
    // Don't auto-fire encode when a UHF 24-hex value happens to slip
    // through the imager broadcast — only treat it as a search term if
    // it's something the catalog can actually match.
    if (RegExp(r'^[0-9A-Fa-f]{24}$').hasMatch(v)) return;
    _searchCtrl.text = v;
    _searchCtrl.selection =
        TextSelection.collapsed(offset: _searchCtrl.text.length);
    _onSearchChanged(v);
  }

  Widget _buildTagListBody() {
    if (_tags.isEmpty) {
      return Container(
        alignment: Alignment.center,
        padding: EdgeInsets.symmetric(horizontal: 32.w),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(LucideIcons.radio,
                size: 40, color: const Color(0xFF8FA1A1)),
            const SizedBox(height: 12),
            Text(
              _phase == _Phase.scan
                  ? 'Pull the trigger to start scanning.\nRadio is at $_powerDbm dBm.'
                  : 'No tags in this session.',
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.w600,
                color: Color(0xFF6D7979),
              ),
            ),
          ],
        ),
      );
    }
    return ListView.separated(
      padding: EdgeInsets.fromLTRB(20.w, 6.h, 20.w, 12.h),
      itemCount: _tags.length,
      separatorBuilder: (_, __) => SizedBox(height: 12.h),
      itemBuilder: (_, i) {
        final tag = _tags[i];
        final isActive = _encodingIndex == i && _phase == _Phase.encoding;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _CountItemContainer(
              tag: tag,
              phase: _phase,
              isActive: isActive,
              encodeRunning: _encodingIndex >= 0,
              accent: _resolveAccent(tag),
              onTap: () => _toggleExpand(tag),
              onRemove: (_phase == _Phase.scan || _phase == _Phase.pickSku) &&
                      _encodingIndex < 0
                  ? () => _removeTag(tag)
                  : null,
            ),
            if (_phase == _Phase.post && tag.newEpc != null) ...[
              _StatusTray(
                tag: tag,
                onStatusChanged: (s) => _setStatusForTag(tag, s),
                onSave: tag.statusSaved ? null : () => _saveStatus(tag),
              ),
              _TestNewTagRow(onPressed: () => _openTestNewTag(tag)),
            ],
            if (_phase == _Phase.post && tag.encodeError != null)
              Container(
                color: _kErrLineBg,
                padding: EdgeInsets.symmetric(horizontal: 14.w, vertical: 8.h),
                width: double.infinity,
                child: Text(
                  'Encode failed: ${tag.encodeError}',
                  style: GoogleFonts.spaceGrotesk(
                    fontSize: 12.sp,
                    fontWeight: FontWeight.w700,
                    color: _kErrorRed,
                  ),
                ),
              ),
          ],
        );
      },
    );
  }

  Widget _buildPickSkuBody() {
    final imagerArmed = _barcodeSub != null;
    return Column(
      children: [
        Padding(
          padding: EdgeInsets.fromLTRB(20.w, 14.h, 20.w, 6.h),
          child: Stack(
            clipBehavior: Clip.none,
            children: [
              Container(
                decoration: BoxDecoration(
                  color: Colors.white,
                  border: Border.all(color: AppColors.primary, width: 2),
                  borderRadius: BorderRadius.circular(2.r),
                ),
                padding: EdgeInsets.symmetric(horizontal: 14.w, vertical: 10.h),
                child: TextField(
                  controller: _searchCtrl,
                  autofocus: true,
                  decoration: const InputDecoration(
                    isCollapsed: true,
                    border: InputBorder.none,
                    enabledBorder: InputBorder.none,
                    focusedBorder: InputBorder.none,
                    contentPadding: EdgeInsets.zero,
                    hintText: '',
                  ),
                  style: GoogleFonts.robotoMono(
                    fontSize: 22.sp,
                    fontWeight: FontWeight.w700,
                    color: AppColors.textMain,
                  ),
                  onChanged: _onSearchChanged,
                ),
              ),
              Positioned(
                top: -10.h,
                left: 12.w,
                child: Container(
                  color: Colors.white,
                  padding: EdgeInsets.symmetric(horizontal: 6.w),
                  child: Text(
                    'Search item',
                    style: GoogleFonts.spaceGrotesk(
                      fontSize: 12.sp,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 0.6,
                      color: _kTextSlate,
                    ),
                  ),
                ),
              ),
              if (imagerArmed)
                Positioned(
                  top: -10.h,
                  right: 12.w,
                  child: Container(
                    decoration: BoxDecoration(
                      color: AppColors.primary,
                      borderRadius: BorderRadius.circular(3.r),
                    ),
                    padding: EdgeInsets.symmetric(horizontal: 8.w, vertical: 1.h),
                    child: Text(
                      '2D',
                      style: GoogleFonts.spaceGrotesk(
                        fontSize: 10.sp,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 1.2,
                        color: Colors.white,
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
        if (_searchLoading)
          Padding(
            padding: EdgeInsets.symmetric(vertical: 8.h),
            child: const LinearProgressIndicator(minHeight: 2),
          ),
        if (_searchError != null)
          Padding(
            padding: EdgeInsets.symmetric(horizontal: 20.w, vertical: 6.h),
            child: Text(
              'Search failed: $_searchError',
              style: GoogleFonts.spaceGrotesk(
                fontSize: 11.sp,
                color: _kErrorRed,
              ),
            ),
          ),
        Expanded(
          child: _searchResults.isEmpty
              ? Center(
                  child: Text(
                    _query.length < _minQueryLen
                        ? 'Type at least $_minQueryLen characters to search'
                        : (_searchLoading ? '' : 'No results'),
                    style: GoogleFonts.manrope(
                      fontSize: 12.sp,
                      color: const Color(0xFF6D7979),
                    ),
                  ),
                )
              : Container(
                  margin: EdgeInsets.fromLTRB(20.w, 12.h, 20.w, 16.h),
                  decoration: BoxDecoration(
                    color: Colors.white,
                    border: Border.all(color: const Color(0xFFD7DEDE)),
                    borderRadius: BorderRadius.circular(2.r),
                  ),
                  child: ListView.separated(
                    padding: EdgeInsets.zero,
                    itemCount: _searchResults.length,
                    separatorBuilder: (_, __) => const Divider(
                      height: 1,
                      thickness: 1,
                      color: Color(0xFFF0F2F2),
                    ),
                    itemBuilder: (_, i) {
                      final row = _searchResults[i];
                      return _SkuResultTile(
                          row: row, onTap: () => _selectSku(row));
                    },
                  ),
                ),
        ),
      ],
    );
  }
}

String _skuSummary(Map<String, dynamic> row) {
  final sku = row['sku']?.toString() ?? row['custom_sku']?.toString() ?? '';
  final name = row['name']?.toString() ?? row['item_name']?.toString() ?? '';
  final color = row['color']?.toString() ?? '';
  final size = row['size']?.toString() ?? '';
  final parts = <String>[
    if (sku.isNotEmpty) sku,
    if (name.isNotEmpty) name,
    if (color.isNotEmpty) color,
    if (size.isNotEmpty) size,
  ];
  return parts.isEmpty ? '—' : parts.join(' · ');
}

// ── SKU search result tile ──────────────────────────────────────────────

class _SkuResultTile extends StatelessWidget {
  const _SkuResultTile({required this.row, required this.onTap});

  final Map<String, dynamic> row;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final sku = row['sku']?.toString() ?? row['custom_sku']?.toString() ?? '';
    final name = row['name']?.toString() ?? row['item_name']?.toString() ?? '';
    final color = row['color']?.toString() ?? '';
    final size = row['size']?.toString() ?? '';
    final descParts = <String>[
      if (name.isNotEmpty) name,
      if (color.isNotEmpty) color,
      if (size.isNotEmpty) size,
    ];
    final desc = descParts.join(' · ').toUpperCase();
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: EdgeInsets.fromLTRB(18.w, 12.h, 18.w, 12.h),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              sku.isEmpty ? '—' : sku,
              style: GoogleFonts.robotoMono(
                fontSize: 18.sp,
                fontWeight: FontWeight.w700,
                color: AppColors.primary,
              ),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            if (desc.isNotEmpty) ...[
              SizedBox(height: 4.h),
              // 2026-05-28: bigger + black description per operator design pass
              Text(
                desc,
                style: GoogleFonts.manrope(
                  fontSize: 15.sp,
                  fontWeight: FontWeight.w700,
                  color: AppColors.textMain,
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ],
          ],
        ),
      ),
    );
  }
}

// ── Count-style item container ──────────────────────────────────────────

class _CountItemContainer extends StatelessWidget {
  const _CountItemContainer({
    required this.tag,
    required this.phase,
    required this.isActive,
    required this.encodeRunning,
    required this.accent,
    required this.onTap,
    required this.onRemove,
  });

  final _Tag tag;
  final _Phase phase;
  final bool isActive;
  final bool encodeRunning;
  final Color accent;
  final VoidCallback onTap;
  final VoidCallback? onRemove;

  String _skuLine() {
    final r = tag.resolved;
    if (r != null) {
      final sku = r['sku']?.toString() ?? r['custom_sku']?.toString() ?? '';
      if (sku.isNotEmpty) return 'SKU: $sku';
    }
    return tag.oldEpc;
  }

  String _descLine() {
    final r = tag.resolved;
    if (r == null) return 'Foreign / not in catalog';
    final name = r['name']?.toString() ?? r['item_name']?.toString() ?? '';
    final color = r['color']?.toString() ?? '';
    final size = r['size']?.toString() ?? '';
    final parts = <String>[
      if (name.isNotEmpty) name,
      if (color.isNotEmpty) color,
      if (size.isNotEmpty) size,
    ];
    return parts.isEmpty ? '—' : parts.join(' · ').toUpperCase();
  }

  Map<String, String> _kvs() {
    final r = tag.resolved;
    if (r == null) return const {};
    final out = <String, String>{};
    final upc = r['upc']?.toString() ?? '';
    final color = r['color']?.toString() ?? '';
    final size = r['size']?.toString() ?? '';
    final bin = r['bin_code']?.toString() ?? r['bin']?.toString() ?? '';
    final status = r['status']?.toString() ?? '';
    final matrix = r['matrix']?.toString() ?? r['matrix_id']?.toString() ?? '';
    if (upc.isNotEmpty) out['UPC'] = upc;
    if (color.isNotEmpty) out['COLOR'] = color;
    if (size.isNotEmpty) out['SIZE'] = size;
    if (bin.isNotEmpty) out['BIN'] = bin;
    if (status.isNotEmpty) out['STATUS'] = status;
    if (matrix.isNotEmpty) out['MATRIX'] = matrix;
    return out;
  }

  @override
  Widget build(BuildContext context) {
    final recognized = tag.resolved != null;
    final kvs = tag.expanded ? _kvs() : const <String, String>{};
    final descColor = recognized ? AppColors.textMain : _kTextMuted;

    // Plain Container + GestureDetector — no Material/InkWell/Stack.
    // Earlier shape used Material > InkWell > Stack with a Positioned
    // accent strip + Align in the slot; layout was fragile in release
    // builds and a single broken constraint blanked the whole card.
    // This version makes the accent strip just be the leading child of
    // the Row and gives the right slot a fixed width.
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Container(
        color: _kCardGrey,
        child: IntrinsicHeight(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Container(
                width: 4,
                color: accent == Colors.transparent ? _kCardGrey : accent,
              ),
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(12, 10, 8, 10),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.center,
                        children: [
                          Expanded(
                            child: Text(
                              _skuLine(),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                fontSize: 18,
                                fontWeight: FontWeight.w700,
                                color: Color(0xFF171D1D),
                                fontFamily: 'monospace',
                                height: 1.2,
                              ),
                            ),
                          ),
                          const SizedBox(width: 6),
                          Transform.rotate(
                            angle: tag.expanded ? 3.14159 : 0,
                            child: const Icon(
                              Icons.keyboard_arrow_down,
                              size: 18,
                              color: _kTextMuted,
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 4),
                      Text(
                        _descLine(),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 14,
                          fontWeight: FontWeight.w700,
                          color: descColor,
                          height: 1.2,
                        ),
                      ),
                      if (kvs.isNotEmpty) ...[
                        const SizedBox(height: 8),
                        Container(
                          decoration: const BoxDecoration(
                            border: Border(
                              top: BorderSide(color: _kHairline, width: 1),
                            ),
                          ),
                          padding: const EdgeInsets.only(top: 8, bottom: 2),
                          child: _KvGrid(entries: kvs),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
              Padding(
                padding: EdgeInsets.only(
                  left: 8,
                  right: 12,
                  top: tag.expanded ? 10 : 0,
                ),
                child: Align(
                  widthFactor: 1,
                  alignment: tag.expanded
                      ? Alignment.topCenter
                      : Alignment.center,
                  child: _buildSlot(),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildSlot() {
    if (phase == _Phase.encoding) {
      if (isActive) {
        return const SizedBox(
          width: 22,
          height: 22,
          child: CircularProgressIndicator(
            strokeWidth: 2.5,
            valueColor: AlwaysStoppedAnimation<Color>(AppColors.primary),
          ),
        );
      }
      return const _ResultPill(
        label: 'QUEUED',
        bg: _kPillQueuedBg,
        fg: _kTextMuted,
      );
    }
    if (phase == _Phase.post) {
      if (tag.newEpc != null) {
        return const _ResultPill(
          label: 'ENCODED',
          bg: _kPillOkBg,
          fg: _kSuccessGreen,
        );
      }
      return const _ResultPill(
        label: 'FAILED',
        bg: _kPillBadBg,
        fg: _kErrorRed,
      );
    }
    if (onRemove == null) return const SizedBox.shrink();
    return GestureDetector(
      onTap: onRemove,
      child: Container(
        width: 42,
        height: 42,
        color: _kTrashRed,
        alignment: Alignment.center,
        child: const Icon(
          Icons.delete_outline,
          size: 22,
          color: Colors.white,
        ),
      ),
    );
  }
}

class _KvGrid extends StatelessWidget {
  const _KvGrid({required this.entries});

  final Map<String, String> entries;

  @override
  Widget build(BuildContext context) {
    final list = entries.entries.toList();
    final rows = <Widget>[];
    for (var i = 0; i < list.length; i += 2) {
      final left = list[i];
      final right = i + 1 < list.length ? list[i + 1] : null;
      rows.add(Padding(
        padding: EdgeInsets.only(bottom: 6.h),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(child: _kv(left.key, left.value)),
            SizedBox(width: 14.w),
            Expanded(
              child: right == null
                  ? const SizedBox.shrink()
                  : _kv(right.key, right.value),
            ),
          ],
        ),
      ));
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: rows,
    );
  }

  Widget _kv(String k, String v) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          k.toUpperCase(),
          style: GoogleFonts.spaceGrotesk(
            fontSize: 9.sp,
            fontWeight: FontWeight.w800,
            letterSpacing: 1.4,
            color: _kTextMuted,
          ),
        ),
        SizedBox(height: 1.h),
        Text(
          v,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: GoogleFonts.robotoMono(
            fontSize: 12.sp,
            fontWeight: FontWeight.w700,
            color: AppColors.textMain,
          ),
        ),
      ],
    );
  }
}

class _ResultPill extends StatelessWidget {
  const _ResultPill({
    required this.label,
    required this.bg,
    required this.fg,
  });

  final String label;
  final Color bg;
  final Color fg;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(4),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      child: Text(
        label,
        style: TextStyle(
          fontSize: 12,
          fontWeight: FontWeight.w800,
          letterSpacing: 1.2,
          color: fg,
        ),
      ),
    );
  }
}

// ── Phase-4 status tray ─────────────────────────────────────────────────

class _StatusTray extends StatelessWidget {
  const _StatusTray({
    required this.tag,
    required this.onStatusChanged,
    required this.onSave,
  });

  final _Tag tag;
  final ValueChanged<String> onStatusChanged;
  final VoidCallback? onSave;

  static const _options = <_StatusOption>[
    _StatusOption(value: 'unknown', label: 'UNKNOWN'),
    _StatusOption(value: 'in-stock', label: 'LIVE'),
    _StatusOption(value: 'tag_killed', label: 'TAG KILLED'),
  ];

  @override
  Widget build(BuildContext context) {
    final disabled = tag.statusSaved && onSave == null;
    final Color saveBg;
    final Color saveFg;
    final String saveLabel;
    if (tag.statusSaved) {
      saveBg = _kSuccessGreen;
      saveFg = Colors.white;
      saveLabel = 'SAVED';
    } else if (onSave != null) {
      saveBg = _kAmber;
      saveFg = Colors.white;
      saveLabel = 'SAVE';
    } else {
      saveBg = _kSaveDisabledBg;
      saveFg = _kTextMuted;
      saveLabel = 'SAVE';
    }

    return Container(
      color: _kTrayBg,
      padding: EdgeInsets.symmetric(horizontal: 14.w, vertical: 10.h),
      child: Row(
        children: [
          Text(
            'STATUS',
            style: GoogleFonts.spaceGrotesk(
              fontSize: 10.sp,
              fontWeight: FontWeight.w800,
              letterSpacing: 1.4,
              color: _kTextMuted,
            ),
          ),
          SizedBox(width: 10.w),
          Expanded(
            child: Container(
              decoration: BoxDecoration(
                color: Colors.white,
                border: Border.all(color: const Color(0xFFD7DEDE)),
                borderRadius: BorderRadius.circular(4.r),
              ),
              padding: EdgeInsets.symmetric(horizontal: 10.w),
              child: DropdownButtonHideUnderline(
                child: DropdownButton<String>(
                  isExpanded: true,
                  isDense: true,
                  value: _normalize(tag.currentStatus),
                  items: _options
                      .map((o) => DropdownMenuItem<String>(
                            value: o.value,
                            child: Text(
                              o.label,
                              style: GoogleFonts.spaceGrotesk(
                                fontSize: 14.sp,
                                fontWeight: FontWeight.w800,
                                color: AppColors.textMain,
                              ),
                            ),
                          ))
                      .toList(),
                  onChanged: (v) {
                    if (v != null) onStatusChanged(v);
                  },
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
                onTap: disabled ? null : onSave,
                child: Container(
                  constraints: BoxConstraints(minWidth: 92.w),
                  alignment: Alignment.center,
                  padding: EdgeInsets.symmetric(horizontal: 16.w, vertical: 8.h),
                  child: Text(
                    saveLabel,
                    style: GoogleFonts.spaceGrotesk(
                      fontSize: 13.sp,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 1.2,
                      color: saveFg,
                    ),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  String _normalize(String s) {
    // Accept legacy values + fold to the three options the dropdown shows.
    if (s == 'in-stock' || s == 'tag_killed' || s == 'unknown') return s;
    return 'unknown';
  }
}

class _StatusOption {
  const _StatusOption({required this.value, required this.label});
  final String value;
  final String label;
}

class _TestNewTagRow extends StatelessWidget {
  const _TestNewTagRow({required this.onPressed});

  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return Container(
      color: _kTrayBg,
      padding: EdgeInsets.fromLTRB(14.w, 0, 14.w, 14.h),
      child: SizedBox(
        width: double.infinity,
        child: OutlinedButton.icon(
          icon: const Icon(LucideIcons.testTube2, size: 18, color: AppColors.primary),
          label: Text(
            'TEST NEW TAG',
            style: GoogleFonts.spaceGrotesk(
              fontSize: 14.sp,
              fontWeight: FontWeight.w800,
              letterSpacing: 1.4,
              color: AppColors.primary,
            ),
          ),
          style: OutlinedButton.styleFrom(
            backgroundColor: Colors.white,
            foregroundColor: AppColors.primary,
            side: const BorderSide(color: AppColors.primary, width: 1.5),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(6.r),
            ),
            padding: EdgeInsets.symmetric(horizontal: 14.w, vertical: 12.h),
          ),
          onPressed: onPressed,
        ),
      ),
    );
  }
}

// ── Bottom toolbar button ───────────────────────────────────────────────

class _ToolbarButton extends StatelessWidget {
  const _ToolbarButton({
    required this.label,
    required this.icon,
    required this.background,
    required this.onPressed,
  });

  final String label;
  final IconData icon;
  final Color background;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: background,
      borderRadius: BorderRadius.circular(2.r),
      child: InkWell(
        borderRadius: BorderRadius.circular(2.r),
        onTap: onPressed,
        child: Container(
          alignment: Alignment.center,
          padding: EdgeInsets.symmetric(horizontal: 8.w),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, color: Colors.white, size: 22.sp),
              SizedBox(width: 10.w),
              Flexible(
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: GoogleFonts.spaceGrotesk(
                    fontSize: 15.sp,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 0.5,
                    color: Colors.white,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// ── Local 0-33 dBm power slider ─────────────────────────────────────────
//
// Encode workspace gets its own slider rather than reusing the global
// RfidPowerSlider widget because:
//   - The operator asked for 0..33 dBm on THIS screen. The global widget
//     stops at kAntennaPowerDbmMax (30).
//   - The encode screen needs the slider's value at hand (the inserted
//     items row + the chip-write power-cycle both reference it), and
//     it's clearer to keep it as local state than to read back from
//     MobileSettingsRepository every time.
//
// Native controllers clamp internally (Chainway 5..23, Zebra 0..30) so
// 24..33 effectively pin at whatever the chip's real ceiling is. The
// display still shows what the operator picked.

class _EncodePowerSlider extends StatelessWidget {
  const _EncodePowerSlider({
    required this.powerDbm,
    required this.minDbm,
    required this.maxDbm,
    required this.onChanged,
    required this.onChangeEnd,
  });

  final int powerDbm;
  final int minDbm;
  final int maxDbm;
  final ValueChanged<int> onChanged;
  final ValueChanged<int> onChangeEnd;

  @override
  Widget build(BuildContext context) {
    final clamped = powerDbm.clamp(minDbm, maxDbm);
    return Container(
      color: _kPwrStripBg,
      padding: EdgeInsets.symmetric(horizontal: 20.w, vertical: 12.h),
      child: Row(
        children: [
          Text(
            'PWR',
            style: GoogleFonts.spaceGrotesk(
              fontSize: 11.sp,
              fontWeight: FontWeight.w800,
              letterSpacing: 1.4,
              color: _kTextSlate,
            ),
          ),
          SizedBox(width: 12.w),
          Expanded(
            child: SliderTheme(
              data: SliderTheme.of(context).copyWith(
                trackHeight: 8,
                activeTrackColor: AppColors.primary,
                inactiveTrackColor: const Color(0xFFCDD7D7),
                thumbColor: AppColors.primary,
                overlayColor: AppColors.primary.withValues(alpha: 0.10),
                thumbShape:
                    const RoundSliderThumbShape(enabledThumbRadius: 13),
                overlayShape:
                    const RoundSliderOverlayShape(overlayRadius: 22),
              ),
              child: Slider(
                value: clamped.toDouble(),
                min: minDbm.toDouble(),
                max: maxDbm.toDouble(),
                divisions: maxDbm - minDbm,
                onChanged: (v) => onChanged(v.round()),
                onChangeEnd: (v) => onChangeEnd(v.round()),
              ),
            ),
          ),
          SizedBox(width: 8.w),
          SizedBox(
            width: 64.w,
            child: Text(
              '$clamped dBm',
              textAlign: TextAlign.right,
              style: GoogleFonts.spaceGrotesk(
                fontSize: 14.sp,
                fontWeight: FontWeight.w800,
                color: AppColors.textMain,
              ),
            ),
          ),
          SizedBox(width: 8.w),
          Container(
            decoration: BoxDecoration(
              color: AppColors.primary,
              borderRadius: BorderRadius.circular(3.r),
            ),
            padding: EdgeInsets.symmetric(horizontal: 6.w, vertical: 2.h),
            child: Text(
              'LIVE',
              style: GoogleFonts.spaceGrotesk(
                fontSize: 9.sp,
                fontWeight: FontWeight.w800,
                letterSpacing: 1.2,
                color: Colors.white,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
