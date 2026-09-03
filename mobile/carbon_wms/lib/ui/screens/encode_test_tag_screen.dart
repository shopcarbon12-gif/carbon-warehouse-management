import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/hardware/rfid_tag_read.dart';
import 'package:carbon_wms/hardware/rfid_vendor_channel.dart';
import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/scan_sounds.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';
import 'package:carbon_wms/hardware/hardware_trigger.dart';

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
  static const int _defaultPowerDbm = 1;
  static const int _powerMinDbm = 0;
  static const int _powerMaxDbm = 33;
  static const Duration _powerDebounce = Duration(milliseconds: 250);

  int _powerDbm = _defaultPowerDbm;
  Timer? _powerPushTimer;

  bool _scanning = false;
  bool _resolving = false;
  String? _lastEpc;
  Map<String, dynamic>? _resolveResult;
  String? _error;

  bool _expanded = true;

  StreamSubscription<RfidTagRead>? _tagSub;
  StreamSubscription<String>? _triggerSub;

  @override
  void initState() {
    super.initState();
    unawaited(ScanSounds.instance.init());
    // Silence native per-tag beep — on this screen we only want the
    // SUCCESS chime when the target EPC is matched, not a beep per read.
    unawaited(ScanSounds.instance.setTagBeepSuppressed(true));
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _activate();
    });
  }

  @override
  void dispose() {
    _tagSub?.cancel();
    _triggerSub?.cancel();
    _powerPushTimer?.cancel();
    unawaited(RfidVendorChannel.stopChainwayInventory());
    unawaited(RfidVendorChannel.stopZebraInventory());
    unawaited(RfidVendorChannel.setZebraTriggerModeRfid());
    unawaited(ScanSounds.instance.setTagBeepSuppressed(false));
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
    _triggerSub = hardwareTriggerFor(this).listen(_onTrigger);
  }

  void _onPowerSliderChanged(int dbm) {
    if (_powerDbm == dbm) return;
    setState(() => _powerDbm = dbm);
    _powerPushTimer?.cancel();
    _powerPushTimer = Timer(_powerDebounce, () {
      unawaited(RfidVendorChannel.setAntennaPowerDbm(dbm));
    });
  }

  void _onPowerSliderEnded(int dbm) {
    _powerPushTimer?.cancel();
    unawaited(RfidVendorChannel.setAntennaPowerDbm(dbm));
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
    // When the caller passed an expectedEpc, ignore every other tag the
    // antenna hears — operator only wants to verify that the chip they
    // just encoded is broadcasting the new EPC. No partial UI for foreign
    // tags, no per-tag beep, no resolve roundtrip. Keep scanning until
    // the target arrives (or the operator pulls the trigger again).
    final expected = widget.expectedEpc?.toUpperCase();
    if (expected != null && epc.toUpperCase() != expected) return;
    // Match — stop the radio so we don't keep accumulating reads while
    // we resolve. Play the success chime exactly once, here.
    unawaited(_stopScan());
    try {
      ScanSounds.instance.play(ScanCue.success);
    } catch (_) {}
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
      // Success chime already played in _onRead the moment the matching
      // EPC arrived — don't double-play. Resolve is just enrichment.
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
    final hasResolve = _lastEpc != null;
    return CarbonScaffold(
      pageTitle: 'TEST TAG',
      bottomBar: _buildBottomBar(),
      body: Container(
        color: Colors.white,
        width: double.infinity,
        // When we have no result yet (or we're still resolving / errored),
        // stretch the white card across the whole body so the prompt sits
        // dead-centre instead of floating at the top.
        child: hasResolve
            ? SingleChildScrollView(
                padding: const EdgeInsets.only(bottom: 16),
                child: _buildContent(),
              )
            : Center(child: _buildContent()),
      ),
    );
  }

  Widget _buildContent() {
    if (_lastEpc == null) {
      return Padding(
        padding: const EdgeInsets.symmetric(horizontal: 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(LucideIcons.testTube2,
                size: 48, color: Color(0xFF8FA1A1)),
            const SizedBox(height: 14),
            Text(
              'Pull the trigger to read your encoded tag.\nRadio is at $_powerDbm dBm.',
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.w600,
                color: Color(0xFF6D7979),
              ),
            ),
          ],
        ),
      );
    }
    if (_resolving) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 60),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const CircularProgressIndicator(strokeWidth: 2),
            const SizedBox(height: 10),
            Text(
              'Looking up $_lastEpc ...',
              style: const TextStyle(
                fontSize: 14,
                fontFamily: 'monospace',
                color: Color(0xFF6D7979),
              ),
            ),
          ],
        ),
      );
    }
    if (_error != null) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 24, horizontal: 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(LucideIcons.alertTriangle, color: _kErrorRed, size: 32),
            const SizedBox(height: 8),
            Text(
              'Lookup failed: $_error',
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w700,
                color: _kErrorRed,
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
        const SizedBox(height: 12),
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
      margin: const EdgeInsets.fromLTRB(20, 10, 20, 0),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(4),
        border: matched ? null : Border.all(color: _kAmber),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Icon(icon, size: 18, color: fg),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              label,
              style: TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w800,
                letterSpacing: 1.0,
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
    final pretty = StringBuffer();
    for (var i = 0; i < epc.length; i++) {
      if (i > 0 && i % 4 == 0) pretty.write(' ');
      pretty.write(epc[i]);
    }
    return _TtSection(
      label: 'EPC',
      child: SelectableText(
        pretty.toString(),
        style: const TextStyle(
          fontSize: 16,
          fontWeight: FontWeight.w700,
          color: Color(0xFF171D1D),
          fontFamily: 'monospace',
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
    const monoBlack = TextStyle(
      fontSize: 13,
      fontWeight: FontWeight.w800,
      color: Color(0xFF171D1D),
      fontFamily: 'monospace',
    );
    const body = TextStyle(
      fontSize: 13,
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
              borderRadius: BorderRadius.circular(3),
            ),
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
            child: Text(
              pillLabel,
              style: const TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w800,
                letterSpacing: 1.2,
                color: Colors.white,
              ),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              prose,
              style: const TextStyle(
                fontSize: 13,
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
      padding: const EdgeInsets.symmetric(horizontal: 20),
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
        _TestPowerSlider(
          powerDbm: _powerDbm,
          minDbm: _powerMinDbm,
          maxDbm: _powerMaxDbm,
          onChanged: _onPowerSliderChanged,
          onChangeEnd: _onPowerSliderEnded,
        ),
        Container(
          height: 88,
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
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
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
              const SizedBox(width: 8),
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
      margin: const EdgeInsets.symmetric(horizontal: 20),
      padding: const EdgeInsets.symmetric(vertical: 10),
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
            style: const TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w800,
              letterSpacing: 1.4,
              color: _kTextMuted,
            ),
          ),
          const SizedBox(height: 5),
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
    // Plain Container + GestureDetector. Same simplification as encode_screen
    // — Material > InkWell > Stack + Positioned + Align(no widthFactor) was
    // fragile in release builds and could blank the whole card.
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Container(
        color: _kCardGrey,
        child: IntrinsicHeight(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Container(
                width: 4,
                color: matched ? _kSuccessGreen : _kCardGrey,
              ),
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(12, 10, 8, 10),
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
                              style: const TextStyle(
                                fontSize: 18,
                                fontWeight: FontWeight.w700,
                                color: Color(0xFF171D1D),
                                fontFamily: 'monospace',
                                height: 1.2,
                              ),
                            ),
                          ),
                          const SizedBox(width: 6),
                          Transform.rotate(
                            angle: expanded ? 3.14159 : 0,
                            child: const Icon(
                              Icons.keyboard_arrow_down,
                              size: 18,
                              color: _kTextMuted,
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 4),
                      Text(
                        _descLine(),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 14,
                          fontWeight: FontWeight.w700,
                          color: Color(0xFF171D1D),
                          height: 1.2,
                        ),
                      ),
                      if (kvs.isNotEmpty) ...[
                        const SizedBox(height: 8),
                        Container(
                          decoration: const BoxDecoration(
                            border: Border(
                              top: BorderSide(color: _kHairline, width: 1),
                            ),
                          ),
                          padding: const EdgeInsets.only(top: 8, bottom: 2),
                          child: _TtKvGrid(entries: kvs),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
              Padding(
                padding: EdgeInsets.only(
                  left: 8,
                  right: 12,
                  top: expanded ? 10 : 0,
                ),
                child: Align(
                  widthFactor: 1,
                  alignment:
                      expanded ? Alignment.topCenter : Alignment.center,
                  child: matched
                      ? _MatchPill.match()
                      : _MatchPill.mismatch(),
                ),
              ),
            ],
          ),
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
        borderRadius: BorderRadius.circular(4),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      child: Text(
        label,
        style: TextStyle(
          fontSize: 12,
          fontWeight: FontWeight.w800,
          letterSpacing: 1.2,
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
        padding: const EdgeInsets.only(bottom: 6),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(child: _kv(left.key, left.value)),
            const SizedBox(width: 14),
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
          style: const TextStyle(
            fontSize: 10,
            fontWeight: FontWeight.w800,
            letterSpacing: 1.2,
            color: _kTextMuted,
          ),
        ),
        const SizedBox(height: 1),
        Text(
          v,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(
            fontSize: 13,
            fontWeight: FontWeight.w700,
            color: Color(0xFF171D1D),
            fontFamily: 'monospace',
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
    return GestureDetector(
      onTap: onPressed,
      behavior: HitTestBehavior.opaque,
      child: Container(
        decoration: BoxDecoration(
          color: background,
          borderRadius: BorderRadius.circular(2),
        ),
        alignment: Alignment.center,
        padding: const EdgeInsets.symmetric(horizontal: 8),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, color: Colors.white, size: 22),
            const SizedBox(width: 10),
            Flexible(
              child: Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 0.5,
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

// ── Power strip — live, debounced push to chip ──────────────────────────

class _TestPowerSlider extends StatelessWidget {
  const _TestPowerSlider({
    required this.powerDbm,
    required this.minDbm,
    required this.maxDbm,
    required this.onChanged,
    required this.onChangeEnd,
  });

  final int powerDbm;
  final int minDbm;
  final int maxDbm;
  final ValueChanged<int> onChanged;
  final ValueChanged<int> onChangeEnd;

  @override
  Widget build(BuildContext context) {
    final clamped = powerDbm.clamp(minDbm, maxDbm);
    return Container(
      color: _kPwrStripBg,
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
      child: Row(
        children: [
          const Text(
            'PWR',
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w800,
              letterSpacing: 1.4,
              color: _kTextSlate,
            ),
          ),
          const SizedBox(width: 12),
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
                value: clamped.toDouble(),
                min: minDbm.toDouble(),
                max: maxDbm.toDouble(),
                divisions: maxDbm - minDbm,
                onChanged: (v) => onChanged(v.round()),
                onChangeEnd: (v) => onChangeEnd(v.round()),
              ),
            ),
          ),
          const SizedBox(width: 8),
          SizedBox(
            width: 64,
            child: Text(
              '$powerDbm dBm',
              textAlign: TextAlign.right,
              style: const TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w800,
                color: Color(0xFF171D1D),
              ),
            ),
          ),
          const SizedBox(width: 8),
          Container(
            decoration: BoxDecoration(
              color: AppColors.primary,
              borderRadius: BorderRadius.circular(3),
            ),
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
            child: const Text(
              'LIVE',
              style: TextStyle(
                fontSize: 10,
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
