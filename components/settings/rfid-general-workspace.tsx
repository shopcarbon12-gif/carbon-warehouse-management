"use client";

import { useCallback, useEffect, useState } from "react";
import useSWR from "swr";
import type { TenantSettingsRow } from "@/lib/settings/tenant-settings-defaults";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? res.statusText);
  }
  return res.json() as Promise<TenantSettingsRow>;
};

export function RfidGeneralWorkspace() {
  const { data, error, mutate, isLoading } = useSWR("/api/settings/tenant-settings", fetcher, {
    revalidateOnFocus: false,
  });

  const [encoding, setEncoding] = useState<"SENITRON" | "CUSTOM">("SENITRON");
  const [prefix, setPrefix] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    setEncoding(data.epc_settings.encodingStandard);
    setPrefix(data.epc_settings.companyPrefix);
    setActiveId(data.epc_settings.activeProfileId);
    setMsg(null);
  }, [data]);

  const onReset = useCallback(() => {
    if (!data) return;
    setEncoding(data.epc_settings.encodingStandard);
    setPrefix(data.epc_settings.companyPrefix);
    setActiveId(data.epc_settings.activeProfileId);
    setMsg(null);
  }, [data]);

  const onSave = useCallback(async () => {
    setMsg(null);
    setBusy(true);
    try {
      const res = await fetch("/api/settings/tenant-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          epc_settings: {
            encodingStandard: encoding,
            companyPrefix: prefix.replace(/\s/g, "").toUpperCase() || "F0A0B",
            activeProfileId: activeId,
          },
        }),
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
  }, [activeId, encoding, mutate, prefix]);

  const profiles = data?.epc_profiles ?? [];

  return (
    <div className="space-y-6">
      {error ? (
        <p className="font-mono text-xs text-red-400/90">{error.message}</p>
      ) : null}

      {isLoading || !data ? (
        <p className="font-mono text-xs text-[var(--wms-muted)]">Loading…</p>
      ) : (
        <div className="max-w-xl space-y-5 rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)]/60 p-6">
          <p className="font-mono text-[0.65rem] text-[var(--wms-muted)]">
            Global RFID EPC encoding defaults for this tenant. Bit layouts are configured under EPC setting
            profiles.
          </p>

          <label className="block font-mono text-xs text-[var(--wms-muted)]">
            Encoding standard
            <select
              value={encoding}
              onChange={(e) => setEncoding(e.target.value as "SENITRON" | "CUSTOM")}
              className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 text-[var(--wms-fg)]"
            >
              <option value="SENITRON">SENITRON (default)</option>
              <option value="CUSTOM">Custom</option>
            </select>
          </label>

          <label className="block font-mono text-xs text-[var(--wms-muted)]">
            Company prefix (hex)
            <input
              value={prefix}
              onChange={(e) => setPrefix(e.target.value.toUpperCase().replace(/[^0-9A-F]/g, ""))}
              maxLength={12}
              className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-[var(--wms-fg)]"
            />
          </label>

          <label className="block font-mono text-xs text-[var(--wms-muted)]">
            Active EPC profile (optional)
            <select
              value={activeId ?? ""}
              onChange={(e) => setActiveId(e.target.value || null)}
              className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 text-[var(--wms-fg)]"
            >
              <option value="">— None —</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} {!p.isActive ? "(inactive)" : ""}
                </option>
              ))}
            </select>
          </label>

          {msg ? (
            <p
              className={`font-mono text-xs ${msg === "Saved." ? "wms-status-success" : "text-red-600 dark:text-red-400/90"}`}
            >
              {msg}
            </p>
          ) : null}

          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void onSave()}
              className="wms-btn-primary wms-btn-sm font-mono disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={onReset}
              className="rounded-md border border-[var(--wms-border)] px-4 py-2 font-mono text-xs text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)]"
            >
              Reset
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
