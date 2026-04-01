"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
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
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 border-b border-slate-800/80 py-3 font-mono text-xs text-slate-300 last:border-0">
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-10 shrink-0 rounded-full border transition-colors ${
          checked ? "border-teal-500/60 bg-teal-600/35" : "border-slate-600 bg-slate-800/80"
        }`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-slate-100 transition-transform ${
            checked ? "translate-x-4" : "translate-x-0.5"
          }`}
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
    return <p className="font-mono text-xs text-red-400/90">{error.message}</p>;
  }
  if (isLoading || !data || !h) {
    return <p className="font-mono text-xs text-slate-500">Loading…</p>;
  }

  return (
    <div className="space-y-8">
      <Section title="System">
        <label className="mb-2 block font-mono text-xs text-slate-500">
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
            className="mt-1 w-full max-w-xs rounded border border-slate-700 bg-zinc-900 px-3 py-2 text-slate-100"
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
        <label className="block py-2 font-mono text-xs text-slate-500">
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
            className="mt-1 w-full max-w-xs rounded border border-slate-700 bg-zinc-900 px-3 py-2 text-slate-100"
          />
        </label>
        <label className="block py-2 font-mono text-xs text-slate-500">
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
            className="mt-1 w-full max-w-xs rounded border border-slate-700 bg-zinc-900 px-3 py-2 text-slate-100"
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
        <p className="mb-2 font-mono text-[0.6rem] leading-relaxed text-slate-500">
          Variables:{" "}
          <code className="text-slate-400">
            {`{{item.customSku}} {{item.name}} {{item.upc}} {{item.vendor}} {{item.color}} {{item.size}} {{item.price}} {{item.quantity}}`}
          </code>
        </p>
        <textarea
          value={h.itemDetailsTemplate}
          onChange={(e) => setH((s) => (s ? { ...s, itemDetailsTemplate: e.target.value } : s))}
          rows={3}
          className="w-full rounded border border-slate-700 bg-zinc-900 px-3 py-2 font-mono text-xs text-slate-100"
        />
      </Section>

      <Section title="Tag details (scanner template)">
        <p className="mb-2 font-mono text-[0.6rem] leading-relaxed text-slate-500">
          Variables:{" "}
          <code className="text-slate-400">{`{{epc.id}} {{epc.status}} {{epc.lastSeen}} {{epc.zone}}`}</code>
        </p>
        <textarea
          value={h.tagDetailsTemplate}
          onChange={(e) => setH((s) => (s ? { ...s, tagDetailsTemplate: e.target.value } : s))}
          rows={4}
          className="w-full rounded border border-slate-700 bg-zinc-900 px-3 py-2 font-mono text-xs text-slate-100"
        />
      </Section>

      {msg ? (
        <p className={`font-mono text-xs ${msg === "Saved." ? "text-emerald-400/90" : "text-red-400/90"}`}>
          {msg}
        </p>
      ) : null}

      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void onSave()}
          className="rounded-md bg-teal-600 px-4 py-2 font-mono text-xs font-semibold text-white hover:bg-teal-500 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save handheld settings"}
        </button>
        <button
          type="button"
          onClick={() => setH(structuredClone(data.handheld_settings))}
          className="rounded-md border border-slate-600 px-4 py-2 font-mono text-xs text-slate-300 hover:bg-zinc-800"
        >
          Reset
        </button>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-zinc-950/60 p-5">
      <h2 className="mb-2 border-b border-slate-800 pb-2 font-mono text-[0.65rem] font-bold uppercase tracking-wider text-teal-500/90">
        {title}
      </h2>
      <div>{children}</div>
    </div>
  );
}
