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
  const SearchAndEncodeScreen({super.key, this.cloudGeigerResolveEpc});

  static const String routeName = '/search-and-encode';

  /// When opened from Cloud + Geiger → Take an Action, this is the EPC
  /// that was sent to the handheld. After a successful chip-write on
  /// that specific tag (first attempt OR retry) we POST to
  /// `/api/handheld/epc-queue` to dismiss the drop server-side so it
  /// disappears across every device. Null on the dashboard Re-Encode
  /// tile entry path.
  final String? cloudGeigerResolveEpc;

  @override
  State<SearchAndEncodeScreen> createState() => _SearchAndEncodeScreenState();
}

class _SearchAndEncodeScreenState extends State<SearchAndEncodeScreen> {
  _TargetField _targetField = _TargetField.customSku;
  int _positionStart = 1;
  int _positionEnd = 13;
  int _powerDbm = 30;

  bool _running = false;
  int? _liveRssi;

  int _readCount = 0;
  int _encodedCount = 0;
  int _detectedCount = 0;

  final List<EncodeTagResult> _history = <EncodeTagResult>[];
  final Set<String> _seen = <String>{};

  /// Cards whose chip-write failed (operator moved away, RF dropout, etc.)
  /// keyed by the old C-prefix EPC. When the operator scans the same tag
  /// again, [_onTagRead] retries the write against the previously-claimed
  /// `newEpc` instead of allocating a fresh serial server-side (which
  /// would leak the first claim's items row). Cleared on a successful
  /// retry or when the operator removes the row.
  final Map<String, EncodeTagResult> _failedCards = <String, EncodeTagResult>{};

  /// Guard against re-entry while a retry write is still in flight — the
  /// vendor channel takes ~100-400 ms to come back and the radio keeps
  /// streaming reads of the still-unwritten tag during that window.
  final Set<String> _retryInFlight = <String>{};

  /// SINGLE-FLIGHT MUTEX (2026-05-30).
  /// The radio fires ~50 reads/sec; without this gate, the first 5-6
  /// C-prefix EPCs each kick off their own catalog → encode-claim →
  /// chip-write pipeline concurrently. The native chip-write
  /// serializes on the vendor's executor so the calls queue 5-10s
  /// deep behind each other while the radio keeps reading + the dart
  /// queue keeps growing — operators perceive this as "the screen is
  /// stuck, can't move the handheld." This flag drops incoming tag
  /// reads to a no-op while a write pipeline is already running.
  /// When the current write completes (success OR failure), the next
  /// trigger-held tag becomes the next write target. Matches the
  /// operator's mental model: "first tag, encode within a second,
  /// then the next one."
  bool _processInFlight = false;

  /// Memoized [WmsApiClient.catalogItemByCustomSku] result keyed by
  /// the extracted customSku. Operators re-encoding a stack of the
  /// same defective product would otherwise pay ~300 ms of warehouse
  /// wifi per tag for an identical lookup. Cleared by the RESET
  /// button so a SKU correction by an admin mid-session can be picked
  /// up without restart.
  final Map<String, Map<String, dynamic>?> _catalogCache =
      <String, Map<String, dynamic>?>{};

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
    // Silence the native per-tag beep — re-encode is only supposed to
    // beep on success/fail of the actual rewrite, never on raw reads
    // (and especially not on the foreign EPCs we silently drop in
    // _onTagRead's C-prefix filter).
    unawaited(_sounds.setTagBeepSuppressed(true));
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted) return;
      context.read<RfidManager>().scanContext = 'RE_ENCODE';
      final settings = context.read<MobileSettingsRepository>();
      // Inherit the operator's last global power. The shared
      // RfidPowerSlider lives at the bottom of this screen and is the
      // single source of truth — pre-1.2.46 we forcibly reset to 23 dBm
      // on every entry, then `_startScan` re-applied the local
      // `_powerDbm` (also frozen at 23) before every run. Net effect:
      // dragging the bottom slider up to 30 dBm did nothing on RFD8500
      // because the next trigger pull silently dropped power back to 23,
      // and the strict verifyEpcWrite (3 new sightings, 0 old) couldn't
      // see enough new-EPC reads at 23 dBm so every encode reported
      // writeFailed. Now the slider's value flows straight to the radio
      // and `_powerDbm` mirrors the repo, not the other way around.
      _powerDbm = settings.config.transferOutAntennaPower;
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
    // Read fresh from the repo so the radio matches the bottom slider
    // even if entry-time and ensureScannerReady run in different ticks.
    if (mounted) {
      _powerDbm = context
          .read<MobileSettingsRepository>()
          .config
          .transferOutAntennaPower;
    }
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
    // Restore the per-tag native beep for downstream screens (count /
    // status change / etc rely on it firing for every read).
    unawaited(_sounds.setTagBeepSuppressed(false));
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
                      // Route through the repo so the bottom
                      // RfidPowerSlider stays in sync and the next scan
                      // start reads the same value. Pre-1.2.46 this
                      // popup slider called setAntennaPowerDbm directly,
                      // which set the radio but left the bottom slider
                      // displaying a stale value.
                      unawaited(context
                          .read<MobileSettingsRepository>()
                          .setGlobalAntennaPower(n));
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
    // Always read FRESH from the repo — the bottom RfidPowerSlider
    // updates the repo on every drag tick, so this picks up whatever
    // the operator just dialled in. Pre-1.2.46 we read `_powerDbm`
    // here, which never reflected the slider's value.
    final settings = context.read<MobileSettingsRepository>();
    _powerDbm = settings.config.transferOutAntennaPower;
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

  // ── Incoming reads ────────────────────────────────────────────────────────

  void _onTagRead(RfidTagRead read) {
    if (!_running) return;
    final epc = read.epcHex24;
    if (epc.isEmpty) return;
    // STRICT re-encode filter: only legacy C-prefix tags (C1*/C2*/C3*)
    // are eligible to be rewritten. Every other EPC is silently dropped —
    // no rebuild, no beep, no light, no _seen entry, no _readCount bump,
    // no processTag. With native per-tag beep already suppressed in
    // initState, this means a Carbon-prefix or foreign tag in the
    // antenna's field is invisible to the operator on this screen.
    final upper = epc.toUpperCase();
    if (!(upper.startsWith('C1') ||
        upper.startsWith('C2') ||
        upper.startsWith('C3'))) {
      return;
    }
    if (read.rssi != null) _liveRssi = read.rssi;

    // SINGLE-FLIGHT GATE — drop EVERY incoming read while we're busy
    // running a pipeline. The radio fires 50+ reads/sec; without this,
    // 5-6 C-prefix EPCs each kick off their own catalog→claim→write in
    // parallel and the native chip-write executor queues 5-10s deep
    // ("can't move the handheld, screen is stuck"). Reads we drop now
    // will be re-emitted naturally — the operator just keeps the
    // trigger held, the next tag in range becomes the next write
    // target the instant the current pipeline finishes.
    if (_processInFlight) return;

    // Retry path: a previous write for this exact chip failed (operator
    // moved too far / RF dropout). The server already burned a serial
    // via /api/rfid/encode-claim, so just re-issue the chip write with
    // the same newEpc instead of claiming again — claiming again leaves
    // the first allocation orphaned in items.
    final failed = _failedCards[epc];
    if (failed != null) {
      if (_retryInFlight.contains(epc)) return;
      _processInFlight = true;
      _sounds.play(ScanCue.read);
      unawaited(_retryWrite(failed).whenComplete(() {
        _processInFlight = false;
      }));
      return;
    }

    if (!_seen.add(epc)) {
      return;
    }
    setState(() => _readCount += 1);
    // Operator asked for a single beep on every relevant (C-prefix) read.
    // Native per-tag beep stays suppressed (silences the foreign-tag drop
    // path above); this explicit Dart cue fires only after the C-prefix
    // filter passes, so the operator hears exactly the tags they care
    // about and nothing else.
    _sounds.play(ScanCue.read);
    _processInFlight = true;
    unawaited(_processTag(epc).whenComplete(() {
      _processInFlight = false;
    }));
  }

  /// Re-run the chip write for a card whose previous write failed.
  /// Re-uses `card.newEpc` from the prior `postEncodeClaim` — the serial
  /// is already burned server-side and the items row already exists.
  Future<void> _retryWrite(EncodeTagResult card) async {
    final newEpc = card.newEpc;
    if (newEpc == null || newEpc.length != 24) return;
    if (_retryInFlight.contains(card.oldEpc)) return;
    _retryInFlight.add(card.oldEpc);
    _updateCard(card, (c) {
      // Flip back to "in progress" so the badge reflects the new attempt.
      c.status = EncodeStatus.detected;
      c.failureReason = EncodeFailureReason.none;
    });
    bool written = false;
    try {
      written = await RfidVendorChannel.writeEpcTag(
        targetEpc: card.oldEpc,
        newEpc: newEpc,
      );
    } catch (_) {
      written = false;
    }
    if (!mounted) {
      _retryInFlight.remove(card.oldEpc);
      return;
    }
    if (!written) {
      _updateCard(card, (c) {
        c.status = EncodeStatus.tagIssue;
        c.failureReason = EncodeFailureReason.writeFailed;
      });
      _sounds.play(ScanCue.error);
      _retryInFlight.remove(card.oldEpc);
      return;
    }
    _updateCard(card, (c) {
      c.status = EncodeStatus.encoded;
      c.failureReason = EncodeFailureReason.none;
    });
    _failedCards.remove(card.oldEpc);
    _retryInFlight.remove(card.oldEpc);
    setState(() => _encodedCount += 1);
    _sounds.play(ScanCue.success);
    // Same finalisation as the first-attempt success path — the server's
    // encode-claim left the items row at 'unknown' even though the chip
    // is now confirmed to carry [newEpc].
    unawaited(_finalizeWrite(oldEpc: card.oldEpc, newEpc: newEpc));
    unawaited(_reportEvent(
      oldEpc: card.oldEpc,
      newEpc: newEpc,
      systemId: card.systemId,
      serial: card.serial,
      customSku: card.customSku ?? '',
    ));
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
      _sounds.play(ScanCue.error);
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
      _sounds.play(ScanCue.error);
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

    // SINGLE-ROUND-TRIP CATALOG + CLAIM (1.2.104, 2026-05-30).
    // Pre-1.2.104 the screen did two awaits per tag — GET catalog,
    // then POST encode-claim — each ~200-500ms on warehouse Wi-Fi.
    // /api/rfid/encode-resolve-and-claim merges them into one
    // transaction + one HTTPS round-trip. The SKU catalog cache
    // [_catalogCache] also remains: when we've already merged for
    // this customSku in-session, we skip the round-trip for the
    // catalog half AND still get a fresh serial from the same call
    // (server still does the catalog lookup but the result lands
    // identically — no harm). The cache key stays `customSku` so a
    // cache HIT short-circuits the lookup half of the merged
    // endpoint via the same code path. RESET clears the cache.
    Map<String, dynamic> resolved;
    try {
      resolved = await api.postEncodeResolveAndClaim(
        customSku: customSku,
        oldEpc: epc,
      );
    } on WmsApiException catch (e) {
      // 404 = SKU not in catalog (notFound), 422 = no system_id, 409 =
      // EPC collision (caller can retry). All three are surfaced to
      // the operator as TAG_ISSUE with a specific reason; the screen
      // only differentiates `notInCatalog` for the dashboard tally.
      if (e.statusCode == 404) {
        _updateCard(card, (c) {
          c.status = EncodeStatus.notFound;
          c.failureReason = EncodeFailureReason.notInCatalog;
        });
        _sounds.play(ScanCue.error);
        unawaited(_reportEvent(oldEpc: epc, customSku: customSku, status: 'not_found'));
        return;
      }
      _updateCard(card, (c) {
        c.status = EncodeStatus.tagIssue;
        c.failureReason = EncodeFailureReason.serialFetchFailed;
      });
      _sounds.play(ScanCue.error);
      return;
    } catch (_) {
      _updateCard(card, (c) {
        c.status = EncodeStatus.tagIssue;
        c.failureReason = EncodeFailureReason.serialFetchFailed;
      });
      _sounds.play(ScanCue.error);
      return;
    }

    final systemId = _toInt(resolved['system_id']);
    final itemName = resolved['name']?.toString() ?? '';
    final customSkuId = resolved['customSkuId']?.toString() ?? '';
    // Memoize the catalog half — used as a defensive cache so we don't
    // re-resolve for a SKU we've already seen this session (e.g. if a
    // future flow needs catalog-only lookup again). Stored even on the
    // merged success path so it's available without an extra GET.
    _catalogCache[customSku] = <String, dynamic>{
      'id': customSkuId,
      'system_id': systemId,
      'name': itemName,
      'custom_sku': customSku,
      'sku': customSku,
    };
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
      _sounds.play(ScanCue.error);
      return;
    }

    final newEpc = (resolved['epc'] as String?)?.toUpperCase() ?? '';
    final serial = (resolved['serial'] as num?)?.toInt() ?? 0;
    if (newEpc.length != 24 || serial == 0) {
      _updateCard(card, (c) {
        c.status = EncodeStatus.tagIssue;
        c.failureReason = EncodeFailureReason.serialFetchFailed;
      });
      _sounds.play(ScanCue.error);
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
      // Arm retry — same C-prefix EPC scanned again pulls this card out
      // of [_failedCards] and re-runs writeEpcTag with the existing
      // [newEpc] instead of claiming a fresh serial. The server-side
      // claim already happened above, so allocating again here would
      // leak the first serial as an orphan items row.
      _failedCards[epc] = card;
      _sounds.play(ScanCue.error);
      unawaited(_reportEvent(
        oldEpc: epc, newEpc: newEpc, systemId: systemId, serial: serial,
        customSku: customSku, status: 'write_failed',
      ));
      return;
    }

    _updateCard(card, (c) {
      c.status = EncodeStatus.encoded;
      c.failureReason = EncodeFailureReason.none;
    });
    setState(() => _encodedCount += 1);
    _sounds.play(ScanCue.success);
    // Phase 3 — server-side finalisation. encode-claim left the new EPC's
    // items row at status='unknown' (the WMS can't trust the chip wrote
    // until the handheld confirms). Now that writeEpcTag returned true we
    // know the chip committed → flip to 'in-stock' (LIVE) and dismiss the
    // old EPC from the Defective EPCs modal. Best-effort: a finalize
    // failure doesn't undo the chip write, so we don't surface it as a
    // tag error — just log via the event report below.
    unawaited(_finalizeWrite(oldEpc: epc, newEpc: newEpc));
    unawaited(_reportEvent(
      oldEpc: epc, newEpc: newEpc, systemId: systemId, serial: serial,
      customSku: customSku,
    ));
  }

  Future<void> _dismissCloudGeiger(String epc) async {
    try {
      final api = context.read<WmsApiClient>();
      final deviceId = _deviceId ??
          await HandheldDeviceIdentity.primaryDeviceIdForServer();
      await api.dismissEpcQueueItems(deviceId: deviceId, epcs: [epc]);
    } catch (_) {
      /* best-effort — slide-delete on Cloud+Geiger still works */
    }
  }

  Future<void> _finalizeWrite({required String oldEpc, required String newEpc}) async {
    // Cloud + Geiger auto-resolve: if this re-encode happened against
    // the exact EPC that was sent to the handheld, dismiss the queue
    // row server-side so the Cloud + Geiger screen drops it on every
    // device. The /api/handheld/epc-queue POST is best-effort and
    // independent of the finalize call below.
    final resolveEpc = widget.cloudGeigerResolveEpc?.trim().toUpperCase();
    if (resolveEpc != null && resolveEpc == oldEpc.toUpperCase()) {
      unawaited(_dismissCloudGeiger(resolveEpc));
    }
    try {
      await context.read<WmsApiClient>().postEncodeFinalize(
            newEpc: newEpc,
            oldEpc: oldEpc,
          );
    } catch (_) {
      /* swallow — chip is written, finalize is best-effort */
    }
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
      _failedCards.clear();
      _retryInFlight.clear();
      _catalogCache.clear();
      _processInFlight = false;
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
      pageTitle: 'reencode',
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
                                _failedCards.remove(r.oldEpc);
                                _retryInFlight.remove(r.oldEpc);
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

class _EncodeRow extends StatefulWidget {
  const _EncodeRow({
    required this.rowKey, required this.row,
    this.onDelete, this.confirmDelete,
  });

  final String rowKey;
  final EncodeTagResult row;
  final VoidCallback? onDelete;
  final Future<bool> Function()? confirmDelete;

  @override
  State<_EncodeRow> createState() => _EncodeRowState();
}

class _EncodeRowState extends State<_EncodeRow> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final row = widget.row;
    final descStyle = GoogleFonts.manrope(
      fontSize: 15.sp, fontWeight: FontWeight.w700,
      color: AppColors.textMain, height: 1.2,
    );

    final content = Material(
      color: const Color(0xFFECECEC),
      borderRadius: BorderRadius.zero,
      child: InkWell(
        onTap: () => setState(() => _expanded = !_expanded),
        child: IntrinsicHeight(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Container(width: 4.w, color: row.status.chipColor),
              Expanded(
                child: Padding(
                  padding: EdgeInsets.symmetric(vertical: 10.h, horizontal: 12.w),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.center,
                        children: [
                          Expanded(
                            child: Text(
                              _describe(row),
                              style: descStyle,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                          SizedBox(width: 10.w),
                          _StatusBadge(status: row.status),
                        ],
                      ),
                      if (_expanded) ...[
                        SizedBox(height: 8.h),
                        _EpcKv(label: 'OLD', value: row.oldEpc),
                        SizedBox(height: 4.h),
                        _EpcKv(
                          label: 'NEW',
                          value: (row.newEpc ?? '').isEmpty ? '—' : row.newEpc!,
                          accent: (row.newEpc != null && row.newEpc != row.oldEpc),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );

    final onDelete = widget.onDelete;
    final confirmDelete = widget.confirmDelete;
    if (onDelete == null || confirmDelete == null) return content;
    return Dismissible(
      key: ValueKey<String>(widget.rowKey),
      direction: DismissDirection.endToStart,
      background: Container(
        alignment: Alignment.centerRight,
        padding: EdgeInsets.symmetric(horizontal: 14.w),
        color: const Color(0xFFBF2E2E),
        child: Icon(Icons.delete_outline, color: Colors.white, size: 26.sp),
      ),
      confirmDismiss: (_) async {
        final ok = await confirmDelete();
        if (ok) onDelete();
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

class _EpcKv extends StatelessWidget {
  const _EpcKv({required this.label, required this.value, this.accent = false});
  final String label;
  final String value;
  final bool accent;
  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        SizedBox(
          width: 38.w,
          child: Text(
            label,
            style: GoogleFonts.spaceGrotesk(
              fontSize: 10.sp,
              fontWeight: FontWeight.w800,
              letterSpacing: 1.2,
              color: const Color(0xFF6D7979),
            ),
          ),
        ),
        Expanded(
          child: Text(
            value,
            style: GoogleFonts.robotoMono(
              fontSize: 12.sp,
              fontWeight: FontWeight.w700,
              color: accent ? AppColors.primary : AppColors.textMain,
              height: 1.2,
            ),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ),
      ],
    );
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

