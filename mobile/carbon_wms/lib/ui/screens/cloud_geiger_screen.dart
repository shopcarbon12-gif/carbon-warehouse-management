import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/hardware/rfid_tag_read.dart';
import 'package:carbon_wms/hardware/rfid_vendor_channel.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/epc/epc_codec.dart';
import 'package:carbon_wms/services/handheld_device_identity.dart';
import 'package:carbon_wms/services/mobile_permissions.dart';
import 'package:carbon_wms/services/scan_sounds.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/guards/permission_guard.dart';
import 'package:carbon_wms/ui/screens/locate_tag_screen.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart' show CarbonScaffold;

/// Cloud + Geiger — landing pad for EPCs that were "Sent to handheld" from
/// the web defective-EPCs drawer. Each EPC renders as a count-style
/// container: SKU + matrix description when the Carbon formula passes,
/// raw EPC otherwise. Tapping the right-edge radio icon pushes the
/// single-tag Geiger; slide-left to dismiss; Take an Action from inside
/// Geiger auto-resolves the row.
///
/// Bulk find (2026-05-29): pulling the trigger on THIS screen starts a
/// UHF inventory that marks any EPC from the list as "found" with a
/// green container outline. This is a pure visual overlay — found state
/// does NOT change any server-side data, does NOT remove the row, does
/// NOT trigger Take an Action, and does NOT survive a Refresh tap. The
/// operator gets a quick visual sweep: are all the dropped tags
/// physically present in this area? Refresh clears every found marker.
/// Upload CSV produces an audit-only `cloud-geiger-find` upload with
/// one row per dropped EPC and a found/not_found column.
class CloudGeigerScreen extends StatefulWidget {
  const CloudGeigerScreen({super.key});

  @override
  State<CloudGeigerScreen> createState() => _CloudGeigerScreenState();
}

const Color _kCardGrey = Color(0xFFECECEC);
const Color _kCardFound = Color(0xFFD6F5E6);
const Color _kStripeFound = Color(0xFF16A34A);
const Color _kTrashRed = Color(0xFFBF2E2E);
const Color _kTextMuted = Color(0xFF8A9090);
// Light teal used by the two non-CSV bottom buttons (REFRESH + DELETE
// ALL). Distinct from AppColors.primary (the deeper teal used for the
// CSV button and the geiger icon) so the destructive + maintenance
// actions visually separate from the destination action.
const Color _kLightTeal = Color(0xFF2BA3A3);

class _CloudGeigerScreenState extends State<CloudGeigerScreen> {
  static const Duration _pollInterval = Duration(seconds: 8);

  final List<_GeigerItem> _items = <_GeigerItem>[];
  final Set<String> _seenEpcs = <String>{};

  /// In-memory bulk-find overlay. Independent of the persistent server
  /// queue — Refresh resets it; killing the screen clears it; never
  /// writes back to the items table.
  final Set<String> _foundEpcs = <String>{};

  Timer? _poller;
  bool _loading = false;
  String? _error;

  // Bulk-find radio state.
  RfidManager? _rfid;
  StreamSubscription<RfidTagRead>? _uhfSub;
  StreamSubscription<RfidTagRead>? _vendorSub;
  StreamSubscription<String>? _triggerSub;
  bool _scanning = false;
  bool _uploading = false;

  // Power slider — bounds populated from native getPowerRangeDbm so the
  // operator can't drag below the radio's floor (RFD8500 ~5..30, C72E
  // 5..23) or above its ceiling.
  int _minDbm = 1;
  int _maxDbm = 30;
  int _powerDbm = 23;

  @override
  void initState() {
    super.initState();
    unawaited(ScanSounds.instance.init());
    // Silence the native per-tag beep. Cloud+Geiger only wants audible
    // feedback when a *list-EPC* is freshly matched — the operator must
    // not hear a beep for every tag the radio picks up in the field
    // (which on a typical warehouse aisle is dozens of tags per sec).
    // Dart-side ScanCue.read fires explicitly inside _onUhfRead when
    // _foundEpcs.add(epc) returns true (i.e. first sighting of a
    // queued EPC). Restored in dispose so downstream screens keep
    // their per-tag beep.
    unawaited(ScanSounds.instance.setTagBeepSuppressed(true));
    // RFID-only screen — kill the 2D imager so a stray trigger doesn't
    // fire it. Same hand-off pattern Status Change uses.
    unawaited(RfidVendorChannel.scannerDisableTriggerRelay());
    unawaited(RfidVendorChannel.close2dBarcode());
    unawaited(RfidVendorChannel.enableRfidFunctionMode());
    unawaited(RfidVendorChannel.setZebraTriggerModeRfid());

    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted) return;
      _rfid = context.read<RfidManager>();
      // 2026-05-29 — ROOT FIX for "trigger pull doesn't pick up tags on
      // the main screen, but per-row Geiger finds them". RfidManager
      // gates its geigerTagReads stream on _scanContext == 'GEIGER_FIND'
      // (rfid_manager.dart:379). Cloud+Geiger was setting the context
      // to a project-specific 'CLOUD_GEIGER_BULK_FIND' which the
      // manager didn't recognise → no reads ever flowed into our
      // stream → 0/N forever. Use the same 'GEIGER_FIND' context the
      // locate-tag screen uses; it's the canonical Carbon WMS label
      // for "raw single-tag-style reads, no edge ingest / ghost
      // filter".
      _rfid!.scanContext = 'GEIGER_FIND';
      _uhfSub = _rfid!.geigerTagReads.listen(_onUhfRead, onError: (_) {});
      // Belt-and-suspenders: also subscribe to the vendor channel's
      // raw stream. The locate-tag screen does this for the same
      // reason — if the manager's gate ever falls out of sync with
      // the active driver, the vendor channel still surfaces every
      // chip the radio reports.
      _vendorSub = RfidVendorChannel.tagReadStream().listen(
        _onUhfRead,
        onError: (_) {},
      );

      await _hydrateSliderRange();
      // Default the slider to the radio's MAX achievable dBm so the
      // first bulk-find sweep has the widest possible range without
      // the operator having to drag the slider first. They can always
      // dial down for closer work; defaulting low frustrated operators
      // hunting tags across an aisle.
      _powerDbm = _maxDbm;
      await _rfid!.setSessionPowerOverrideDbm(_powerDbm);
      try {
        await RfidVendorChannel.setAntennaPowerDbm(_powerDbm);
      } catch (_) {}

      _triggerSub = RfidVendorChannel.hardwareTriggerStream().listen((event) {
        if (!mounted) return;
        if (event != 'down') return;
        // No EPCs to find → ignore the trigger entirely. We never want
        // bulk-find to fire when the list is empty: the operator gets
        // a confusing "started but found nothing" radio chirp and the
        // header would flip into BULK FIND state with no rows to mark.
        // Only block on _start; an already-running scan still stops on
        // a second pull so the operator can cancel cleanly.
        if (!_scanning && _items.isEmpty) return;
        if (_scanning) {
          unawaited(_stopScan());
        } else {
          unawaited(_startScan());
        }
      }, onError: (_) {});

      unawaited(_pollOnce());
    });
    _poller = Timer.periodic(_pollInterval, (_) => unawaited(_pollOnce()));
  }

  @override
  void dispose() {
    _poller?.cancel();
    _poller = null;
    unawaited(_uhfSub?.cancel());
    unawaited(_vendorSub?.cancel());
    unawaited(_triggerSub?.cancel());
    unawaited(RfidVendorChannel.stopChainwayInventory());
    unawaited(RfidVendorChannel.stopZebraInventory());
    // Restore the native per-tag beep for downstream screens
    // (count / status change / etc rely on it firing for every read).
    unawaited(ScanSounds.instance.setTagBeepSuppressed(false));
    final rfid = _rfid;
    if (rfid != null) {
      unawaited(rfid.setSessionPowerOverrideDbm(null));
    }
    super.dispose();
  }

  Future<void> _hydrateSliderRange() async {
    final range = await RfidVendorChannel.getPowerRangeDbm();
    if (!mounted || range == null) return;
    setState(() {
      _minDbm = range.minDbm;
      _maxDbm = range.maxDbm;
      _powerDbm = _powerDbm.clamp(_minDbm, _maxDbm);
    });
  }

  Future<void> _startScan() async {
    if (_scanning) return;
    setState(() => _scanning = true);
    try {
      ScanSounds.instance.play(ScanCue.start);
    } catch (_) {}
    try {
      await RfidVendorChannel.startZebraInventory();
    } catch (_) {}
    try {
      await RfidVendorChannel.startChainwayInventory();
    } catch (_) {}
  }

  Future<void> _stopScan() async {
    if (!_scanning) return;
    setState(() => _scanning = false);
    try {
      ScanSounds.instance.play(ScanCue.stop);
    } catch (_) {}
    try {
      await RfidVendorChannel.stopZebraInventory();
    } catch (_) {}
    try {
      await RfidVendorChannel.stopChainwayInventory();
    } catch (_) {}
  }

  Future<void> _setPower(int dbm) async {
    final clamped = dbm.clamp(_minDbm, _maxDbm);
    if (clamped == _powerDbm) return;
    setState(() => _powerDbm = clamped);
    final rfid = _rfid;
    if (rfid != null) {
      await rfid.setSessionPowerOverrideDbm(clamped);
    }
    try {
      await RfidVendorChannel.setAntennaPowerDbm(clamped);
    } catch (_) {}
  }

  void _onUhfRead(RfidTagRead read) {
    if (!mounted || !_scanning) return;
    final epc = read.epcHex24.toUpperCase();
    if (epc.isEmpty) return;
    // Exact-match against the queue first. If no exact match AND the
    // queued EPCs are shorter / differently-prefixed (a CSV with 16-hex
    // tail-only EPCs vs the radio's 24-hex full EPC is the most common
    // case), fall back to a suffix compare on the last 16 hex chars
    // (item + serial bits — what's actually unique). 0/N counts in the
    // field were the symptom that pushed this in.
    String matched = epc;
    var hit = _seenEpcs.contains(epc);
    if (!hit && epc.length >= 16) {
      final tail = epc.substring(epc.length - 16);
      for (final q in _seenEpcs) {
        if (q == epc) continue;
        if (q.endsWith(tail) ||
            (q.length >= 16 && tail.endsWith(q.substring(q.length - 16)))) {
          matched = q;
          hit = true;
          break;
        }
      }
    }
    if (!hit) return;
    if (_foundEpcs.add(matched)) {
      // First time we've heard this EPC during the bulk-find pass —
      // tick the success cue so the operator hears progress. Native
      // per-tag beep is suppressed for this screen so this is the ONLY
      // sound the operator gets, and only on a fresh queue hit.
      try {
        ScanSounds.instance.play(ScanCue.read);
      } catch (_) {}
      setState(() {});
    }
  }

  Future<void> _pollOnce() async {
    if (!mounted || _loading) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final api = context.read<WmsApiClient>();
      final deviceId = await HandheldDeviceIdentity.primaryDeviceIdForServer();
      final result = await api.pollMyEpcQueue(deviceId: deviceId);
      if (!mounted) return;

      // Server-side queue is persistent; each poll returns the full
      // pending set. Treat the response as authoritative.
      final serverSet = <String>{};
      final fresh = <String>[];
      for (final raw in result.epcs) {
        final e = raw.trim().toUpperCase();
        if (e.isEmpty) continue;
        serverSet.add(e);
        if (_seenEpcs.add(e)) {
          fresh.add(e);
          _items.add(_GeigerItem.bare(e));
        }
      }
      _items.removeWhere((it) => !serverSet.contains(it.epc));
      _seenEpcs.retainAll(serverSet);
      _foundEpcs.retainAll(serverSet);
      if (fresh.isNotEmpty) {
        unawaited(_enrich(fresh));
      }
      setState(() {});
    } on WmsApiException catch (e) {
      if (!mounted) return;
      setState(() => _error = 'HTTP ${e.statusCode}');
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  /// Bulk-EPC enrichment via /api/handheld/epc-lookup. The server reply
  /// uses field name `epcHex` (NOT `epc`) and `productName` (NOT `name`)
  /// — pre-2026-05-29 we keyed off `r['epc']` which silently returned
  /// null for every row, so every container stayed "Resolving…" forever.
  Future<void> _enrich(List<String> epcs) async {
    try {
      final api = context.read<WmsApiClient>();
      final rows = await api.lookupEpcs(epcs);
      if (!mounted) return;
      final byEpc = <String, Map<String, dynamic>>{};
      for (final r in rows) {
        // Server-side field is `epcHex`; legacy/alt `epc` checked as fallback.
        final eRaw = (r['epcHex'] as String?) ?? (r['epc'] as String?);
        final e = eRaw?.trim().toUpperCase();
        if (e == null || e.isEmpty) continue;
        byEpc[e] = r;
      }
      setState(() {
        for (var i = 0; i < _items.length; i++) {
          final it = _items[i];
          final r = byEpc[it.epc];
          if (r == null) continue;
          _items[i] = it.withResolved(r);
        }
      });
    } catch (_) {
      /* enrichment best-effort; raw EPC still renders */
    }
  }

  void _removeItem(_GeigerItem item) {
    setState(() {
      _items.removeWhere((e) => e.epc == item.epc);
      _seenEpcs.remove(item.epc);
      _foundEpcs.remove(item.epc);
    });
    unawaited(_dismissOnServer(item.epc));
  }

  Future<void> _dismissOnServer(String epc) async {
    try {
      final api = context.read<WmsApiClient>();
      final deviceId = await HandheldDeviceIdentity.primaryDeviceIdForServer();
      await api.dismissEpcQueueItems(deviceId: deviceId, epcs: [epc]);
    } catch (_) {
      /* best-effort */
    }
  }

  /// Refresh: clear every bulk-find marker AND re-poll the server. The
  /// server-side queue itself isn't touched; only our in-memory "I just
  /// physically saw this tag" overlay resets. Operator gets a fresh
  /// canvas to do another sweep.
  Future<void> _onRefresh() async {
    setState(() => _foundEpcs.clear());
    await _pollOnce();
  }

  Future<void> _confirmDeleteAll() async {
    if (_items.isEmpty) return;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Delete every row?'),
        content: Text(
          'This permanently dismisses all ${_items.length} EPC(s) for '
          'this handheld on the server. They will not come back from '
          'the next poll. Continue?',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: const Color(0xFFBF2E2E),
              foregroundColor: Colors.white,
            ),
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('Delete all'),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    final epcs = _items.map((e) => e.epc).toList(growable: false);
    setState(() {
      _items.clear();
      _seenEpcs.clear();
      _foundEpcs.clear();
    });
    // Best-effort server dismiss for every EPC. Failure on any single
    // call doesn't undo the local clear — the next poll will re-fetch
    // any rows the server still considers pending.
    unawaited(_dismissBatch(epcs));
  }

  Future<void> _dismissBatch(List<String> epcs) async {
    try {
      final api = context.read<WmsApiClient>();
      final deviceId = await HandheldDeviceIdentity.primaryDeviceIdForServer();
      await api.dismissEpcQueueItems(deviceId: deviceId, epcs: epcs);
    } catch (_) {
      /* best-effort */
    }
  }

  Future<void> _openGeiger(_GeigerItem item) async {
    // Thread the enrichment payload through so LocateTagScreen renders
    // its built-in item-info card directly under the EPC strip. The
    // operator confirmed they don't want to mentally cross-reference
    // SKU/colour/size while sweeping — same container Count Inventory
    // uses, same data this row already has resolved.
    await context.pushGuarded<void>(
      ScreenIds.locateTag,
      (_) => LocateTagScreen(
        targetEpc: item.epc,
        targetSku: item.sku,
        targetName: item.itemName,
        targetColor: item.color,
        targetSize: item.size,
        cloudGeigerMode: true,
      ),
    );
  }

  /// Snapshot the current list (epc + found-or-not + best-effort sku /
  /// description) into a CSV and POST it via the `cloud-geiger-find`
  /// audit-only upload mode. The desktop /reports/uploads page picks
  /// it up by `workflow_mode`. No items rows are touched.
  Future<void> _uploadCsv() async {
    if (_items.isEmpty || _uploading) return;
    setState(() => _uploading = true);
    final messenger = ScaffoldMessenger.of(context);
    try {
      final api = context.read<WmsApiClient>();
      final deviceId = await HandheldDeviceIdentity.primaryDeviceIdForServer();
      final csv = _buildFindCsv();
      await api.postInventoryUpload(
        deviceId: deviceId,
        mode: 'cloud-geiger-find',
        csvData: csv,
      );
      if (!mounted) return;
      messenger.showSnackBar(SnackBar(
        content: Text(
          'Uploaded ${_items.length} row(s) · '
          '${_foundEpcs.length} found / '
          '${_items.length - _foundEpcs.length} not found',
        ),
      ));
    } catch (e) {
      if (!mounted) return;
      messenger.showSnackBar(SnackBar(content: Text('Upload failed: $e')));
    } finally {
      if (mounted) setState(() => _uploading = false);
    }
  }

  String _buildFindCsv() {
    final buf = StringBuffer()
      ..writeln('epc,found,sku,item_name,color,size,checked_at_iso');
    final nowIso = DateTime.now().toUtc().toIso8601String();
    for (final it in _items) {
      buf.write(_csvField(it.epc));
      buf.write(',');
      buf.write(_foundEpcs.contains(it.epc) ? 'found' : 'not_found');
      buf.write(',');
      buf.write(_csvField(it.sku ?? ''));
      buf.write(',');
      buf.write(_csvField(it.itemName ?? ''));
      buf.write(',');
      buf.write(_csvField(it.color ?? ''));
      buf.write(',');
      buf.write(_csvField(it.size ?? ''));
      buf.write(',');
      buf.write(_csvField(nowIso));
      buf.writeln();
    }
    return buf.toString();
  }

  static String _csvField(String v) {
    if (v.isEmpty) return '';
    if (v.contains(',') || v.contains('"') || v.contains('\n')) {
      return '"${v.replaceAll('"', '""')}"';
    }
    return v;
  }

  @override
  Widget build(BuildContext context) {
    final foundCount = _foundEpcs.length;
    final totalCount = _items.length;
    return CarbonScaffold(
      pageTitle: 'cloud + geiger',
      body: ColoredBox(
        color: Colors.white,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _BulkFindHeader(
              scanning: _scanning,
              found: foundCount,
              total: totalCount,
            ),
            if (_error != null)
              Container(
                width: double.infinity,
                color: const Color(0xFFFFF4F4),
                padding: EdgeInsets.symmetric(horizontal: 16.w, vertical: 8.h),
                child: Text(
                  _error!,
                  style: GoogleFonts.spaceGrotesk(
                    fontSize: 12.sp,
                    fontWeight: FontWeight.w700,
                    color: const Color(0xFFD9534F),
                  ),
                ),
              ),
            Expanded(
              child: _items.isEmpty ? _buildEmpty() : _buildList(),
            ),
            Padding(
              padding: EdgeInsets.fromLTRB(20.w, 10.h, 20.w, 10.h),
              child: Row(
                children: [
                  Expanded(
                    child: SizedBox(
                      height: 48,
                      child: FilledButton(
                        // _loading deliberately not in the disabled
                        // gate — see commit b8108b2 rationale (the 8s
                        // background poll caused the button to read
                        // as auto-pressed via Material's disabled-
                        // state ripple).
                        onPressed: _uploading ? null : _onRefresh,
                        style: FilledButton.styleFrom(
                          backgroundColor: _kLightTeal,
                          foregroundColor: Colors.white,
                          padding: EdgeInsets.zero,
                          shape: const RoundedRectangleBorder(
                            borderRadius: BorderRadius.zero,
                          ),
                        ),
                        child: const Icon(Icons.refresh, size: 22),
                      ),
                    ),
                  ),
                  SizedBox(width: 8.w),
                  Expanded(
                    child: SizedBox(
                      height: 48,
                      child: FilledButton(
                        onPressed: (_items.isEmpty || _uploading)
                            ? null
                            : () => unawaited(_confirmDeleteAll()),
                        style: FilledButton.styleFrom(
                          backgroundColor: _kLightTeal,
                          disabledBackgroundColor: const Color(0xFFBCC9C9),
                          foregroundColor: Colors.white,
                          padding: EdgeInsets.zero,
                          shape: const RoundedRectangleBorder(
                            borderRadius: BorderRadius.zero,
                          ),
                        ),
                        child: const Icon(Icons.delete_outline, size: 22),
                      ),
                    ),
                  ),
                  SizedBox(width: 8.w),
                  Expanded(
                    child: SizedBox(
                      height: 48,
                      child: FilledButton.icon(
                        onPressed: (_items.isEmpty || _uploading)
                            ? null
                            : () => unawaited(_uploadCsv()),
                        icon: const Icon(
                          Icons.cloud_upload_outlined,
                          size: 18,
                          color: Colors.white,
                        ),
                        label: Text(
                          _uploading ? '…' : 'CSV',
                          style: GoogleFonts.spaceGrotesk(
                            fontSize: 14.sp,
                            fontWeight: FontWeight.w900,
                            letterSpacing: 1.6,
                          ),
                        ),
                        style: FilledButton.styleFrom(
                          backgroundColor: AppColors.primary,
                          disabledBackgroundColor: const Color(0xFFBCC9C9),
                          foregroundColor: Colors.white,
                          shape: const RoundedRectangleBorder(
                            borderRadius: BorderRadius.zero,
                          ),
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
            _BulkFindPowerSlider(
              powerDbm: _powerDbm,
              minDbm: _minDbm,
              maxDbm: _maxDbm,
              scanning: _scanning,
              onChanged: (v) => unawaited(_setPower(v)),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildEmpty() {
    return Center(
      child: Padding(
        padding: EdgeInsets.symmetric(horizontal: 24.w),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(LucideIcons.radio, size: 48.sp, color: _kTextMuted),
            SizedBox(height: 12.h),
            Text(
              'Waiting for EPCs from the cloud',
              textAlign: TextAlign.center,
              style: GoogleFonts.spaceGrotesk(
                fontSize: 18.sp,
                fontWeight: FontWeight.w800,
                color: AppColors.textMain,
              ),
            ),
            SizedBox(height: 6.h),
            Text(
              'Use “Send to handheld” on the web defective-EPCs table to push tags here.',
              textAlign: TextAlign.center,
              style: GoogleFonts.spaceGrotesk(
                fontSize: 13.sp,
                color: _kTextMuted,
                height: 1.35,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildList() {
    return ListView.separated(
      padding: EdgeInsets.fromLTRB(20.w, 12.h, 20.w, 16.h),
      itemCount: _items.length,
      separatorBuilder: (_, __) => SizedBox(height: 12.h),
      itemBuilder: (_, i) {
        final item = _items[i];
        final found = _foundEpcs.contains(item.epc);
        return _SwipeRevealRow(
          key: ValueKey<String>('geiger-${item.epc}'),
          onDelete: () => _removeItem(item),
          child: _GeigerItemContainer(
            item: item,
            found: found,
            onGeigerTap: () => _openGeiger(item),
          ),
        );
      },
    );
  }
}

class _BulkFindHeader extends StatelessWidget {
  const _BulkFindHeader({
    required this.scanning,
    required this.found,
    required this.total,
  });
  final bool scanning;
  final int found;
  final int total;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      color: const Color(0xFFF0F5F4),
      padding: EdgeInsets.fromLTRB(20.w, 8.h, 20.w, 8.h),
      child: Row(
        children: [
          Container(
            padding: EdgeInsets.symmetric(horizontal: 8.w, vertical: 3.h),
            color: scanning
                ? const Color(0x3316A34A)
                : const Color(0x33334466),
            child: Text(
              scanning ? 'BULK FIND' : 'IDLE',
              style: GoogleFonts.spaceGrotesk(
                fontSize: 10.sp,
                fontWeight: FontWeight.w800,
                letterSpacing: 1.4,
                color: scanning
                    ? const Color(0xFF16A34A)
                    : const Color(0xFF334466),
              ),
            ),
          ),
          SizedBox(width: 10.w),
          Expanded(
            child: Text(
              total == 0
                  ? 'PULL TRIGGER TO LOCATE BULK'
                  : 'FOUND $found / $total',
              style: GoogleFonts.spaceGrotesk(
                fontSize: 11.sp,
                fontWeight: FontWeight.w800,
                letterSpacing: 1.6,
                color: const Color(0xFF3D4949),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// In-memory row backing a single Cloud+Geiger container. Decoded SKU/desc
/// is best-effort — when the EPC is foreign or enrichment hasn't landed yet,
/// the container falls back to the raw EPC string.
class _GeigerItem {
  const _GeigerItem({
    required this.epc,
    required this.formulaOk,
    this.sku,
    this.itemName,
    this.color,
    this.size,
  });

  factory _GeigerItem.bare(String epc) {
    final formulaOk = isCurrentFormat(epc);
    return _GeigerItem(epc: epc, formulaOk: formulaOk);
  }

  final String epc;
  final bool formulaOk;
  final String? sku;
  final String? itemName;
  final String? color;
  final String? size;

  _GeigerItem withResolved(Map<String, dynamic> row) {
    String? s(String k) {
      final v = row[k];
      if (v == null) return null;
      final str = v.toString().trim();
      return str.isEmpty ? null : str;
    }
    return _GeigerItem(
      epc: epc,
      formulaOk: formulaOk,
      sku: s('sku') ?? s('custom_sku'),
      // Server-side field is `productName`; legacy aliases checked too.
      itemName: s('productName') ?? s('name') ?? s('item_name'),
      color: s('color'),
      size: s('size'),
    );
  }
}

class _GeigerItemContainer extends StatefulWidget {
  const _GeigerItemContainer({
    required this.item,
    required this.found,
    required this.onGeigerTap,
  });

  final _GeigerItem item;
  final bool found;
  final VoidCallback onGeigerTap;

  @override
  State<_GeigerItemContainer> createState() => _GeigerItemContainerState();
}

class _GeigerItemContainerState extends State<_GeigerItemContainer> {
  bool _expanded = false;

  String _primaryLine() {
    final item = widget.item;
    if (item.formulaOk && (item.sku ?? '').isNotEmpty) {
      return 'SKU: ${item.sku}';
    }
    return item.epc;
  }

  String _secondaryLine() {
    final item = widget.item;
    if (!item.formulaOk) return 'Foreign EPC / no Carbon prefix';
    final parts = <String>[
      if ((item.itemName ?? '').isNotEmpty) item.itemName!,
      if ((item.color ?? '').isNotEmpty) item.color!,
      if ((item.size ?? '').isNotEmpty) item.size!,
    ];
    if (parts.isEmpty) return 'Resolving…';
    return parts.join(' · ').toUpperCase();
  }

  /// Container body is tappable only when the row is resolved AND the
  /// EPC isn't already the primary line (raw-EPC rows have nothing to
  /// reveal). Toggles `_expanded` to show the 24-hex EPC string in a
  /// recessed monospace strip under the description.
  bool get _canExpand =>
      widget.item.formulaOk && (widget.item.sku ?? '').isNotEmpty;

  @override
  Widget build(BuildContext context) {
    final item = widget.item;
    final cardBg = widget.found ? _kCardFound : _kCardGrey;
    final stripe = widget.found ? _kStripeFound : AppColors.primary;
    return Container(
      color: cardBg,
      child: IntrinsicHeight(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Container(width: 4, color: stripe),
            Expanded(
              child: GestureDetector(
                onTap: _canExpand
                    ? () => setState(() => _expanded = !_expanded)
                    : null,
                behavior: HitTestBehavior.opaque,
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(12, 10, 8, 10),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: Text(
                              _primaryLine(),
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
                          if (widget.found) ...[
                            const SizedBox(width: 8),
                            Container(
                              padding: const EdgeInsets.symmetric(
                                  horizontal: 8, vertical: 3),
                              color: _kStripeFound,
                              child: Text(
                                'FOUND',
                                style: GoogleFonts.spaceGrotesk(
                                  fontSize: 10.sp,
                                  fontWeight: FontWeight.w900,
                                  letterSpacing: 1.0,
                                  color: Colors.white,
                                ),
                              ),
                            ),
                          ],
                          if (_canExpand) ...[
                            const SizedBox(width: 6),
                            Transform.rotate(
                              angle: _expanded ? 3.14159 : 0,
                              child: const Icon(
                                Icons.keyboard_arrow_down,
                                size: 18,
                                color: _kTextMuted,
                              ),
                            ),
                          ],
                        ],
                      ),
                      const SizedBox(height: 4),
                      Text(
                        _secondaryLine(),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 14,
                          fontWeight: FontWeight.w700,
                          color: item.formulaOk
                              ? AppColors.textMain
                              : _kTextMuted,
                          height: 1.2,
                        ),
                      ),
                      if (_expanded) ...[
                        const SizedBox(height: 8),
                        Container(
                          padding: EdgeInsets.symmetric(
                              horizontal: 10.w, vertical: 6.h),
                          color: const Color(0xFFE2E7E7),
                          child: Text(
                            item.epc,
                            style: GoogleFonts.robotoMono(
                              fontSize: 11.sp,
                              fontWeight: FontWeight.w700,
                              color: const Color(0xFF3D4949),
                              letterSpacing: 0.4,
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
            ),
            GestureDetector(
              onTap: widget.onGeigerTap,
              behavior: HitTestBehavior.opaque,
              child: Container(
                width: 56,
                alignment: Alignment.center,
                color: AppColors.primary,
                child: const Icon(
                  LucideIcons.radio,
                  size: 26,
                  color: Colors.white,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Custom slidable row — pan the child to the RIGHT to reveal a red
/// trash button on the LEFT side. The reveal is a STAGED action: the
/// swipe alone does NOT delete; the operator must tap the revealed
/// trash button. This replaces the prior Dismissible swipe-left flow
/// because operators wanted a confirmation step without the modal
/// dialog overhead.
///
/// Tap anywhere else on the foreground (or swipe back left) collapses.
class _SwipeRevealRow extends StatefulWidget {
  const _SwipeRevealRow({
    super.key,
    required this.child,
    required this.onDelete,
  });

  final Widget child;
  final VoidCallback onDelete;

  @override
  State<_SwipeRevealRow> createState() => _SwipeRevealRowState();
}

class _SwipeRevealRowState extends State<_SwipeRevealRow>
    with SingleTickerProviderStateMixin {
  static const double _revealWidth = 72.0;
  late final AnimationController _ctrl;
  bool _isOpen = false;

  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 180),
      value: 0,
    );
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  void _onDragUpdate(DragUpdateDetails d) {
    // Only allow right-drag (positive delta when closed) and left-drag
    // when open (negative delta returns to closed). Clamps prevent
    // overshoot.
    final next = (_ctrl.value + d.primaryDelta! / _revealWidth)
        .clamp(0.0, 1.0);
    _ctrl.value = next;
  }

  void _onDragEnd(DragEndDetails d) {
    final vx = d.primaryVelocity ?? 0;
    if (vx.abs() > 600) {
      // Strong flick — snap in the flicked direction.
      if (vx > 0) {
        _open();
      } else {
        _close();
      }
      return;
    }
    if (_ctrl.value > 0.5) {
      _open();
    } else {
      _close();
    }
  }

  void _open() {
    _ctrl.animateTo(1.0).then((_) {
      if (mounted) setState(() => _isOpen = true);
    });
  }

  void _close() {
    _ctrl.animateTo(0.0).then((_) {
      if (mounted) setState(() => _isOpen = false);
    });
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _ctrl,
      builder: (_, __) {
        final offset = _ctrl.value * _revealWidth;
        return SizedBox(
          height: null,
          child: Stack(
            children: [
              // Background — trash button revealed under the swiped row.
              Positioned.fill(
                child: Row(
                  children: [
                    GestureDetector(
                      onTap: () {
                        widget.onDelete();
                      },
                      behavior: HitTestBehavior.opaque,
                      child: Container(
                        width: _revealWidth,
                        color: _kTrashRed,
                        alignment: Alignment.center,
                        child: Icon(
                          Icons.delete_outline,
                          color: Colors.white,
                          size: 28.sp,
                        ),
                      ),
                    ),
                    // Tap on the visible part of the foreground (the
                    // sliver to the right of the trash button) collapses
                    // the row. Same gesture iOS Mail uses.
                    Expanded(
                      child: GestureDetector(
                        behavior: HitTestBehavior.translucent,
                        onTap: _isOpen ? _close : null,
                      ),
                    ),
                  ],
                ),
              ),
              // Foreground — the row content, slid to the right.
              Transform.translate(
                offset: Offset(offset, 0),
                child: GestureDetector(
                  onHorizontalDragUpdate: _onDragUpdate,
                  onHorizontalDragEnd: _onDragEnd,
                  behavior: HitTestBehavior.translucent,
                  child: widget.child,
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

/// Bottom-bar power slider — mirrors the Status Change pattern. Bounds
/// come from native getPowerRangeDbm so RFD8500 / C72E both clamp to
/// their real achievable range.
class _BulkFindPowerSlider extends StatelessWidget {
  const _BulkFindPowerSlider({
    required this.powerDbm,
    required this.minDbm,
    required this.maxDbm,
    required this.scanning,
    required this.onChanged,
  });

  final int powerDbm;
  final int minDbm;
  final int maxDbm;
  final bool scanning;
  final ValueChanged<int> onChanged;

  @override
  Widget build(BuildContext context) {
    final lo = minDbm.toDouble();
    final hi = maxDbm.toDouble();
    final value = powerDbm.toDouble().clamp(lo, hi);
    return Container(
      decoration: const BoxDecoration(
        color: Color(0xFFF0F5F4),
        border: Border(top: BorderSide(color: Color(0xFFCDD7D7), width: 1)),
      ),
      padding: EdgeInsets.fromLTRB(14.w, 8.h, 14.w, 8.h),
      child: Row(
        children: [
          Container(
            padding: EdgeInsets.symmetric(horizontal: 8.w, vertical: 3.h),
            color: scanning
                ? const Color(0x3316A34A)
                : const Color(0x33334466),
            child: Text(
              scanning ? 'SCANNING' : 'IDLE',
              style: GoogleFonts.spaceGrotesk(
                fontSize: 10.sp,
                fontWeight: FontWeight.w800,
                letterSpacing: 1.4,
                color: scanning
                    ? const Color(0xFF16A34A)
                    : const Color(0xFF334466),
              ),
            ),
          ),
          SizedBox(width: 10.w),
          Text(
            'PWR',
            style: GoogleFonts.spaceGrotesk(
              fontSize: 10.sp,
              fontWeight: FontWeight.w800,
              letterSpacing: 1.4,
              color: const Color(0xFF6D7979),
            ),
          ),
          SizedBox(width: 6.w),
          Expanded(
            child: SliderTheme(
              data: SliderTheme.of(context).copyWith(
                trackHeight: 3,
                activeTrackColor: AppColors.primary,
                inactiveTrackColor: const Color(0xFFCDD7D7),
                thumbColor: AppColors.primary,
                overlayColor: AppColors.primary.withValues(alpha: 0.10),
                thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 8),
                overlayShape: const RoundSliderOverlayShape(overlayRadius: 16),
              ),
              child: Slider(
                value: value,
                min: lo,
                max: hi,
                divisions: (maxDbm - minDbm).clamp(1, 60),
                onChanged: (v) => onChanged(v.round()),
              ),
            ),
          ),
          SizedBox(width: 8.w),
          SizedBox(
            width: 56.w,
            child: Text(
              '$powerDbm dBm',
              textAlign: TextAlign.right,
              style: GoogleFonts.spaceGrotesk(
                fontSize: 12.sp,
                fontWeight: FontWeight.w800,
                color: AppColors.textMain,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
