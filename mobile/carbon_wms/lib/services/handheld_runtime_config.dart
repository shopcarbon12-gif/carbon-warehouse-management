import 'dart:convert';

/// Subset of server `handheld_settings` applied to RFID drivers + UI templates.
class HandheldRuntimeConfig {
  const HandheldRuntimeConfig({
    required this.triggerModeHoldRelease,
    required this.transferOutAntennaPower,
    required this.transferInAntennaPower,
    required this.transferOutPowerLock,
    required this.itemDetailsTemplate,
    required this.tagDetailsTemplate,
  });

  /// When true, hardware should use hold-to-scan; when false, click/single-shot style.
  final bool triggerModeHoldRelease;
  final int transferOutAntennaPower;
  final int transferInAntennaPower;
  final bool transferOutPowerLock;
  final String itemDetailsTemplate;
  final String tagDetailsTemplate;

  HandheldRuntimeConfig copyWith({
    bool? triggerModeHoldRelease,
    int? transferOutAntennaPower,
    int? transferInAntennaPower,
    bool? transferOutPowerLock,
    String? itemDetailsTemplate,
    String? tagDetailsTemplate,
  }) {
    return HandheldRuntimeConfig(
      triggerModeHoldRelease: triggerModeHoldRelease ?? this.triggerModeHoldRelease,
      transferOutAntennaPower: transferOutAntennaPower ?? this.transferOutAntennaPower,
      transferInAntennaPower: transferInAntennaPower ?? this.transferInAntennaPower,
      transferOutPowerLock: transferOutPowerLock ?? this.transferOutPowerLock,
      itemDetailsTemplate: itemDetailsTemplate ?? this.itemDetailsTemplate,
      tagDetailsTemplate: tagDetailsTemplate ?? this.tagDetailsTemplate,
    );
  }

  static const HandheldRuntimeConfig fallback = HandheldRuntimeConfig(
    triggerModeHoldRelease: true,
    transferOutAntennaPower: 270,
    transferInAntennaPower: 240,
    transferOutPowerLock: true,
    itemDetailsTemplate: '{{item.customSku}} - {{item.name}}',
    tagDetailsTemplate: '{{epc.id}}\n{{epc.status}} · {{epc.zone}}',
  );

  factory HandheldRuntimeConfig.fromMobileSyncJson(Map<String, dynamic> root) {
    final handheld = root['handheld_settings'];
    if (handheld is! Map) return fallback;

    final system = handheld['system'];
    final transfer = handheld['transfer'];

    var holdRelease = true;
    if (system is Map && system['triggerMode'] == 'CLICK') {
      holdRelease = false;
    }

    var outPower = 270;
    var inPower = 240;
    var powerLock = true;
    if (transfer is Map) {
      final o = transfer['transferOutAntennaPower'];
      final i = transfer['transferInAntennaPower'];
      final l = transfer['transferOutPowerLock'];
      if (o is num) outPower = o.round().clamp(0, 300);
      if (i is num) inPower = i.round().clamp(0, 300);
      if (l is bool) powerLock = l;
    }

    final itemT = handheld['itemDetailsTemplate'];
    final tagT = handheld['tagDetailsTemplate'];

    return HandheldRuntimeConfig(
      triggerModeHoldRelease: holdRelease,
      transferOutAntennaPower: outPower,
      transferInAntennaPower: inPower,
      transferOutPowerLock: powerLock,
      itemDetailsTemplate:
          itemT is String && itemT.trim().isNotEmpty ? itemT : fallback.itemDetailsTemplate,
      tagDetailsTemplate:
          tagT is String && tagT.trim().isNotEmpty ? tagT : fallback.tagDetailsTemplate,
    );
  }

  Map<String, dynamic> toJson() => {
        'triggerModeHoldRelease': triggerModeHoldRelease,
        'transferOutAntennaPower': transferOutAntennaPower,
        'transferInAntennaPower': transferInAntennaPower,
        'transferOutPowerLock': transferOutPowerLock,
        'itemDetailsTemplate': itemDetailsTemplate,
        'tagDetailsTemplate': tagDetailsTemplate,
      };

  static HandheldRuntimeConfig? fromJsonString(String? raw) {
    if (raw == null || raw.isEmpty) return null;
    try {
      final m = jsonDecode(raw) as Map<String, dynamic>;
      return HandheldRuntimeConfig(
        triggerModeHoldRelease: m['triggerModeHoldRelease'] != false,
        transferOutAntennaPower: (m['transferOutAntennaPower'] as num?)?.round().clamp(0, 300) ?? 270,
        transferInAntennaPower: (m['transferInAntennaPower'] as num?)?.round().clamp(0, 300) ?? 240,
        transferOutPowerLock: m['transferOutPowerLock'] != false,
        itemDetailsTemplate: m['itemDetailsTemplate'] as String? ?? fallback.itemDetailsTemplate,
        tagDetailsTemplate: m['tagDetailsTemplate'] as String? ?? fallback.tagDetailsTemplate,
      );
    } catch (_) {
      return null;
    }
  }

  String toJsonString() => jsonEncode(toJson());
}
