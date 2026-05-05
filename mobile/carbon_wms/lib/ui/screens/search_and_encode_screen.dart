import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/hardware/rfid_manager.dart';
import 'package:carbon_wms/hardware/rfid_tag_read.dart';
import 'package:carbon_wms/hardware/rfid_vendor_channel.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/encode/encode_csv.dart';
import 'package:carbon_wms/services/encode/encode_tag_result.dart';
import 'package:carbon_wms/services/epc/epc_codec.dart';
import 'package:carbon_wms/services/handheld_device_identity.dart';
import 'package:carbon_wms/services/mobile_settings_repository.dart';
import 'package:carbon_wms/services/scan_sounds.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';
import 'package:carbon_wms/ui/widgets/rfid_power_slider.dart';

enum _TargetField { customSku, sku, barcode }

extension _TargetFieldLabel on _TargetField {
  String get label {
    switch (this) {
      case _TargetField.customSku: return 'Custom SKU';
      case _TargetField.sku:        return 'SKU';
      case _TargetField.barcode:    return 'Barcode';
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
  static const Duration _kPopupDuration = Duration(seconds: 10);

  _TargetField _targetField = _TargetField.customSku;
  int _positionStart = 1;
  int _positionEnd = 13;
  int _powerDbm = 30;

  bool _running = false;
  bool _paused = false;
  int? _liveRssi;

  int _readCount = 0;
  int _encodedCount = 0;
  int _detectedCount = 0;

  final List<EncodeTagResult> _history = <EncodeTagResult>[];
  final Set<String> _seen = <String>{};

  RfidManager? _rfid;
  StreamSubscription<RfidTagRead>? _directTagSub;
  StreamSubscription<String>? _barcodeSub;
  StreamSubscription<String>? _triggerSub;

  final ScanSounds _sounds = ScanSounds.instance;
  String? _deviceId;
  String? _warehouseId;

  bool _uploading = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted) return;
      context.read<RfidManager>().scanContext = 'RE_ENCODE';
      final settings = context.read<MobileSettingsRepository>();
      // Re-encode default — operator preference, 1.2.42: enter the screen
      // at 23 dBm regardless of where the global slider was. Writes need
      // close range and high power; 23 dBm is the Chainway firmware cap
      // and a sensible Zebra default for re-encoding. The shared
      // RfidPowerSlider reads from settings.config.transferOutAntennaPower,
      // so calling setGlobalAntennaPower(23) here also moves the slider
      // and live-pushes the new value to the radio in one tick. Operator
      // can still drag the slider after entry — no save button by design.
      const reEncodePowerDbm = 23;
      await settings.setGlobalAntennaPower(reEncodePowerDbm);
      _powerDbm = reEncodePowerDbm;
      _deviceId = await HandheldDeviceIdentity.primaryDeviceIdForServer();
      unawaited(_sounds.init());
      await _resolveWarehouse();
      await _ensureScannerReady();
      if (mounted) setState(() {});
    });
  }

  Future<void> _resolveWarehouse() async {
    try {
      final api = context.read<WmsApiClient>();
      final locs = await api
          .fetchSessionLocations()
          .timeout(const Duration(seconds: 6), onTimeout: () => []);
      if (!mounted || locs.isEmpty) return;
      final code = (locs.first['code'] ?? '').trim();
      if (code.isNotEmpty) _warehouseId = code;
    } catch (_) {/* best-effort */}
  }

  // Wire all three input streams (direct vendor reads, broadcast barcode EPC, physical trigger)
  // exactly once on first frame — BEFORE the user touches START. That way pulling the trigger
  // on entry can initiate a scan, and the vendor stack is already warm.
  Future<void> _ensureScannerReady() async {
    await RfidVendorChannel.scannerDisableTriggerRelay();
    await RfidVendorChannel.close2dBarcode();
    await RfidVendorChannel.enableRfidFunctionMode();
    // RFD8500: route the physical trigger to UHF (no-op if Zebra reader not connected).
    await RfidVendorChannel.setZebraTriggerModeRfid();
    await RfidVendorChannel.setAntennaPowerDbm(_powerDbm);

    await _directTagSub?.cancel();
    _directTagSub = RfidVendorChannel.tagReadStream().listen(
      _onTagRead,
      onError: (_) {},
    );

    await _barcodeSub?.cancel();
    _barcodeSub = RfidVendorChannel.hardwareBarcodeStream().listen((raw) {
      final epc = _extractEpcFromBarcode(raw);
      if (epc == null) return;
      _onTagRead(RfidTagRead(epcHex24: epc));
    }, onError: (_) {});

    await _triggerSub?.cancel();
    _triggerSub = RfidVendorChannel.hardwareTriggerStream().listen((event) {
      if (event == 'down') unawaited(_toggleScan());
    }, onError: (_) {});
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _rfid ??= context.read<RfidManager>();
  }

  @override
  void dispose() {
    unawaited(_directTagSub?.cancel());
    unawaited(_barcodeSub?.cancel());
    unawaited(_triggerSub?.cancel());
    unawaited(_rfid?.stopLocateScanning());
    _sounds.stopAll();
    // Reopen the 2D engine for the next screen, but don't pre-enable the
    // trigger relay — Bin Assign / Fast Putaway own their own setup, and
    // pre-enabling it here lit the 2D laser on the next RFID-only screen's
    // first trigger pull (before its postFrameCallback could disable it).
    unawaited(RfidVendorChannel.open2dBarcode());
    super.dispose();
  }

  // ── Module settings modal ────────────────────────────────────────────────

  Future<void> _openModuleSettings() async {
    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: Colors.white,
      isScrollControlled: true,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(8.r)),
      ),
      builder: (ctx) {
        return StatefulBuilder(
          builder: (ctx, setM) {
            final isRunning = _running;
            return Padding(
              padding: EdgeInsets.fromLTRB(
                20.w, 16.h, 20.w,
                MediaQuery.of(ctx).viewInsets.bottom + 16.h,
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    'ENCODE SETTINGS',
                    style: GoogleFonts.spaceGrotesk(
                      fontSize: 13.sp, fontWeight: FontWeight.w700,
                      letterSpacing: 2.4, color: AppColors.primary,
                    ),
                  ),
                  SizedBox(height: 12.h),
                  DropdownButtonFormField<_TargetField>(
                    initialValue: _targetField,
                    decoration: const InputDecoration(labelText: 'Target Field'),
                    items: _TargetField.values
                        .map((f) => DropdownMenuItem(value: f, child: Text(f.label)))
                        .toList(),
                    onChanged: isRunning ? null : (v) {
                      if (v == null) return;
                      setM(() {});
                      setState(() => _targetField = v);
                    },
                  ),
                  SizedBox(height: 10.h),
                  Row(children: [
                    Expanded(child: TextFormField(
                      initialValue: '$_positionStart',
                      keyboardType: TextInputType.number,
                      inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                      enabled: !isRunning,
                      decoration: const InputDecoration(labelText: 'Position Start'),
                      onChanged: (v) {
                        final n = int.tryParse(v.trim()) ?? _positionStart;
                        setState(() => _positionStart = n);
                      },
                    )),
                    SizedBox(width: 10.w),
                    Expanded(child: TextFormField(
                      initialValue: '$_positionEnd',
                      keyboardType: TextInputType.number,
                      inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                      enabled: !isRunning,
                      decoration: const InputDecoration(labelText: 'Position End'),
                      onChanged: (v) {
                        final n = int.tryParse(v.trim()) ?? _positionEnd;
                        setState(() => _positionEnd = n);
                      },
                    )),
                  ]),
                  SizedBox(height: 14.h),
                  Text(
                    'RFID Power: $_powerDbm dBm',
                    style: GoogleFonts.manrope(
                      fontSize: 12.sp, fontWeight: FontWeight.w700,
                      color: AppColors.textMuted,
                    ),
                  ),
                  Slider(
                    value: _powerDbm.clamp(1, 30).toDouble(),
                    min: 1, max: 30, divisions: 29,
                    onChanged: isRunning ? null : (v) {
                      final n = v.round();
                      setM(() {});
                      setState(() => _powerDbm = n);
                      unawaited(RfidVendorChannel.setAntennaPowerDbm(n));
                    },
                    activeColor: AppColors.primary,
                  ),
                  if (_liveRssi != null)
                    Padding(
                      padding: EdgeInsets.only(top: 4.h),
                      child: Text(
                        'Last RSSI: $_liveRssi dBm',
                        style: GoogleFonts.manrope(
                          fontSize: 11.sp, color: AppColors.textMuted,
                        ),
                      ),
                    ),
                ],
              ),
            );
          },
        );
      },
    );
  }

  // ── Scan control ──────────────────────────────────────────────────────────

  String? _validateConfig() {
    if (_positionStart <= 0 || _positionEnd <= 0) return 'Positions must be > 0';
    if (_positionStart >= _positionEnd) return 'Start must be less than End';
    return null;
  }

  Future<void> _toggleScan() async {
    if (_running) {
      await _stopScan();
      return;
    }
    final err = _validateConfig();
    if (err != null) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(err)));
      return;
    }
    await _startScan();
  }

  Future<void> _startScan() async {
    if (_running) return;
    final m = _rfid;
    if (m == null) return;
    await RfidVendorChannel.setAntennaPowerDbm(_powerDbm);
    try {
      await m.startLocateScanning();
    } catch (_) {/* simulated reads still deliver via broadcast */}
    if (!mounted) return;
    setState(() => _running = true);
    _sounds.play(ScanCue.start);
  }

  Future<void> _stopScan() async {
    // Re-Encode doesn't play per-tag read beeps — there's nothing to silence, so we
    // skip the stopAll() the Count screen uses. stopAll() resets every non-read
    // audioplayers instance to Idle; on some Android builds (Samsung S25) that
    // makes the immediately-following play(ScanCue.stop) a silent no-op because
    // the player needs setSource() again to leave Idle. Skipping stopAll here lets
    // start/stop/success/error all fire cleanly.
    await _rfid?.stopLocateScanning();
    if (!mounted) return;
    setState(() => _running = false);
    _sounds.play(ScanCue.stop);
  }

  Future<void> _pauseForPopup() async {
    _paused = true;
    // No stopAll here: Re-Encode doesn't beep per tag, so there are no queued
    // read clicks to silence. Calling stopAll() was also killing the error
    // player's internal state and swallowing the subsequent play(error) call.
    await _rfid?.pauseScanning();
  }

  Future<void> _resumeAfterPopup() async {
    if (!_running) {
      _paused = false;
      return;
    }
    try {
      await _rfid?.startLocateScanning();
    } catch (_) {/* ignore */}
    _paused = false;
  }

  // ── Incoming reads ────────────────────────────────────────────────────────

  void _onTagRead(RfidTagRead read) {
    if (!_running || _paused) return;
    final epc = read.epcHex24;
    if (epc.isEmpty) return;
    if (read.rssi != null) _liveRssi = read.rssi;
    if (!_seen.add(epc)) {
      // Duplicate sighting — no UI change needed, skip the rebuild entirely.
      return;
    }
    setState(() => _readCount += 1);
    // Re-Encode screen is intentionally silent per-EPC; only start/stop/success/error
    // cues play here. Count still beeps per tag.
    unawaited(_processTag(epc));
  }

  Future<void> _processTag(String epc) async {
    final cfg = context.read<MobileSettingsRepository>().epcConfig;
    if (isCurrentFormat(epc, cfg)) {
      final systemId = decodeSystemId(epc, cfg);
      final serial = decodeSerial(epc, cfg);
      final card = EncodeTagResult(
        oldEpc: epc,
        newEpc: epc,
        systemId: systemId,
        serial: serial,
        status: EncodeStatus.alreadyNew,
        at: DateTime.now(),
      );
      _pushHistory(card);
      if (systemId != null) {
        final ours = await _lookupItemBySystemId(systemId);
        if (ours != null) {
          _updateCard(card, (c) {
            c.itemName = (ours['name'] as String?) ?? '';
            c.customSku = (ours['custom_sku'] as String?) ?? '';
            c.status = EncodeStatus.alreadyNew;
            c.failureReason = EncodeFailureReason.none;
          });
          return;
        }
      }
      _updateCard(card, (c) {
        c.status = EncodeStatus.foreignCurrent;
        c.failureReason = EncodeFailureReason.foreignEpc;
      });
      await _openForeignTagPopup(card);
      return;
    }

    if (epc.length < _positionEnd) {
      final card = EncodeTagResult(
        oldEpc: epc,
        status: EncodeStatus.tagIssue,
        failureReason: EncodeFailureReason.configInvalid,
        at: DateTime.now(),
      );
      _pushHistory(card);
      await _openForeignTagPopup(card);
      return;
    }

    final customSku = extractCustomSku(epc, _positionStart, _positionEnd);
    final card = EncodeTagResult(
      oldEpc: epc,
      customSku: customSku,
      status: EncodeStatus.detected,
      at: DateTime.now(),
    );
    _pushHistory(card);

    final api = context.read<WmsApiClient>();

    if (kDebugMode) {
      // ignore: avoid_print
      print('[SearchEncode] legacy epc=$epc pos=[$_positionStart..$_positionEnd] sku=$customSku warehouse=$_warehouseId');
    }

    Map<String, dynamic>? item;
    try {
      item = await api.catalogItemByCustomSku(customSku);
      if (kDebugMode) {
        // ignore: avoid_print
        print('[SearchEncode] catalog lookup sku=$customSku -> ${item == null ? "NULL" : "hit system_id=${item['system_id']} name=${item['name']}"}');
      }
    } catch (e) {
      if (kDebugMode) {
        // ignore: avoid_print
        print('[SearchEncode] catalog lookup sku=$customSku THREW: $e');
      }
      item = null;
    }

    if (item == null) {
      _updateCard(card, (c) {
        c.status = EncodeStatus.notFound;
        c.failureReason = EncodeFailureReason.notInCatalog;
      });
      unawaited(_reportEvent(oldEpc: epc, customSku: customSku, status: 'not_found'));
      await _openForeignTagPopup(card);
      return;
    }

    final customSkuId = item['id']?.toString() ?? '';
    final systemId = _toInt(item['system_id']);
    final itemName = item['name']?.toString() ?? '';
    _updateCard(card, (c) {
      c.systemId = systemId;
      c.itemName = itemName;
      c.status = EncodeStatus.detected;
    });
    setState(() => _detectedCount += 1);

    if (systemId == null || customSkuId.isEmpty) {
      _updateCard(card, (c) {
        c.status = EncodeStatus.tagIssue;
        c.failureReason = EncodeFailureReason.badSystemId;
      });
      await _openForeignTagPopup(card);
      return;
    }

    // 1.2.42: re-encode now uses the same atomic /api/rfid/encode-claim
    // endpoint as the new Encode screen. Server allocates the next
    // serial under MAX(serial)+1 with a 100,001 floor for fresh SKUs,
    // INSERTs the items row, and kills the old EPC's row in one txn —
    // so re-encoded tags pick up at the right serial position and never
    // collide with anything Senitron-issued or commission-issued.
    //
    // Drops the legacy nextRfidSerial + client-side buildEpc combo
    // (per-warehouse counter, no atomic kill, no MAX+1 awareness).
    Map<String, dynamic> claim;
    try {
      claim = await api.postEncodeClaim(
        customSkuId: customSkuId,
        oldEpc: epc,
      );
    } catch (_) {
      _updateCard(card, (c) {
        c.status = EncodeStatus.tagIssue;
        c.failureReason = EncodeFailureReason.serialFetchFailed;
      });
      await _openForeignTagPopup(card);
      return;
    }
    final newEpc = (claim['epc'] as String?)?.toUpperCase() ?? '';
    final serial = (claim['serial'] as num?)?.toInt() ?? 0;
    if (newEpc.length != 24 || serial == 0) {
      _updateCard(card, (c) {
        c.status = EncodeStatus.tagIssue;
        c.failureReason = EncodeFailureReason.serialFetchFailed;
      });
      await _openForeignTagPopup(card);
      return;
    }
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
    } catch (_) { written = false; }

    if (!written) {
      _updateCard(card, (c) {
        c.status = EncodeStatus.tagIssue;
        c.failureReason = EncodeFailureReason.writeFailed;
      });
      unawaited(_reportEvent(
        oldEpc: epc, newEpc: newEpc, systemId: systemId, serial: serial,
        customSku: customSku, status: 'write_failed',
      ));
      await _openForeignTagPopup(card);
      return;
    }

    _updateCard(card, (c) {
      c.status = EncodeStatus.encoded;
      c.failureReason = EncodeFailureReason.none;
    });
    setState(() => _encodedCount += 1);
    _sounds.play(ScanCue.success);
    unawaited(_reportEvent(
      oldEpc: epc, newEpc: newEpc, systemId: systemId, serial: serial,
      customSku: customSku,
    ));
  }

  Future<Map<String, dynamic>?> _lookupItemBySystemId(int systemId) async {
    try {
      return await context
          .read<WmsApiClient>()
          .catalogLookupBySystemId(systemId.toString());
    } catch (_) { return null; }
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
    } catch (_) {/* best-effort */}
  }

  Future<void> _openForeignTagPopup(EncodeTagResult card) async {
    if (!mounted) return;
    await _pauseForPopup();
    if (!mounted) return;
    _sounds.play(ScanCue.error);
    final closedBy = await showDialog<String>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => _ForeignTagDialog(card: card, duration: _kPopupDuration),
    );
    if (kDebugMode) {
      // ignore: avoid_print
      print('[SearchEncode] popup closed by=$closedBy card=${card.oldEpc}');
    }
    await _resumeAfterPopup();
  }

  void _pushHistory(EncodeTagResult r) {
    if (!mounted) return;
    setState(() => _history.insert(0, r));
  }

  void _updateCard(EncodeTagResult card, void Function(EncodeTagResult) mutate) {
    if (!mounted) return;
    setState(() => mutate(card));
  }

  void _resetScreen() {
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

  String? _extractEpcFromBarcode(String raw) {
    final compact = raw.trim().toUpperCase().replaceAll(RegExp(r'\s+'), '');
    if (compact.isEmpty) return null;
    final exact = RegExp(r'^[0-9A-F]{8,}$').firstMatch(compact)?.group(0);
    if (exact != null) return exact;
    final m = RegExp(r'([0-9A-F]{8,})').allMatches(compact).toList();
    if (m.isEmpty) return null;
    m.sort((a, b) => (b.group(1)?.length ?? 0).compareTo(a.group(1)?.length ?? 0));
    return m.first.group(1);
  }

  // ── CSV upload ────────────────────────────────────────────────────────────

  Future<void> _uploadCsv() async {
    if (_history.isEmpty || _uploading) return;
    setState(() => _uploading = true);
    final messenger = ScaffoldMessenger.of(context);
    final api = context.read<WmsApiClient>();
    try {
      final csv = buildEncodeSessionCsv(_history.reversed);
      final deviceId =
          _deviceId ?? await HandheldDeviceIdentity.primaryDeviceIdForServer();
      await api.postInventoryUpload(
        deviceId: deviceId,
        mode: 're-encode',
        csvData: csv,
      );
      if (!mounted) return;
      messenger.showSnackBar(
        const SnackBar(
          duration: Duration(seconds: 4),
          content: Text('Uploaded. Admins: Reports → Uploads at wms.shopcarbon.com/reports/uploads'),
        ),
      );
    } catch (e) {
      if (!mounted) return;
      messenger.showSnackBar(SnackBar(content: Text('Upload failed: $e')));
    } finally {
      if (mounted) setState(() => _uploading = false);
    }
  }

  // ── UI ────────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final tileColor = isDark ? const Color(0xFF1C2828) : const Color(0xFFEEF4F3);
    final textColor = isDark ? const Color(0xFFE0ECEC) : AppColors.textMain;
    final summaryLabelColor = isDark ? const Color(0xFF5C6C6C) : const Color(0xFF3F4A4A);
    final watermarkColor = isDark ? const Color(0x66A0B3B3) : const Color(0x2995A5A7);
    const summaryBoxHeight = 60.0;

    return CarbonScaffold(
      pageTitle: 'encode',
      actions: [
        IconButton(
          icon: const Icon(Icons.settings_outlined),
          onPressed: _openModuleSettings,
        ),
      ],
      body: ColoredBox(
        color: Colors.white,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Three summary tiles directly under the AppBar (no location header).
            Padding(
              padding: EdgeInsets.fromLTRB(20.w, 12.h, 20.w, 0.h),
              child: LayoutBuilder(
                builder: (context, constraints) {
                  final tileWidth = (constraints.maxWidth - 16) / 3;
                  return Row(children: [
                    _SummaryTile(
                      label: 'Read', value: '$_readCount',
                      icon: Icons.sensors_outlined,
                      boxWidth: tileWidth, boxHeight: summaryBoxHeight,
                      tileColor: tileColor, textColor: textColor,
                      labelColor: summaryLabelColor, watermarkColor: watermarkColor,
                    ),
                    SizedBox(width: 8.w),
                    _SummaryTile(
                      label: 'Encoded', value: '$_encodedCount',
                      icon: Icons.check_circle_outline,
                      boxWidth: tileWidth, boxHeight: summaryBoxHeight,
                      tileColor: tileColor, textColor: textColor,
                      labelColor: summaryLabelColor, watermarkColor: watermarkColor,
                    ),
                    SizedBox(width: 8.w),
                    _SummaryTile(
                      label: 'Detected', value: '$_detectedCount',
                      icon: Icons.search_outlined,
                      boxWidth: tileWidth, boxHeight: summaryBoxHeight,
                      tileColor: tileColor, textColor: textColor,
                      labelColor: summaryLabelColor, watermarkColor: watermarkColor,
                    ),
                  ]);
                },
              ),
            ),
            SizedBox(height: 12.h),
            Expanded(
              child: Padding(
                padding: EdgeInsets.fromLTRB(20.w, 0.h, 20.w, 0.h),
                child: _history.isEmpty
                    ? Center(
                        child: Text(
                          'No tags scanned yet',
                          style: GoogleFonts.manrope(
                            fontSize: 14.sp, fontWeight: FontWeight.w700,
                            color: const Color(0xFF5A6464),
                          ),
                        ),
                      )
                    : ListView.separated(
                        padding: EdgeInsets.only(bottom: 12.h),
                        itemCount: _history.length,
                        separatorBuilder: (_, __) => SizedBox(height: 12.h),
                        itemBuilder: (_, i) {
                          final r = _history[i];
                          return _EncodeRow(
                            rowKey: 'enc-${r.oldEpc}-${r.at.millisecondsSinceEpoch}',
                            row: r,
                            onDelete: () {
                              setState(() {
                                _history.removeAt(i);
                                _seen.remove(r.oldEpc);
                              });
                            },
                            confirmDelete: () async {
                              final ok = await showDialog<bool>(
                                context: context,
                                builder: (ctx) => AlertDialog(
                                  title: const Text('Remove from list?'),
                                  content: const Text(
                                      'This only removes the row; it does NOT undo any write that already happened on the tag.'),
                                  actions: [
                                    TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('Cancel')),
                                    TextButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text('Remove')),
                                  ],
                                ),
                              );
                              return ok ?? false;
                            },
                          );
                        },
                      ),
              ),
            ),
            Padding(
              padding: EdgeInsets.fromLTRB(20.w, 10.h, 20.w, 10.h),
              child: Row(children: [
                Expanded(
                  child: SizedBox(
                    height: 48,
                    child: FilledButton(
                      onPressed: () => unawaited(_toggleScan()),
                      style: FilledButton.styleFrom(
                        backgroundColor: _running ? const Color(0xFFBF2E2E) : const Color(0xFF0A7C80),
                        foregroundColor: Colors.white,
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(2.r)),
                        padding: EdgeInsets.symmetric(horizontal: 12.w),
                      ),
                      child: Row(children: [
                        Expanded(
                          child: Align(
                            alignment: Alignment.centerLeft,
                            child: Text(
                              _running ? 'STOP' : 'START',
                              style: GoogleFonts.spaceGrotesk(
                                fontSize: 16.sp, fontWeight: FontWeight.w800, letterSpacing: 1.8,
                              ),
                            ),
                          ),
                        ),
                        SizedBox(width: 8.w),
                        Icon(
                          _running ? Icons.stop_circle_outlined : Icons.play_circle_outline,
                          size: 20.sp,
                        ),
                      ]),
                    ),
                  ),
                ),
                SizedBox(width: 8.w),
                SizedBox(
                  width: 48, height: 48,
                  child: FilledButton(
                    onPressed: _resetScreen,
                    style: FilledButton.styleFrom(
                      backgroundColor: const Color(0xFF6A7575),
                      foregroundColor: Colors.white,
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(2.r)),
                      padding: EdgeInsets.zero,
                    ),
                    child: Icon(Icons.restart_alt, size: 20.sp),
                  ),
                ),
                SizedBox(width: 8.w),
                Expanded(
                  child: SizedBox(
                    height: 48,
                    child: FilledButton(
                      onPressed: (_history.isEmpty || _uploading) ? null : () => unawaited(_uploadCsv()),
                      style: FilledButton.styleFrom(
                        backgroundColor: const Color(0xFF2BA3A3),
                        disabledBackgroundColor: const Color(0xFF6A7575),
                        foregroundColor: Colors.white,
                        disabledForegroundColor: Colors.white,
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(2.r)),
                        padding: EdgeInsets.symmetric(horizontal: 12.w),
                      ),
                      child: Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Text(
                            _uploading ? 'UPLOADING…' : 'UPLOAD CSV',
                            style: GoogleFonts.spaceGrotesk(
                              fontSize: 16.sp, fontWeight: FontWeight.w800,
                              letterSpacing: 1.5, color: Colors.white,
                            ),
                          ),
                          SizedBox(width: 8.w),
                          Icon(Icons.cloud_upload_outlined, size: 20.sp, color: Colors.white),
                        ],
                      ),
                    ),
                  ),
                ),
              ]),
            ),
            const RfidPowerSlider(),
          ],
        ),
      ),
    );
  }
}

// ── Summary tile ────────────────────────────────────────────────────────────

class _SummaryTile extends StatelessWidget {
  const _SummaryTile({
    required this.label, required this.value, required this.icon,
    required this.boxWidth, required this.boxHeight,
    required this.tileColor, required this.textColor,
    required this.labelColor, required this.watermarkColor,
  });

  final String label;
  final String value;
  final IconData icon;
  final double boxWidth;
  final double boxHeight;
  final Color tileColor;
  final Color textColor;
  final Color labelColor;
  final Color watermarkColor;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: boxWidth, height: boxHeight,
      child: Material(
        color: tileColor,
        borderRadius: BorderRadius.circular(2.r),
        clipBehavior: Clip.hardEdge,
        child: Stack(children: [
          Positioned(right: 4.w, bottom: 0.h, child: Icon(icon, size: 52.sp, color: watermarkColor)),
          Padding(
            padding: EdgeInsets.fromLTRB(9.w, 3.h, 9.w, 3.h),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(label, style: GoogleFonts.manrope(
                  fontSize: 13.sp, fontWeight: FontWeight.w700, color: labelColor,
                )),
                Expanded(
                  child: Align(
                    alignment: Alignment.center,
                    child: Text(
                      value, maxLines: 1, softWrap: false, overflow: TextOverflow.clip,
                      style: GoogleFonts.spaceGrotesk(
                        fontSize: 34.sp, fontWeight: FontWeight.w700,
                        letterSpacing: -1.0, color: textColor, height: 1.0.h,
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ]),
      ),
    );
  }
}

// ── Scanned-tag row (with subtle left status stripe) ────────────────────────

class _EncodeRow extends StatelessWidget {
  const _EncodeRow({
    required this.rowKey, required this.row,
    this.onDelete, this.confirmDelete,
  });

  final String rowKey;
  final EncodeTagResult row;
  final VoidCallback? onDelete;
  final Future<bool> Function()? confirmDelete;

  static const double _fixedContainerHeight = 68.0;

  @override
  Widget build(BuildContext context) {
    final descStyle = GoogleFonts.manrope(
      fontSize: 15.sp, fontWeight: FontWeight.w700,
      color: AppColors.textMain, height: 1.2,
    );

    final content = Material(
      color: const Color(0xFFECECEC),
      borderRadius: BorderRadius.zero,
      child: SizedBox(
        height: _fixedContainerHeight,
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Left stripe: subtle status color, 4px wide.
            Container(width: 4.w, color: row.status.chipColor),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 12),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.center,
                  children: [
                    Expanded(
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        mainAxisAlignment: MainAxisAlignment.center,
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            row.oldEpc,
                            style: GoogleFonts.robotoMono(
                              fontSize: 14.sp, fontWeight: FontWeight.w700,
                              color: AppColors.textMain, height: 1.2,
                            ),
                            maxLines: 1, overflow: TextOverflow.ellipsis,
                          ),
                          if (row.newEpc != null && row.newEpc != row.oldEpc)
                            Padding(
                              padding: EdgeInsets.only(top: 2.h),
                              child: Text(
                                '→ ${row.newEpc}',
                                style: GoogleFonts.robotoMono(
                                  fontSize: 12.sp, fontWeight: FontWeight.w700,
                                  color: AppColors.primary, height: 1.2,
                                ),
                                maxLines: 1, overflow: TextOverflow.ellipsis,
                              ),
                            )
                          else
                            Padding(
                              padding: EdgeInsets.only(top: 2.h),
                              child: Text(
                                _describe(row), style: descStyle,
                                maxLines: 1, overflow: TextOverflow.ellipsis,
                              ),
                            ),
                        ],
                      ),
                    ),
                    SizedBox(width: 10.w),
                    _StatusBadge(status: row.status),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );

    if (onDelete == null || confirmDelete == null) return content;
    return Dismissible(
      key: ValueKey<String>(rowKey),
      direction: DismissDirection.endToStart,
      background: Container(
        alignment: Alignment.centerRight,
        padding: EdgeInsets.symmetric(horizontal: 14.w),
        color: const Color(0xFFBF2E2E),
        child: Icon(Icons.delete_outline, color: Colors.white, size: 26.sp),
      ),
      confirmDismiss: (_) async {
        final ok = await confirmDelete!.call();
        if (ok) onDelete!.call();
        return ok;
      },
      child: content,
    );
  }

  String _describe(EncodeTagResult r) {
    if (r.failureReason != EncodeFailureReason.none) {
      return r.failureReason.display;
    }
    final parts = <String>[
      if (r.systemId != null) '#${r.systemId}',
      if ((r.itemName ?? '').isNotEmpty) r.itemName!,
    ];
    if (parts.isNotEmpty) return parts.join(' · ');
    if ((r.customSku ?? '').isNotEmpty) return 'Custom SKU: ${r.customSku}';
    return r.status.label;
  }
}

class _StatusBadge extends StatelessWidget {
  const _StatusBadge({required this.status});
  final EncodeStatus status;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: EdgeInsets.symmetric(horizontal: 10.w, vertical: 4.h),
      decoration: BoxDecoration(
        color: status.chipColor,
        borderRadius: BorderRadius.circular(2.r),
      ),
      child: Text(
        status.label.toUpperCase(),
        style: GoogleFonts.spaceGrotesk(
          color: Colors.white, fontSize: 10.sp,
          fontWeight: FontWeight.w800, letterSpacing: 0.8,
        ),
      ),
    );
  }
}

// ── Popup with 10s countdown ────────────────────────────────────────────────

class _ForeignTagDialog extends StatefulWidget {
  const _ForeignTagDialog({required this.card, required this.duration});
  final EncodeTagResult card;
  final Duration duration;

  @override
  State<_ForeignTagDialog> createState() => _ForeignTagDialogState();
}

class _ForeignTagDialogState extends State<_ForeignTagDialog> {
  late Timer _ticker;
  late DateTime _deadline;
  int _remaining = 0;

  @override
  void initState() {
    super.initState();
    _deadline = DateTime.now().add(widget.duration);
    _remaining = widget.duration.inSeconds;
    _ticker = Timer.periodic(const Duration(milliseconds: 250), (_) {
      final left = _deadline.difference(DateTime.now()).inMilliseconds;
      if (left <= 0) {
        _ticker.cancel();
        if (mounted) Navigator.of(context).pop('timeout');
        return;
      }
      final secs = (left / 1000).ceil();
      if (secs != _remaining && mounted) setState(() => _remaining = secs);
    });
  }

  @override
  void dispose() {
    _ticker.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.card;
    final reasonText = c.failureReason.display.isNotEmpty
        ? c.failureReason.display
        : c.status.label;
    return AlertDialog(
      titlePadding: EdgeInsets.fromLTRB(20.w, 16.h, 16.w, 8.h),
      contentPadding: EdgeInsets.fromLTRB(20.w, 0, 20.w, 4.h),
      title: Row(children: [
        Icon(Icons.report_gmailerrorred, color: const Color(0xFFDC2626), size: 24.sp),
        SizedBox(width: 8.w),
        Expanded(
          child: Text(
            'Foreign / failed tag',
            style: GoogleFonts.spaceGrotesk(fontSize: 16.sp, fontWeight: FontWeight.w900),
          ),
        ),
        Text(
          '${_remaining}s',
          style: GoogleFonts.manrope(
            fontSize: 14.sp, fontWeight: FontWeight.w800, color: AppColors.textMuted,
          ),
        ),
      ]),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _kv('EPC', c.oldEpc, mono: true),
            if ((c.customSku ?? '').isNotEmpty) _kv('Custom SKU', c.customSku!),
            if (c.systemId != null) _kv('System ID', '${c.systemId}'),
            if ((c.itemName ?? '').isNotEmpty) _kv('Item', c.itemName!),
            if (c.serial != null) _kv('Serial', '${c.serial}'),
            Padding(
              padding: EdgeInsets.only(top: 8.h),
              child: Text(
                reasonText,
                style: GoogleFonts.manrope(
                  color: const Color(0xFFDC2626),
                  fontWeight: FontWeight.w800, fontSize: 13.sp,
                ),
              ),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop('user'),
          child: const Text('Close'),
        ),
      ],
    );
  }

  Widget _kv(String k, String v, {bool mono = false}) {
    return Padding(
      padding: EdgeInsets.symmetric(vertical: 2.h),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 90.w,
            child: Text(k, style: GoogleFonts.manrope(
              fontSize: 11.sp, color: AppColors.textMuted,
              fontWeight: FontWeight.w700, letterSpacing: 0.6,
            )),
          ),
          Expanded(
            child: mono
                ? Text(v, style: GoogleFonts.robotoMono(
                    fontSize: 12.sp, color: AppColors.textMain,
                    fontWeight: FontWeight.w700))
                : Text(v, style: GoogleFonts.manrope(
                    fontSize: 12.sp, color: AppColors.textMain,
                    fontWeight: FontWeight.w700)),
          ),
        ],
      ),
    );
  }
}
