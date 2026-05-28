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
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';

const Color _kErrorRed = Color(0xFFD9534F);
const Color _kSuccessGreen = Color(0xFF2A8E2A);

/// "Test your new tag" — pull-trigger to verify that a freshly-encoded
/// chip is broadcasting an EPC the WMS recognises.
///
/// Flow:
///   1. Operator opens this screen from the Encode review (or anywhere).
///   2. Pull trigger (single-pull-toggle: down starts, second down stops).
///   3. The radio reads at 10 dBm (close-range so a stray rack tag can't
///      hijack the result).
///   4. First EPC read: POST /api/rfid/encode-resolve to get item info,
///      then show the enriched panel. ingestEpcs runs server-side as part
///      of the resolve path so the items row updates (e.g. status flip
///      from 'unknown' → 'in-stock' if the catalog matches).
///   5. "Test another" resets the panel for the next read.
///
/// When [expectedEpc] is non-null, the screen highlights a match vs
/// mismatch — green for "this is the chip you just encoded", amber for
/// "the radio heard a different EPC instead".
class EncodeTestTagScreen extends StatefulWidget {
  const EncodeTestTagScreen({super.key, this.expectedEpc});

  /// EPC the operator just wrote, passed in by the Encode screen so we
  /// can give a clear "yes that's your tag" vs "no, this is something
  /// else" affordance. Optional — if null the screen still works as a
  /// generic single-tag scan + lookup.
  final String? expectedEpc;

  @override
  State<EncodeTestTagScreen> createState() => _EncodeTestTagScreenState();
}

class _EncodeTestTagScreenState extends State<EncodeTestTagScreen> {
  static const int _powerDbm = 10;

  bool _scanning = false;
  bool _resolving = false;
  String? _lastEpc;
  Map<String, dynamic>? _resolveResult;
  String? _error;

  StreamSubscription<RfidTagRead>? _tagSub;
  StreamSubscription<String>? _triggerSub;

  @override
  void initState() {
    super.initState();
    unawaited(ScanSounds.instance.init());
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _activate();
    });
  }

  @override
  void dispose() {
    _tagSub?.cancel();
    _triggerSub?.cancel();
    unawaited(RfidVendorChannel.stopChainwayInventory());
    unawaited(RfidVendorChannel.stopZebraInventory());
    unawaited(RfidVendorChannel.setZebraTriggerModeRfid());
    super.dispose();
  }

  Future<void> _activate() async {
    if (!mounted) return;
    unawaited(RfidVendorChannel.scannerDisableTriggerRelay());
    unawaited(RfidVendorChannel.close2dBarcode());
    unawaited(RfidVendorChannel.enableRfidFunctionMode());
    unawaited(RfidVendorChannel.setZebraTriggerModeRfid());
    unawaited(RfidVendorChannel.setAntennaPowerDbm(_powerDbm));
    _tagSub = RfidVendorChannel.tagReadStream().listen(_onRead);
    _triggerSub = RfidVendorChannel.hardwareTriggerStream().listen(_onTrigger);
  }

  void _onTrigger(String event) {
    if (!mounted) return;
    if (event != 'down') return;
    // Single-pull-toggle. Don't make the operator hold the trigger —
    // they need both hands for the chip.
    if (_scanning) {
      unawaited(_stopScan());
    } else {
      unawaited(_startScan());
    }
  }

  Future<void> _startScan() async {
    if (_scanning) return;
    setState(() {
      _scanning = true;
      _error = null;
    });
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

  Future<void> _stopScan() async {
    if (!_scanning) return;
    setState(() => _scanning = false);
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

  void _onRead(RfidTagRead read) {
    if (!mounted) return;
    if (!_scanning) return;
    final epc = read.epcHex24;
    if (epc.length != 24) return;
    // First read wins. Stop the radio immediately so we don't keep
    // accumulating reads while we resolve.
    unawaited(_stopScan());
    setState(() {
      _lastEpc = epc;
      _resolveResult = null;
      _resolving = true;
      _error = null;
    });
    unawaited(_resolve(epc));
  }

  Future<void> _resolve(String epc) async {
    final api = context.read<WmsApiClient>();
    try {
      final r = await api.postEncodeResolve(epc);
      if (!mounted) return;
      setState(() {
        _resolveResult = r;
        _resolving = false;
      });
      try {
        ScanSounds.instance.play(ScanCue.success);
      } catch (_) {}
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '$e';
        _resolving = false;
      });
      try {
        ScanSounds.instance.play(ScanCue.error);
      } catch (_) {}
    }
  }

  void _testAnother() {
    setState(() {
      _lastEpc = null;
      _resolveResult = null;
      _error = null;
    });
  }

  @override
  Widget build(BuildContext context) {
    return CarbonScaffold(
      pageTitle: 'TEST TAG',
      body: ColoredBox(
        color: const Color(0xFFF7FAFA),
        child: Column(
          children: [
            _TestTagHeader(
              scanning: _scanning,
              hasResult: _resolveResult != null,
              expectedEpc: widget.expectedEpc,
              actualEpc: _lastEpc,
            ),
            Expanded(
              child: SingleChildScrollView(
                padding: EdgeInsets.fromLTRB(14.w, 14.h, 14.w, 24.h),
                child: _buildContent(),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildContent() {
    if (_lastEpc == null) {
      return Padding(
        padding: EdgeInsets.symmetric(vertical: 80.h),
        child: Column(
          children: [
            Icon(LucideIcons.testTube2,
                size: 36.r, color: const Color(0xFF8FA1A1)),
            SizedBox(height: 12.h),
            Text(
              'Pull the trigger to read your encoded tag.\nRadio is at $_powerDbm dBm.',
              textAlign: TextAlign.center,
              style: GoogleFonts.manrope(
                fontSize: 12.sp,
                color: const Color(0xFF6D7979),
              ),
            ),
          ],
        ),
      );
    }
    if (_resolving) {
      return Padding(
        padding: EdgeInsets.symmetric(vertical: 60.h),
        child: Column(
          children: [
            const CircularProgressIndicator(strokeWidth: 2),
            SizedBox(height: 10.h),
            Text(
              'Looking up $_lastEpc …',
              style: GoogleFonts.spaceMono(
                fontSize: 11.sp,
                color: const Color(0xFF6D7979),
              ),
            ),
          ],
        ),
      );
    }
    if (_error != null) {
      return Padding(
        padding: EdgeInsets.symmetric(vertical: 24.h),
        child: Column(
          children: [
            Icon(LucideIcons.alertTriangle, color: _kErrorRed, size: 32.r),
            SizedBox(height: 8.h),
            Text(
              'Lookup failed: $_error',
              textAlign: TextAlign.center,
              style: GoogleFonts.spaceGrotesk(
                fontSize: 11.sp,
                fontWeight: FontWeight.w700,
                color: _kErrorRed,
              ),
            ),
            SizedBox(height: 16.h),
            _testAnotherButton(),
          ],
        ),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _ResultPanel(
          epc: _lastEpc!,
          expectedEpc: widget.expectedEpc,
          result: _resolveResult!,
        ),
        SizedBox(height: 14.h),
        _testAnotherButton(),
      ],
    );
  }

  Widget _testAnotherButton() {
    return SizedBox(
      width: double.infinity,
      child: ElevatedButton.icon(
        icon: const Icon(LucideIcons.refreshCw, size: 16),
        label: Text(
          'TEST ANOTHER',
          style: GoogleFonts.spaceGrotesk(
            fontSize: 11.sp,
            fontWeight: FontWeight.w800,
            letterSpacing: 1.2,
          ),
        ),
        style: ElevatedButton.styleFrom(
          backgroundColor: AppColors.primary,
          foregroundColor: Colors.white,
          minimumSize: Size(0, 36.h),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(4.r),
          ),
        ),
        onPressed: _testAnother,
      ),
    );
  }
}

class _TestTagHeader extends StatelessWidget {
  const _TestTagHeader({
    required this.scanning,
    required this.hasResult,
    required this.expectedEpc,
    required this.actualEpc,
  });

  final bool scanning;
  final bool hasResult;
  final String? expectedEpc;
  final String? actualEpc;

  @override
  Widget build(BuildContext context) {
    final hint = scanning
        ? 'Reading at 10 dBm — first matching tag wins.'
        : (hasResult
            ? 'Result below. Pull trigger to test another tag.'
            : 'Pull trigger to test a tag.');
    final showMatch = expectedEpc != null && actualEpc != null;
    final matched = showMatch && expectedEpc!.toUpperCase() == actualEpc!.toUpperCase();
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
                'TEST TAG',
                style: GoogleFonts.spaceGrotesk(
                  fontSize: 11.sp,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 1.6,
                  color: AppColors.primary,
                ),
              ),
              const Spacer(),
              if (scanning)
                Container(
                  padding: EdgeInsets.symmetric(horizontal: 8.w, vertical: 2.h),
                  decoration: BoxDecoration(
                    color: Colors.white12,
                    borderRadius: BorderRadius.circular(3.r),
                  ),
                  child: Text(
                    'READING…',
                    style: GoogleFonts.spaceGrotesk(
                      fontSize: 10.sp,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 1.2,
                      color: Colors.white,
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
          if (showMatch) ...[
            SizedBox(height: 6.h),
            Container(
              padding: EdgeInsets.symmetric(horizontal: 8.w, vertical: 4.h),
              decoration: BoxDecoration(
                color: matched ? _kSuccessGreen : const Color(0xFFE08A2C),
                borderRadius: BorderRadius.circular(3.r),
              ),
              child: Text(
                matched
                    ? 'MATCHES THE NEW EPC YOU JUST ENCODED'
                    : 'DIFFERENT TAG — expected $expectedEpc',
                style: GoogleFonts.spaceGrotesk(
                  fontSize: 10.sp,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 1.0,
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

class _ResultPanel extends StatelessWidget {
  const _ResultPanel({
    required this.epc,
    required this.expectedEpc,
    required this.result,
  });

  final String epc;
  final String? expectedEpc;
  final Map<String, dynamic> result;

  @override
  Widget build(BuildContext context) {
    final status = result['status']?.toString() ?? '';
    final decoded = result['decoded'];
    final item = result['item'];

    return Container(
      width: double.infinity,
      padding: EdgeInsets.fromLTRB(14.w, 12.h, 14.w, 12.h),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(6.r),
        border: Border.all(color: const Color(0xFFD7DEDE)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'EPC',
            style: GoogleFonts.spaceGrotesk(
              fontSize: 9.sp,
              fontWeight: FontWeight.w800,
              letterSpacing: 1.4,
              color: const Color(0xFF6D7979),
            ),
          ),
          SizedBox(height: 2.h),
          SelectableText(
            epc,
            style: GoogleFonts.spaceMono(
              fontSize: 12.sp,
              fontWeight: FontWeight.w700,
              color: AppColors.textMain,
            ),
          ),
          SizedBox(height: 10.h),
          if (decoded is Map<String, dynamic>) ...[
            Text(
              'DECODED',
              style: GoogleFonts.spaceGrotesk(
                fontSize: 9.sp,
                fontWeight: FontWeight.w800,
                letterSpacing: 1.4,
                color: const Color(0xFF6D7979),
              ),
            ),
            SizedBox(height: 2.h),
            Text(
              'prefix ${decoded['prefix']} · system_id ${decoded['system_id']} · serial ${decoded['serial']}',
              style: GoogleFonts.spaceMono(
                fontSize: 10.sp,
                color: AppColors.textMain,
              ),
            ),
            SizedBox(height: 10.h),
          ],
          Text(
            'RESOLVE',
            style: GoogleFonts.spaceGrotesk(
              fontSize: 9.sp,
              fontWeight: FontWeight.w800,
              letterSpacing: 1.4,
              color: const Color(0xFF6D7979),
            ),
          ),
          SizedBox(height: 2.h),
          Text(
            switch (status) {
              'known' => 'KNOWN — items row found at this location',
              'valid_orphan' =>
                'VALID FORMULA, NO ITEMS ROW — chip has a Carbon EPC but the catalog doesn\'t have it yet',
              'foreign' =>
                'FOREIGN — EPC isn\'t a Carbon-prefix tag (or undecodable)',
              _ => status.isEmpty ? '(no status returned)' : status,
            },
            style: GoogleFonts.spaceGrotesk(
              fontSize: 11.sp,
              fontWeight: FontWeight.w700,
              color: AppColors.textMain,
            ),
          ),
          if (item is Map<String, dynamic>) ...[
            SizedBox(height: 10.h),
            _ItemPanel(item: item),
          ],
        ],
      ),
    );
  }
}

class _ItemPanel extends StatelessWidget {
  const _ItemPanel({required this.item});

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
      padding: EdgeInsets.fromLTRB(10.w, 8.h, 10.w, 8.h),
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
              fontSize: 12.sp,
              fontWeight: FontWeight.w800,
              color: AppColors.textMain,
            ),
          ),
          SizedBox(height: 4.h),
          Wrap(
            spacing: 10.w,
            runSpacing: 2.h,
            children: [
              if (sku.isNotEmpty) _kv('SKU', sku),
              if (upc.isNotEmpty) _kv('UPC', upc),
              if (color.isNotEmpty) _kv('Color', color),
              if (size.isNotEmpty) _kv('Size', size),
              if (status.isNotEmpty) _kv('Status', status),
              if (bin.isNotEmpty) _kv('Bin', bin),
            ],
          ),
        ],
      ),
    );
  }

  Widget _kv(String k, String v) {
    return RichText(
      text: TextSpan(
        children: [
          TextSpan(
            text: '$k ',
            style: GoogleFonts.spaceGrotesk(
              fontSize: 9.sp,
              fontWeight: FontWeight.w800,
              letterSpacing: 1.2,
              color: const Color(0xFF6D7979),
            ),
          ),
          TextSpan(
            text: v,
            style: GoogleFonts.spaceGrotesk(
              fontSize: 11.sp,
              fontWeight: FontWeight.w700,
              color: AppColors.textMain,
            ),
          ),
        ],
      ),
    );
  }
}
