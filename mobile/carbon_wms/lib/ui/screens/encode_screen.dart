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
///                 UNKNOWN) with a save icon (bulk-status) and a button
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
/// Local constant so the file doesn't depend on a not-yet-defined
/// `AppColors.error` member.
const Color _kErrorRed = Color(0xFFD9534F);

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
  /// can flip via dropdown + save icon.
  String currentStatus = 'unknown';

  /// True when [currentStatus] has been persisted via bulk-status since
  /// the last change. Save icon only enabled when this is false.
  bool statusSaved = true;
}

class _EncodeScreenState extends State<EncodeScreen> {
  static const int _scanPowerDbm = 10;
  static const Duration _searchDebounce = Duration(milliseconds: 300);
  static const int _minQueryLen = 2;

  _Phase _phase = _Phase.scan;

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

  // Phase banner / error toast
  String? _banner;

  // Streams
  StreamSubscription<RfidTagRead>? _tagSub;
  StreamSubscription<String>? _triggerSub;

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
    _searchDebounceTimer?.cancel();
    _searchCtrl.dispose();
    // Stop any active inventory so the next screen doesn't inherit it.
    unawaited(RfidVendorChannel.stopChainwayInventory());
    unawaited(RfidVendorChannel.stopZebraInventory());
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
    // Force the radio to 10 dBm for this screen — close-range only so
    // a foreign tag in the next bin can't accidentally join the list.
    unawaited(RfidVendorChannel.setAntennaPowerDbm(_scanPowerDbm));
    // Wire streams once. _attach guards against re-subscribing.
    _attachStreams();
  }

  void _attachStreams() {
    if (_tagSub != null) return;
    _tagSub = RfidVendorChannel.tagReadStream().listen(_onRawTagRead);
    _triggerSub = RfidVendorChannel.hardwareTriggerStream().listen(_onTrigger);
  }

  // ── Trigger handling ──────────────────────────────────────────────────

  void _onTrigger(String event) {
    if (!mounted) return;
    switch (_phase) {
      case _Phase.scan:
        // Hold-to-read at 10 dBm. Down → start inventory; up → stop.
        if (event == 'down') {
          unawaited(_startInventory());
        } else if (event == 'up') {
          unawaited(_stopInventory());
        }
        break;
      case _Phase.pickSku:
        // Trigger does nothing while the operator is searching for the
        // target SKU. They use the text field + tap.
        break;
      case _Phase.encoding:
        // The encode pass starts on the first 'down' after the SKU pick
        // and runs sequentially to completion. We ignore further trigger
        // events while in flight.
        if (event == 'down' && _encodingIndex < 0 && !_encodePassDone) {
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
    setState(() {
      _selectedSku = row;
      _phase = _Phase.encoding;
      _encodingIndex = -1;
      _encodePassDone = false;
      _banner = null;
    });
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
        // dropdown defaults correctly and the save icon stays disabled
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
    setState(() {
      _encodingIndex = -1;
      _encodePassDone = true;
      _phase = _Phase.post;
      _banner = null;
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

  // ── Build ─────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return CarbonScaffold(
      pageTitle: 'ENCODE',
      body: ColoredBox(
        color: const Color(0xFFF7FAFA),
        child: Column(
          children: [
            _PhaseHeader(
              phase: _phase,
              selectedSku: _selectedSku,
              isScanning: _isScanning,
              encodingIndex: _encodingIndex,
              total: _tags.length,
              onResetToScan: _phase != _Phase.scan ? _resetToScan : null,
              onGoToPickSku: _phase == _Phase.scan && _tags.isNotEmpty
                  ? _goToPickSku
                  : null,
            ),
            if (_banner != null)
              Padding(
                padding: EdgeInsets.fromLTRB(14.w, 6.h, 14.w, 0),
                child: Container(
                  width: double.infinity,
                  padding: EdgeInsets.symmetric(horizontal: 10.w, vertical: 6.h),
                  decoration: BoxDecoration(
                    color: const Color(0xFFFFF4E5),
                    border: Border.all(color: const Color(0xFFE08A2C)),
                    borderRadius: BorderRadius.circular(4.r),
                  ),
                  child: Text(
                    _banner!,
                    style: GoogleFonts.spaceGrotesk(
                      fontSize: 11.sp,
                      fontWeight: FontWeight.w700,
                      color: const Color(0xFF8A4E12),
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

  void _resetToScan() {
    setState(() {
      _phase = _Phase.scan;
      _selectedSku = null;
      _searchCtrl.clear();
      _query = '';
      _searchResults = [];
      _searchError = null;
      _encodingIndex = -1;
      _encodePassDone = false;
      _banner = null;
    });
    unawaited(RfidVendorChannel.setAntennaPowerDbm(_scanPowerDbm));
  }

  void _goToPickSku() {
    setState(() {
      _phase = _Phase.pickSku;
      _banner = null;
    });
    // Searching is text-driven — keep radio at 10 dBm but stop inventory
    // so a stray scan doesn't add a tag mid-search.
    unawaited(_stopInventory());
  }

  Widget _buildTagListBody() {
    if (_tags.isEmpty) {
      return Center(
        child: Padding(
          padding: EdgeInsets.symmetric(horizontal: 32.w),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(LucideIcons.radio,
                  size: 36.r, color: const Color(0xFF8FA1A1)),
              SizedBox(height: 12.h),
              Text(
                _phase == _Phase.scan
                    ? 'Pull and hold the trigger to scan tags.\nRadio is at $_scanPowerDbm dBm (close range only).'
                    : 'No tags in this session.',
                textAlign: TextAlign.center,
                style: GoogleFonts.manrope(
                  fontSize: 12.sp,
                  color: const Color(0xFF6D7979),
                ),
              ),
            ],
          ),
        ),
      );
    }
    return ListView.separated(
      padding: EdgeInsets.fromLTRB(12.w, 10.h, 12.w, 16.h),
      itemCount: _tags.length,
      separatorBuilder: (_, __) => SizedBox(height: 8.h),
      itemBuilder: (_, i) {
        final tag = _tags[i];
        final highlighted = _encodingIndex == i;
        return _TagCard(
          tag: tag,
          highlighted: highlighted,
          phase: _phase,
          encodeRunning: _encodingIndex >= 0,
          onRemove: _phase == _Phase.scan ||
                  _phase == _Phase.pickSku ||
                  _phase == _Phase.post
              ? () => _removeTag(tag)
              : null,
          onStatusChanged: _phase == _Phase.post && tag.newEpc != null
              ? (s) => _setStatusForTag(tag, s)
              : null,
          onSaveStatus: _phase == _Phase.post && tag.newEpc != null && !tag.statusSaved
              ? () => _saveStatus(tag)
              : null,
          onTestNewTag: _phase == _Phase.post && tag.newEpc != null
              ? () => _openTestNewTag(tag)
              : null,
        );
      },
    );
  }

  Widget _buildPickSkuBody() {
    return Column(
      children: [
        Padding(
          padding: EdgeInsets.fromLTRB(14.w, 12.h, 14.w, 6.h),
          child: TextField(
            controller: _searchCtrl,
            autofocus: true,
            decoration: InputDecoration(
              hintText: 'Search SKU / UPC / name',
              prefixIcon: const Icon(LucideIcons.search, size: 18),
              filled: true,
              fillColor: Colors.white,
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(6.r),
                borderSide: const BorderSide(color: Color(0xFFCDD7D7)),
              ),
            ),
            onChanged: _onSearchChanged,
          ),
        ),
        if (_searchLoading)
          Padding(
            padding: EdgeInsets.symmetric(vertical: 8.h),
            child: const LinearProgressIndicator(minHeight: 2),
          ),
        if (_searchError != null)
          Padding(
            padding: EdgeInsets.symmetric(horizontal: 14.w, vertical: 6.h),
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
              : ListView.separated(
                  padding: EdgeInsets.fromLTRB(12.w, 6.h, 12.w, 16.h),
                  itemCount: _searchResults.length,
                  separatorBuilder: (_, __) => SizedBox(height: 6.h),
                  itemBuilder: (_, i) {
                    final row = _searchResults[i];
                    return _SkuResultTile(row: row, onTap: () => _selectSku(row));
                  },
                ),
        ),
      ],
    );
  }
}

// ── Phase header ────────────────────────────────────────────────────────

class _PhaseHeader extends StatelessWidget {
  const _PhaseHeader({
    required this.phase,
    required this.selectedSku,
    required this.isScanning,
    required this.encodingIndex,
    required this.total,
    required this.onResetToScan,
    required this.onGoToPickSku,
  });

  final _Phase phase;
  final Map<String, dynamic>? selectedSku;
  final bool isScanning;
  final int encodingIndex;
  final int total;
  final VoidCallback? onResetToScan;
  final VoidCallback? onGoToPickSku;

  @override
  Widget build(BuildContext context) {
    final (label, hint) = switch (phase) {
      _Phase.scan => (
          'SCAN',
          isScanning
              ? 'Reading at 10 dBm — release trigger to stop'
              : 'Hold trigger to read tags · $total in list',
        ),
      _Phase.pickSku => (
          'PICK SKU',
          'Type to search. Tap a result to lock the target.',
        ),
      _Phase.encoding => (
          'ENCODE',
          encodingIndex >= 0
              ? 'Writing chip ${encodingIndex + 1} of $total…'
              : 'Pull trigger to encode $total tag${total == 1 ? '' : 's'}',
        ),
      _Phase.post => ('REVIEW', 'Set status per tag, save, then test.'),
    };

    return Container(
      width: double.infinity,
      color: const Color(0xFF1F2A2A),
      padding: EdgeInsets.fromLTRB(14.w, 10.h, 14.w, 10.h),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text(
                label,
                style: GoogleFonts.spaceGrotesk(
                  fontSize: 11.sp,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 1.6,
                  color: AppColors.primary,
                ),
              ),
              const Spacer(),
              if (onResetToScan != null)
                TextButton(
                  onPressed: onResetToScan,
                  style: TextButton.styleFrom(
                    foregroundColor: Colors.white70,
                    padding: EdgeInsets.symmetric(horizontal: 8.w),
                    minimumSize: Size(0, 28.h),
                  ),
                  child: Text(
                    'BACK TO SCAN',
                    style: GoogleFonts.spaceGrotesk(
                      fontSize: 10.sp,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 1.2,
                    ),
                  ),
                ),
              if (onGoToPickSku != null)
                ElevatedButton(
                  onPressed: onGoToPickSku,
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppColors.primary,
                    foregroundColor: Colors.white,
                    padding: EdgeInsets.symmetric(horizontal: 12.w),
                    minimumSize: Size(0, 30.h),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(4.r),
                    ),
                  ),
                  child: Text(
                    'SEARCH SKU →',
                    style: GoogleFonts.spaceGrotesk(
                      fontSize: 10.sp,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 1.2,
                    ),
                  ),
                ),
            ],
          ),
          SizedBox(height: 4.h),
          Text(
            hint,
            style: GoogleFonts.manrope(
              fontSize: 11.sp,
              color: Colors.white70,
            ),
          ),
          if (selectedSku != null && phase != _Phase.scan && phase != _Phase.pickSku) ...[
            SizedBox(height: 6.h),
            Container(
              padding: EdgeInsets.symmetric(horizontal: 8.w, vertical: 4.h),
              decoration: BoxDecoration(
                color: Colors.white12,
                borderRadius: BorderRadius.circular(3.r),
              ),
              child: Text(
                'TARGET: ${_skuSummary(selectedSku!)}',
                style: GoogleFonts.spaceGrotesk(
                  fontSize: 10.sp,
                  fontWeight: FontWeight.w700,
                  color: Colors.white,
                ),
              ),
            ),
          ],
        ],
      ),
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
    final upc = row['upc']?.toString() ?? '';
    final color = row['color']?.toString() ?? '';
    final size = row['size']?.toString() ?? '';
    return Material(
      color: Colors.white,
      borderRadius: BorderRadius.circular(6.r),
      child: InkWell(
        borderRadius: BorderRadius.circular(6.r),
        onTap: onTap,
        child: Padding(
          padding: EdgeInsets.fromLTRB(12.w, 10.h, 12.w, 10.h),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                name.isEmpty ? '(unnamed)' : name,
                style: GoogleFonts.manrope(
                  fontSize: 12.sp,
                  fontWeight: FontWeight.w800,
                  color: AppColors.textMain,
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
              SizedBox(height: 2.h),
              Text(
                [
                  if (sku.isNotEmpty) 'SKU $sku',
                  if (upc.isNotEmpty) 'UPC $upc',
                  if (color.isNotEmpty) color,
                  if (size.isNotEmpty) size,
                ].join('  ·  '),
                style: GoogleFonts.spaceGrotesk(
                  fontSize: 10.sp,
                  fontWeight: FontWeight.w600,
                  color: const Color(0xFF6D7979),
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// ── Per-tag card ────────────────────────────────────────────────────────

class _TagCard extends StatelessWidget {
  const _TagCard({
    required this.tag,
    required this.highlighted,
    required this.phase,
    required this.encodeRunning,
    required this.onRemove,
    required this.onStatusChanged,
    required this.onSaveStatus,
    required this.onTestNewTag,
  });

  final _Tag tag;
  final bool highlighted;
  final _Phase phase;
  final bool encodeRunning;
  final VoidCallback? onRemove;
  final ValueChanged<String>? onStatusChanged;
  final VoidCallback? onSaveStatus;
  final VoidCallback? onTestNewTag;

  static const _statusOptions = <_StatusOption>[
    _StatusOption(value: 'in-stock', label: 'LIVE'),
    _StatusOption(value: 'tag_killed', label: 'TAG KILLED'),
    _StatusOption(value: 'unknown', label: 'UNKNOWN'),
  ];

  @override
  Widget build(BuildContext context) {
    final recognized = tag.resolved != null;
    final isEncoding = highlighted && encodeRunning;
    final hasNewEpc = tag.newEpc != null;
    final hasError = tag.encodeError != null;

    return Container(
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(6.r),
        border: Border.all(
          color: isEncoding
              ? AppColors.primary
              : hasError
                  ? _kErrorRed
                  : hasNewEpc
                      ? const Color(0xFFB7E2B7)
                      : const Color(0xFFD7DEDE),
          width: isEncoding ? 1.5 : 1,
        ),
      ),
      padding: EdgeInsets.fromLTRB(12.w, 10.h, 8.w, 10.h),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Top row: EPC + (encoding spinner or trash)
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      hasNewEpc ? 'NEW EPC' : 'EPC',
                      style: GoogleFonts.spaceGrotesk(
                        fontSize: 9.sp,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 1.4,
                        color: const Color(0xFF6D7979),
                      ),
                    ),
                    SizedBox(height: 2.h),
                    SelectableText(
                      hasNewEpc ? tag.newEpc! : tag.oldEpc,
                      style: GoogleFonts.spaceMono(
                        fontSize: 11.sp,
                        fontWeight: FontWeight.w700,
                        color: AppColors.textMain,
                      ),
                    ),
                    if (hasNewEpc) ...[
                      SizedBox(height: 4.h),
                      Text(
                        'was ${tag.oldEpc}',
                        style: GoogleFonts.spaceMono(
                          fontSize: 9.sp,
                          color: const Color(0xFF8FA1A1),
                        ),
                      ),
                    ],
                  ],
                ),
              ),
              if (isEncoding)
                Padding(
                  padding: EdgeInsets.only(right: 4.w, top: 4.h),
                  child: SizedBox(
                    width: 16.r,
                    height: 16.r,
                    child: const CircularProgressIndicator(strokeWidth: 2),
                  ),
                )
              else if (onRemove != null)
                IconButton(
                  icon: const Icon(LucideIcons.trash2, size: 18),
                  color: const Color(0xFF6D7979),
                  visualDensity: VisualDensity.compact,
                  padding: EdgeInsets.zero,
                  constraints: BoxConstraints(
                    minWidth: 32.w,
                    minHeight: 32.h,
                  ),
                  onPressed: onRemove,
                ),
            ],
          ),
          if (recognized && !hasNewEpc) ...[
            SizedBox(height: 6.h),
            _ResolvedPanel(item: tag.resolved!),
          ],
          if (hasError) ...[
            SizedBox(height: 6.h),
            Text(
              'Encode failed: ${tag.encodeError}',
              style: GoogleFonts.spaceGrotesk(
                fontSize: 10.sp,
                fontWeight: FontWeight.w700,
                color: _kErrorRed,
              ),
            ),
          ],
          if (hasNewEpc && phase == _Phase.post) ...[
            SizedBox(height: 8.h),
            Row(
              children: [
                Text(
                  'STATUS',
                  style: GoogleFonts.spaceGrotesk(
                    fontSize: 9.sp,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 1.4,
                    color: const Color(0xFF6D7979),
                  ),
                ),
                SizedBox(width: 8.w),
                Expanded(
                  child: DropdownButton<String>(
                    isExpanded: true,
                    isDense: true,
                    value: tag.currentStatus,
                    items: _statusOptions
                        .map((o) => DropdownMenuItem<String>(
                              value: o.value,
                              child: Text(
                                o.label,
                                style: GoogleFonts.spaceGrotesk(
                                  fontSize: 11.sp,
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                            ))
                        .toList(),
                    onChanged: onStatusChanged == null
                        ? null
                        : (v) {
                            if (v != null) onStatusChanged!(v);
                          },
                  ),
                ),
                IconButton(
                  icon: Icon(
                    LucideIcons.save,
                    size: 18,
                    color: onSaveStatus == null
                        ? const Color(0xFFB7C2C2)
                        : AppColors.primary,
                  ),
                  visualDensity: VisualDensity.compact,
                  padding: EdgeInsets.zero,
                  constraints: BoxConstraints(
                    minWidth: 32.w,
                    minHeight: 32.h,
                  ),
                  tooltip: tag.statusSaved ? 'Saved' : 'Save status',
                  onPressed: onSaveStatus,
                ),
              ],
            ),
            SizedBox(height: 6.h),
            SizedBox(
              width: double.infinity,
              child: OutlinedButton.icon(
                icon: const Icon(LucideIcons.testTube2, size: 16),
                label: Text(
                  'TEST NEW TAG',
                  style: GoogleFonts.spaceGrotesk(
                    fontSize: 10.sp,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 1.2,
                  ),
                ),
                style: OutlinedButton.styleFrom(
                  foregroundColor: AppColors.primary,
                  side: const BorderSide(color: AppColors.primary),
                  minimumSize: Size(0, 32.h),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(4.r),
                  ),
                ),
                onPressed: onTestNewTag,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _StatusOption {
  const _StatusOption({required this.value, required this.label});
  final String value;
  final String label;
}

class _ResolvedPanel extends StatelessWidget {
  const _ResolvedPanel({required this.item});

  final Map<String, dynamic> item;

  @override
  Widget build(BuildContext context) {
    final sku = item['sku']?.toString() ?? '';
    final name = item['name']?.toString() ?? '';
    final color = item['color']?.toString() ?? '';
    final size = item['size']?.toString() ?? '';
    final upc = item['upc']?.toString() ?? '';
    final status = item['status']?.toString() ?? '';
    final bin = item['bin_code']?.toString() ?? '';
    return Container(
      padding: EdgeInsets.fromLTRB(8.w, 6.h, 8.w, 6.h),
      decoration: BoxDecoration(
        color: const Color(0xFFEEF4F3),
        borderRadius: BorderRadius.circular(4.r),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            name.isEmpty ? '(no name)' : name,
            style: GoogleFonts.manrope(
              fontSize: 11.sp,
              fontWeight: FontWeight.w800,
              color: AppColors.textMain,
            ),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          SizedBox(height: 2.h),
          Text(
            [
              if (sku.isNotEmpty) 'SKU $sku',
              if (upc.isNotEmpty) 'UPC $upc',
              if (color.isNotEmpty) color,
              if (size.isNotEmpty) size,
              if (status.isNotEmpty) 'status: $status',
              if (bin.isNotEmpty) 'bin: $bin',
            ].join('  ·  '),
            style: GoogleFonts.spaceGrotesk(
              fontSize: 10.sp,
              fontWeight: FontWeight.w600,
              color: const Color(0xFF6D7979),
            ),
          ),
        ],
      ),
    );
  }
}
