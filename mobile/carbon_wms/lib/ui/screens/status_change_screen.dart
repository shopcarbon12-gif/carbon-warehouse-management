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
import 'package:carbon_wms/services/scan_sounds.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/screens/inventory_catalog_screen.dart'
    show CatalogRowCard;
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';
import 'package:carbon_wms/ui/widgets/rfid_power_slider.dart';

/// Status Change — handheld flow.
///
///   Step 1: SEARCH    — operator either types a query, fires the 2D
///                       imager (search box auto-fills), or pulls a UHF
///                       read (skips straight to step 3 with the matching
///                       catalog row).
///   Step 2: PICK EPC  — list the in-stock EPCs for the chosen item.
///   Step 3: PICK STATUS — list the operator-applicable statuses (per
///                       /api/scanner/status-labels), tap to choose, hit
///                       Commit. POSTs single-EPC bulk-status; on success
///                       we return to step 1.
///
/// Trigger discipline: BOTH 2D and UHF stay armed on this screen so the
/// operator can use whichever path is fastest. UHF reads route via the
/// RfidManager geiger sink; 2D codes flow through hardwareBarcodeStream.
class StatusChangeScreen extends StatefulWidget {
  const StatusChangeScreen({super.key});

  @override
  State<StatusChangeScreen> createState() => _StatusChangeScreenState();
}

enum _StatusStep { search, pickEpc, pickStatus }

class _StatusLabel {
  const _StatusLabel({
    required this.name,
    required this.displayLabel,
    required this.applicable,
    required this.superAdminLocked,
    required this.systemOnly,
  });
  final String name;
  final String displayLabel;
  final bool applicable;
  final bool superAdminLocked;
  final bool systemOnly;
}

class _StatusChangeScreenState extends State<StatusChangeScreen> {
  static const Duration _searchDebounce = Duration(milliseconds: 300);
  static const int _minQueryLen = 2;

  // ── flow state ────────────────────────────────────────────────────────
  _StatusStep _step = _StatusStep.search;
  final TextEditingController _searchCtrl = TextEditingController();
  Timer? _debounce;
  String _query = '';
  bool _searchLoading = false;
  String? _searchError;
  List<Map<String, dynamic>> _searchResults = [];

  Map<String, dynamic>? _selectedItem; // catalog row
  bool _epcsLoading = false;
  String? _epcsError;
  List<Map<String, dynamic>> _itemEpcs = [];

  Map<String, dynamic>? _selectedEpcRow; // entry from _itemEpcs
  String _selectedTargetStatus = '';
  bool _override = false;
  bool _committing = false;

  // ── status-label catalogue (loaded once on entry) ────────────────────
  List<_StatusLabel> _statusLabels = [];
  bool _isSuperAdmin = false;
  bool _labelsLoading = true;
  String? _labelsError;

  // ── trigger / scanner subscriptions ──────────────────────────────────
  StreamSubscription<RfidTagRead>? _uhfSub;
  StreamSubscription<String>? _barcodeSub;

  @override
  void initState() {
    super.initState();
    unawaited(ScanSounds.instance.init());
    _activateBothScanners();
    _attachStreams();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      // Route UHF reads through the Geiger sink so they reach _onUhfRead
      // without competing with Count's session-EPC accumulation.
      context.read<RfidManager>().scanContext = 'GEIGER_FIND';
      unawaited(_loadStatusLabels());
    });
  }

  @override
  void dispose() {
    _debounce?.cancel();
    unawaited(_uhfSub?.cancel());
    unawaited(_barcodeSub?.cancel());
    _searchCtrl.dispose();
    // Release scanner-mode flips. Other screens that want a specific
    // mode will re-assert on entry; we just make sure we don't leave
    // the device in a half-state.
    unawaited(RfidVendorChannel.setZebraTriggerModeRfid());
    super.dispose();
  }

  void _activateBothScanners() {
    // Keep the 2D engine warm AND the trigger flipped to UHF — Chainway
    // can fire 2D barcode broadcasts independently of the trigger when
    // the imager is open, and Zebra reads route through the same
    // hardware_barcode broadcast when paired in HID-keyboard fallback.
    unawaited(RfidVendorChannel.open2dBarcode());
    unawaited(RfidVendorChannel.enableRfidFunctionMode());
    unawaited(RfidVendorChannel.setZebraTriggerModeRfid());
  }

  void _attachStreams() {
    final rfid = context.read<RfidManager>();
    _uhfSub = rfid.geigerTagReads.listen(_onUhfRead, onError: (_) {});
    _barcodeSub = RfidVendorChannel.hardwareBarcodeStream().listen(
      _onBarcodeRead,
      onError: (_) {},
    );
  }

  // ── status-label load ────────────────────────────────────────────────
  Future<void> _loadStatusLabels() async {
    setState(() {
      _labelsLoading = true;
      _labelsError = null;
    });
    try {
      final api = context.read<WmsApiClient>();
      final res = await api.fetchScannerStatusLabels();
      final rows = (res['rows'] as List?) ?? const [];
      final parsed = rows.whereType<Map<String, dynamic>>().map((r) {
        return _StatusLabel(
          name: r['name']?.toString() ?? '',
          displayLabel: (r['display_label']?.toString().trim().isNotEmpty ?? false)
              ? r['display_label'].toString()
              : (r['name']?.toString() ?? ''),
          applicable: r['applicable'] == true,
          superAdminLocked: r['super_admin_locked'] == true,
          systemOnly: r['is_system_only'] == true,
        );
      }).toList();
      if (!mounted) return;
      setState(() {
        _statusLabels = parsed;
        _isSuperAdmin = res['super_admin'] == true;
        _labelsLoading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _labelsLoading = false;
        _labelsError = 'Status list unavailable: $e';
      });
    }
  }

  // ── trigger / scanner inputs ─────────────────────────────────────────
  void _onBarcodeRead(String raw) {
    if (!mounted) return;
    final code = raw.trim();
    if (code.isEmpty) return;
    // EPC-shaped (24 hex) → treat as a UHF read instead of a search query.
    final isEpc24 = RegExp(r'^[0-9A-F]{24}$').hasMatch(code.toUpperCase());
    if (isEpc24) {
      unawaited(_jumpFromEpc(code.toUpperCase()));
      return;
    }
    // Anything else → drop into the search box and run the search.
    if (_step != _StatusStep.search) {
      setState(() => _step = _StatusStep.search);
    }
    _searchCtrl.text = code;
    _searchCtrl.selection =
        TextSelection.collapsed(offset: _searchCtrl.text.length);
    _onSearchChanged(code);
  }

  void _onUhfRead(RfidTagRead read) {
    if (!mounted) return;
    final epc = read.epcHex24.toUpperCase();
    if (epc.isEmpty) return;
    // Only accept UHF when the operator is actively at the search step
    // (or already inspecting a different EPC). Mid-commit reads are
    // ignored so we don't yank state out from under them.
    if (_step == _StatusStep.pickStatus && _committing) return;
    unawaited(_jumpFromEpc(epc));
  }

  Future<void> _jumpFromEpc(String epc) async {
    final api = context.read<WmsApiClient>();
    try {
      final row = await api.lookupCatalogByEpc(epc);
      if (!mounted) return;
      if (row == null) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('EPC not at this location: $epc')),
        );
        return;
      }
      // Pre-fetch this EPC's row in fetchCatalogEpcs so we can pre-select.
      await _selectItem(row, jumpToEpc: epc);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text('Lookup failed: $e')));
    }
  }

  // ── catalog search ───────────────────────────────────────────────────
  void _onSearchChanged(String value) {
    _debounce?.cancel();
    final trimmed = value.trim();
    if (trimmed.length < _minQueryLen) {
      if (_searchResults.isNotEmpty || _query.isNotEmpty) {
        setState(() {
          _query = '';
          _searchResults = [];
          _searchError = null;
        });
      }
      return;
    }
    _debounce = Timer(_searchDebounce, () {
      if (!mounted) return;
      if (trimmed == _query) return;
      setState(() => _query = trimmed);
      unawaited(_runSearch());
    });
  }

  Future<void> _runSearch() async {
    if (_query.isEmpty) return;
    setState(() {
      _searchLoading = true;
      _searchError = null;
      _searchResults = [];
    });
    try {
      final api = context.read<WmsApiClient>();
      final res = await api.fetchCatalogGrid(q: _query, page: 1, limit: 100);
      if (!mounted) return;
      final rows = (res['rows'] as List?)
              ?.whereType<Map<String, dynamic>>()
              .toList() ??
          [];
      setState(() {
        _searchResults = rows;
        _searchLoading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _searchLoading = false;
        _searchError = 'Search failed: $e';
      });
    }
  }

  // ── select item → load EPCs ──────────────────────────────────────────
  Future<void> _selectItem(
    Map<String, dynamic> row, {
    String? jumpToEpc,
  }) async {
    final id = row['custom_sku_id']?.toString() ?? '';
    if (id.isEmpty) return;
    setState(() {
      _selectedItem = row;
      _itemEpcs = [];
      _epcsLoading = true;
      _epcsError = null;
      _step = _StatusStep.pickEpc;
    });
    try {
      final api = context.read<WmsApiClient>();
      final epcs = await api.fetchCatalogEpcs(id);
      if (!mounted) return;
      setState(() {
        _itemEpcs = epcs;
        _epcsLoading = false;
      });
      if (jumpToEpc != null) {
        Map<String, dynamic>? match;
        for (final e in epcs) {
          if ((e['epc']?.toString() ?? '').toUpperCase() == jumpToEpc) {
            match = e;
            break;
          }
        }
        if (match != null) {
          _selectEpc(match);
        }
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _epcsLoading = false;
        _epcsError = 'EPC list failed: $e';
      });
    }
  }

  void _selectEpc(Map<String, dynamic> row) {
    setState(() {
      _selectedEpcRow = row;
      _selectedTargetStatus = '';
      _override = false;
      _step = _StatusStep.pickStatus;
    });
  }

  // ── commit ───────────────────────────────────────────────────────────
  Future<void> _commit() async {
    final epcRow = _selectedEpcRow;
    final target = _selectedTargetStatus.trim();
    if (epcRow == null || target.isEmpty) return;
    final epc = epcRow['epc']?.toString() ?? '';
    if (epc.isEmpty) return;
    setState(() => _committing = true);
    try {
      final api = context.read<WmsApiClient>();
      final res = await api.postBulkStatus(
        epcs: [epc],
        targetStatus: target,
        override: _override,
      );
      if (!mounted) return;
      final updated = (res['updated'] as num?)?.toInt() ?? 0;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(updated > 0
            ? 'Status updated → $target'
            : 'No change applied (status may already match)')),
      );
      ScanSounds.instance.play(ScanCue.success);
      _resetToSearch();
    } catch (e) {
      if (!mounted) return;
      ScanSounds.instance.play(ScanCue.error);
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text('Commit failed: $e')));
    } finally {
      if (mounted) setState(() => _committing = false);
    }
  }

  void _resetToSearch() {
    setState(() {
      _step = _StatusStep.search;
      _selectedItem = null;
      _itemEpcs = [];
      _selectedEpcRow = null;
      _selectedTargetStatus = '';
      _override = false;
      _searchCtrl.clear();
      _query = '';
      _searchResults = [];
    });
  }

  // ── ui ───────────────────────────────────────────────────────────────
  @override
  Widget build(BuildContext context) {
    return CarbonScaffold(
      pageTitle: 'STATUS CHANGE',
      body: SafeArea(
        top: false,
        child: Column(
          children: [
            _StepHeader(
              step: _step,
              onBack: _step == _StatusStep.search ? null : _stepBack,
            ),
            Expanded(child: _buildStepBody()),
            const RfidPowerSlider(),
          ],
        ),
      ),
    );
  }

  void _stepBack() {
    setState(() {
      if (_step == _StatusStep.pickStatus) {
        _step = _StatusStep.pickEpc;
        _selectedEpcRow = null;
        _selectedTargetStatus = '';
        _override = false;
      } else if (_step == _StatusStep.pickEpc) {
        _step = _StatusStep.search;
        _selectedItem = null;
        _itemEpcs = [];
      }
    });
  }

  Widget _buildStepBody() {
    switch (_step) {
      case _StatusStep.search:
        return _buildSearch();
      case _StatusStep.pickEpc:
        return _buildEpcList();
      case _StatusStep.pickStatus:
        return _buildStatusPick();
    }
  }

  // ── search step ──────────────────────────────────────────────────────
  Widget _buildSearch() {
    return Column(
      children: [
        Padding(
          padding: EdgeInsets.fromLTRB(20.w, 12.h, 20.w, 8.h),
          child: _SearchBar(
            controller: _searchCtrl,
            onChanged: _onSearchChanged,
            onClear: () {
              _searchCtrl.clear();
              _onSearchChanged('');
            },
          ),
        ),
        Padding(
          padding: EdgeInsets.fromLTRB(20.w, 0, 20.w, 8.h),
          child: Align(
            alignment: Alignment.centerLeft,
            child: Text(
              _query.isEmpty
                  ? 'TYPE · 2D · OR PULL TRIGGER FOR UHF'
                  : (_searchLoading
                      ? 'SEARCHING…'
                      : '${_searchResults.length} RESULTS'),
              style: GoogleFonts.spaceGrotesk(
                fontSize: 11.sp,
                fontWeight: FontWeight.w700,
                letterSpacing: 1.4,
                color: const Color(0xFF6D7979),
              ),
            ),
          ),
        ),
        if (_searchError != null)
          Padding(
            padding: EdgeInsets.fromLTRB(20.w, 4.h, 20.w, 4.h),
            child: Text(
              _searchError!,
              style: GoogleFonts.manrope(
                fontSize: 12.sp,
                fontWeight: FontWeight.w700,
                color: const Color(0xFFBF2E2E),
              ),
            ),
          ),
        Expanded(
          child: _query.isEmpty
              ? const _SearchEmptyHint()
              : _searchLoading && _searchResults.isEmpty
                  ? const Center(child: CircularProgressIndicator())
                  : _searchResults.isEmpty
                      ? Center(
                          child: Padding(
                            padding: EdgeInsets.all(24.r),
                            child: Text(
                              'No matches for "$_query".',
                              textAlign: TextAlign.center,
                              style: GoogleFonts.manrope(
                                fontSize: 14.sp,
                                fontWeight: FontWeight.w700,
                                color: const Color(0xFF5A6464),
                              ),
                            ),
                          ),
                        )
                      : ListView.separated(
                          padding: EdgeInsets.fromLTRB(20.w, 0, 20.w, 12.h),
                          itemCount: _searchResults.length,
                          separatorBuilder: (_, __) => SizedBox(height: 12.h),
                          itemBuilder: (_, i) {
                            final r = _searchResults[i];
                            return CatalogRowCard(
                              row: r,
                              onQtyTap: () => _selectItem(r),
                            );
                          },
                        ),
        ),
      ],
    );
  }

  // ── EPC list step ────────────────────────────────────────────────────
  Widget _buildEpcList() {
    final item = _selectedItem;
    final name = item?['name']?.toString() ?? '';
    final color = item?['color']?.toString() ?? '';
    final size = item?['size']?.toString() ?? '';
    final sku = item?['sku']?.toString() ?? '';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _ItemSummaryCard(name: name, color: color, size: size, sku: sku),
        if (_epcsError != null)
          Padding(
            padding: EdgeInsets.fromLTRB(20.w, 8.h, 20.w, 0),
            child: Text(
              _epcsError!,
              style: GoogleFonts.manrope(
                fontSize: 12.sp,
                fontWeight: FontWeight.w700,
                color: const Color(0xFFBF2E2E),
              ),
            ),
          ),
        Expanded(
          child: _epcsLoading
              ? const Center(child: CircularProgressIndicator())
              : _itemEpcs.isEmpty
                  ? Center(
                      child: Padding(
                        padding: EdgeInsets.all(24.r),
                        child: Text(
                          'No in-stock EPCs at this location.',
                          textAlign: TextAlign.center,
                          style: GoogleFonts.manrope(
                            fontSize: 14.sp,
                            fontWeight: FontWeight.w700,
                            color: const Color(0xFF5A6464),
                          ),
                        ),
                      ),
                    )
                  : ListView.separated(
                      padding: EdgeInsets.fromLTRB(20.w, 12.h, 20.w, 12.h),
                      itemCount: _itemEpcs.length,
                      separatorBuilder: (_, __) => SizedBox(height: 8.h),
                      itemBuilder: (_, i) {
                        final r = _itemEpcs[i];
                        return _EpcPickRow(
                          row: r,
                          onTap: () => _selectEpc(r),
                        );
                      },
                    ),
        ),
      ],
    );
  }

  // ── status pick step ─────────────────────────────────────────────────
  Widget _buildStatusPick() {
    final item = _selectedItem;
    final epcRow = _selectedEpcRow;
    final name = item?['name']?.toString() ?? '';
    final color = item?['color']?.toString() ?? '';
    final size = item?['size']?.toString() ?? '';
    final sku = item?['sku']?.toString() ?? '';
    final epc = epcRow?['epc']?.toString().toUpperCase() ?? '';
    final currentStatus = epcRow?['status']?.toString() ?? '';
    final binCode = epcRow?['bin_code']?.toString() ?? '';

    final applicable = _statusLabels.where((s) => s.applicable).toList();
    final unavailable = _statusLabels.where((s) => !s.applicable).toList();

    final canCommit = _selectedTargetStatus.isNotEmpty &&
        _selectedTargetStatus != currentStatus &&
        !_committing;

    return Column(
      children: [
        _ItemSummaryCard(
          name: name,
          color: color,
          size: size,
          sku: sku,
          epc: epc,
          currentStatus: currentStatus,
          binCode: binCode,
        ),
        Expanded(
          child: ListView(
            padding: EdgeInsets.fromLTRB(20.w, 12.h, 20.w, 12.h),
            children: [
              Text(
                'CHOOSE NEW STATUS',
                style: GoogleFonts.spaceGrotesk(
                  fontSize: 11.sp,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 1.4,
                  color: const Color(0xFF6D7979),
                ),
              ),
              SizedBox(height: 8.h),
              if (_labelsLoading)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 16),
                  child: Center(child: CircularProgressIndicator()),
                )
              else if (_labelsError != null)
                Text(
                  _labelsError!,
                  style: GoogleFonts.manrope(
                    fontSize: 12.sp,
                    fontWeight: FontWeight.w700,
                    color: const Color(0xFFBF2E2E),
                  ),
                )
              else ...[
                for (final s in applicable)
                  _StatusOptionTile(
                    label: s.displayLabel,
                    value: s.name,
                    selected: _selectedTargetStatus == s.name,
                    disabled: s.name == currentStatus,
                    onTap: () =>
                        setState(() => _selectedTargetStatus = s.name),
                  ),
                if (unavailable.isNotEmpty) ...[
                  SizedBox(height: 16.h),
                  Text(
                    'LOCKED · SUPER ADMIN ONLY',
                    style: GoogleFonts.spaceGrotesk(
                      fontSize: 10.sp,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 1.4,
                      color: const Color(0xFF8A9595),
                    ),
                  ),
                  SizedBox(height: 6.h),
                  for (final s in unavailable)
                    _StatusOptionTile(
                      label: s.displayLabel,
                      value: s.name,
                      selected: false,
                      disabled: true,
                      onTap: () {},
                    ),
                ],
              ],
              SizedBox(height: 16.h),
              if (_isSuperAdmin)
                CheckboxListTile(
                  contentPadding: EdgeInsets.zero,
                  controlAffinity: ListTileControlAffinity.leading,
                  title: Text(
                    'Override risky transitions (e.g. sold → in-stock)',
                    style: GoogleFonts.manrope(
                      fontSize: 13.sp,
                      fontWeight: FontWeight.w700,
                      color: AppColors.textMain,
                    ),
                  ),
                  value: _override,
                  onChanged: (v) => setState(() => _override = v ?? false),
                ),
            ],
          ),
        ),
        Padding(
          padding: EdgeInsets.fromLTRB(20.w, 0, 20.w, 16.h),
          child: _CommitButton(
            enabled: canCommit,
            busy: _committing,
            onTap: canCommit ? _commit : null,
          ),
        ),
      ],
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// step header — shows current step + back affordance
// ═══════════════════════════════════════════════════════════════════════════

class _StepHeader extends StatelessWidget {
  const _StepHeader({required this.step, this.onBack});

  final _StatusStep step;
  final VoidCallback? onBack;

  String get _label {
    switch (step) {
      case _StatusStep.search:
        return '1 · FIND ITEM';
      case _StatusStep.pickEpc:
        return '2 · PICK EPC';
      case _StatusStep.pickStatus:
        return '3 · PICK STATUS';
    }
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 36.h,
      padding: EdgeInsets.symmetric(horizontal: 20.w),
      color: const Color(0xFFF0F5F4),
      child: Row(
        children: [
          if (onBack != null)
            GestureDetector(
              onTap: onBack,
              behavior: HitTestBehavior.opaque,
              child: Padding(
                padding: EdgeInsets.only(right: 10.w),
                child: Icon(
                  LucideIcons.chevronLeft,
                  size: 18.sp,
                  color: const Color(0xFF3D4949),
                ),
              ),
            ),
          Text(
            _label,
            style: GoogleFonts.spaceGrotesk(
              fontSize: 11.sp,
              fontWeight: FontWeight.w800,
              letterSpacing: 1.6,
              color: const Color(0xFF3D4949),
            ),
          ),
        ],
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// search bar (reused styling from geiger)
// ═══════════════════════════════════════════════════════════════════════════

class _SearchBar extends StatelessWidget {
  const _SearchBar({
    required this.controller,
    required this.onChanged,
    required this.onClear,
  });

  final TextEditingController controller;
  final ValueChanged<String> onChanged;
  final VoidCallback onClear;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: const BoxDecoration(
        color: Color(0xFFF0F5F4),
        borderRadius: BorderRadius.all(Radius.circular(2)),
      ),
      child: Padding(
        padding: EdgeInsets.symmetric(horizontal: 12.w),
        child: Row(
          children: [
            Icon(Icons.search, size: 22.sp, color: const Color(0xFF6D7979)),
            SizedBox(width: 10.w),
            Expanded(
              child: TextField(
                controller: controller,
                onChanged: onChanged,
                autofocus: true,
                textInputAction: TextInputAction.search,
                style: GoogleFonts.spaceGrotesk(
                  fontSize: 15.sp,
                  fontWeight: FontWeight.w600,
                  color: AppColors.textMain,
                ),
                decoration: InputDecoration(
                  border: InputBorder.none,
                  isCollapsed: true,
                  contentPadding: EdgeInsets.symmetric(vertical: 16.h),
                  hintText: 'EPC · SKU · UPC · NAME · BIN',
                  hintStyle: GoogleFonts.spaceGrotesk(
                    fontSize: 13.sp,
                    fontWeight: FontWeight.w600,
                    letterSpacing: 1.2,
                    color: const Color(0xFF6D7979),
                  ),
                ),
              ),
            ),
            if (controller.text.isNotEmpty)
              GestureDetector(
                onTap: onClear,
                child: Padding(
                  padding: EdgeInsets.symmetric(horizontal: 6.w),
                  child: Icon(Icons.close,
                      size: 20.sp, color: const Color(0xFF6D7979)),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _SearchEmptyHint extends StatelessWidget {
  const _SearchEmptyHint();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: EdgeInsets.all(24.r),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(LucideIcons.scan,
                size: 48.sp, color: const Color(0xFFBCC9C9)),
            SizedBox(height: 12.h),
            Text(
              'TYPE · 2D · OR PULL TRIGGER',
              textAlign: TextAlign.center,
              style: GoogleFonts.spaceGrotesk(
                fontSize: 13.sp,
                fontWeight: FontWeight.w800,
                letterSpacing: 1.6,
                color: const Color(0xFF5A6464),
              ),
            ),
            SizedBox(height: 6.h),
            Text(
              'A 2D barcode fills the search.\nA UHF read jumps straight to status.',
              textAlign: TextAlign.center,
              style: GoogleFonts.manrope(
                fontSize: 12.sp,
                fontWeight: FontWeight.w600,
                color: const Color(0xFF6D7979),
                height: 1.4,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// item summary card — shared by EPC-list + status-pick steps
// ═══════════════════════════════════════════════════════════════════════════

class _ItemSummaryCard extends StatelessWidget {
  const _ItemSummaryCard({
    required this.name,
    required this.color,
    required this.size,
    required this.sku,
    this.epc,
    this.currentStatus,
    this.binCode,
  });

  final String name;
  final String color;
  final String size;
  final String sku;
  final String? epc;
  final String? currentStatus;
  final String? binCode;

  @override
  Widget build(BuildContext context) {
    final desc = [
      if (name.isNotEmpty) name,
      if (color.isNotEmpty) color,
      if (size.isNotEmpty) size,
    ].join(' · ');
    return Container(
      width: double.infinity,
      color: const Color(0xFFECECEC),
      padding: EdgeInsets.fromLTRB(16.w, 12.h, 16.w, 12.h),
      margin: EdgeInsets.fromLTRB(20.w, 12.h, 20.w, 0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: [
              Expanded(
                child: Text(
                  sku.isEmpty ? 'SKU: —' : 'SKU: $sku',
                  style: GoogleFonts.robotoMono(
                    fontSize: 16.sp,
                    fontWeight: FontWeight.w700,
                    color: AppColors.textMain,
                  ),
                ),
              ),
              if (binCode != null && binCode!.isNotEmpty)
                Container(
                  padding:
                      EdgeInsets.symmetric(horizontal: 10.w, vertical: 4.h),
                  color: AppColors.primary,
                  child: Text(
                    'BIN $binCode',
                    style: GoogleFonts.spaceGrotesk(
                      fontSize: 12.sp,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 1.0,
                      color: Colors.white,
                    ),
                  ),
                ),
            ],
          ),
          if (desc.isNotEmpty) ...[
            SizedBox(height: 4.h),
            Text(
              desc,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: GoogleFonts.manrope(
                fontSize: 13.sp,
                fontWeight: FontWeight.w700,
                color: AppColors.textMain,
              ),
            ),
          ],
          if (epc != null && epc!.isNotEmpty) ...[
            SizedBox(height: 6.h),
            Text(
              'EPC · $epc',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: GoogleFonts.spaceGrotesk(
                fontSize: 12.sp,
                fontWeight: FontWeight.w700,
                letterSpacing: 0.4,
                color: const Color(0xFF3F4A4A),
              ),
            ),
          ],
          if (currentStatus != null && currentStatus!.isNotEmpty) ...[
            SizedBox(height: 4.h),
            Text(
              'CURRENT · ${currentStatus!.toUpperCase()}',
              style: GoogleFonts.spaceGrotesk(
                fontSize: 11.sp,
                fontWeight: FontWeight.w700,
                letterSpacing: 1.2,
                color: const Color(0xFF6D7979),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// EPC list row — tap to drill into status pick
// ═══════════════════════════════════════════════════════════════════════════

class _EpcPickRow extends StatelessWidget {
  const _EpcPickRow({required this.row, required this.onTap});

  final Map<String, dynamic> row;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final epc = row['epc']?.toString().toUpperCase() ?? '';
    final status = row['status']?.toString() ?? '';
    final bin = row['bin_code']?.toString() ?? '';
    return Material(
      color: const Color(0xFFECECEC),
      borderRadius: BorderRadius.zero,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: EdgeInsets.fromLTRB(12.w, 10.h, 12.w, 10.h),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      epc.isEmpty ? '—' : epc,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: GoogleFonts.spaceGrotesk(
                        fontSize: 14.sp,
                        fontWeight: FontWeight.w700,
                        letterSpacing: 0.4,
                        color: AppColors.textMain,
                      ),
                    ),
                    SizedBox(height: 2.h),
                    Text(
                      [
                        if (status.isNotEmpty) status.toUpperCase(),
                        if (bin.isNotEmpty) 'BIN $bin',
                      ].join(' · '),
                      style: GoogleFonts.spaceGrotesk(
                        fontSize: 11.sp,
                        fontWeight: FontWeight.w700,
                        letterSpacing: 1.0,
                        color: const Color(0xFF6D7979),
                      ),
                    ),
                  ],
                ),
              ),
              Icon(LucideIcons.chevronRight,
                  size: 18.sp, color: const Color(0xFF6D7979)),
            ],
          ),
        ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// status option tile — radio-style, with disabled state for current status
// ═══════════════════════════════════════════════════════════════════════════

class _StatusOptionTile extends StatelessWidget {
  const _StatusOptionTile({
    required this.label,
    required this.value,
    required this.selected,
    required this.disabled,
    required this.onTap,
  });

  final String label;
  final String value;
  final bool selected;
  final bool disabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final fg = disabled
        ? const Color(0xFF8A9595)
        : (selected ? Colors.white : AppColors.textMain);
    final bg = disabled
        ? const Color(0xFFEEEEEE)
        : (selected ? AppColors.primary : const Color(0xFFF0F5F4));
    return Padding(
      padding: EdgeInsets.only(bottom: 6.h),
      child: Material(
        color: bg,
        child: InkWell(
          onTap: disabled ? null : onTap,
          child: Padding(
            padding:
                EdgeInsets.symmetric(horizontal: 14.w, vertical: 12.h),
            child: Row(
              children: [
                Icon(
                  selected
                      ? Icons.radio_button_checked
                      : Icons.radio_button_unchecked,
                  size: 18.sp,
                  color: fg,
                ),
                SizedBox(width: 10.w),
                Expanded(
                  child: Text(
                    label,
                    style: GoogleFonts.manrope(
                      fontSize: 14.sp,
                      fontWeight: FontWeight.w800,
                      color: fg,
                    ),
                  ),
                ),
                if (disabled)
                  Text(
                    'CURRENT',
                    style: GoogleFonts.spaceGrotesk(
                      fontSize: 10.sp,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 1.2,
                      color: fg,
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// commit button
// ═══════════════════════════════════════════════════════════════════════════

class _CommitButton extends StatelessWidget {
  const _CommitButton({
    required this.enabled,
    required this.busy,
    required this.onTap,
  });

  final bool enabled;
  final bool busy;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final bg = enabled ? AppColors.primary : const Color(0xFFBCC9C9);
    return GestureDetector(
      onTap: enabled && !busy ? onTap : null,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 150),
        height: 56.h,
        decoration: BoxDecoration(
          color: bg,
          boxShadow: const [
            BoxShadow(
              color: Color(0x24000000),
              blurRadius: 18,
              offset: Offset(0, 8),
            ),
          ],
        ),
        child: Center(
          child: busy
              ? const SizedBox(
                  width: 22,
                  height: 22,
                  child: CircularProgressIndicator(
                    strokeWidth: 2.4,
                    valueColor: AlwaysStoppedAnimation(Colors.white),
                  ),
                )
              : Text(
                  'COMMIT STATUS CHANGE',
                  style: GoogleFonts.manrope(
                    fontSize: 15.sp,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 2.0,
                    color: Colors.white,
                  ),
                ),
        ),
      ),
    );
  }
}
