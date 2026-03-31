/**
 * Canonical defaults for `tenant_settings` JSONB columns (keep seed + mobile fallbacks aligned).
 */

import { normalizeAntennaPowerDbm } from "@/lib/settings/antenna-power";

export type EncodingStandard = "SENITRON" | "CUSTOM";

export type EpcSettings = {
  encodingStandard: EncodingStandard;
  /** Hex company prefix without 0x, e.g. F0A0B */
  companyPrefix: string;
  /** Matches `id` on an object in `epc_profiles`, or null */
  activeProfileId: string | null;
};

export type EpcProfile = {
  id: string;
  name: string;
  epcPrefix: string;
  itemStartBit: number;
  itemLength: number;
  serialStartBit: number;
  serialLength: number;
  isActive: boolean;
};

export type TriggerMode = "HOLD_RELEASE" | "CLICK";

export type HandheldSettings = {
  system: {
    triggerMode: TriggerMode;
    vibrateOnRead: boolean;
    beepOnRead: boolean;
  };
  inventory: {
    autoSaveInventoryData: boolean;
    confirmOnQtyChange: boolean;
  };
  transfer: {
    transferOutPowerLock: boolean;
    transferOutAntennaPower: number;
    transferInAntennaPower: number;
  };
  encoding: {
    validateEpcChecksum: boolean;
  };
  /** Scanner item detail line(s); variables: {{item.*}} */
  itemDetailsTemplate: string;
  /** Scanner tag / EPC line(s); variables: {{epc.*}} */
  tagDetailsTemplate: string;
};

export const DEFAULT_EPC_SETTINGS: EpcSettings = {
  encodingStandard: "SENITRON",
  companyPrefix: "F0A0B",
  activeProfileId: null,
};

export const DEFAULT_EPC_PROFILES: EpcProfile[] = [
  {
    id: "default",
    name: "Default profile",
    epcPrefix: "F0A0B",
    itemStartBit: 32,
    itemLength: 40,
    serialStartBit: 80,
    serialLength: 36,
    isActive: true,
  },
];

export const DEFAULT_HANDHELD_SETTINGS: HandheldSettings = {
  system: {
    triggerMode: "HOLD_RELEASE",
    vibrateOnRead: true,
    beepOnRead: true,
  },
  inventory: {
    autoSaveInventoryData: true,
    confirmOnQtyChange: false,
  },
  transfer: {
    transferOutPowerLock: true,
    /** dBm 0–30 (defaults ~90% / 80% of max) */
    transferOutAntennaPower: 27,
    transferInAntennaPower: 24,
  },
  encoding: {
    validateEpcChecksum: true,
  },
  itemDetailsTemplate: "{{item.customSku}} - {{item.name}}",
  tagDetailsTemplate: "{{epc.id}}\n{{epc.status}} · {{epc.zone}}",
};

export function normalizeEpcSettings(raw: unknown): EpcSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_EPC_SETTINGS };
  const o = raw as Record<string, unknown>;
  const enc = o.encodingStandard === "CUSTOM" ? "CUSTOM" : "SENITRON";
  const prefix =
    typeof o.companyPrefix === "string" && o.companyPrefix.trim()
      ? o.companyPrefix.trim().toUpperCase()
      : DEFAULT_EPC_SETTINGS.companyPrefix;
  const aid =
    typeof o.activeProfileId === "string" && o.activeProfileId.trim()
      ? o.activeProfileId.trim()
      : null;
  return { encodingStandard: enc, companyPrefix: prefix, activeProfileId: aid };
}

export function normalizeEpcProfiles(raw: unknown): EpcProfile[] {
  if (!Array.isArray(raw)) return DEFAULT_EPC_PROFILES.map((p) => ({ ...p }));
  const out: EpcProfile[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const id = typeof r.id === "string" && r.id.trim() ? r.id.trim() : "";
    if (!id) continue;
    out.push({
      id,
      name: typeof r.name === "string" ? r.name : id,
      epcPrefix:
        typeof r.epcPrefix === "string" && r.epcPrefix.trim()
          ? r.epcPrefix.trim().toUpperCase()
          : DEFAULT_EPC_SETTINGS.companyPrefix,
      itemStartBit: typeof r.itemStartBit === "number" && Number.isFinite(r.itemStartBit) ? r.itemStartBit : 32,
      itemLength: typeof r.itemLength === "number" && Number.isFinite(r.itemLength) ? r.itemLength : 40,
      serialStartBit:
        typeof r.serialStartBit === "number" && Number.isFinite(r.serialStartBit) ? r.serialStartBit : 80,
      serialLength:
        typeof r.serialLength === "number" && Number.isFinite(r.serialLength) ? r.serialLength : 36,
      isActive: r.isActive !== false,
    });
  }
  return out.length ? out : DEFAULT_EPC_PROFILES.map((p) => ({ ...p }));
}

export function normalizeHandheldSettings(raw: unknown): HandheldSettings {
  const base = structuredClone(DEFAULT_HANDHELD_SETTINGS);
  if (!raw || typeof raw !== "object") return base;
  const o = raw as Record<string, unknown>;
  if (o.system && typeof o.system === "object") {
    const s = o.system as Record<string, unknown>;
    if (s.triggerMode === "CLICK") base.system.triggerMode = "CLICK";
    if (typeof s.vibrateOnRead === "boolean") base.system.vibrateOnRead = s.vibrateOnRead;
    if (typeof s.beepOnRead === "boolean") base.system.beepOnRead = s.beepOnRead;
  }
  if (o.inventory && typeof o.inventory === "object") {
    const i = o.inventory as Record<string, unknown>;
    if (typeof i.autoSaveInventoryData === "boolean")
      base.inventory.autoSaveInventoryData = i.autoSaveInventoryData;
    if (typeof i.confirmOnQtyChange === "boolean")
      base.inventory.confirmOnQtyChange = i.confirmOnQtyChange;
  }
  if (o.transfer && typeof o.transfer === "object") {
    const t = o.transfer as Record<string, unknown>;
    if (typeof t.transferOutPowerLock === "boolean")
      base.transfer.transferOutPowerLock = t.transferOutPowerLock;
    if (typeof t.transferOutAntennaPower === "number" && Number.isFinite(t.transferOutAntennaPower))
      base.transfer.transferOutAntennaPower = normalizeAntennaPowerDbm(t.transferOutAntennaPower);
    if (typeof t.transferInAntennaPower === "number" && Number.isFinite(t.transferInAntennaPower))
      base.transfer.transferInAntennaPower = normalizeAntennaPowerDbm(t.transferInAntennaPower);
  }
  if (o.encoding && typeof o.encoding === "object") {
    const e = o.encoding as Record<string, unknown>;
    if (typeof e.validateEpcChecksum === "boolean")
      base.encoding.validateEpcChecksum = e.validateEpcChecksum;
  }
  if (typeof o.itemDetailsTemplate === "string" && o.itemDetailsTemplate.trim())
    base.itemDetailsTemplate = o.itemDetailsTemplate;
  if (typeof o.tagDetailsTemplate === "string" && o.tagDetailsTemplate.trim())
    base.tagDetailsTemplate = o.tagDetailsTemplate;
  return base;
}

export type TenantSettingsRow = {
  epc_settings: EpcSettings;
  epc_profiles: EpcProfile[];
  handheld_settings: HandheldSettings;
  updated_at: string;
};
