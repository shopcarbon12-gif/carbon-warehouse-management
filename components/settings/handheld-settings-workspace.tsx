"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import useSWR from "swr";
import type { HandheldSettings, TenantSettingsRow } from "@/lib/settings/tenant-settings-defaults";
import { WmsToggle } from "@/components/ui/wms-toggle";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? res.statusText);
  }
  return res.json() as Promise<TenantSettingsRow>;
};

const fieldClass =
  "wms-field mt-1 w-full max-w-xs rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-[0.8125em] text-[var(--wms-fg)] shadow-[inset_0_1px_2px_rgba(0,0,0,0.06)] placeholder:text-[var(--wms-muted)]";

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
    return <p className="font-mono text-[0.8125em] text-red-500">{error.message}</p>;
  }
  if (isLoading || !data || !h) {
    return <p className="font-mono text-[0.8125em] text-[var(--wms-muted)]">Loading…</p>;
  }

  return (
    <div className="space-y-8">
      <Section title="System">
        <label className="mb-2 block font-mono text-[0.8125em] text-[var(--wms-muted)]">
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
            className={fieldClass}
          >
            <option value="HOLD_RELEASE">Hold / release (continuous)</option>
            <option value="CLICK">Click (single read)</option>
          </select>
        </label>
        <WmsToggle
          checked={h.system.vibrateOnRead}
          onChange={(v) => setH((s) => (s ? { ...s, system: { ...s.system, vibrateOnRead: v } } : s))}
          label="Vibrate on tag read"
        />
        <WmsToggle
          checked={h.system.beepOnRead}
          onChange={(v) => setH((s) => (s ? { ...s, system: { ...s.system, beepOnRead: v } } : s))}
          label="Beep on tag read"
        />
      </Section>

      <Section title="Inventory">
        <WmsToggle
          checked={h.inventory.autoSaveInventoryData}
          onChange={(v) =>
            setH((s) => (s ? { ...s, inventory: { ...s.inventory, autoSaveInventoryData: v } } : s))
          }
          label="Auto-save inventory data"
        />
        <WmsToggle
          checked={h.inventory.confirmOnQtyChange}
          onChange={(v) =>
            setH((s) => (s ? { ...s, inventory: { ...s.inventory, confirmOnQtyChange: v } } : s))
          }
          label="Confirm on quantity change"
        />
      </Section>

      <Section title="Transfer">
        <WmsToggle
          checked={h.transfer.transferOutPowerLock}
          onChange={(v) =>
            setH((s) => (s ? { ...s, transfer: { ...s.transfer, transferOutPowerLock: v } } : s))
          }
          label="Transfer-out power lock (high power for outbound)"
        />
        <label className="block py-2 font-mono text-[0.8125em] text-[var(--wms-muted)]">
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
            className={fieldClass}
          />
        </label>
        <label className="block py-2 font-mono text-[0.8125em] text-[var(--wms-muted)]">
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
            className={fieldClass}
          />
        </label>
      </Section>

      <Section title="Encoding">
        <WmsToggle
          checked={h.encoding.validateEpcChecksum}
          onChange={(v) =>
            setH((s) => (s ? { ...s, encoding: { ...s.encoding, validateEpcChecksum: v } } : s))
          }
          label="Validate EPC checksum"
        />
      </Section>

      <Section title="Item details (scanner template)">
        <p className="mb-2 font-mono text-[0.65em] leading-relaxed text-[var(--wms-muted)]">
          Variables:{" "}
          <code className="text-[var(--wms-fg)]">
            {`{{item.customSku}} {{item.name}} {{item.upc}} {{item.vendor}} {{item.color}} {{item.size}} {{item.price}} {{item.quantity}}`}
          </code>
        </p>
        <textarea
          value={h.itemDetailsTemplate}
          onChange={(e) => setH((s) => (s ? { ...s, itemDetailsTemplate: e.target.value } : s))}
          rows={3}
          className={`${fieldClass} min-h-[5em] w-full max-w-none font-mono`}
        />
      </Section>

      <Section title="Tag details (scanner template)">
        <p className="mb-2 font-mono text-[0.65em] leading-relaxed text-[var(--wms-muted)]">
          Variables:{" "}
          <code className="text-[var(--wms-fg)]">{`{{epc.id}} {{epc.status}} {{epc.lastSeen}} {{epc.zone}}`}</code>
        </p>
        <textarea
          value={h.tagDetailsTemplate}
          onChange={(e) => setH((s) => (s ? { ...s, tagDetailsTemplate: e.target.value } : s))}
          rows={4}
          className={`${fieldClass} min-h-[6em] w-full max-w-none font-mono`}
        />
      </Section>

      {msg ? (
        <p
          className={`font-mono text-[0.8125em] ${msg === "Saved." ? "text-emerald-600 dark:text-emerald-400/90" : "text-red-500"}`}
        >
          {msg}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void onSave()}
          className="rounded-md bg-[var(--wms-accent)] px-4 py-2 font-mono text-[0.8125em] font-semibold text-slate-950 shadow-[0_2px_8px_color-mix(in_oklab,var(--wms-accent)_40%,transparent)] hover:brightness-110 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save handheld settings"}
        </button>
        <button
          type="button"
          onClick={() => setH(structuredClone(data.handheld_settings))}
          className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-4 py-2 font-mono text-[0.8125em] text-[var(--wms-fg)] hover:bg-[var(--wms-surface)]"
        >
          Reset
        </button>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] p-5 shadow-[0_1px_0_rgba(255,255,255,0.04)_inset] dark:bg-[color-mix(in_oklab,var(--wms-surface)_92%,black)]">
      <h2 className="mb-2 border-b border-[var(--wms-border)] pb-2 font-mono text-[0.65em] font-bold uppercase tracking-wider text-[var(--wms-accent)]">
        {title}
      </h2>
      <div>{children}</div>
    </div>
  );
}
