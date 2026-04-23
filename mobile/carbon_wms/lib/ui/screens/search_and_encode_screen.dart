import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/hardware/rfid_tag_read.dart';
import 'package:carbon_wms/hardware/rfid_vendor_channel.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/encode/encode_tag_result.dart';
import 'package:carbon_wms/services/epc/epc_codec.dart';
import 'package:carbon_wms/services/handheld_device_identity.dart';
import 'package:carbon_wms/services/mobile_settings_repository.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';
import 'package:carbon_wms/ui/widgets/tactical_bottom_bar.dart';

enum _TargetField { customSku, sku, barcode }

extension _TargetFieldLabel on _TargetField {
  String get label {
    switch (this) {
      case _TargetField.customSku:
        return 'Custom SKU';
      case _TargetField.sku:
        return 'SKU';
      case _TargetField.barcode:
        return 'Barcode';
    }
  }
}

class SearchAndEncodeScreen extends StatefulWidget {
  const SearchAndEncodeScreen({super.key});

  static const String routeName = '/search-and-encode';

  @override
  State<SearchAndEncodeScreen> createState() => _SearchAndEncodeScreenState();
}

class _SearchAndEncodeScreenState extends State<SearchAndEncodeScreen> {
  final _startCtrl = TextEditingController(text: '1');
  final _endCtrl = TextEditingController(text: '13');

  _TargetField _targetField = _TargetField.customSku;

  bool _running = false;
  int _powerDbm = 30;
  double _powerSlider = 1.0;
  int? _liveRssi;

  int _readCount = 0;
  int _encodedCount = 0;
  int _detectedCount = 0;

  final List<EncodeTagResult> _history = <EncodeTagResult>[];
  final Set<String> _seen = <String>{};

  RfidManager? _rfid;
  StreamSubscription<RfidTagRead>? _tagSub;
  String? _deviceId;
  String? _warehouseId;
  String? _configError;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted) return;
      context.read<RfidManager>().scanContext = 'RE_ENCODE';
      final settings = context.read<MobileSettingsRepository>();
      _powerDbm = settings.config.transferOutAntennaPower;
      _powerSlider = (_powerDbm.clamp(0, 30)) / 30.0;
      _deviceId = await HandheldDeviceIdentity.primaryDeviceIdForServer();
      _warehouseId = await _resolveWarehouseId();
      if (mounted) setState(() {});
    });
  }

  Future<String?> _resolveWarehouseId() async {
    try {
      final api = context.read<WmsApiClient>();
      final locs = await api.fetchSessionLocations();
      if (locs.isNotEmpty) return locs.first['code'];
    } catch (_) {
      /* offline or session expired — warehouseId stays null and uploads report it */
    }
    return null;
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _rfid ??= context.read<RfidManager>();
  }

  @override
  void dispose() {
    unawaited(_tagSub?.cancel());
    unawaited(_rfid?.stopLocateScanning());
    _startCtrl.dispose();
    _endCtrl.dispose();
    super.dispose();
  }

  int? get _positionStart => int.tryParse(_startCtrl.text.trim());
  int? get _positionEnd => int.tryParse(_endCtrl.text.trim());

  String? _validateConfig() {
    final s = _positionStart;
    final e = _positionEnd;
    if (s == null || e == null) return 'Positions must be integers';
    if (s <= 0 || e <= 0) return 'Positions must be greater than 0';
    if (s >= e) return 'Start must be less than End';
    return null;
  }

  Future<void> _onStartPressed() async {
    final err = _validateConfig();
    if (err != null) {
      setState(() => _configError = err);
      return;
    }
    setState(() => _configError = null);
    await _startScan();
  }

  Future<void> _startScan() async {
    if (_running) return;
    final m = _rfid;
    if (m == null) return;
    await RfidVendorChannel.setAntennaPowerDbm(_powerDbm);
    await _tagSub?.cancel();
    _tagSub = m.unifiedTagReads.listen(_onTagRead);
    try {
      await m.startLocateScanning();
    } catch (_) {
      /* fall through — simulated reads still dispatch through unifiedTagReads */
    }
    if (!mounted) return;
    setState(() => _running = true);
  }

  Future<void> _stopScan() async {
    await _tagSub?.cancel();
    _tagSub = null;
    await _rfid?.stopLocateScanning();
    if (!mounted) return;
    setState(() => _running = false);
  }

  void _onTagRead(RfidTagRead read) {
    final epc = read.epcHex24;
    if (epc.isEmpty) return;
    if (read.rssi != null) _liveRssi = read.rssi;
    if (!_seen.add(epc)) {
      // dedupe within session
      if (mounted) setState(() {});
      return;
    }
    setState(() => _readCount += 1);
    unawaited(_processTag(epc));
  }

  Future<void> _processTag(String epc) async {
    if (isCurrentFormat(epc)) {
      _pushHistory(EncodeTagResult(
        oldEpc: epc,
        status: EncodeStatus.alreadyNew,
        at: DateTime.now(),
      ));
      return;
    }

    final s = _positionStart;
    final e = _positionEnd;
    if (s == null || e == null || s <= 0 || e <= s || epc.length < e) {
      _pushHistory(EncodeTagResult(
        oldEpc: epc,
        status: EncodeStatus.tagIssue,
        at: DateTime.now(),
      ));
      return;
    }

    final customSku = extractCustomSku(epc, s, e);
    final card = EncodeTagResult(
      oldEpc: epc,
      customSku: customSku,
      status: EncodeStatus.detected,
      at: DateTime.now(),
    );
    _pushHistory(card);

    final api = context.read<WmsApiClient>();

    Map<String, dynamic>? item;
    try {
      item = await api.catalogItemByCustomSku(customSku);
    } catch (_) {
      item = null;
    }

    if (item == null) {
      _updateCard(card, (c) {
        c.status = EncodeStatus.notFound;
      });
      unawaited(_reportEvent(
        oldEpc: epc,
        customSku: customSku,
        status: 'not_found',
      ));
      return;
    }

    final systemId = _toInt(item['system_id']);
    final itemName = item['name']?.toString() ?? '';
    _updateCard(card, (c) {
      c.systemId = systemId;
      c.itemName = itemName;
      c.status = EncodeStatus.detected;
    });
    setState(() => _detectedCount += 1);

    if (systemId == null) {
      _updateCard(card, (c) => c.status = EncodeStatus.tagIssue);
      return;
    }

    int serial;
    try {
      serial = await api.nextRfidSerial(warehouseId: _warehouseId ?? '');
    } catch (_) {
      _updateCard(card, (c) => c.status = EncodeStatus.tagIssue);
      return;
    }

    final newEpc = buildEpc(systemId, serial);
    _updateCard(card, (c) {
      c.newEpc = newEpc;
      c.serial = serial;
    });

    bool written = false;
    try {
      written = await RfidVendorChannel.writeEpcTag(
        targetEpc: epc,
        newEpc: newEpc,
      );
    } catch (_) {
      written = false;
    }

    if (!written) {
      _updateCard(card, (c) => c.status = EncodeStatus.tagIssue);
      unawaited(_reportEvent(
        oldEpc: epc,
        newEpc: newEpc,
        systemId: systemId,
        serial: serial,
        customSku: customSku,
        status: 'write_failed',
      ));
      return;
    }

    _updateCard(card, (c) => c.status = EncodeStatus.encoded);
    setState(() => _encodedCount += 1);
    unawaited(_reportEvent(
      oldEpc: epc,
      newEpc: newEpc,
      systemId: systemId,
      serial: serial,
      customSku: customSku,
    ));
  }

  Future<void> _reportEvent({
    required String oldEpc,
    String? newEpc,
    int? systemId,
    int? serial,
    required String customSku,
    String? status,
  }) async {
    try {
      await context.read<WmsApiClient>().postRfidEncodeEvent(
            oldEpc: oldEpc,
            newEpc: newEpc,
            systemId: systemId,
            serial: serial,
            customSku: customSku,
            warehouseId: _warehouseId ?? '',
            deviceId: _deviceId ?? '',
            status: status,
          );
    } catch (_) {
      /* best-effort: server logs will reconcile from ingest; do not block UI */
    }
  }

  void _pushHistory(EncodeTagResult r) {
    if (!mounted) return;
    setState(() => _history.insert(0, r));
  }

  void _updateCard(EncodeTagResult card, void Function(EncodeTagResult) mutate) {
    if (!mounted) return;
    setState(() => mutate(card));
  }

  void _clearHistory() {
    setState(() {
      _history.clear();
      _seen.clear();
      _readCount = 0;
      _detectedCount = 0;
      _encodedCount = 0;
      _liveRssi = null;
    });
  }

  int? _toInt(Object? v) {
    if (v is int) return v;
    if (v is num) return v.toInt();
    if (v is String) return int.tryParse(v);
    return null;
  }

  // ── UI ────────────────────────────────────────────────────────────────────

  Widget _buildConfigPanel() {
    return Card(
      margin: EdgeInsets.fromLTRB(16.w, 12.h, 16.w, 4.h),
      child: Padding(
        padding: EdgeInsets.all(12.r),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            DropdownButtonFormField<_TargetField>(
              key: ValueKey(_targetField),
              initialValue: _targetField,
              decoration: const InputDecoration(labelText: 'Target Field'),
              items: _TargetField.values
                  .map((f) => DropdownMenuItem(value: f, child: Text(f.label)))
                  .toList(),
              onChanged: _running
                  ? null
                  : (v) {
                      if (v != null) setState(() => _targetField = v);
                    },
            ),
            SizedBox(height: 10.h),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _startCtrl,
                    keyboardType: TextInputType.number,
                    inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                    enabled: !_running,
                    decoration: const InputDecoration(
                      labelText: 'EPC Position Start',
                    ),
                    onChanged: (_) {
                      if (_configError != null) {
                        setState(() => _configError = null);
                      }
                    },
                  ),
                ),
                SizedBox(width: 10.w),
                Expanded(
                  child: TextField(
                    controller: _endCtrl,
                    keyboardType: TextInputType.number,
                    inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                    enabled: !_running,
                    decoration: const InputDecoration(
                      labelText: 'EPC Position End',
                    ),
                    onChanged: (_) {
                      if (_configError != null) {
                        setState(() => _configError = null);
                      }
                    },
                  ),
                ),
              ],
            ),
            if (_configError != null)
              Padding(
                padding: EdgeInsets.only(top: 8.h),
                child: Text(
                  _configError!,
                  style: TextStyle(
                    color: const Color(0xFFDC2626),
                    fontSize: 12.sp,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _buildEmptyState() {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onDoubleTap: _clearHistory,
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              'Encoding Mode',
              style: TextStyle(
                color: AppColors.primary,
                fontWeight: FontWeight.w800,
                fontSize: 16.sp,
                letterSpacing: 1.1,
              ),
            ),
            SizedBox(height: 6.h),
            Text(
              'Double tap to clear history',
              style: TextStyle(
                color: AppColors.textMuted,
                fontSize: 12.sp,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildCard(EncodeTagResult r) {
    final status = r.status;
    return Card(
      margin: EdgeInsets.symmetric(horizontal: 16.w, vertical: 4.h),
      child: Padding(
        padding: EdgeInsets.all(12.r),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              r.oldEpc,
              style: TextStyle(
                fontFamily: 'monospace',
                fontSize: 12.sp,
                fontWeight: FontWeight.w700,
                letterSpacing: 0.6,
              ),
            ),
            SizedBox(height: 4.h),
            if (r.systemId != null || (r.itemName ?? '').isNotEmpty)
              Text(
                '${r.systemId != null ? 'Item #${r.systemId} · ' : ''}${r.itemName ?? ''}',
                style: TextStyle(
                  fontSize: 12.sp,
                  color: AppColors.textMain,
                ),
              )
            else if (r.customSku != null)
              Text(
                'Custom SKU: ${r.customSku}',
                style: TextStyle(
                  fontSize: 12.sp,
                  color: AppColors.textMuted,
                ),
              ),
            if (r.serial != null)
              Padding(
                padding: EdgeInsets.only(top: 2.h),
                child: Text(
                  'Serial # ${r.serial}',
                  style: TextStyle(
                    fontSize: 11.sp,
                    color: AppColors.textMuted,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            SizedBox(height: 8.h),
            Align(
              alignment: Alignment.centerLeft,
              child: Container(
                padding: EdgeInsets.symmetric(horizontal: 10.w, vertical: 4.h),
                decoration: BoxDecoration(
                  color: status.chipColor,
                  borderRadius: BorderRadius.circular(999),
                ),
                child: Text(
                  status.label,
                  style: TextStyle(
                    color: Colors.white,
                    fontSize: 11.sp,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 0.8,
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildList() {
    if (_history.isEmpty) return _buildEmptyState();
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onDoubleTap: _clearHistory,
      child: ListView.builder(
        padding: EdgeInsets.symmetric(vertical: 4.h),
        itemCount: _history.length,
        itemBuilder: (_, i) => _buildCard(_history[i]),
      ),
    );
  }

  Widget _buildBottomBar() {
    return Material(
      color: AppColors.surface,
      elevation: 12,
      child: SafeArea(
        top: false,
        minimum: EdgeInsets.fromLTRB(12.w, 8.h, 12.w, 12.h),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                Text('Close',
                    style: TextStyle(
                        fontSize: 11.sp,
                        color: AppColors.textMuted,
                        fontWeight: FontWeight.w700)),
                Expanded(
                  child: Slider(
                    value: _powerSlider,
                    onChanged: _running
                        ? null
                        : (v) {
                            setState(() {
                              _powerSlider = v;
                              _powerDbm = (v * 30).round().clamp(1, 30);
                            });
                          },
                    activeColor: AppColors.primary,
                  ),
                ),
                Text('Far',
                    style: TextStyle(
                        fontSize: 11.sp,
                        color: AppColors.textMuted,
                        fontWeight: FontWeight.w700)),
              ],
            ),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text('$_powerDbm dBm',
                    style: TextStyle(
                        fontSize: 11.sp,
                        fontWeight: FontWeight.w800,
                        color: AppColors.textMain)),
                Text(
                  _liveRssi != null ? 'RSSI $_liveRssi dBm' : 'RSSI —',
                  style: TextStyle(
                      fontSize: 11.sp,
                      fontWeight: FontWeight.w800,
                      color: AppColors.textMuted),
                ),
              ],
            ),
            SizedBox(height: 8.h),
            Row(
              children: [
                Expanded(
                  child: _StatPill(
                    label: 'Read',
                    value: '$_readCount',
                  ),
                ),
                SizedBox(width: 8.w),
                Expanded(
                  child: _StatPill(
                    label: 'Encoded / Detected',
                    value: '$_encodedCount / $_detectedCount',
                  ),
                ),
              ],
            ),
            SizedBox(height: 10.h),
            _running
                ? TacticalSlateButton(
                    label: 'STOP',
                    onPressed: () => unawaited(_stopScan()),
                  )
                : TacticalEmeraldButton(
                    label: 'START',
                    onPressed: () => unawaited(_onStartPressed()),
                  ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return CarbonScaffold(
      pageTitle: 'Search and Encode',
      bottomBar: _buildBottomBar(),
      body: Column(
        children: [
          _buildConfigPanel(),
          Expanded(child: _buildList()),
        ],
      ),
    );
  }
}

class _StatPill extends StatelessWidget {
  const _StatPill({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: EdgeInsets.symmetric(horizontal: 10.w, vertical: 6.h),
      decoration: BoxDecoration(
        color: AppColors.background,
        borderRadius: BorderRadius.circular(8.r),
        border: Border.all(color: AppColors.border),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label,
              style: TextStyle(
                  fontSize: 10.sp,
                  color: AppColors.textMuted,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 0.6)),
          Text(value,
              style: TextStyle(
                  fontSize: 12.sp,
                  color: AppColors.textMain,
                  fontWeight: FontWeight.w900)),
        ],
      ),
    );
  }
}
