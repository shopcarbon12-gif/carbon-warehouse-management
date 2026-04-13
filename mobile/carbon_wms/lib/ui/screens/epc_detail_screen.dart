import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/screens/locate_tag_screen.dart';

const Color _surface    = Color(0xFFFFFFFF);
const Color _surfaceLow = Color(0xFFF3F3F4);

/// Shows all EPCs for a single SKU assigned to a bin.
/// Tapping any EPC navigates to the Geiger (LocateTagScreen).
class EpcDetailScreen extends StatefulWidget {
  const EpcDetailScreen({
    super.key,
    required this.sku,
    required this.description,
    required this.binCode,
    required this.customSkuId,
    this.initialEpcs = const [],
  });

  final String sku;
  final String description;
  final String binCode;
  final String customSkuId;
  final List<String> initialEpcs;

  @override
  State<EpcDetailScreen> createState() => _EpcDetailScreenState();
}

class _EpcDetailScreenState extends State<EpcDetailScreen> {
  List<String> _epcs = [];
  bool _loading = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _epcs = List.of(widget.initialEpcs);
    if (_epcs.isEmpty) _loadEpcs();
  }

  Future<void> _loadEpcs() async {
    setState(() { _loading = true; _error = null; });
    try {
      final api = context.read<WmsApiClient>();
      final rows = await api.fetchEpcsForCustomSku(widget.sku);
      final epcs = rows.map((r) => r['epc']?.toString() ?? r['id']?.toString() ?? '').where((e) => e.isNotEmpty).toList();
      setState(() { _epcs = epcs; _loading = false; });
    } catch (e) {
      setState(() { _error = e.toString(); _loading = false; });
    }
  }

  @override
  Widget build(BuildContext context) {
    final isDark    = Theme.of(context).brightness == Brightness.dark;
    final bg        = isDark ? const Color(0xFF111A1A) : _surface;
    final bgLow     = isDark ? const Color(0xFF1C2828) : _surfaceLow;
    final mainColor = isDark ? const Color(0xFFE0ECEC) : AppColors.textMain;
    final muted     = isDark ? const Color(0xFF7A9090) : AppColors.textMuted;

    return Scaffold(
      backgroundColor: bg,
      appBar: AppBar(
        backgroundColor: bg,
        elevation: 0,
        surfaceTintColor: Colors.transparent,
        leading: IconButton(
          icon: Icon(Icons.arrow_back, color: mainColor),
          onPressed: () => Navigator.pop(context),
        ),
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              widget.sku,
              style: GoogleFonts.spaceGrotesk(
                fontSize: 16, fontWeight: FontWeight.w700, color: AppColors.primary),
            ),
            if (widget.description.isNotEmpty)
              Text(
                widget.description,
                style: GoogleFonts.manrope(fontSize: 12, color: muted),
              ),
          ],
        ),
        actions: [
          IconButton(
            icon: Icon(Icons.refresh, color: muted),
            onPressed: _loading ? null : _loadEpcs,
          ),
        ],
      ),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // ── Header ──────────────────────────────────────────────────────
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(
                  'BIN: ${widget.binCode}',
                  style: GoogleFonts.spaceGrotesk(
                    fontSize: 11, fontWeight: FontWeight.w700,
                    letterSpacing: 2.0, color: muted),
                ),
                Text(
                  '${_epcs.length} EPCs',
                  style: GoogleFonts.manrope(
                    fontSize: 13, fontWeight: FontWeight.w700, color: AppColors.primary),
                ),
              ],
            ),
          ),
          if (_loading)
            const LinearProgressIndicator(minHeight: 2),

          if (_error != null)
            Padding(
              padding: const EdgeInsets.all(16),
              child: Text(_error!, style: GoogleFonts.manrope(color: Colors.red.shade400)),
            ),

          // ── EPC list ─────────────────────────────────────────────────────
          Expanded(
            child: _epcs.isEmpty && !_loading
                ? Center(
                    child: Text(
                      'NO EPCS FOUND',
                      style: GoogleFonts.spaceGrotesk(
                        fontSize: 12, fontWeight: FontWeight.w700,
                        letterSpacing: 2.0, color: muted),
                    ),
                  )
                : ListView.builder(
                    padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
                    itemCount: _epcs.length,
                    itemBuilder: (ctx, i) {
                      final epc = _epcs[i];
                      return Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: GestureDetector(
                          onTap: () => Navigator.push(
                            context,
                            MaterialPageRoute(
                              builder: (_) => LocateTagScreen(targetEpc: epc),
                            ),
                          ),
                          child: Container(
                            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
                            decoration: BoxDecoration(
                              color: bgLow,
                              borderRadius: BorderRadius.circular(6),
                            ),
                            child: Row(
                              children: [
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      Text(
                                        'EPC ${i + 1}',
                                        style: GoogleFonts.spaceGrotesk(
                                          fontSize: 10, fontWeight: FontWeight.w700,
                                          letterSpacing: 1.5, color: muted),
                                      ),
                                      const SizedBox(height: 3),
                                      Text(
                                        epc,
                                        style: GoogleFonts.spaceGrotesk(
                                          fontSize: 13, fontWeight: FontWeight.w600,
                                          color: mainColor, letterSpacing: 0.3),
                                      ),
                                    ],
                                  ),
                                ),
                                Icon(Icons.radar, color: AppColors.primary, size: 22),
                                const SizedBox(width: 4),
                                Text(
                                  'LOCATE',
                                  style: GoogleFonts.manrope(
                                    fontSize: 11, fontWeight: FontWeight.w800,
                                    color: AppColors.primary, letterSpacing: 0.5),
                                ),
                              ],
                            ),
                          ),
                        ),
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }
}
