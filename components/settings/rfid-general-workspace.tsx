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
        <p className="font-mono text-xs text-slate-500">Loading…</p>
      ) : (
        <div className="max-w-xl space-y-5 rounded-xl border border-slate-800 bg-zinc-950/60 p-6">
          <p className="font-mono text-[0.65rem] text-slate-500">
            Global RFID EPC encoding defaults for this tenant. Bit layouts are configured under EPC setting
            profiles.
          </p>

          <label className="block font-mono text-xs text-slate-400">
            Encoding standard
            <select
              value={encoding}
              onChange={(e) => setEncoding(e.target.value as "SENITRON" | "CUSTOM")}
              className="mt-1 w-full rounded border border-slate-700 bg-zinc-900 px-3 py-2 text-slate-100"
            >
              <option value="SENITRON">SENITRON (default)</option>
              <option value="CUSTOM">Custom</option>
            </select>
          </label>

          <label className="block font-mono text-xs text-slate-400">
            Company prefix (hex)
            <input
              value={prefix}
              onChange={(e) => setPrefix(e.target.value.toUpperCase().replace(/[^0-9A-F]/g, ""))}
              maxLength={12}
              className="mt-1 w-full rounded border border-slate-700 bg-zinc-900 px-3 py-2 font-mono text-slate-100"
            />
          </label>

          <label className="block font-mono text-xs text-slate-400">
            Active EPC profile (optional)
            <select
              value={activeId ?? ""}
              onChange={(e) => setActiveId(e.target.value || null)}
              className="mt-1 w-full rounded border border-slate-700 bg-zinc-900 px-3 py-2 text-slate-100"
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
              className={`font-mono text-xs ${msg === "Saved." ? "text-emerald-400/90" : "text-red-400/90"}`}
            >
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
              {busy ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={onReset}
              className="rounded-md border border-slate-600 px-4 py-2 font-mono text-xs text-slate-300 hover:bg-zinc-800"
            >
              Reset
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
