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
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart' show CarbonScaffold;

/// Zone Management (owner, 2026-10-16) — Bin Management → Zone Management.
///
/// Pick a zone (e.g. "Store"), pull the trigger and walk: every tag the sled
/// reads is checked against the WMS and listed — product, size, colour, bin
/// and current zone. ASSIGN puts the LIVE tags of this location in the zone;
/// REMOVE takes them out. Bins never change. Tags that can't be assigned
/// (not LIVE, another location, not in the WMS, not a Carbon tag,
/// damaged-chip read, re-encoded old number) are listed with the reason; tap
/// any row for everything the WMS knows about that tag.
///
/// One zone per tag (assigning moves it from another zone); a zone clears by
/// itself when the tag is sold, moves location or stops being LIVE.
class ZoneManagementScreen extends StatefulWidget {
  const ZoneManagementScreen({super.key});

  @override
  State<ZoneManagementScreen> createState() => _ZoneManagementScreenState();
}

const Color _kOk = Color(0xFF16A34A);
const Color _kWarn = Color(0xFFB45309);
const Color _kCard = Color(0xFFECECEC);

class _Zone {
  const _Zone(this.id, this.name, this.count);
  final String id;
  final String name;
  final int count;
}

class _Tag {
  _Tag(this.epc);
  final String epc;
  Map<String, dynamic>? check; // null = still being checked
  bool get checked => check != null;
  bool get ok => check?['ok'] == true;
  Map<String, dynamic> get d =>
      (check?['details'] is Map) ? Map<String, dynamic>.from(check!['details'] as Map) : const {};
  String? get zoneId => d['zoneId'] as String?;
  String? get zone => d['zone'] as String?;
  String? get reasonText => check?['reasonText'] as String?;
}

String _when(Object? iso) {
  if (iso is! String || iso.isEmpty) return '—';
  final t = DateTime.tryParse(iso)?.toLocal();
  if (t == null) return '—';
  const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  final h = t.hour % 12 == 0 ? 12 : t.hour % 12;
  return '${m[t.month - 1]} ${t.day} $h:${t.minute.toString().padLeft(2, '0')} ${t.hour < 12 ? 'AM' : 'PM'}';
}

String _bins(Map<String, dynamic> d) {
  final bin = d['bin'] as String?;
  final extra = (d['extraBins'] is List) ? (d['extraBins'] as List).map((e) => '$e').toList() : <String>[];
  if (bin == null || bin.isEmpty) return extra.isEmpty ? '—' : extra.join(', ');
  return extra.isEmpty ? bin : '$bin (+ ${extra.join(', ')})';
}

String _product(Map<String, dynamic> d) =>
    [d['product'], d['color'], d['size']].where((v) => v != null && '$v'.isNotEmpty).join(' · ');

class _ZoneManagementScreenState extends State<ZoneManagementScreen> {
  List<_Zone> _zones = const [];
  bool _canManage = false;
  String? _zoneId;
  bool _removeMode = false;
  bool _busy = false;
  String? _message;

  final Map<String, _Tag> _tags = <String, _Tag>{};
  final List<String> _order = <String>[];
  final Set<String> _pending = <String>{};
  Timer? _checkTimer;
  bool _checking = false;

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
  Timer? _powerApplyTimer;
  int _minDbm = 1;
  int _maxDbm = 30;
  int _powerDbm = 23;

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
  }

  @override
  void initState() {
    super.initState();
    unawaited(ScanSounds.instance.init());
    // One beep per NEW tag (paced), not the native per-read beep.
    unawaited(ScanSounds.instance.setTagBeepSuppressed(true));
    unawaited(RfidVendorChannel.scannerDisableTriggerRelay());
    unawaited(RfidVendorChannel.close2dBarcode());
    unawaited(RfidVendorChannel.enableRfidFunctionMode());
    unawaited(RfidVendorChannel.setZebraTriggerModeRfid());
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _rfid = context.read<RfidManager>();
      // Raw reads only — nothing is ingested or changed by reading.
      _rfid!.scanContext = 'GEIGER_FIND';
      _triggerSub = hardwareTriggerFor(this).listen(_onTrigger, onError: (_) {});
      _vendorSub = RfidVendorChannel.tagReadStream().listen(_onUhfRead, onError: (_) {});
      _radioReady = _initRadio();
      unawaited(_loadZones());
    });
  }

  @override
  void dispose() {
    _lifecycleRfid?.lifecycleStopTick.removeListener(_onLifecycleStop);
    _checkTimer?.cancel();
    _powerApplyTimer?.cancel();
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

  Future<void> _initRadio() async {
    final range = await RfidVendorChannel.getPowerRangeDbm();
    if (!mounted) return;
    if (range != null) {
      setState(() {
        _minDbm = range.minDbm;
        _maxDbm = range.maxDbm;
        _powerDbm = range.maxDbm;
      });
    }
    await _applyRadioSetup();
  }

  Future<void> _applyRadioSetup() async {
    unawaited(ScanSounds.instance.setTagBeepSuppressed(true));
    _rfid?.scanContext = 'GEIGER_FIND';
    await RfidVendorChannel.setEpcInventoryFilter(null);
    // Quiet mode: a tag already read stays silent while powered, so a crowded
    // rack doesn't keep re-reading the same tags.
    await RfidVendorChannel.setQuietInventory(true);
    await _rfid?.setSessionPowerOverrideDbm(_powerDbm);
    try {
      await RfidVendorChannel.setAntennaPowerDbm(_powerDbm);
    } catch (_) {}
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

  // ── Scanning ──────────────────────────────────────────────────────────────

  void _onTrigger(String event) {
    if (!mounted || event != 'down') return;
    if (_scanning) {
      unawaited(_stopScan());
    } else {
      unawaited(_startScan());
    }
  }

  Future<void> _startScan() async {
    if (_scanning || (_rfid?.isBackgrounded ?? false)) return;
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
  }

  void _setPower(int dbm) {
    final v = dbm.clamp(_minDbm, _maxDbm);
    if (v == _powerDbm) return;
    setState(() => _powerDbm = v);
    _powerApplyTimer?.cancel();
    _powerApplyTimer = Timer(const Duration(milliseconds: 180), () async {
      if (!mounted) return;
      await _rfid?.setSessionPowerOverrideDbm(v);
      try {
        await RfidVendorChannel.setAntennaPowerDbm(v);
      } catch (_) {}
    });
  }

  void _onUhfRead(RfidTagRead read) {
    if (!mounted || !_scanning) return;
    final epc = read.epcHex24.toUpperCase();
    if (epc.length != 24 || _tags.containsKey(epc)) return;
    _tags[epc] = _Tag(epc);
    _order.insert(0, epc);
    _pending.add(epc);
    _beeper.request();
    _checkTimer ??= Timer(const Duration(milliseconds: 600), _flushChecks);
    setState(() {});
  }

  /// Checks newly read tags in batches (product, bin, current zone, or why
  /// it can't be assigned).
  Future<void> _flushChecks() async {
    _checkTimer = null;
    if (_checking || _pending.isEmpty || !mounted) return;
    _checking = true;
    final batch = _pending.take(400).toList();
    _pending.removeAll(batch);
    try {
      final rows = await context.read<WmsApiClient>().checkZoneEpcs(batch);
      if (!mounted) return;
      for (final r in rows) {
        final t = _tags[('${r['epc']}').toUpperCase()];
        if (t != null) t.check = r;
      }
      setState(() {});
    } catch (_) {
      _pending.addAll(batch); // retry on the next flush
    } finally {
      _checking = false;
      if (_pending.isNotEmpty && mounted) {
        _checkTimer ??= Timer(const Duration(milliseconds: 900), _flushChecks);
      }
    }
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  List<_Tag> get _all => _order.map((e) => _tags[e]!).toList();

  /// ASSIGN: LIVE tags here not already in this zone. REMOVE: tags in this zone.
  List<_Tag> get _actionable => _all.where((t) {
        if (!t.ok) return false;
        return _removeMode ? t.zoneId == _zoneId : t.zoneId != _zoneId;
      }).toList();

  List<_Tag> get _cannot => _all.where((t) => t.checked && !t.ok).toList();

  Future<void> _run() async {
    final zone = _zone;
    final list = _actionable.map((t) => t.epc).toList();
    if (zone == null || list.isEmpty || _busy) return;
    final perms = context.read<MobilePermissions>();
    final api = context.read<WmsApiClient>();
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
    try {
      if (_removeMode) {
        final j = await api.removeEpcsFromZone(list, zoneId: zone.id);
        _message = 'Removed ${j['removed'] ?? 0} tag(s) from ${zone.name}.';
      } else {
        final j = await api.assignEpcsToZone(zone.id, list);
        final done = ((j['assigned'] as num?)?.toInt() ?? 0) + ((j['moved'] as num?)?.toInt() ?? 0);
        final moved = (j['moved'] as num?)?.toInt() ?? 0;
        final skipped = (j['skipped'] is List) ? (j['skipped'] as List).length : 0;
        _message = '$done assigned to ${zone.name}'
            '${moved > 0 ? ' ($moved moved from another zone)' : ''}'
            '${skipped > 0 ? ' · $skipped couldn\'t be assigned' : ''}.';
        try {
          ScanSounds.instance.play(ScanCue.success);
        } catch (_) {}
      }
      // Re-check what changed so every row shows its new zone.
      final rows = await api.checkZoneEpcs(list);
      for (final r in rows) {
        final t = _tags[('${r['epc']}').toUpperCase()];
        if (t != null) t.check = r;
      }
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
      _order.clear();
      _pending.clear();
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

  Future<void> _openZone() async {
    final zone = _zone;
    if (zone == null) return;
    if (_scanning) await _stopScan();
    if (!mounted) return;
    await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => _ZoneContentsScreen(zone: zone)));
    if (!mounted) return;
    await coveringRouteGone(_route);
    if (!mounted) return;
    _radioReady = _applyRadioSetup();
    unawaited(_loadZones());
  }

  void _showTag(_Tag t) {
    final d = t.d;
    final rows = <List<String>>[
      if (!t.ok && t.reasonText != null) ['Why not', t.reasonText!],
      ['EPC', t.epc],
      ['Serial', '${d['serial'] ?? '—'}'],
      ['Product', _product(d).isEmpty ? '—' : _product(d)],
      ['SKU', '${d['sku'] ?? '—'}'],
      ['Price', d['retailPrice'] == null ? '—' : '\$${d['retailPrice']}'],
      ['Status', '${d['statusLabel'] ?? 'Not in WMS'}'],
      ['Bin', _bins(d)],
      ['Location', '${d['location'] ?? '—'}'],
      ['Zone', '${d['zone'] ?? '—'}${d['zoneAssignedAt'] != null ? ' (since ${_when(d['zoneAssignedAt'])})' : ''}'],
      ['Last seen', '${_when(d['lastSeenAt'])}${d['lastSeenReaderZone'] != null ? ' · ${d['lastSeenReaderZone']} reader' : ''}'],
      ['First seen', _when(d['firstSeenAt'])],
      ['Source', '${d['source'] ?? '—'}'],
    ];
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (ctx) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          padding: EdgeInsets.fromLTRB(16.w, 0, 16.w, 16.h),
          children: [
            for (final r in rows)
              Padding(
                padding: EdgeInsets.symmetric(vertical: 4.h),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SizedBox(
                      width: 92.w,
                      child: Text(r[0], style: TextStyle(color: AppColors.textMuted, fontSize: 12.sp)),
                    ),
                    Expanded(
                      child: SelectableText(
                        r[1],
                        style: TextStyle(
                          fontSize: 13.sp,
                          fontWeight: r[0] == 'Why not' ? FontWeight.w700 : FontWeight.w500,
                          color: r[0] == 'Why not' ? _kWarn : AppColors.textMain,
                        ),
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

  // ── UI ────────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    final zone = _zone;
    final actionable = _actionable;
    final cannot = _cannot;
    final checking = _all.where((t) => !t.checked).length;
    return CarbonScaffold(
      pageTitle: 'ZONE MANAGEMENT',
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (_busy) const LinearProgressIndicator(minHeight: 2),
            Padding(
              padding: EdgeInsets.fromLTRB(16.w, 12.h, 16.w, 4.h),
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
                    onPressed: zone == null ? null : _openZone,
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
              child: SegmentedButton<bool>(
                segments: const [
                  ButtonSegment(value: false, label: Text('ASSIGN'), icon: Icon(Icons.add_location_alt_outlined)),
                  ButtonSegment(value: true, label: Text('REMOVE'), icon: Icon(Icons.wrong_location_outlined)),
                ],
                selected: {_removeMode},
                onSelectionChanged: (s) => setState(() => _removeMode = s.first),
              ),
            ),
            Padding(
              padding: EdgeInsets.fromLTRB(16.w, 2.h, 16.w, 0),
              child: Row(
                children: [
                  Text('Power', style: TextStyle(fontSize: 12.sp, color: AppColors.textMuted)),
                  Expanded(
                    child: Slider(
                      value: _powerDbm.toDouble().clamp(_minDbm.toDouble(), _maxDbm.toDouble()),
                      min: _minDbm.toDouble(),
                      max: _maxDbm.toDouble(),
                      divisions: (_maxDbm - _minDbm).clamp(1, 40),
                      label: '$_powerDbm dBm',
                      onChanged: (v) => _setPower(v.round()),
                    ),
                  ),
                  Text('$_powerDbm dBm', style: GoogleFonts.spaceGrotesk(fontSize: 13.sp, fontWeight: FontWeight.w700)),
                ],
              ),
            ),
            Padding(
              padding: EdgeInsets.fromLTRB(16.w, 0, 16.w, 6.h),
              child: Text(
                '${_order.length} read · ${actionable.length} ${_removeMode ? 'in this zone' : 'ready'}'
                ' · ${cannot.length} can\'t be assigned${checking > 0 ? ' · $checking checking…' : ''}',
                style: TextStyle(fontSize: 12.sp, color: AppColors.textMuted),
              ),
            ),
            Expanded(
              child: _order.isEmpty
                  ? Center(
                      child: Padding(
                        padding: EdgeInsets.all(24.w),
                        child: Text(
                          _scanning ? 'Scanning… walk past the tags.' : 'Pull the trigger to read tags.',
                          textAlign: TextAlign.center,
                          style: TextStyle(color: AppColors.textMuted, fontSize: 14.sp),
                        ),
                      ),
                    )
                  : ListView(
                      padding: EdgeInsets.symmetric(horizontal: 12.w),
                      children: [
                        if (cannot.isNotEmpty) _sectionHeader('Couldn\'t assign (${cannot.length}) — tap for details', _kWarn),
                        for (final t in cannot) _tagRow(t),
                        _sectionHeader(_removeMode ? 'Read tags' : 'Read tags (LIVE here)', AppColors.textMuted),
                        for (final t in _all.where((t) => !t.checked || t.ok)) _tagRow(t),
                      ],
                    ),
            ),
            if (_message != null)
              Padding(
                padding: EdgeInsets.fromLTRB(16.w, 6.h, 16.w, 0),
                child: Text(_message!, style: TextStyle(fontSize: 12.5.sp, fontWeight: FontWeight.w600)),
              ),
            Padding(
              padding: EdgeInsets.fromLTRB(12.w, 8.h, 12.w, 12.h),
              child: Row(
                children: [
                  OutlinedButton(
                    onPressed: _order.isEmpty || _busy ? null : _clear,
                    style: OutlinedButton.styleFrom(
                      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
                      minimumSize: Size(0, 48.h),
                    ),
                    child: const Text('CLEAR'),
                  ),
                  SizedBox(width: 8.w),
                  Expanded(
                    child: FilledButton(
                      onPressed: zone == null || actionable.isEmpty || _busy ? null : _run,
                      style: FilledButton.styleFrom(
                        backgroundColor: _removeMode ? const Color(0xFFBF2E2E) : AppColors.primary,
                        shape: const RoundedRectangleBorder(borderRadius: BorderRadius.zero),
                        minimumSize: Size(0, 48.h),
                      ),
                      child: Text(
                        zone == null
                            ? 'PICK A ZONE'
                            : _removeMode
                                ? 'REMOVE ${actionable.length} FROM ${zone.name.toUpperCase()}'
                                : 'ASSIGN ${actionable.length} TO ${zone.name.toUpperCase()}',
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
                _scanning ? 'SCANNING — PULL TRIGGER TO STOP' : 'PULL TRIGGER TO SCAN',
                style: GoogleFonts.spaceGrotesk(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 13.sp),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _sectionHeader(String text, Color color) => Padding(
        padding: EdgeInsets.fromLTRB(4.w, 10.h, 4.w, 4.h),
        child: Text(text, style: TextStyle(fontSize: 12.sp, fontWeight: FontWeight.w800, color: color)),
      );

  Widget _tagRow(_Tag t) {
    final d = t.d;
    final String sub;
    final Color stripe;
    if (!t.checked) {
      sub = 'Checking…';
      stripe = AppColors.border;
    } else if (!t.ok) {
      sub = t.reasonText ?? 'Can\'t be assigned';
      stripe = _kWarn;
    } else if (t.zoneId == _zoneId) {
      sub = 'Bin ${_bins(d)} · already in ${t.zone}';
      stripe = _removeMode ? const Color(0xFFBF2E2E) : _kOk;
    } else {
      sub = 'Bin ${_bins(d)}${t.zone != null ? ' · in ${t.zone}${_removeMode ? '' : ' → will move'}' : ''}';
      stripe = _removeMode ? AppColors.border : AppColors.primary;
    }
    return InkWell(
      onTap: t.checked ? () => _showTag(t) : null,
      child: Container(
        margin: EdgeInsets.only(bottom: 6.h),
        decoration: BoxDecoration(color: _kCard, border: Border(left: BorderSide(color: stripe, width: 4))),
        padding: EdgeInsets.symmetric(horizontal: 10.w, vertical: 8.h),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              _product(d).isEmpty ? t.epc : _product(d),
              style: TextStyle(fontSize: 13.5.sp, fontWeight: FontWeight.w700),
              overflow: TextOverflow.ellipsis,
            ),
            SizedBox(height: 2.h),
            Text(sub, style: TextStyle(fontSize: 12.sp, color: !t.ok && t.checked ? _kWarn : AppColors.textMuted)),
            if (_product(d).isNotEmpty)
              Text(t.epc, style: TextStyle(fontSize: 11.sp, color: AppColors.textMuted, fontFamily: 'monospace')),
          ],
        ),
      ),
    );
  }
}

/// Read-only list of the LIVE tags in a zone (pull to refresh).
class _ZoneContentsScreen extends StatefulWidget {
  const _ZoneContentsScreen({required this.zone});
  final _Zone zone;

  @override
  State<_ZoneContentsScreen> createState() => _ZoneContentsScreenState();
}

class _ZoneContentsScreenState extends State<_ZoneContentsScreen> {
  List<Map<String, dynamic>>? _rows;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => unawaited(_load()));
  }

  Future<void> _load() async {
    try {
      final rows = await context.read<WmsApiClient>().fetchZoneEpcs(widget.zone.id);
      if (mounted) setState(() => _rows = rows);
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
                  Padding(
                    padding: EdgeInsets.all(24.w),
                    child: Text(_error ?? 'Loading…', textAlign: TextAlign.center),
                  ),
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
                    final d = rows[i - 1];
                    return Container(
                      margin: EdgeInsets.only(bottom: 6.h),
                      color: _kCard,
                      padding: EdgeInsets.symmetric(horizontal: 10.w, vertical: 8.h),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(_product(d).isEmpty ? '${d['epc']}' : _product(d),
                              style: TextStyle(fontWeight: FontWeight.w700, fontSize: 13.5.sp)),
                          Text(
                            'Bin ${_bins(d)} · since ${_when(d['zoneAssignedAt'])}${d['assignedBy'] != null ? ' · ${d['assignedBy']}' : ''}',
                            style: TextStyle(fontSize: 12.sp, color: AppColors.textMuted),
                          ),
                          Text('${d['epc']}', style: TextStyle(fontSize: 11.sp, color: AppColors.textMuted, fontFamily: 'monospace')),
                        ],
                      ),
                    );
                  },
                ),
        ),
      ),
    );
  }
}
