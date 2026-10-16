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
import 'package:carbon_wms/services/beep_pacer.dart';
import 'package:carbon_wms/services/epc/epc_codec.dart';
import 'package:carbon_wms/services/handheld_device_identity.dart';
import 'package:carbon_wms/services/mobile_permissions.dart';
import 'package:carbon_wms/services/scan_sounds.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/guards/covering_route.dart';
import 'package:carbon_wms/ui/guards/permission_guard.dart';
import 'package:carbon_wms/ui/screens/bulk_geiger_screen.dart';
import 'package:carbon_wms/ui/screens/locate_tag_screen.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart' show CarbonScaffold;
import 'package:carbon_wms/ui/widgets/item_status_bin.dart';
import 'package:carbon_wms/hardware/hardware_trigger.dart';

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

  /// Last 16 hex of each queued EPC → that EPC. A read that isn't an exact
  /// match is looked up here (a CSV of 16-hex tails vs the radio's 24-hex
  /// EPC) — one map lookup instead of scanning the whole list per read.
  final Map<String, String> _byTail = <String, String>{};

  /// In-memory bulk-find overlay. Independent of the persistent server
  /// queue — Refresh resets it; killing the screen clears it; never
  /// writes back to the items table.
  final Set<String> _foundEpcs = <String>{};

  Timer? _poller;
  // Latest-wins coalesce timer for the power slider (see _setPower).
  Timer? _powerApplyTimer;
  bool _loading = false;
  String? _error;

  // Bulk-find radio state.
  RfidManager? _rfid;
  ModalRoute<dynamic>? _route;
  StreamSubscription<RfidTagRead>? _vendorSub;
  StreamSubscription<String>? _triggerSub;
  bool _scanning = false;
  bool _uploading = false;

  /// Bumped by every start / stop, so a slow start that a stop overtook
  /// never flips the screen back to scanning.
  int _scanGen = 0;

  /// Radio setup in flight (entry, or handing back after Geiger / Bulk
  /// Geiger closed). A start waits for it.
  Future<void> _radioReady = Future<void>.value();

  /// Shown when a start did not reach the sled.
  String? _radioProblem;

  /// One beep per newly found EPC, spaced so a burst is still countable.
  final BeepPacer _beeper = BeepPacer();
  Timer? _repaintTimer;

  // Power slider — bounds populated from native getPowerRangeDbm so the
  // operator can't drag below the radio's floor (RFD8500 ~5..30, C72E
  // 5..23) or above its ceiling.
  int _minDbm = 1;
  int _maxDbm = 30;
  int _powerDbm = 23;

  RfidManager? _lifecycleRfid;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _route = ModalRoute.of(context);
    if (_lifecycleRfid == null) {
      _lifecycleRfid = context.read<RfidManager>();
      _lifecycleRfid!.lifecycleStopTick.addListener(_onLifecycleStop);
    }
  }

  /// App went to background / screen off: RfidManager already stopped the radio.
  /// Only drop this screen's own scanning state — no cue, no restart. (The
  /// queue poller is a server refresh, not a scan timer — it keeps running.)
  void _onLifecycleStop() {
    if (!mounted) return;
    if (_scanning) {
      _scanGen++;
      _beeper.cancel();
      setState(() => _scanning = false);
    }
  }

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

    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _rfid = context.read<RfidManager>();
      // 'GEIGER_FIND' — the canonical context for raw single-tag-style
      // reads (no edge ingest / ghost filter), same as Locate.
      _rfid!.scanContext = 'GEIGER_FIND';
      // Trigger FIRST: it used to be wired only after the power-range and
      // power calls finished, so a slow sled left the first pulls unheard.
      _triggerSub = hardwareTriggerFor(this).listen(_onTrigger, onError: (_) {});
      // The tag stream. (It used to also listen to RfidManager's
      // geigerTagReads "in case" — the real reason reads went missing was
      // the shared platform channel, fixed in ChannelFanout.)
      _vendorSub = RfidVendorChannel.tagReadStream().listen(
        _onUhfRead,
        onError: (_) {},
      );
      _radioReady = _initRadio();
      unawaited(_pollOnce());
    });
    _poller = Timer.periodic(_pollInterval, (_) => unawaited(_pollOnce()));
  }

  /// Entry: slider bounds, then the radio at the reader's MAX achievable dBm
  /// so the first sweep has the widest range without touching the slider.
  Future<void> _initRadio() async {
    await _hydrateSliderRange();
    if (!mounted) return;
    setState(() => _powerDbm = _maxDbm);
    await _applyRadioSetup();
  }

  /// Everything this screen needs from the radio. Applied on entry, after
  /// Geiger / Bulk Geiger opened from here have fully closed (their dispose
  /// restores THEIR defaults: power override off, per-tag beep on, one-tag
  /// filter, 2D imager), and before every start. Each step is a no-op on the
  /// sled when nothing changed.
  Future<void> _applyRadioSetup() async {
    unawaited(ScanSounds.instance.setTagBeepSuppressed(true));
    _rfid?.scanContext = 'GEIGER_FIND';
    try {
      await RfidVendorChannel.scannerDisableTriggerRelay();
      await RfidVendorChannel.close2dBarcode();
      await RfidVendorChannel.enableRfidFunctionMode();
      await RfidVendorChannel.setZebraTriggerModeRfid();
    } catch (_) {/* best-effort — no-op when the sled is not connected */}
    await RfidVendorChannel.setEpcInventoryFilter(null);
    // Quiet mode (owner, 2026-10-16), as in Count and Bulk Geiger: a tag
    // already read stays silent while the sled keeps powering it, so in a
    // crowded aisle the radio spends its time on tags not read yet instead of
    // re-reading the ones it has. This screen only uses a tag's first read.
    // Re-asserted on every start: Geiger (S0) and Bulk Geiger restore their
    // own session in dispose.
    await RfidVendorChannel.setQuietInventory(true);
    await _rfid?.setSessionPowerOverrideDbm(_powerDbm);
    try {
      await RfidVendorChannel.setAntennaPowerDbm(_powerDbm);
    } catch (_) {}
  }

  /// Back from a screen opened here: wait until it is really gone (its
  /// dispose ran), then take the radio back.
  Future<void> _reclaimRadio() async {
    await coveringRouteGone(_route);
    if (!mounted) return;
    await _applyRadioSetup();
  }

  void _onTrigger(String event) {
    if (!mounted || event != 'down') return;
    // A running scan always stops on a pull.
    if (_scanning) {
      unawaited(_stopScan());
      return;
    }
    // No EPCs to find → ignore the pull: no "started but found nothing".
    if (_items.isEmpty) return;
    if (_foundEpcs.length >= _items.length) {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(const SnackBar(
        content: Text('Every EPC on the list is found. Tap Refresh to look again.'),
        duration: Duration(milliseconds: 1600),
      ));
      return;
    }
    unawaited(_startScan());
  }

  @override
  void dispose() {
    _lifecycleRfid?.lifecycleStopTick.removeListener(_onLifecycleStop);
    _poller?.cancel();
    _poller = null;
    _powerApplyTimer?.cancel();
    _repaintTimer?.cancel();
    _beeper.dispose();
    unawaited(_vendorSub?.cancel());
    unawaited(_triggerSub?.cancel());
    unawaited(RfidVendorChannel.stopChainwayInventory());
    unawaited(RfidVendorChannel.stopZebraInventory());
    // Hand the next screen the default session back.
    unawaited(RfidVendorChannel.setQuietInventory(false));
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

  /// The screen flips to BULK FIND at once; the radio follows. A stop (second
  /// pull, background, leaving) at any point wins — [_scanGen] makes every
  /// late step of an overtaken start a no-op.
  Future<void> _startScan() async {
    if (_scanning || _items.isEmpty) return;
    if (_rfid?.isBackgrounded ?? false) return;
    final gen = ++_scanGen;
    setState(() {
      _scanning = true;
      _radioProblem = null;
    });
    try {
      ScanSounds.instance.play(ScanCue.start);
    } catch (_) {}
    // Back from Geiger / Bulk Geiger a moment ago: let it finish handing the
    // radio back first, or its dispose would stop this scan again.
    await _radioReady;
    if (!_isLive(gen)) return;
    await _applyRadioSetup();
    if (!_isLive(gen)) return;
    final problem = await _startRadio();
    if (!_isLive(gen) || problem == null) return;
    // Said so instead of showing BULK FIND over a radio that is off.
    _beeper.cancel();
    setState(() {
      _scanning = false;
      _radioProblem = problem;
    });
    try {
      ScanSounds.instance.play(ScanCue.stop);
    } catch (_) {}
  }

  bool _isLive(int gen) => mounted && _scanning && gen == _scanGen;

  /// Starts inventory on the reader this phone actually has. Returns what to
  /// tell the operator when it did not start; null when it did.
  Future<String?> _startRadio() async {
    const notStarted = 'The sled did not start. Pull the trigger again.';
    final status = await RfidVendorChannel.readerStatus();
    if (status != null && !status.connected) {
      return 'No RFID sled connected. Connect the RFD8500, then pull the trigger.';
    }
    switch (status?.stack) {
      case 'zebra':
        try {
          await RfidVendorChannel.startZebraInventory();
          return null;
        } catch (_) {
          return notStarted;
        }
      case 'chainway':
        try {
          await RfidVendorChannel.startChainwayInventory();
          return null;
        } catch (_) {
          return notStarted;
        }
      default:
        // Reader state unknown: try both, as before.
        var started = false;
        try {
          await RfidVendorChannel.startZebraInventory();
          started = true;
        } catch (_) {}
        try {
          await RfidVendorChannel.startChainwayInventory();
          started = true;
        } catch (_) {}
        return started ? null : notStarted;
    }
  }

  Future<void> _stopScan({bool silent = false}) async {
    if (!_scanning) return;
    _scanGen++;
    _beeper.cancel();
    setState(() => _scanning = false);
    if (!silent) {
      try {
        ScanSounds.instance.play(ScanCue.stop);
      } catch (_) {}
    }
    await RfidVendorChannel.stopZebraInventory();
    await RfidVendorChannel.stopChainwayInventory();
  }

  Future<void> _setPower(int dbm) async {
    final clamped = dbm.clamp(_minDbm, _maxDbm);
    if (clamped == _powerDbm) return;
    // Update the visual label immediately so the slider tracks the finger,
    // but coalesce the native radio push (see _schedulePowerApply).
    setState(() => _powerDbm = clamped);
    _schedulePowerApply(clamped);
  }

  /// Latest-wins coalesce (~180 ms) before pushing power to the radio. On
  /// the RFD8500 every push is a stop -> setAntennaRfConfig -> resume cycle,
  /// so a fast drag without this queues one cycle per tick and stutters the
  /// bulk-find sweep. Mirrors the Count / Transfer-In sliders.
  void _schedulePowerApply(int dbm) {
    _powerApplyTimer?.cancel();
    _powerApplyTimer = Timer(const Duration(milliseconds: 180), () async {
      if (!mounted) return;
      final rfid = _rfid;
      if (rfid != null) {
        await rfid.setSessionPowerOverrideDbm(dbm);
      }
      try {
        await RfidVendorChannel.setAntennaPowerDbm(dbm);
      } catch (_) {}
    });
  }

  void _onUhfRead(RfidTagRead read) {
    if (!mounted || !_scanning) return;
    final epc = read.epcHex24.toUpperCase();
    if (epc.isEmpty) return;
    // Exact match first, then the last 16 hex (item + serial — what is
    // actually unique) for queues holding tail-only EPCs. Both are single
    // lookups: this runs for EVERY tag the sled hears in the aisle, and the
    // old per-read loop over the whole list grew with the list.
    final matched = _seenEpcs.contains(epc)
        ? epc
        : (epc.length >= 16 ? _byTail[epc.substring(epc.length - 16)] : null);
    if (matched == null || !_foundEpcs.add(matched)) return;
    // First time this EPC is heard this pass: one beep (the native per-tag
    // beep is off here, so this is the only sound, and only on a new hit).
    _beeper.request();
    if (_foundEpcs.length >= _items.length) {
      // Everything on the list is found — nothing left to look for.
      try {
        ScanSounds.instance.play(ScanCue.success);
      } catch (_) {}
      unawaited(_stopScan(silent: true));
    }
    // A burst of finds repaints once, not once per tag.
    _repaintTimer ??= Timer(const Duration(milliseconds: 150), () {
      _repaintTimer = null;
      if (mounted) setState(() {});
    });
  }

  void _reindexTails() {
    _byTail
      ..clear()
      ..addEntries([
        for (final q in _seenEpcs)
          if (q.length >= 16) MapEntry(q.substring(q.length - 16), q),
      ]);
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
      _reindexTails();
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
  ///
  /// Sent in chunks of 500 — the server's per-call cap. One call with more
  /// (the web can queue up to 5,000) was rejected and left every row on
  /// "Resolving…".
  Future<void> _enrich(List<String> epcs) async {
    final api = context.read<WmsApiClient>();
    for (var start = 0; start < epcs.length; start += 500) {
      final end = start + 500 > epcs.length ? epcs.length : start + 500;
      try {
        final rows = await api.lookupEpcs(epcs.sublist(start, end));
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
  }

  void _removeItem(_GeigerItem item) {
    setState(() {
      _items.removeWhere((e) => e.epc == item.epc);
      _seenEpcs.remove(item.epc);
      _foundEpcs.remove(item.epc);
      _reindexTails();
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
  /// canvas to do another sweep. Every row's status / bin is re-read too —
  /// they can change while the list sits here.
  Future<void> _onRefresh() async {
    setState(() => _foundEpcs.clear());
    await _pollOnce();
    if (!mounted || _items.isEmpty) return;
    unawaited(_enrich(_items.map((e) => e.epc).toList()));
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
    if (_scanning) await _stopScan();
    if (!mounted) return;
    setState(() {
      _items.clear();
      _seenEpcs.clear();
      _foundEpcs.clear();
      _byTail.clear();
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
    // Geiger takes the radio. A bulk find left "running" here used to come
    // back showing BULK FIND over a radio Geiger had already stopped, so the
    // next pull only "stopped" it and the one after that started it.
    if (_scanning) await _stopScan();
    if (!mounted) return;
    // Thread the enrichment payload through so LocateTagScreen renders
    // its built-in item-info card directly under the EPC strip. The
    // operator confirmed they don't want to mentally cross-reference
    // SKU/colour/size while sweeping — same container Count Inventory
    // uses, same data this row already has resolved.
    await context.pushGuarded<void>(
      ScreenIds.locateTag,
      (_) => LocateTagScreen(
        targetEpc: item.epc,
        targetBin: item.bin,
        targetSku: item.sku,
        targetName: item.itemName,
        targetColor: item.color,
        targetSize: item.size,
        cloudGeigerMode: true,
      ),
    );
    // Locate's dispose (per-tag beep on, power override off, one-tag filter
    // off, radio stopped) runs ~300 ms AFTER this await returns. Take the
    // radio back only once it has run, and hold any trigger pull until then.
    if (!mounted) return;
    _radioReady = _reclaimRadio();
    await _radioReady;
  }

  /// This list in Bulk Geiger (one beep per tag found, tap one → Geiger).
  Future<void> _openBulk() async {
    if (_scanning) await _stopScan();
    if (!mounted) return;
    await context.pushGuarded<void>(
      ScreenIds.bulkGeiger,
      (_) => BulkGeigerScreen(initialEpcs: _items.map((e) => e.epc).toList()),
    );
    // Same hand-back as _openGeiger.
    if (!mounted) return;
    _radioReady = _reclaimRadio();
    await _radioReady;
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
    final perms = context.read<MobilePermissions>();
    final canDeleteAll = perms.canDo(ScreenIds.cloudGeiger, 'dismiss_all');
    final canExportCsv = perms.canDo(ScreenIds.cloudGeiger, 'export_csv');
    return CarbonScaffold(
      pageTitle: 'cloud + geiger',
      actions: [
        IconButton(
          tooltip: 'Open in Bulk Geiger',
          onPressed: _items.isEmpty ? null : () => unawaited(_openBulk()),
          icon: const Icon(LucideIcons.radar),
        ),
      ],
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
            if (_radioProblem != null)
              Container(
                width: double.infinity,
                color: const Color(0xFFFFF7E6),
                padding: EdgeInsets.symmetric(horizontal: 16.w, vertical: 8.h),
                child: Text(
                  _radioProblem!,
                  style: GoogleFonts.spaceGrotesk(
                    fontSize: 12.sp,
                    fontWeight: FontWeight.w800,
                    color: const Color(0xFFB45309),
                  ),
                ),
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
                  if (canDeleteAll) ...[
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
                  ],
                  if (canExportCsv) ...[
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
    this.resolved = false,
    this.status,
    this.bin,
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

  /// The server lookup answered for this EPC — [status] null then means the
  /// tag has no WMS record.
  final bool resolved;

  /// WMS items.status (`in-stock`, `tag_killed`, `retired`…).
  final String? status;

  /// The tag's assigned bin code, null when it has none.
  final String? bin;

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
      resolved: true,
      status: s('status'),
      bin: s('bin'),
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
                      if (item.resolved) ...[
                        const SizedBox(height: 6),
                        ItemStatusBinLine(status: item.status, bin: item.bin),
                      ],
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
