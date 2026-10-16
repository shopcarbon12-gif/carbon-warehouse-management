import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/hardware/hardware_trigger.dart';
import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/hardware/rfid_tag_read.dart';
import 'package:carbon_wms/hardware/rfid_vendor_channel.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/beep_pacer.dart';
import 'package:carbon_wms/services/mobile_permissions.dart';
import 'package:carbon_wms/services/scan_sounds.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/guards/covering_route.dart';
import 'package:carbon_wms/ui/screens/tag_page_screen.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart' show CarbonScaffold;
import 'package:carbon_wms/ui/widgets/scan_range.dart';

/// Zone Management (owner, 2026-10-16) — Bin Management → Zone Management.
///
/// Pick a zone (e.g. "Store"), pull the trigger and walk. While scanning the
/// screen only counts and lists tags (a light repaint 4×/s, only visible rows
/// drawn); when you pause, every new tag is checked against the WMS: product,
/// size, colour, bin, current zone — or why it can't be assigned. ASSIGN puts
/// the LIVE tags of this location in the zone, REMOVE takes them out; bins
/// never change. The whole scan (couldn't-assign included) becomes a report.
///
/// Range — NEAR / MEDIUM / FAR, see [ScanRange] (shared with Bulk Geiger,
/// Cloud + Geiger, Add-On Count and Add-On Catalog).
///
/// Swipe a line right to drop it (it won't be assigned, and re-reads are
/// ignored until CLEAR). Tap a line for its tag page (photo, details, GEIGER).
class ZoneManagementScreen extends StatefulWidget {
  const ZoneManagementScreen({super.key});

  @override
  State<ZoneManagementScreen> createState() => _ZoneManagementScreenState();
}

const Color _kOk = Color(0xFF16A34A);
const Color _kWarn = Color(0xFFB45309);
const Color _kCard = Color(0xFFECECEC);
const Color _kRed = Color(0xFFBF2E2E);

class _Zone {
  const _Zone(this.id, this.name, this.count);
  final String id;
  final String name;
  final int count;
}

class _Tag {
  _Tag(this.epc, this.rssi);
  final String epc;
  int? rssi; // strongest read this session
  Map<String, dynamic>? check; // null = not checked yet
  Map<String, dynamic> d = const {};

  void setCheck(Map<String, dynamic> c) {
    check = c;
    d = (c['details'] is Map) ? Map<String, dynamic>.from(c['details'] as Map) : const {};
    product = [d['product'], d['color'], d['size']].where((v) => v != null && '$v'.isNotEmpty).join(' · ');
    final bin = d['bin'] as String?;
    final extra = (d['extraBins'] is List) ? (d['extraBins'] as List).map((e) => '$e').toList() : <String>[];
    bins = (bin == null || bin.isEmpty)
        ? (extra.isEmpty ? '—' : extra.join(', '))
        : (extra.isEmpty ? bin : '$bin (+ ${extra.join(', ')})');
  }

  String product = '';
  String bins = '—';
  bool get checked => check != null;
  bool get ok => check?['ok'] == true;
  String? get zoneId => d['zoneId'] as String?;
  String? get zone => d['zone'] as String?;
  String? get reasonText => check?['reasonText'] as String?;
}

class _ZoneManagementScreenState extends State<ZoneManagementScreen> {
  List<_Zone> _zones = const [];
  bool _canManage = false;
  String? _zoneId;
  bool _removeMode = false;
  bool _busy = false;
  String? _message;

  final Map<String, _Tag> _tags = <String, _Tag>{};
  final Set<String> _dropped = <String>{};
  int _checkingTotal = 0;
  int _checkingDone = 0;

  // Range / signal gate (keys kept from 1.2.178: zone_mgmt_range, …).
  final ScanRangeSetting _range = ScanRangeSetting('zone_mgmt');

  // Radio — same handling as Cloud + Geiger.
  RfidManager? _rfid;
  RfidManager? _lifecycleRfid;
  ModalRoute<dynamic>? _route;
  StreamSubscription<RfidTagRead>? _vendorSub;
  StreamSubscription<String>? _triggerSub;
  bool _scanning = false;
  int _scanGen = 0;
  Future<void> _radioReady = Future<void>.value();
  final BeepPacer _beeper = BeepPacer();
  final ScanPower _power = ScanPower();
  Timer? _repaintTimer;
  bool _dirty = false;

  _Zone? get _zone {
    for (final z in _zones) {
      if (z.id == _zoneId) return z;
    }
    return null;
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _route = ModalRoute.of(context);
    if (_lifecycleRfid == null) {
      _lifecycleRfid = context.read<RfidManager>();
      _lifecycleRfid!.lifecycleStopTick.addListener(_onLifecycleStop);
    }
  }

  void _onLifecycleStop() {
    if (!mounted || !_scanning) return;
    _scanGen++;
    _beeper.cancel();
    setState(() => _scanning = false);
    unawaited(_checkPending());
  }

  @override
  void initState() {
    super.initState();
    unawaited(ScanSounds.instance.init());
    // One paced beep per NEW tag, not the native per-read beep.
    unawaited(ScanSounds.instance.setTagBeepSuppressed(true));
    unawaited(RfidVendorChannel.scannerDisableTriggerRelay());
    unawaited(RfidVendorChannel.close2dBarcode());
    unawaited(RfidVendorChannel.enableRfidFunctionMode());
    unawaited(RfidVendorChannel.setZebraTriggerModeRfid());
    // Light repaint while scanning: the list redraws at most 4×/s.
    _repaintTimer = Timer.periodic(const Duration(milliseconds: 250), (_) {
      if (_dirty && mounted) {
        _dirty = false;
        setState(() {});
      }
    });
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted) return;
      _rfid = context.read<RfidManager>();
      // Raw reads only — nothing is ingested or changed by reading.
      _rfid!.scanContext = 'GEIGER_FIND';
      _triggerSub = hardwareTriggerFor(this).listen(_onTrigger, onError: (_) {});
      _vendorSub = RfidVendorChannel.tagReadStream().listen(_onUhfRead, onError: (_) {});
      await _range.load();
      if (mounted) setState(() {});
      _radioReady = _initRadio();
      unawaited(_loadZones());
    });
  }

  @override
  void dispose() {
    _lifecycleRfid?.lifecycleStopTick.removeListener(_onLifecycleStop);
    _repaintTimer?.cancel();
    _power.dispose();
    _beeper.dispose();
    unawaited(_vendorSub?.cancel());
    unawaited(_triggerSub?.cancel());
    unawaited(RfidVendorChannel.stopZebraInventory());
    unawaited(RfidVendorChannel.stopChainwayInventory());
    unawaited(RfidVendorChannel.setQuietInventory(false));
    unawaited(ScanSounds.instance.setTagBeepSuppressed(false));
    final rfid = _rfid;
    if (rfid != null) unawaited(rfid.setSessionPowerOverrideDbm(null));
    super.dispose();
  }

  // ── Range ─────────────────────────────────────────────────────────────────

  void _setRange(ScanRange r) {
    setState(() => _range.range = r);
    unawaited(_range.save());
    _radioReady = _applyRadioSetup();
  }

  // ── Radio ─────────────────────────────────────────────────────────────────

  Future<void> _initRadio() async {
    await _power.loadRange();
    if (!mounted) return;
    setState(() {});
    await _applyRadioSetup();
  }

  Future<void> _applyRadioSetup() async {
    unawaited(ScanSounds.instance.setTagBeepSuppressed(true));
    _rfid?.scanContext = 'GEIGER_FIND';
    await RfidVendorChannel.setEpcInventoryFilter(null);
    // FAR: quiet mode (a read tag stays silent while powered — less noise in a
    // crowded rack). NEAR / MEDIUM: off, so a tag that was too far the first
    // time answers again when the operator walks up to it.
    await RfidVendorChannel.setQuietInventory(_range.quietMode);
    await _power.apply(_rfid);
  }

  Future<void> _loadZones() async {
    try {
      final j = await context.read<WmsApiClient>().fetchAssignedZones();
      if (!mounted) return;
      final list = (j['zones'] is List ? j['zones'] as List : const [])
          .whereType<Map>()
          .map((m) => _Zone('${m['id']}', '${m['name']}', (m['count'] as num?)?.toInt() ?? 0))
          .toList();
      setState(() {
        _zones = list;
        _canManage = j['canManage'] == true;
        if (_zoneId == null || !list.any((z) => z.id == _zoneId)) {
          _zoneId = list.isNotEmpty ? list.first.id : null;
        }
      });
    } catch (e) {
      if (mounted) setState(() => _message = 'Could not load zones: $e');
    }
  }

  void _onTrigger(String event) {
    if (!mounted || event != 'down') return;
    if (_scanning) {
      unawaited(_stopScan());
    } else {
      unawaited(_startScan());
    }
  }

  Future<void> _startScan() async {
    if (_scanning || _busy || (_rfid?.isBackgrounded ?? false)) return;
    final gen = ++_scanGen;
    setState(() {
      _scanning = true;
      _message = null;
    });
    try {
      ScanSounds.instance.play(ScanCue.start);
    } catch (_) {}
    await _radioReady;
    if (!mounted || !_scanning || gen != _scanGen) return;
    await _applyRadioSetup();
    if (!mounted || !_scanning || gen != _scanGen) return;
    final problem = await _startRadio();
    if (problem == null || !mounted || gen != _scanGen) return;
    setState(() {
      _scanning = false;
      _message = problem;
    });
  }

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

  /// Pause: stop the radio, then look up every tag read since the last check.
  Future<void> _stopScan() async {
    if (!_scanning) return;
    _scanGen++;
    _beeper.cancel();
    setState(() => _scanning = false);
    try {
      ScanSounds.instance.play(ScanCue.stop);
    } catch (_) {}
    await RfidVendorChannel.stopZebraInventory();
    await RfidVendorChannel.stopChainwayInventory();
    await _checkPending();
  }

  void _setPower(int dbm) {
    if (_power.set(dbm, _rfid)) setState(() {});
  }

  /// Hot path: no network, no setState — just record and mark for repaint.
  void _onUhfRead(RfidTagRead read) {
    if (!_scanning) return;
    final epc = read.epcHex24.toUpperCase();
    if (epc.length != 24 || _dropped.contains(epc)) return;
    final rssi = read.rssi;
    final existing = _tags[epc];
    if (existing != null) {
      if (rssi != null && (existing.rssi == null || rssi > existing.rssi!)) {
        existing.rssi = rssi;
        _dirty = true;
      }
      return;
    }
    // Signal gate (NEAR / MEDIUM): too weak = too far or not in front of the
    // antenna yet — ignored until a stronger read.
    if (!_range.passes(rssi)) return;
    _tags[epc] = _Tag(epc, rssi);
    _beeper.request();
    _dirty = true;
  }

  /// Checks every not-yet-checked tag, 400 per call, with progress.
  Future<void> _checkPending() async {
    final todo = _tags.values.where((t) => !t.checked).map((t) => t.epc).toList();
    if (todo.isEmpty || !mounted) return;
    final api = context.read<WmsApiClient>();
    setState(() {
      _checkingTotal = todo.length;
      _checkingDone = 0;
    });
    for (var i = 0; i < todo.length; i += 400) {
      final batch = todo.sublist(i, i + 400 > todo.length ? todo.length : i + 400);
      try {
        final rows = await api.checkZoneEpcs(batch);
        for (final r in rows) {
          _tags[('${r['epc']}').toUpperCase()]?.setCheck(r);
        }
      } catch (e) {
        if (mounted) setState(() => _message = 'Check failed — pause again to retry ($e)');
      }
      if (!mounted) return;
      setState(() => _checkingDone = i + batch.length);
    }
    if (mounted) setState(() => _checkingTotal = 0);
  }

  // ── Lists ─────────────────────────────────────────────────────────────────

  /// ASSIGN: LIVE tags here not already in this zone. REMOVE: tags in this zone.
  bool _isActionable(_Tag t) {
    if (!t.ok) return false;
    return _removeMode ? t.zoneId == _zoneId : t.zoneId != _zoneId;
  }

  /// Display order: while scanning, strongest signal first; after the check,
  /// couldn't-assign first, then by product.
  List<_Tag> _display() {
    final list = _tags.values.toList();
    if (_scanning || list.any((t) => !t.checked)) {
      list.sort((a, b) => (b.rssi ?? -999).compareTo(a.rssi ?? -999));
    } else {
      list.sort((a, b) {
        final c = (a.ok ? 1 : 0).compareTo(b.ok ? 1 : 0);
        return c != 0 ? c : a.product.compareTo(b.product);
      });
    }
    return list;
  }

  void _drop(_Tag t) {
    setState(() {
      _tags.remove(t.epc);
      _dropped.add(t.epc);
    });
  }

  Future<void> _run() async {
    final zone = _zone;
    final perms = context.read<MobilePermissions>();
    final api = context.read<WmsApiClient>();
    final actionable = _tags.values.where(_isActionable).length;
    if (zone == null || actionable == 0 || _busy) return;
    if (!perms.canEdit(ScreenIds.zoneManagement)) {
      setState(() => _message = 'Not allowed to change zones');
      return;
    }
    if (_scanning) await _stopScan();
    if (!mounted) return;
    setState(() {
      _busy = true;
      _message = null;
    });
    // The whole scan (dropped lines excluded) goes to the server: it changes
    // only what it may and the report keeps every tag, couldn't-assign too.
    final all = _tags.keys.toList();
    try {
      if (_removeMode) {
        final j = await api.removeEpcsFromZone(all, zoneId: zone.id);
        _message = 'Removed ${j['removed'] ?? 0} tag(s) from ${zone.name}. Report saved (Reports → Zones).';
      } else {
        final j = await api.assignEpcsToZone(zone.id, all);
        final done = ((j['assigned'] as num?)?.toInt() ?? 0) + ((j['moved'] as num?)?.toInt() ?? 0);
        final moved = (j['moved'] as num?)?.toInt() ?? 0;
        final skipped = (j['skipped'] is List) ? (j['skipped'] as List).length : 0;
        _message = '$done assigned to ${zone.name}'
            '${moved > 0 ? ' ($moved moved from another zone)' : ''}'
            '${skipped > 0 ? ' · $skipped couldn\'t be assigned' : ''}. Report saved (Reports → Zones).';
        try {
          ScanSounds.instance.play(ScanCue.success);
        } catch (_) {}
      }
      // Re-check so every line shows its new zone.
      for (final t in _tags.values) {
        t.check = null;
      }
      await _checkPending();
      await _loadZones();
    } catch (e) {
      _message = 'Failed: $e';
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _clear() {
    setState(() {
      _tags.clear();
      _dropped.clear();
      _message = null;
    });
  }

  Future<void> _newZone() async {
    final ctrl = TextEditingController();
    final name = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        shape: const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
        title: const Text('New zone'),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          maxLength: 60,
          decoration: const InputDecoration(labelText: 'Zone name, e.g. Store'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('CANCEL')),
          FilledButton(
            style: FilledButton.styleFrom(shape: const RoundedRectangleBorder(borderRadius: BorderRadius.zero)),
            onPressed: () => Navigator.pop(ctx, ctrl.text.trim()),
            child: const Text('CREATE'),
          ),
        ],
      ),
    );
    if (name == null || name.isEmpty || !mounted) return;
    try {
      final j = await context.read<WmsApiClient>().createAssignedZone(name);
      final id = (j['zone'] is Map) ? '${(j['zone'] as Map)['id']}' : null;
      await _loadZones();
      if (mounted && id != null) setState(() => _zoneId = id);
    } catch (e) {
      if (mounted) setState(() => _message = 'Create failed: $e');
    }
  }

  /// Opens another screen with the radio stopped, then takes it back.
  Future<void> _openAndReclaim(Widget screen) async {
    if (_scanning) await _stopScan();
    if (!mounted) return;
    await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => screen));
    if (!mounted) return;
    await coveringRouteGone(_route);
    if (!mounted) return;
    _radioReady = _applyRadioSetup();
    unawaited(_loadZones());
  }

  // ── UI ────────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    final zone = _zone;
    final rows = _display();
    final actionable = rows.where(_isActionable).length;
    final cannot = rows.where((t) => t.checked && !t.ok).length;
    final unchecked = rows.where((t) => !t.checked).length;
    final checking = _checkingTotal > 0;
    return CarbonScaffold(
      pageTitle: 'ZONE MANAGEMENT',
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (_busy || checking)
              LinearProgressIndicator(
                minHeight: 3,
                value: checking && _checkingTotal > 0 ? _checkingDone / _checkingTotal : null,
              ),
            Padding(
              padding: EdgeInsets.fromLTRB(16.w, 10.h, 16.w, 0),
              child: Row(
                children: [
                  Expanded(
                    child: DropdownButtonFormField<String>(
                      key: ValueKey(_zoneId),
                      initialValue: _zoneId,
                      isExpanded: true,
                      decoration: const InputDecoration(labelText: 'Zone', isDense: true),
                      items: [
                        for (final z in _zones)
                          DropdownMenuItem(value: z.id, child: Text('${z.name}  (${z.count})', overflow: TextOverflow.ellipsis)),
                      ],
                      onChanged: (v) => setState(() => _zoneId = v),
                    ),
                  ),
                  if (_canManage && context.read<MobilePermissions>().canDo(ScreenIds.zoneManagement, 'manage_zones'))
                    IconButton(tooltip: 'New zone', icon: const Icon(Icons.add_circle_outline), onPressed: _newZone),
                  IconButton(
                    tooltip: 'Tags in this zone',
                    icon: const Icon(Icons.list_alt),
                    onPressed: zone == null ? null : () => _openAndReclaim(_ZoneContentsScreen(zone: zone)),
                  ),
                ],
              ),
            ),
            if (_zones.isEmpty)
              Padding(
                padding: EdgeInsets.symmetric(horizontal: 16.w),
                child: Text(
                  _canManage ? 'No zones yet — tap + to create one (e.g. Store).' : 'No zones yet — ask an admin to create one.',
                  style: TextStyle(color: AppColors.textMuted, fontSize: 12.sp),
                ),
              ),
            Padding(
              padding: EdgeInsets.fromLTRB(16.w, 6.h, 16.w, 0),
              child: Row(
                children: [
                  Expanded(
                    child: SegmentedButton<bool>(
                      showSelectedIcon: false,
                      segments: const [
                        ButtonSegment(value: false, label: Text('ASSIGN')),
                        ButtonSegment(value: true, label: Text('REMOVE')),
                      ],
                      selected: {_removeMode},
                      onSelectionChanged: (s) => setState(() => _removeMode = s.first),
                    ),
                  ),
                  SizedBox(width: 8.w),
                  Expanded(
                    child: ScanRangeButtons(value: _range.range, onChanged: _setRange),
                  ),
                ],
              ),
            ),
            Padding(
              padding: EdgeInsets.fromLTRB(16.w, 0, 16.w, 0),
              child: ScanPowerRow(power: _power, onChanged: _setPower),
            ),
            if (_range.range != ScanRange.far)
              Padding(
                padding: EdgeInsets.fromLTRB(16.w, 0, 16.w, 0),
                child: ScanMinSignalRow(
                  setting: _range,
                  onChanged: (v) => setState(() => _range.gate[_range.range] = v),
                  onChangeEnd: () => unawaited(_range.save()),
                ),
              ),
            Padding(
              padding: EdgeInsets.fromLTRB(16.w, 0, 16.w, 4.h),
              child: Text(
                checking
                    ? 'Checking $_checkingDone / $_checkingTotal…'
                    : '${rows.length} read · $actionable ${_removeMode ? 'in this zone' : 'ready'}'
                        ' · $cannot can\'t be assigned'
                        '${unchecked > 0 ? ' · $unchecked to check (pause)' : ''}'
                        '${_range.minRssi != null ? ' · only ≥ ${_range.minRssi} dBm' : ''}',
                style: TextStyle(fontSize: 12.sp, color: AppColors.textMuted),
              ),
            ),
            Expanded(
              child: rows.isEmpty
                  ? Center(
                      child: Padding(
                        padding: EdgeInsets.all(24.w),
                        child: Text(
                          _scanning
                              ? 'Scanning… walk past the tags.'
                              : 'Pull the trigger to read tags. Pull again (pause) to see their details.\n'
                                  'Swipe a line right to drop it. Tap a line to open the tag.',
                          textAlign: TextAlign.center,
                          style: TextStyle(color: AppColors.textMuted, fontSize: 13.sp),
                        ),
                      ),
                    )
                  : ListView.builder(
                      padding: EdgeInsets.symmetric(horizontal: 12.w),
                      itemCount: rows.length,
                      itemBuilder: (_, i) => _tagRow(rows[i]),
                    ),
            ),
            if (_message != null)
              Padding(
                padding: EdgeInsets.fromLTRB(16.w, 6.h, 16.w, 0),
                child: Text(_message!, style: TextStyle(fontSize: 12.5.sp, fontWeight: FontWeight.w600)),
              ),
            Padding(
              padding: EdgeInsets.fromLTRB(12.w, 8.h, 12.w, 10.h),
              child: Row(
                children: [
                  OutlinedButton(
                    onPressed: rows.isEmpty || _busy || _scanning ? null : _clear,
                    style: OutlinedButton.styleFrom(
                      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
                      minimumSize: Size(0, 48.h),
                    ),
                    child: const Text('CLEAR'),
                  ),
                  SizedBox(width: 8.w),
                  Expanded(
                    child: FilledButton(
                      onPressed: zone == null || actionable == 0 || _busy || checking || unchecked > 0 ? null : _run,
                      style: FilledButton.styleFrom(
                        backgroundColor: _removeMode ? _kRed : AppColors.primary,
                        shape: const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
                        minimumSize: Size(0, 48.h),
                      ),
                      child: Text(
                        zone == null
                            ? 'PICK A ZONE'
                            : unchecked > 0
                                ? 'PAUSE TO CHECK $unchecked'
                                : _removeMode
                                    ? 'REMOVE $actionable FROM ${zone.name.toUpperCase()}'
                                    : 'ASSIGN $actionable TO ${zone.name.toUpperCase()}',
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  ),
                ],
              ),
            ),
            Container(
              color: _scanning ? _kOk : AppColors.slateAction,
              padding: EdgeInsets.symmetric(vertical: 8.h),
              alignment: Alignment.center,
              child: Text(
                _scanning ? 'SCANNING — PULL TRIGGER TO PAUSE' : 'PULL TRIGGER TO SCAN',
                style: GoogleFonts.spaceGrotesk(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 13.sp),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _tagRow(_Tag t) {
    final String sub;
    final Color stripe;
    if (!t.checked) {
      sub = _scanning ? 'Read${t.rssi != null ? ' · ${t.rssi} dBm' : ''}' : 'Not checked yet — pause to check';
      stripe = AppColors.border;
    } else if (!t.ok) {
      sub = t.reasonText ?? 'Can\'t be assigned';
      stripe = _kWarn;
    } else if (t.zoneId == _zoneId) {
      sub = 'Bin ${t.bins} · already in ${t.zone}';
      stripe = _removeMode ? _kRed : _kOk;
    } else {
      sub = 'Bin ${t.bins}${t.zone != null ? ' · in ${t.zone}${_removeMode ? '' : ' → will move'}' : ''}';
      stripe = _removeMode ? AppColors.border : AppColors.primary;
    }
    return Dismissible(
      key: ValueKey(t.epc),
      direction: DismissDirection.startToEnd,
      background: Container(
        margin: EdgeInsets.only(bottom: 6.h),
        color: _kRed,
        alignment: Alignment.centerLeft,
        padding: EdgeInsets.only(left: 18.w),
        child: const Icon(Icons.delete_outline, color: Colors.white),
      ),
      onDismissed: (_) => _drop(t),
      child: InkWell(
        onTap: () => _openAndReclaim(TagPageScreen(
          epc: t.epc,
          fallback: t.d.isEmpty ? null : t.d,
          reason: t.checked && !t.ok ? t.reasonText : null,
        )),
        child: Container(
          margin: EdgeInsets.only(bottom: 6.h),
          decoration: BoxDecoration(color: _kCard, border: Border(left: BorderSide(color: stripe, width: 4))),
          padding: EdgeInsets.symmetric(horizontal: 10.w, vertical: 8.h),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                t.product.isEmpty ? t.epc : t.product,
                style: TextStyle(fontSize: 13.5.sp, fontWeight: FontWeight.w700),
                overflow: TextOverflow.ellipsis,
              ),
              SizedBox(height: 2.h),
              Text(sub, style: TextStyle(fontSize: 12.sp, color: t.checked && !t.ok ? _kWarn : AppColors.textMuted)),
              if (t.product.isNotEmpty)
                Text(t.epc, style: TextStyle(fontSize: 11.sp, color: AppColors.textMuted, fontFamily: 'monospace')),
            ],
          ),
        ),
      ),
    );
  }
}

/// Read-only list of the LIVE tags in a zone (pull to refresh); tap → tag page.
class _ZoneContentsScreen extends StatefulWidget {
  const _ZoneContentsScreen({required this.zone});
  final _Zone zone;

  @override
  State<_ZoneContentsScreen> createState() => _ZoneContentsScreenState();
}

String _when(Object? iso) {
  if (iso is! String || iso.isEmpty) return '—';
  final t = DateTime.tryParse(iso)?.toLocal();
  if (t == null) return '—';
  const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  final h = t.hour % 12 == 0 ? 12 : t.hour % 12;
  return '${m[t.month - 1]} ${t.day} $h:${t.minute.toString().padLeft(2, '0')} ${t.hour < 12 ? 'AM' : 'PM'}';
}

class _ZoneContentsScreenState extends State<_ZoneContentsScreen> {
  List<_Tag>? _rows;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => unawaited(_load()));
  }

  Future<void> _load() async {
    try {
      final rows = await context.read<WmsApiClient>().fetchZoneEpcs(widget.zone.id);
      if (!mounted) return;
      setState(() => _rows = rows.map((d) {
            final t = _Tag('${d['epc']}', null)..setCheck({'ok': true, 'details': d});
            return t;
          }).toList());
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  @override
  Widget build(BuildContext context) {
    final rows = _rows;
    return CarbonScaffold(
      pageTitle: widget.zone.name.toUpperCase(),
      body: SafeArea(
        child: RefreshIndicator(
          onRefresh: _load,
          child: rows == null
              ? ListView(children: [
                  Padding(padding: EdgeInsets.all(24.w), child: Text(_error ?? 'Loading…', textAlign: TextAlign.center)),
                ])
              : ListView.builder(
                  padding: EdgeInsets.all(12.w),
                  itemCount: rows.length + 1,
                  itemBuilder: (_, i) {
                    if (i == 0) {
                      return Padding(
                        padding: EdgeInsets.only(bottom: 8.h),
                        child: Text('${rows.length} LIVE tag(s) in ${widget.zone.name}',
                            style: TextStyle(fontWeight: FontWeight.w800, fontSize: 13.sp)),
                      );
                    }
                    final t = rows[i - 1];
                    return InkWell(
                      onTap: () => Navigator.push(
                        context,
                        MaterialPageRoute<void>(builder: (_) => TagPageScreen(epc: t.epc, fallback: t.d)),
                      ),
                      child: Container(
                        margin: EdgeInsets.only(bottom: 6.h),
                        color: _kCard,
                        padding: EdgeInsets.symmetric(horizontal: 10.w, vertical: 8.h),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(t.product.isEmpty ? t.epc : t.product,
                                style: TextStyle(fontWeight: FontWeight.w700, fontSize: 13.5.sp)),
                            Text(
                              'Bin ${t.bins} · since ${_when(t.d['zoneAssignedAt'])}${t.d['assignedBy'] != null ? ' · ${t.d['assignedBy']}' : ''}',
                              style: TextStyle(fontSize: 12.sp, color: AppColors.textMuted),
                            ),
                            Text(t.epc, style: TextStyle(fontSize: 11.sp, color: AppColors.textMuted, fontFamily: 'monospace')),
                          ],
                        ),
                      ),
                    );
                  },
                ),
        ),
      ),
    );
  }
}
