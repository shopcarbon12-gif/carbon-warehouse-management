import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:provider/provider.dart';

import 'package:carbon_wms/network/wms_api_client.dart';
import 'package:carbon_wms/services/scan_sounds.dart';
import 'package:carbon_wms/theme/app_theme.dart';
import 'package:carbon_wms/ui/widgets/carbon_scaffold.dart';

/// Status Change — pick step. Renders the operator's scanned batch as the
/// header ("ACTIVE BATCH · N EPCs") and a 2-column grid of status cards
/// (icon + bold label + subtitle). One status can be selected at a time;
/// COMMIT POSTs `bulk-status` for every EPC in the batch and pops back.
///
/// The actual `targetStatus` sent to `/api/inventory/bulk-status` is the
/// WMS canonical value ('in-stock', 'damaged', etc.) — NOT the label
/// `name` (which is the display form, e.g. "LIVE"). This screen owns the
/// mapping because the server allow-list rejects label names.
class StatusPickScreen extends StatefulWidget {
  const StatusPickScreen({
    super.key,
    required this.epcs,
    required this.statusOptions,
    required this.isSuperAdmin,
    this.onCommitted,
  });

  /// All EPCs the operator scanned on the previous screen.
  final List<String> epcs;

  /// Filtered+sorted status labels the operator may pick from. Pre-filtered
  /// to `applicable: true` rows so the grid never renders a disabled tile.
  final List<StatusOption> statusOptions;

  /// When true, the "Override risky transitions" checkbox is rendered. The
  /// server still requires the role gate.
  final bool isSuperAdmin;

  /// Notified on a successful commit so the caller can drop the scanned
  /// rows it had in memory. Called with the count of EPCs the server
  /// reported as updated.
  final void Function(int updated)? onCommitted;

  @override
  State<StatusPickScreen> createState() => _StatusPickScreenState();
}

/// Status label option as the picker sees it — label name + display copy +
/// the WMS value the bulk-status endpoint actually expects.
class StatusOption {
  const StatusOption({
    required this.labelName,
    required this.displayLabel,
    required this.wmsValue,
  });

  /// Display name from `status_labels.name` — e.g. "LIVE", "DAMAGED".
  final String labelName;

  /// Human-readable form. Often identical to [labelName]. We use this for
  /// the bold card title so designers can adjust copy without renaming
  /// the underlying label.
  final String displayLabel;

  /// WMS canonical name — what `POST /api/inventory/bulk-status` expects
  /// (e.g. "in-stock"). Derived from [labelName] via the static mapping
  /// in [StatusPickScreen.wmsValueForLabelName].
  final String wmsValue;
}

/// Visual treatment for a status tile. Icon, supporting subtitle, and any
/// per-status accent. Keyed off the canonical label name (uppercased).
class _StatusTileSpec {
  const _StatusTileSpec({
    required this.icon,
    required this.subtitle,
    this.iconColor,
  });
  final IconData icon;
  final String subtitle;
  final Color? iconColor;
}

const Map<String, _StatusTileSpec> _kTileSpecByLabel = {
  'LIVE': _StatusTileSpec(
    icon: LucideIcons.checkCircle,
    subtitle: 'SELLABLE\nREADY FOR DISPATCH',
    iconColor: Color(0xFF1B7D7D),
  ),
  'DAMAGED': _StatusTileSpec(
    icon: LucideIcons.octagon,
    subtitle: 'QUARANTINE REQUIRED',
    iconColor: Color(0xFFBF2E2E),
  ),
  'STOLEN': _StatusTileSpec(
    icon: LucideIcons.eyeOff,
    subtitle: 'SECURITY FLAG',
    iconColor: Color(0xFF3F4A4A),
  ),
  'RETURN': _StatusTileSpec(
    icon: LucideIcons.clipboardCheck,
    subtitle: 'MANUFACTURER PUSH',
    iconColor: Color(0xFF4C4FA1),
  ),
  'SOLD': _StatusTileSpec(
    icon: LucideIcons.tag,
    subtitle: 'POS COMPLETE',
    iconColor: Color(0xFF3F4A4A),
  ),
  'TAG KILLED': _StatusTileSpec(
    icon: LucideIcons.trash2,
    subtitle: 'RIP PROTOCOL',
    iconColor: Color(0xFF3F4A4A),
  ),
  'PENDING VISIBILITY': _StatusTileSpec(
    icon: LucideIcons.eye,
    subtitle: 'STAGING',
  ),
  'IN TRANSIT': _StatusTileSpec(
    icon: LucideIcons.truck,
    subtitle: 'ROUTING',
  ),
  'PENDING TRANSACTION': _StatusTileSpec(
    icon: LucideIcons.clock,
    subtitle: 'WAITING POS',
  ),
};

const _StatusTileSpec _kFallbackTileSpec = _StatusTileSpec(
  icon: LucideIcons.fileQuestion,
  subtitle: 'STATUS',
);

class _StatusPickScreenState extends State<StatusPickScreen> {
  StatusOption? _selected;
  bool _override = false;
  bool _committing = false;
  String? _commitError;

  Future<void> _commit() async {
    final picked = _selected;
    if (picked == null || widget.epcs.isEmpty) return;
    setState(() {
      _committing = true;
      _commitError = null;
    });
    try {
      final api = context.read<WmsApiClient>();
      final res = await api.postBulkStatus(
        epcs: widget.epcs,
        targetStatus: picked.wmsValue,
        override: _override,
      );
      if (!mounted) return;
      final updated = (res['updated'] as num?)?.toInt() ?? 0;
      ScanSounds.instance.play(
        updated > 0 ? ScanCue.success : ScanCue.error,
      );
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            updated > 0
                ? 'Updated $updated of ${widget.epcs.length} → ${picked.displayLabel}'
                : 'No tags updated (status may already match, or EPC not at this location)',
          ),
        ),
      );
      widget.onCommitted?.call(updated);
      // Pop only after a successful update so the operator can retry from
      // here on a soft failure (server returns 200/updated=0 when the EPC
      // is missing from items at this location — they may want to pick a
      // different status without re-scanning).
      if (updated > 0 && mounted) Navigator.of(context).pop();
    } on WmsApiException catch (e) {
      if (!mounted) return;
      ScanSounds.instance.play(ScanCue.error);
      setState(() => _commitError = 'HTTP ${e.statusCode}');
    } catch (e) {
      if (!mounted) return;
      ScanSounds.instance.play(ScanCue.error);
      setState(() => _commitError = e.toString());
    } finally {
      if (mounted) setState(() => _committing = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return CarbonScaffold(
      pageTitle: 'CHANGE STATUS',
      body: SafeArea(
        top: false,
        child: Column(
          children: [
            _ActiveBatchHeader(epcCount: widget.epcs.length),
            Expanded(child: _buildGrid()),
            if (_commitError != null)
              Container(
                width: double.infinity,
                color: const Color(0xFFFFF4F4),
                padding: EdgeInsets.symmetric(
                    horizontal: 20.w, vertical: 8.h),
                child: Text(
                  _commitError!,
                  style: GoogleFonts.spaceGrotesk(
                    fontSize: 12.sp,
                    fontWeight: FontWeight.w700,
                    color: const Color(0xFFD9534F),
                  ),
                ),
              ),
            if (widget.isSuperAdmin)
              Padding(
                padding: EdgeInsets.fromLTRB(20.w, 0, 20.w, 4.h),
                child: CheckboxListTile(
                  contentPadding: EdgeInsets.zero,
                  controlAffinity: ListTileControlAffinity.leading,
                  dense: true,
                  title: Text(
                    'Override risky transitions',
                    style: GoogleFonts.manrope(
                      fontSize: 13.sp,
                      fontWeight: FontWeight.w700,
                      color: AppColors.textMain,
                    ),
                  ),
                  value: _override,
                  onChanged: (v) => setState(() => _override = v ?? false),
                ),
              ),
            Padding(
              padding: EdgeInsets.fromLTRB(20.w, 8.h, 20.w, 16.h),
              child: _CommitButton(
                enabled: _selected != null && !_committing,
                busy: _committing,
                onTap: _commit,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildGrid() {
    final options = widget.statusOptions;
    if (options.isEmpty) {
      return Center(
        child: Padding(
          padding: EdgeInsets.all(24.r),
          child: Text(
            'No status options available.',
            style: GoogleFonts.manrope(
              fontSize: 13.sp,
              fontWeight: FontWeight.w600,
              color: const Color(0xFF6D7979),
            ),
          ),
        ),
      );
    }
    return GridView.builder(
      padding: EdgeInsets.fromLTRB(20.w, 14.h, 20.w, 14.h),
      gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
        crossAxisCount: 2,
        crossAxisSpacing: 12.w,
        mainAxisSpacing: 12.h,
        childAspectRatio: 1.0,
      ),
      itemCount: options.length,
      itemBuilder: (_, i) {
        final o = options[i];
        final spec = _kTileSpecByLabel[o.labelName.toUpperCase()] ??
            _kFallbackTileSpec;
        final selected = _selected?.labelName == o.labelName;
        return _StatusCard(
          label: o.displayLabel,
          subtitle: spec.subtitle,
          icon: spec.icon,
          iconColor: spec.iconColor ?? AppColors.primary,
          selected: selected,
          onTap: () => setState(() => _selected = o),
        );
      },
    );
  }
}

class _ActiveBatchHeader extends StatelessWidget {
  const _ActiveBatchHeader({required this.epcCount});
  final int epcCount;
  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      color: Colors.white,
      padding: EdgeInsets.fromLTRB(20.w, 16.h, 20.w, 12.h),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'ACTIVE BATCH',
            style: GoogleFonts.spaceGrotesk(
              fontSize: 11.sp,
              fontWeight: FontWeight.w800,
              letterSpacing: 2.0,
              color: const Color(0xFF6D7979),
            ),
          ),
          SizedBox(height: 4.h),
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(
                'CHANGE STATUS',
                style: GoogleFonts.spaceGrotesk(
                  fontSize: 26.sp,
                  fontWeight: FontWeight.w900,
                  letterSpacing: 0.8,
                  color: AppColors.textMain,
                  height: 1.0,
                ),
              ),
              SizedBox(width: 10.w),
              Padding(
                padding: EdgeInsets.only(bottom: 4.h),
                child: Text(
                  '· $epcCount EPC${epcCount == 1 ? '' : 's'}',
                  style: GoogleFonts.spaceGrotesk(
                    fontSize: 13.sp,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 1.0,
                    color: const Color(0xFF6D7979),
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _StatusCard extends StatelessWidget {
  const _StatusCard({
    required this.label,
    required this.subtitle,
    required this.icon,
    required this.iconColor,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final String subtitle;
  final IconData icon;
  final Color iconColor;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final bg = selected ? Colors.white : const Color(0xFFF3F3F4);
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Container(
        decoration: BoxDecoration(
          color: bg,
          border: selected
              ? Border.all(color: AppColors.primary, width: 2)
              : null,
        ),
        padding: EdgeInsets.all(12.r),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(icon, size: 36.sp, color: iconColor),
            SizedBox(height: 14.h),
            Text(
              label.toUpperCase(),
              textAlign: TextAlign.center,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: GoogleFonts.spaceGrotesk(
                fontSize: 16.sp,
                fontWeight: FontWeight.w900,
                letterSpacing: 0.6,
                color: AppColors.textMain,
              ),
            ),
            SizedBox(height: 4.h),
            Text(
              subtitle,
              textAlign: TextAlign.center,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: GoogleFonts.spaceGrotesk(
                fontSize: 11.sp,
                fontWeight: FontWeight.w700,
                letterSpacing: 1.2,
                color: const Color(0xFF6D7979),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

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
        duration: const Duration(milliseconds: 140),
        height: 56.h,
        color: bg,
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
              : Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Text(
                      'COMMIT',
                      style: GoogleFonts.spaceGrotesk(
                        fontSize: 16.sp,
                        fontWeight: FontWeight.w900,
                        letterSpacing: 2.4,
                        color: Colors.white,
                      ),
                    ),
                    SizedBox(width: 10.w),
                    Icon(LucideIcons.chevronRight,
                        color: Colors.white, size: 20.sp),
                  ],
                ),
        ),
      ),
    );
  }
}
