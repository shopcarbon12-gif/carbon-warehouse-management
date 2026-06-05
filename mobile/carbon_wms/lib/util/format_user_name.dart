/// Canonical user display name for the WHOLE mobile app — UI and exported docs.
///
/// Rule (locked 2026-06): never show a user's email in any human-facing place.
/// Always render "First L." — first name + last-initial + dot, e.g. "Elior P.".
/// Falls back to the email's local part, then the raw email, only when no name
/// is on file (so an unnamed account never renders blank). Mirrors the server
/// helper in lib/format-user-name.ts so mobile and web agree 1:1.
String formatUserDisplayName(String? first, String? last, [String? email]) {
  final f = (first ?? '').trim();
  final l = (last ?? '').trim();
  if (f.isNotEmpty) {
    return l.isNotEmpty ? '$f ${l[0].toUpperCase()}.' : f;
  }
  final e = (email ?? '').trim();
  if (e.isNotEmpty) {
    final local = e.split('@').first.trim();
    return local.isNotEmpty ? local : e;
  }
  return '';
}
