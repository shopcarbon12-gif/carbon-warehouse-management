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
    // RFID-only screen — kill the 2D imager so a stray trigger doesn't
    // fire it. Same hand-off pattern Status Change uses.
    unawaited(RfidVendorChannel.scannerDisableTriggerRelay());
    unawaited(RfidVendorChannel.close2dBarcode());
    unawaited(RfidVendorChannel.enableRfidFunctionMode());
    unawaited(RfidVendorChannel.setZebraTriggerModeRfid());

    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted) return;
      _rfid = context.read<RfidManager>();
      _rfid!.scanContext = 'CLOUD_GEIGER_BULK_FIND';
      _uhfSub = _rfid!.geigerTagReads.listen(_onUhfRead, onError: (_) {});

      await _hydrateSliderRange();
      await _rfid!.setSessionPowerOverrideDbm(_powerDbm);
      try {
        await RfidVendorChannel.setAntennaPowerDbm(_powerDbm);
      } catch (_) {}

      _triggerSub = RfidVendorChannel.hardwareTriggerStream().listen((event) {
        if (!mounted) return;
        if (event == 'down') {
          if (_scanning) {
            unawaited(_stopScan());
          } else {
            unawaited(_startScan());
          }
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
    unawaited(_triggerSub?.cancel());
    unawaited(RfidVendorChannel.stopChainwayInventory());
    unawaited(RfidVendorChannel.stopZebraInventory());
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
    if (!_seenEpcs.contains(epc)) return; // not in the dropped list — ignore
    if (_foundEpcs.add(epc)) {
      // First time we've heard this EPC during the bulk-find pass —
      // tick the success cue so the operator hears progress.
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

  Future<void> _enrich(List<String> epcs) async {
    try {
      final api = context.read<WmsApiClient>();
      final rows = await api.lookupEpcs(epcs);
      if (!mounted) return;
      final byEpc = <String, Map<String, dynamic>>{};
      for (final r in rows) {
        final e = (r['epc'] as String?)?.trim().toUpperCase();
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

  Future<void> _openGeiger(_GeigerItem item) async {
    await context.pushGuarded<void>(
      ScreenIds.locateTag,
      (_) => LocateTagScreen(
        targetEpc: item.epc,
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
                      child: FilledButton.icon(
                        onPressed:
                            (_loading || _uploading) ? null : _onRefresh,
                        icon: const Icon(Icons.refresh, size: 18),
                        label: Text(
                          'REFRESH',
                          style: GoogleFonts.spaceGrotesk(
                            fontSize: 14.sp,
                            fontWeight: FontWeight.w900,
                            letterSpacing: 1.6,
                          ),
                        ),
                        style: FilledButton.styleFrom(
                          backgroundColor: const Color(0xFF6A7575),
                          foregroundColor: Colors.white,
                          shape: const RoundedRectangleBorder(
                            borderRadius: BorderRadius.zero,
                          ),
                        ),
                      ),
                    ),
                  ),
                  SizedBox(width: 8.w),
                  Expanded(
                    flex: 2,
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
                          _uploading ? 'UPLOADING…' : 'UPLOAD CSV',
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
        return Dismissible(
          key: ValueKey<String>('geiger-${item.epc}'),
          direction: DismissDirection.endToStart,
          background: Container(
            alignment: Alignment.centerRight,
            padding: EdgeInsets.symmetric(horizontal: 18.w),
            color: _kTrashRed,
            child: Icon(Icons.delete_outline,
                color: Colors.white, size: 26.sp),
          ),
          onDismissed: (_) => _removeItem(item),
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
      itemName: s('name') ?? s('item_name'),
      color: s('color'),
      size: s('size'),
    );
  }
}

class _GeigerItemContainer extends StatelessWidget {
  const _GeigerItemContainer({
    required this.item,
    required this.found,
    required this.onGeigerTap,
  });

  final _GeigerItem item;
  final bool found;
  final VoidCallback onGeigerTap;

  String _primaryLine() {
    if (item.formulaOk && (item.sku ?? '').isNotEmpty) {
      return 'SKU: ${item.sku}';
    }
    return item.epc;
  }

  String _secondaryLine() {
    if (!item.formulaOk) return 'Foreign EPC / no Carbon prefix';
    final parts = <String>[
      if ((item.itemName ?? '').isNotEmpty) item.itemName!,
      if ((item.color ?? '').isNotEmpty) item.color!,
      if ((item.size ?? '').isNotEmpty) item.size!,
    ];
    if (parts.isEmpty) return 'Resolving…';
    return parts.join(' · ').toUpperCase();
  }

  @override
  Widget build(BuildContext context) {
    final cardBg = found ? _kCardFound : _kCardGrey;
    final stripe = found ? _kStripeFound : AppColors.primary;
    return Container(
      color: cardBg,
      child: IntrinsicHeight(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Container(width: 4, color: stripe),
            Expanded(
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
                        if (found) ...[
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
                  ],
                ),
              ),
            ),
            GestureDetector(
              onTap: onGeigerTap,
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
