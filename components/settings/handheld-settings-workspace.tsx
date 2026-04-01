"use client";

import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import useSWR from "swr";
import type { HandheldSettings, TenantSettingsRow } from "@/lib/settings/tenant-settings-defaults";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? res.statusText);
  }
  return res.json() as Promise<TenantSettingsRow>;
};

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  const uid = useId();
  const id = `handheld-toggle-${uid.replace(/:/g, "")}`;
  return (
    <label
      htmlFor={id}
      className="flex cursor-pointer items-center justify-between gap-4 border-b border-[var(--wms-border)]/80 py-3.5 font-mono text-xs text-[var(--wms-fg)] last:border-0"
    >
      <span className="min-w-0 pr-2 font-medium leading-snug">{label}</span>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={[
          "relative h-7 w-12 shrink-0 rounded-full border-2 transition-[box-shadow,background-color,border-color] duration-200 ease-out",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--wms-accent)]/55 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--wms-surface)]",
          checked
            ? [
                "border-[color-mix(in_srgb,var(--wms-accent)_48%,#ffffff)]",
                "bg-[linear-gradient(180deg,color-mix(in_srgb,var(--wms-accent)_32%,#ffffff)_0%,var(--wms-accent)_42%,color-mix(in_srgb,var(--wms-accent)_72%,#000000)_100%)]",
                "shadow-[inset_0_2px_5px_rgba(255,255,255,0.35),inset_0_-4px_10px_rgba(0,0,0,0.2),0_0_0_1px_color-mix(in_srgb,var(--wms-accent)_32%,transparent),0_0_16px_color-mix(in_srgb,var(--wms-accent)_50%,transparent),0_0_34px_color-mix(in_srgb,var(--wms-accent)_26%,transparent),0_4px_14px_rgba(0,0,0,0.1)]",
                "dark:border-[color-mix(in_srgb,var(--wms-accent)_40%,transparent)]",
                "dark:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--wms-accent)_22%,#ffffff)_0%,var(--wms-accent)_45%,color-mix(in_srgb,var(--wms-accent)_65%,#000000)_100%)]",
                "dark:shadow-[inset_0_2px_6px_rgba(255,255,255,0.2),inset_0_-5px_12px_rgba(0,0,0,0.36),0_0_0_1px_color-mix(in_srgb,var(--wms-accent)_28%,transparent),0_0_22px_color-mix(in_srgb,var(--wms-accent)_58%,transparent),0_0_48px_color-mix(in_srgb,var(--wms-accent)_34%,transparent),0_0_72px_color-mix(in_srgb,var(--wms-accent)_16%,transparent)]",
              ].join(" ")
            : [
                "border-[color-mix(in_srgb,var(--wms-border)_90%,#000000)]",
                "bg-[linear-gradient(180deg,color-mix(in_srgb,var(--wms-surface-elevated)_55%,#ffffff)_0%,color-mix(in_srgb,var(--wms-muted)_22%,var(--wms-surface-elevated))_100%)]",
                "shadow-[inset_0_3px_7px_rgba(0,0,0,0.14),inset_0_-2px_5px_rgba(255,255,255,0.45),0_1px_0_rgba(255,255,255,0.65),0_2px_4px_rgba(0,0,0,0.06)]",
                "dark:border-[color-mix(in_srgb,var(--wms-border)_85%,#000000)]",
                "dark:bg-[linear-gradient(180deg,#252a34_0%,color-mix(in_srgb,var(--wms-muted)_28%,var(--wms-surface-elevated))_100%)]",
                "dark:shadow-[inset_0_5px_12px_rgba(0,0,0,0.58),inset_0_1px_0_rgba(255,255,255,0.07),0_1px_0_rgba(255,255,255,0.04)]",
              ].join(" "),
        ].join(" ")}
      >
        <span
          className={[
            "pointer-events-none absolute top-1/2 h-5 w-5 -translate-y-1/2 rounded-full ring-1 transition-all duration-200 ease-out",
            checked
              ? [
                  "left-[calc(100%-1.375rem)]",
                  "bg-[linear-gradient(165deg,color-mix(in_srgb,var(--wms-accent-fg)_8%,#ffffff)_0%,var(--wms-accent-fg)_45%,color-mix(in_srgb,var(--wms-accent-fg)_88%,#000000)_100%)]",
                  "ring-[color-mix(in_srgb,var(--wms-accent-fg)_42%,var(--wms-accent))]",
                  "shadow-[0_0_12px_color-mix(in_srgb,var(--wms-accent)_72%,transparent),0_0_26px_color-mix(in_srgb,var(--wms-accent)_40%,transparent),0_3px_10px_rgba(0,0,0,0.22),inset_0_1px_2px_rgba(255,255,255,0.45)]",
                  "dark:bg-[linear-gradient(165deg,color-mix(in_srgb,var(--wms-accent)_35%,var(--wms-accent-fg))_0%,var(--wms-accent-fg)_55%,#000000_100%)]",
                  "dark:ring-[color-mix(in_srgb,var(--wms-accent)_55%,var(--wms-accent-fg))]",
                  "dark:shadow-[0_0_16px_color-mix(in_srgb,var(--wms-accent)_82%,transparent),0_0_36px_color-mix(in_srgb,var(--wms-accent)_52%,transparent),0_0_56px_color-mix(in_srgb,var(--wms-accent)_26%,transparent),0_3px_12px_rgba(0,0,0,0.45),inset_0_1px_1px_rgba(255,255,255,0.12)]",
                ].join(" ")
              : [
                  "left-0.5",
                  "bg-[linear-gradient(165deg,#ffffff_0%,#e8eaee_55%,#d9dce2_100%)]",
                  "ring-[color-mix(in_srgb,var(--wms-border)_75%,transparent)]",
                  "shadow-[0_2px_6px_rgba(0,0,0,0.16),inset_0_2px_3px_rgba(255,255,255,0.95),inset_0_-2px_4px_rgba(0,0,0,0.06)]",
                  "dark:bg-[linear-gradient(165deg,color-mix(in_srgb,var(--wms-fg)_94%,#ffffff)_0%,color-mix(in_srgb,var(--wms-fg)_68%,var(--wms-surface-elevated))_100%)]",
                  "dark:ring-[color-mix(in_srgb,var(--wms-border)_70%,transparent)]",
                  "dark:shadow-[0_2px_10px_rgba(0,0,0,0.55),inset_0_1px_2px_rgba(255,255,255,0.14),inset_0_-2px_5px_rgba(0,0,0,0.35)]",
                ].join(" "),
          ].join(" ")}
        />
      </button>
    </label>
  );
}

export function HandheldSettingsWorkspace() {
  const { data, error, mutate, isLoading } = useSWR("/api/settings/tenant-settings", fetcher, {
    revalidateOnFocus: false,
  });

  const [h, setH] = useState<HandheldSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    setH(structuredClone(data.handheld_settings));
    setMsg(null);
  }, [data]);

  const onSave = useCallback(async () => {
    if (!h) return;
    setMsg(null);
    setBusy(true);
    try {
      const res = await fetch("/api/settings/tenant-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handheld_settings: h }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? "Save failed");
      setMsg("Saved.");
      void mutate();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }, [h, mutate]);

  if (error) {
    return <p className="font-mono text-xs text-red-600 dark:text-red-400/90">{error.message}</p>;
  }
  if (isLoading || !data || !h) {
    return <p className="font-mono text-xs text-[var(--wms-muted)]">Loading…</p>;
  }

  return (
    <div className="space-y-8">
      <Section title="System">
        <label className="mb-2 block font-mono text-xs text-[var(--wms-muted)]">
          Trigger mode
          <select
            value={h.system.triggerMode}
            onChange={(e) =>
              setH((s) =>
                s
                  ? {
                      ...s,
                      system: {
                        ...s.system,
                        triggerMode: e.target.value as HandheldSettings["system"]["triggerMode"],
                      },
                    }
                  : s,
              )
            }
            className="mt-1 w-full max-w-xs rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 text-[var(--wms-fg)] focus:border-[var(--wms-accent)]/55 focus:outline-none focus:ring-1 focus:ring-[var(--wms-accent)]/35"
          >
            <option value="HOLD_RELEASE">Hold / release (continuous)</option>
            <option value="CLICK">Click (single read)</option>
          </select>
        </label>
        <Toggle
          checked={h.system.vibrateOnRead}
          onChange={(v) => setH((s) => (s ? { ...s, system: { ...s.system, vibrateOnRead: v } } : s))}
          label="Vibrate on tag read"
        />
        <Toggle
          checked={h.system.beepOnRead}
          onChange={(v) => setH((s) => (s ? { ...s, system: { ...s.system, beepOnRead: v } } : s))}
          label="Beep on tag read"
        />
      </Section>

      <Section title="Inventory">
        <Toggle
          checked={h.inventory.autoSaveInventoryData}
          onChange={(v) =>
            setH((s) => (s ? { ...s, inventory: { ...s.inventory, autoSaveInventoryData: v } } : s))
          }
          label="Auto-save inventory data"
        />
        <Toggle
          checked={h.inventory.confirmOnQtyChange}
          onChange={(v) =>
            setH((s) => (s ? { ...s, inventory: { ...s.inventory, confirmOnQtyChange: v } } : s))
          }
          label="Confirm on quantity change"
        />
      </Section>

      <Section title="Transfer">
        <Toggle
          checked={h.transfer.transferOutPowerLock}
          onChange={(v) =>
            setH((s) => (s ? { ...s, transfer: { ...s.transfer, transferOutPowerLock: v } } : s))
          }
          label="Transfer-out power lock (high power for outbound)"
        />
        <label className="block py-2 font-mono text-xs text-[var(--wms-muted)]">
          Transfer-out antenna power (0–30 dBm)
          <input
            type="number"
            min={0}
            max={30}
            value={h.transfer.transferOutAntennaPower}
            onChange={(e) =>
              setH((s) =>
                s
                  ? {
                      ...s,
                      transfer: {
                        ...s.transfer,
                        transferOutAntennaPower: Math.min(30, Math.max(0, Number(e.target.value) || 0)),
                      },
                    }
                  : s,
              )
            }
            className="mt-1 w-full max-w-xs rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 text-[var(--wms-fg)] focus:border-[var(--wms-accent)]/55 focus:outline-none focus:ring-1 focus:ring-[var(--wms-accent)]/35"
          />
        </label>
        <label className="block py-2 font-mono text-xs text-[var(--wms-muted)]">
          Transfer-in antenna power (0–30 dBm)
          <input
            type="number"
            min={0}
            max={30}
            value={h.transfer.transferInAntennaPower}
            onChange={(e) =>
              setH((s) =>
                s
                  ? {
                      ...s,
                      transfer: {
                        ...s.transfer,
                        transferInAntennaPower: Math.min(30, Math.max(0, Number(e.target.value) || 0)),
                      },
                    }
                  : s,
              )
            }
            className="mt-1 w-full max-w-xs rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 text-[var(--wms-fg)] focus:border-[var(--wms-accent)]/55 focus:outline-none focus:ring-1 focus:ring-[var(--wms-accent)]/35"
          />
        </label>
      </Section>

      <Section title="Encoding">
        <Toggle
          checked={h.encoding.validateEpcChecksum}
          onChange={(v) =>
            setH((s) => (s ? { ...s, encoding: { ...s.encoding, validateEpcChecksum: v } } : s))
          }
          label="Validate EPC checksum"
        />
      </Section>

      <Section title="Item details (scanner template)">
        <p className="mb-2 font-mono text-[0.6rem] leading-relaxed text-[var(--wms-muted)]">
          Variables:{" "}
          <code className="text-[var(--wms-muted)]">
            {`{{item.customSku}} {{item.name}} {{item.upc}} {{item.vendor}} {{item.color}} {{item.size}} {{item.price}} {{item.quantity}}`}
          </code>
        </p>
        <textarea
          value={h.itemDetailsTemplate}
          onChange={(e) => setH((s) => (s ? { ...s, itemDetailsTemplate: e.target.value } : s))}
          rows={3}
          className="w-full rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-xs text-[var(--wms-fg)] focus:border-[var(--wms-accent)]/55 focus:outline-none focus:ring-1 focus:ring-[var(--wms-accent)]/35"
        />
      </Section>

      <Section title="Tag details (scanner template)">
        <p className="mb-2 font-mono text-[0.6rem] leading-relaxed text-[var(--wms-muted)]">
          Variables:{" "}
          <code className="text-[var(--wms-muted)]">{`{{epc.id}} {{epc.status}} {{epc.lastSeen}} {{epc.zone}}`}</code>
        </p>
        <textarea
          value={h.tagDetailsTemplate}
          onChange={(e) => setH((s) => (s ? { ...s, tagDetailsTemplate: e.target.value } : s))}
          rows={4}
          className="w-full rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-xs text-[var(--wms-fg)] focus:border-[var(--wms-accent)]/55 focus:outline-none focus:ring-1 focus:ring-[var(--wms-accent)]/35"
        />
      </Section>

      {msg ? (
        <p
          className={`font-mono text-xs ${
            msg === "Saved."
              ? "text-[color-mix(in_srgb,var(--wms-accent)_8%,#14532d)] dark:text-emerald-400/90"
              : "text-red-600 dark:text-red-400/90"
          }`}
        >
          {msg}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void onSave()}
          className="rounded-lg border border-[var(--wms-accent)]/50 bg-[var(--wms-accent)] px-4 py-2 font-mono text-xs font-semibold text-[var(--wms-accent-fg)] shadow-sm hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save handheld settings"}
        </button>
        <button
          type="button"
          onClick={() => setH(structuredClone(data.handheld_settings))}
          className="rounded-lg border border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-muted)_10%,var(--wms-surface-elevated))] px-4 py-2 font-mono text-xs font-medium text-[var(--wms-fg)] shadow-sm hover:border-[var(--wms-accent)]/35"
        >
          Reset
        </button>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)]/60 p-5">
      <h2 className="mb-2 border-b border-[var(--wms-border)] pb-2 font-mono text-[0.65rem] font-bold uppercase tracking-wider text-[var(--wms-secondary)]">
        {title}
      </h2>
      <div>{children}</div>
    </div>
  );
}
