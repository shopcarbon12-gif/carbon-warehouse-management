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
const Color _kCardGrey = Color(0xFFECECEC);
const Color _kTealLight = Color(0xFF2BA3A3);
const Color _kTextMuted = Color(0xFF8A9090);
const Color _kTextSlate = Color(0xFF3F4A4A);
const Color _kPwrStripBg = Color(0xFFEEF4F3);
const Color _kHairline = Color(0x14000000);
const Color _kSectionHairline = Color(0x10000000);
const Color _kPillOkBg = Color(0xFFD6F5E6);
const Color _kPillBadBg = Color(0xFFFFE3BD);
const Color _kAmberSoft = Color(0xFFFFF4E5);
const Color _kAmber = Color(0xFFE08A2C);
const Color _kAmberText = Color(0xFF8A4E12);

/// "Test your new tag" — pull-trigger to verify that a freshly-encoded
/// chip is broadcasting an EPC the WMS recognises.
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

  /// Local card-expansion state for the resolved item. Defaults to true
  /// on this screen — the operator opened the test screen specifically
  /// to verify details, so we show them up front.
  bool _expanded = true;

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
      _expanded = true;
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

  void _toggleExpand() {
    setState(() => _expanded = !_expanded);
  }

  @override
  Widget build(BuildContext context) {
    return CarbonScaffold(
      pageTitle: 'TEST TAG',
      bottomBar: _buildBottomBar(),
      body: ColoredBox(
        color: Colors.white,
        child: SingleChildScrollView(
          padding: EdgeInsets.only(bottom: 16.h),
          child: _buildContent(),
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
            Padding(
              padding: EdgeInsets.symmetric(horizontal: 20.w),
              child: Text(
                'Lookup failed: $_error',
                textAlign: TextAlign.center,
                style: GoogleFonts.spaceGrotesk(
                  fontSize: 11.sp,
                  fontWeight: FontWeight.w700,
                  color: _kErrorRed,
                ),
              ),
            ),
          ],
        ),
      );
    }
    // Resolved + no error — show the banner + sections + item container.
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _buildMatchBanner(),
        _buildEpcSection(),
        _buildDecodedSection(),
        _buildResolveSection(),
        SizedBox(height: 12.h),
        _buildItemContainer(),
      ],
    );
  }

  Widget _buildMatchBanner() {
    final expected = widget.expectedEpc;
    final actual = _lastEpc;
    if (expected == null || actual == null) return const SizedBox.shrink();
    final matched = expected.toUpperCase() == actual.toUpperCase();
    final bg = matched ? _kPillOkBg : _kAmberSoft;
    final fg = matched ? _kSuccessGreen : _kAmberText;
    final icon = matched ? Icons.check : Icons.priority_high;
    final label = matched
        ? 'MATCHES THE NEW EPC YOU JUST ENCODED'
        : 'DIFFERENT TAG — expected $expected';
    return Container(
      margin: EdgeInsets.fromLTRB(20.w, 10.h, 20.w, 0),
      padding: EdgeInsets.symmetric(horizontal: 12.w, vertical: 10.h),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(4.r),
        border: matched ? null : Border.all(color: _kAmber),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Icon(icon, size: 16.sp, color: fg),
          SizedBox(width: 10.w),
          Expanded(
            child: Text(
              label,
              style: GoogleFonts.spaceGrotesk(
                fontSize: 12.sp,
                fontWeight: FontWeight.w800,
                letterSpacing: 1.2,
                color: fg,
                height: 1.3,
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildEpcSection() {
    final epc = _lastEpc ?? '';
    // Format as "E280 6894 0000 ..." — spaces every 4 chars.
    final pretty = StringBuffer();
    for (var i = 0; i < epc.length; i++) {
      if (i > 0 && i % 4 == 0) pretty.write(' ');
      pretty.write(epc[i]);
    }
    return _TtSection(
      label: 'EPC',
      child: SelectableText(
        pretty.toString(),
        style: GoogleFonts.spaceMono(
          fontSize: 16.sp,
          fontWeight: FontWeight.w700,
          color: AppColors.textMain,
          letterSpacing: 0.5,
        ),
      ),
    );
  }

  Widget _buildDecodedSection() {
    final decoded = _resolveResult?['decoded'];
    if (decoded is! Map<String, dynamic>) return const SizedBox.shrink();
    final prefix = decoded['prefix']?.toString() ?? '';
    final systemId = decoded['system_id']?.toString() ?? '';
    final serial = decoded['serial']?.toString() ?? '';
    final monoBlack = GoogleFonts.robotoMono(
      fontSize: 13.sp,
      fontWeight: FontWeight.w800,
      color: AppColors.textMain,
    );
    final body = GoogleFonts.manrope(
      fontSize: 13.sp,
      fontWeight: FontWeight.w600,
      color: _kTextSlate,
      height: 1.5,
    );
    return _TtSection(
      label: 'DECODED',
      child: RichText(
        text: TextSpan(
          style: body,
          children: [
            const TextSpan(text: 'prefix '),
            TextSpan(text: prefix, style: monoBlack),
            const TextSpan(text: ' · system_id '),
            TextSpan(text: systemId, style: monoBlack),
            const TextSpan(text: ' · serial '),
            TextSpan(text: serial, style: monoBlack),
          ],
        ),
      ),
    );
  }

  Widget _buildResolveSection() {
    final status = _resolveResult?['status']?.toString() ?? '';
    final (pillLabel, prose) = switch (status) {
      'known' => ('KNOWN', 'items row found at this location'),
      'valid_orphan' => (
          'ORPHAN',
          'valid Carbon EPC, no items row in catalog yet',
        ),
      'foreign' => ('FOREIGN', 'EPC is not a Carbon-prefix tag'),
      _ => (status.isEmpty ? 'UNKNOWN' : status.toUpperCase(), ''),
    };
    return _TtSection(
      label: 'RESOLVE',
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Container(
            decoration: BoxDecoration(
              color: AppColors.primary,
              borderRadius: BorderRadius.circular(3.r),
            ),
            padding: EdgeInsets.symmetric(horizontal: 8.w, vertical: 3.h),
            child: Text(
              pillLabel,
              style: GoogleFonts.spaceGrotesk(
                fontSize: 10.sp,
                fontWeight: FontWeight.w800,
                letterSpacing: 1.4,
                color: Colors.white,
              ),
            ),
          ),
          SizedBox(width: 10.w),
          Expanded(
            child: Text(
              prose,
              style: GoogleFonts.manrope(
                fontSize: 13.sp,
                fontWeight: FontWeight.w600,
                color: _kTextSlate,
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildItemContainer() {
    final item = _resolveResult?['item'];
    if (item is! Map<String, dynamic>) return const SizedBox.shrink();
    final expected = widget.expectedEpc;
    final actual = _lastEpc;
    final matched = expected != null &&
        actual != null &&
        expected.toUpperCase() == actual.toUpperCase();
    return Padding(
      padding: EdgeInsets.fromLTRB(20.w, 0, 20.w, 0),
      child: _TestItemContainer(
        item: item,
        matched: matched,
        expanded: _expanded,
        onTap: _toggleExpand,
      ),
    );
  }

  Widget _buildBottomBar() {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        const _TestPowerSlider(powerDbm: _powerDbm),
        Container(
          height: 88.h,
          decoration: const BoxDecoration(
            color: Colors.white,
            boxShadow: [
              BoxShadow(
                color: Color(0x14000000),
                offset: Offset(0, -8),
                blurRadius: 24,
              ),
            ],
          ),
          padding: EdgeInsets.symmetric(horizontal: 16.w, vertical: 8.h),
          child: Row(
            children: [
              Expanded(
                flex: 1,
                child: _TtToolbarButton(
                  label: 'BACK',
                  icon: Icons.arrow_back,
                  background: _kTealLight,
                  onPressed: () => Navigator.of(context).pop(),
                ),
              ),
              SizedBox(width: 8.w),
              Expanded(
                flex: 2,
                child: _TtToolbarButton(
                  label: 'TEST ANOTHER',
                  icon: Icons.refresh,
                  background: AppColors.primary,
                  onPressed: _testAnother,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

// ── Section block (EPC / DECODED / RESOLVE) ─────────────────────────────

class _TtSection extends StatelessWidget {
  const _TtSection({required this.label, required this.child});

  final String label;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: EdgeInsets.symmetric(horizontal: 20.w),
      padding: EdgeInsets.symmetric(vertical: 10.h),
      decoration: const BoxDecoration(
        border: Border(
          bottom: BorderSide(color: _kSectionHairline, width: 1),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            style: GoogleFonts.spaceGrotesk(
              fontSize: 10.sp,
              fontWeight: FontWeight.w800,
              letterSpacing: 1.6,
              color: _kTextMuted,
            ),
          ),
          SizedBox(height: 5.h),
          child,
        ],
      ),
    );
  }
}

// ── Item container (count-style grey, parallel to encode_screen's) ──────

class _TestItemContainer extends StatelessWidget {
  const _TestItemContainer({
    required this.item,
    required this.matched,
    required this.expanded,
    required this.onTap,
  });

  final Map<String, dynamic> item;
  final bool matched;
  final bool expanded;
  final VoidCallback onTap;

  String _skuLine() {
    final sku = item['sku']?.toString() ?? item['custom_sku']?.toString() ?? '';
    return sku.isEmpty ? '—' : 'SKU: $sku';
  }

  String _descLine() {
    final name = item['name']?.toString() ?? item['item_name']?.toString() ?? '';
    final color = item['color']?.toString() ?? '';
    final size = item['size']?.toString() ?? '';
    final parts = <String>[
      if (name.isNotEmpty) name,
      if (color.isNotEmpty) color,
      if (size.isNotEmpty) size,
    ];
    return parts.isEmpty ? '—' : parts.join(' · ').toUpperCase();
  }

  Map<String, String> _kvs() {
    final out = <String, String>{};
    final upc = item['upc']?.toString() ?? '';
    final color = item['color']?.toString() ?? '';
    final size = item['size']?.toString() ?? '';
    final bin = item['bin_code']?.toString() ?? item['bin']?.toString() ?? '';
    final status = item['status']?.toString() ?? '';
    final matrix =
        item['matrix']?.toString() ?? item['matrix_id']?.toString() ?? '';
    if (upc.isNotEmpty) out['UPC'] = upc;
    if (color.isNotEmpty) out['COLOR'] = color;
    if (size.isNotEmpty) out['SIZE'] = size;
    if (bin.isNotEmpty) out['BIN'] = bin;
    if (status.isNotEmpty) out['STATUS'] = status;
    if (matrix.isNotEmpty) out['MATRIX'] = matrix;
    return out;
  }

  @override
  Widget build(BuildContext context) {
    final kvs = expanded ? _kvs() : const <String, String>{};
    return Material(
      color: _kCardGrey,
      child: InkWell(
        onTap: onTap,
        child: Stack(
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Expanded(
                  child: Padding(
                    padding: EdgeInsets.fromLTRB(14.w, 10.h, 8.w, 10.h),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          crossAxisAlignment: CrossAxisAlignment.center,
                          children: [
                            Expanded(
                              child: Text(
                                _skuLine(),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: GoogleFonts.robotoMono(
                                  fontSize: 19.sp,
                                  fontWeight: FontWeight.w700,
                                  color: AppColors.textMain,
                                  height: 1.2,
                                ),
                              ),
                            ),
                            SizedBox(width: 6.w),
                            Transform.rotate(
                              angle: expanded ? 3.14159 : 0,
                              child: Icon(
                                Icons.keyboard_arrow_down,
                                size: 16.sp,
                                color: _kTextMuted,
                              ),
                            ),
                          ],
                        ),
                        SizedBox(height: 4.h),
                        Text(
                          _descLine(),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: GoogleFonts.manrope(
                            fontSize: 14.sp,
                            fontWeight: FontWeight.w700,
                            color: AppColors.textMain,
                            height: 1.2,
                          ),
                        ),
                        if (kvs.isNotEmpty) ...[
                          SizedBox(height: 8.h),
                          Container(
                            decoration: const BoxDecoration(
                              border: Border(
                                top: BorderSide(color: _kHairline, width: 1),
                              ),
                            ),
                            padding: EdgeInsets.only(top: 8.h, bottom: 2.h),
                            child: _TtKvGrid(entries: kvs),
                          ),
                        ],
                      ],
                    ),
                  ),
                ),
                Padding(
                  padding: EdgeInsets.fromLTRB(8.w, 0, 12.w, 0),
                  child: Align(
                    widthFactor: 1,
                    alignment:
                        expanded ? Alignment.topCenter : Alignment.center,
                    child: Padding(
                      padding: EdgeInsets.only(top: expanded ? 10.h : 0),
                      child: matched
                          ? _MatchPill.match()
                          : _MatchPill.mismatch(),
                    ),
                  ),
                ),
              ],
            ),
            if (matched)
              Positioned(
                left: 0,
                top: 0,
                bottom: 0,
                child: Container(width: 4, color: _kSuccessGreen),
              ),
          ],
        ),
      ),
    );
  }
}

class _MatchPill extends StatelessWidget {
  const _MatchPill({required this.label, required this.bg, required this.fg});

  factory _MatchPill.match() => const _MatchPill(
        label: 'MATCH',
        bg: _kPillOkBg,
        fg: _kSuccessGreen,
      );

  factory _MatchPill.mismatch() => const _MatchPill(
        label: 'MISMATCH',
        bg: _kPillBadBg,
        fg: _kAmberText,
      );

  final String label;
  final Color bg;
  final Color fg;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(4.r),
      ),
      padding: EdgeInsets.symmetric(horizontal: 14.w, vertical: 8.h),
      child: Text(
        label,
        style: GoogleFonts.spaceGrotesk(
          fontSize: 14.sp,
          fontWeight: FontWeight.w800,
          letterSpacing: 1.4,
          color: fg,
        ),
      ),
    );
  }
}

class _TtKvGrid extends StatelessWidget {
  const _TtKvGrid({required this.entries});

  final Map<String, String> entries;

  @override
  Widget build(BuildContext context) {
    final list = entries.entries.toList();
    final rows = <Widget>[];
    for (var i = 0; i < list.length; i += 2) {
      final left = list[i];
      final right = i + 1 < list.length ? list[i + 1] : null;
      rows.add(Padding(
        padding: EdgeInsets.only(bottom: 6.h),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(child: _kv(left.key, left.value)),
            SizedBox(width: 14.w),
            Expanded(
              child: right == null
                  ? const SizedBox.shrink()
                  : _kv(right.key, right.value),
            ),
          ],
        ),
      ));
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: rows,
    );
  }

  Widget _kv(String k, String v) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          k.toUpperCase(),
          style: GoogleFonts.spaceGrotesk(
            fontSize: 9.sp,
            fontWeight: FontWeight.w800,
            letterSpacing: 1.4,
            color: _kTextMuted,
          ),
        ),
        SizedBox(height: 1.h),
        Text(
          v,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: GoogleFonts.robotoMono(
            fontSize: 13.sp,
            fontWeight: FontWeight.w700,
            color: AppColors.textMain,
          ),
        ),
      ],
    );
  }
}

// ── Toolbar button (parallel to encode_screen's) ────────────────────────

class _TtToolbarButton extends StatelessWidget {
  const _TtToolbarButton({
    required this.label,
    required this.icon,
    required this.background,
    required this.onPressed,
  });

  final String label;
  final IconData icon;
  final Color background;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: background,
      borderRadius: BorderRadius.circular(2.r),
      child: InkWell(
        borderRadius: BorderRadius.circular(2.r),
        onTap: onPressed,
        child: Container(
          alignment: Alignment.center,
          padding: EdgeInsets.symmetric(horizontal: 8.w),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, color: Colors.white, size: 22.sp),
              SizedBox(width: 10.w),
              Flexible(
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: GoogleFonts.spaceGrotesk(
                    fontSize: 15.sp,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 0.5,
                    color: Colors.white,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// ── Power strip (display-only on this screen — power is fixed at 10) ────

class _TestPowerSlider extends StatelessWidget {
  const _TestPowerSlider({required this.powerDbm});

  final int powerDbm;

  @override
  Widget build(BuildContext context) {
    return Container(
      color: _kPwrStripBg,
      padding: EdgeInsets.symmetric(horizontal: 20.w, vertical: 12.h),
      child: Row(
        children: [
          Text(
            'PWR',
            style: GoogleFonts.spaceGrotesk(
              fontSize: 11.sp,
              fontWeight: FontWeight.w800,
              letterSpacing: 1.4,
              color: _kTextSlate,
            ),
          ),
          SizedBox(width: 12.w),
          Expanded(
            child: SliderTheme(
              data: SliderTheme.of(context).copyWith(
                trackHeight: 8,
                activeTrackColor: AppColors.primary,
                inactiveTrackColor: const Color(0xFFCDD7D7),
                thumbColor: AppColors.primary,
                overlayColor: AppColors.primary.withValues(alpha: 0.10),
                thumbShape:
                    const RoundSliderThumbShape(enabledThumbRadius: 13),
                overlayShape:
                    const RoundSliderOverlayShape(overlayRadius: 22),
              ),
              child: Slider(
                value: powerDbm.toDouble(),
                min: 0,
                max: 33,
                divisions: 33,
                onChanged: (_) {},
              ),
            ),
          ),
          SizedBox(width: 8.w),
          SizedBox(
            width: 64.w,
            child: Text(
              '$powerDbm dBm',
              textAlign: TextAlign.right,
              style: GoogleFonts.spaceGrotesk(
                fontSize: 14.sp,
                fontWeight: FontWeight.w800,
                color: AppColors.textMain,
              ),
            ),
          ),
          SizedBox(width: 8.w),
          Container(
            decoration: BoxDecoration(
              color: AppColors.primary,
              borderRadius: BorderRadius.circular(3.r),
            ),
            padding: EdgeInsets.symmetric(horizontal: 6.w, vertical: 2.h),
            child: Text(
              'LIVE',
              style: GoogleFonts.spaceGrotesk(
                fontSize: 9.sp,
                fontWeight: FontWeight.w800,
                letterSpacing: 1.2,
                color: Colors.white,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
