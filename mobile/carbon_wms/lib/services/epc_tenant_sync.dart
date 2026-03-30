int? _intField(dynamic v) {
  if (v is num) return v.round();
  return null;
}

/// Parsed from `GET /api/settings/mobile-sync` (`epc_settings` / `epc_profiles`).
class TenantEpcSettings {
  const TenantEpcSettings({
    required this.encodingStandard,
    required this.companyPrefix,
    this.activeProfileId,
  });

  final String encodingStandard;
  final String companyPrefix;
  final String? activeProfileId;

  static TenantEpcSettings? fromMobileSyncRoot(Map<String, dynamic>? root) {
    if (root == null) return null;
    final raw = root['epc_settings'];
    if (raw is! Map) return null;
    final std = raw['encodingStandard'] ?? raw['encoding_standard'];
    final prefix = raw['companyPrefix'] ?? raw['company_prefix'];
    final active = raw['activeProfileId'] ?? raw['active_profile_id'];
    if (prefix is! String || prefix.trim().isEmpty) return null;
    return TenantEpcSettings(
      encodingStandard: std is String ? std : 'CUSTOM',
      companyPrefix: prefix.trim().toUpperCase(),
      activeProfileId: active is String ? active : null,
    );
  }
}

class TenantEpcProfile {
  const TenantEpcProfile({
    required this.id,
    required this.name,
    required this.epcPrefix,
    required this.itemStartBit,
    required this.itemLength,
    required this.serialStartBit,
    required this.serialLength,
    required this.isActive,
  });

  final String id;
  final String name;
  final String epcPrefix;
  final int itemStartBit;
  final int itemLength;
  final int serialStartBit;
  final int serialLength;
  final bool isActive;

  static List<TenantEpcProfile> listFromMobileSyncRoot(Map<String, dynamic>? root) {
    if (root == null) return [];
    final raw = root['epc_profiles'];
    if (raw is! List) return [];
    final out = <TenantEpcProfile>[];
    for (final item in raw) {
      if (item is! Map) continue;
      final id = item['id']?.toString() ?? '';
      final name = item['name']?.toString() ?? id;
      final pfx = item['epcPrefix'] ?? item['epc_prefix'];
      if (pfx is! String || pfx.trim().isEmpty) continue;
      out.add(
        TenantEpcProfile(
          id: id.isEmpty ? pfx : id,
          name: name,
          epcPrefix: pfx.trim().toUpperCase(),
          itemStartBit: _intField(item['itemStartBit']) ?? _intField(item['item_start_bit']) ?? 32,
          itemLength: _intField(item['itemLength']) ?? _intField(item['item_length']) ?? 40,
          serialStartBit: _intField(item['serialStartBit']) ?? _intField(item['serial_start_bit']) ?? 80,
          serialLength: _intField(item['serialLength']) ?? _intField(item['serial_length']) ?? 36,
          isActive: item['isActive'] == true || item['is_active'] == true,
        ),
      );
    }
    return out;
  }
}

/// First active profile whose hex prefix matches the EPC (24 hex chars typical).
TenantEpcProfile? matchingEpcProfile(String epcHex, List<TenantEpcProfile> profiles) {
  final upper = epcHex.replaceAll(RegExp(r'\s'), '').toUpperCase();
  if (upper.length < 4) return null;
  for (final p in profiles) {
    if (!p.isActive) continue;
    if (upper.startsWith(p.epcPrefix.toUpperCase())) return p;
  }
  return null;
}
