// Item-line text helpers shared by Count / Add-On Catalog
// (count_inventory_screen.dart) and Add-On Count (add_on_epc_card.dart), so
// both render SKU name / BIN / price identically. Moved verbatim from
// count_inventory_screen.dart (names made public) on 2026-10-13.

/// When true, strip a trailing `<COLOR> <SIZE>` or `<SIZE>` suffix from the
/// catalog `name` before rendering. Some catalogs store the variant's color
/// and size baked into the matrix description (e.g., `m.description` comes
/// back as "ELODIE TOP SWEATSUIT BLACK S" for every variant of that matrix),
/// which visually duplicates catalog-sourced `color` and `size` fields when
/// rendered as `name · size / color`.
///
/// Strategy: data-driven strip — we only remove the trailing segment when it
/// exactly matches the catalog's own color/size values. No blind regex over
/// unrelated words. Generic "S"/"M"/"L" letter fallback is also applied when
/// no explicit size hint is available, guarded by the flag.
///
/// Cosmetic only — does not mutate the catalog or any stored data, only the
/// rendered string. Default true for this tenant's data shape; flip to false
/// on any catalog where the matrix description is already variant-clean.
const bool kStripNameSizeSuffix = true;
final RegExp _nameSizeLetterSuffix = RegExp(r'\s+(XXL|XXS|XL|XS|S|M|L)\s*$');

/// Normalize a bin code to the canonical `X-X-XX-X` shape used by the Bin
/// Assign screen. Strips any existing separators, uppercases, and re-inserts
/// dashes at the fixed positions when the compacted code is exactly 5 chars.
/// Other lengths pass through uppercased so older / malformed codes still
/// render (without silently dropping characters).
String formatBinCode(String raw) {
  final s = raw.trim().toUpperCase().replaceAll(RegExp(r'[-\s]'), '');
  if (s.length == 5) {
    return '${s[0]}-${s[1]}-${s.substring(2, 4)}-${s[4]}';
  }
  return raw.trim().toUpperCase();
}

/// Render a SKU's bin location for the UI.
///
/// The catalog endpoint returns `bin_location` as a comma-joined list of all
/// bins that hold the SKU (string_agg on the server side). When a SKU lives
/// in multiple bins we surface the alphabetically-first one followed by an
/// `xN` counter (e.g. `3-C-05-R x4`) so the row stays single-line. A single
/// bin renders without the suffix. Empty input renders empty.
String formatBinDisplay(String? raw) {
  if (raw == null) return '';
  final parts = raw
      .split(',')
      .map((s) => s.trim())
      .where((s) => s.isNotEmpty)
      .toList();
  if (parts.isEmpty) return '';
  final first = formatBinCode(parts.first);
  if (parts.length == 1) return first;
  return '$first x${parts.length}';
}

/// Strip any trailing `<color> <size>`, `<size>`, or `<color>` tail from [name]
/// when [kStripNameSizeSuffix] is true. Matching is case-insensitive against
/// the catalog values. Generic letter-size regex is also applied (S/M/L/XL/XS/
/// XXL/XXS), to catch cases where the matrix description embeds a variant
/// that differs from the current variant (e.g., description baked with
/// "BLACK S" but the current variant row is "BLACK L").
///
/// Iterates until no more tails peel — this handles the common pattern where
/// the description is `<NAME> <COLOR> <SIZE>` and we need to remove both in
/// sequence regardless of which layer matches first.
String stripNameSizeSuffix(String name, {String? size, String? color}) {
  if (!kStripNameSizeSuffix) return name;
  var out = name.trimRight();
  final sz = size?.trim() ?? '';
  final cl = color?.trim() ?? '';

  bool stripTail(String tail) {
    if (tail.isEmpty) return false;
    final lower = out.toLowerCase();
    final t = tail.toLowerCase();
    if (lower.endsWith(' $t')) {
      out = out.substring(0, out.length - (t.length + 1)).trimRight();
      return true;
    }
    return false;
  }

  // Iterate: peel the longest matching tail first, then retry. Up to 4 passes
  // (color+size, size alone, color alone, generic letter-size) to converge.
  var changed = true;
  var guard = 0;
  while (changed && guard < 4) {
    changed = false;
    guard++;
    if (sz.isNotEmpty && cl.isNotEmpty && stripTail('$cl $sz')) { changed = true; continue; }
    if (sz.isNotEmpty && stripTail(sz)) { changed = true; continue; }
    if (cl.isNotEmpty && stripTail(cl)) { changed = true; continue; }
    if (_nameSizeLetterSuffix.hasMatch(out)) {
      out = out.replaceFirst(_nameSizeLetterSuffix, '').trimRight();
      changed = true;
      continue;
    }
  }
  return out;
}

/// "\$52.00" from a num or numeric string; '' when null, unparseable or <= 0
/// (same rule as Count's _priceText). Caller still gates on FieldFlags.showRetailPrice.
String formatRetailPrice(Object? raw) {
  if (raw == null) return '';
  final double? price = raw is num ? raw.toDouble() : double.tryParse(raw.toString());
  if (price == null || !price.isFinite || price <= 0) return '';
  return '\$${price.toStringAsFixed(2)}';
}
