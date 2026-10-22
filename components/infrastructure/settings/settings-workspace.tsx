"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import type { InfrastructureSettingsDto } from "@/lib/server/infrastructure-settings";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? res.statusText);
  }
  return res.json();
};

// The old Lightspeed "Integrations" tab is retired and hidden (its saved
// identifiers stay in the tenant record; the settings API is unchanged).
type Tab = "rfid" | "bins";

export function SettingsWorkspace() {
  const [tab, setTab] = useState<Tab>("rfid");
  const { data, error, mutate } = useSWR<InfrastructureSettingsDto>(
    "/api/infrastructure/settings",
    fetcher,
    { revalidateOnFocus: false },
  );

  const [rfidForm, setRfidForm] = useState({
    company_prefix: "",
    item_bits: "",
    serial_bits: "",
    printer_default: "",
  });
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [binsBusy, setBinsBusy] = useState(false);
  const [binsToast, setBinsToast] = useState<string | null>(null);
  const [binLocationCode, setBinLocationCode] = useState("001");

  useEffect(() => {
    if (!data) return;
    setRfidForm({
      company_prefix: String(data.rfid.company_prefix),
      item_bits: String(data.rfid.item_bits),
      serial_bits: String(data.rfid.serial_bits),
      printer_default: data.rfid.printer_default,
    });
  }, [data]);

  const saveRfid = async () => {
    setBusy(true);
    setToast(null);
    try {
      const res = await fetch("/api/infrastructure/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rfid: {
            company_prefix: Number.parseInt(rfidForm.company_prefix, 10),
            item_bits: Number.parseInt(rfidForm.item_bits, 10),
            serial_bits: Number.parseInt(rfidForm.serial_bits, 10),
            printer_default: rfidForm.printer_default.trim(),
          },
        }),
      });
      const j = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? "Save failed");
      await mutate();
      setToast("RFID defaults saved to tenant settings.");
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const ensureOrlandoBins = async () => {
    setBinsBusy(true);
    setBinsToast(null);
    try {
      const res = await fetch("/api/settings/ensure-orlando-bins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locationCode: binLocationCode.trim() || "001" }),
      });
      const j = (await res.json()) as {
        error?: string;
        inserted?: number;
        binsAfter?: number;
        binsBefore?: number;
        location?: { code: string; name: string };
      };
      if (!res.ok) throw new Error(j.error ?? "Request failed");
      setBinsToast(
        `Location ${j.location?.code ?? "?"} (${j.location?.name ?? ""}): +${j.inserted ?? 0} new bins, total active ${j.binsAfter ?? "?"}.`,
      );
    } catch (e) {
      setBinsToast(e instanceof Error ? e.message : "Failed");
    } finally {
      setBinsBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex gap-2 border-b border-[var(--wms-border)] pb-2">
        {(
          [
            ["rfid", "RFID defaults"],
            ["bins", "Locations / bins"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={`rounded-t-md px-4 py-2 font-mono text-xs uppercase tracking-wide ${
              tab === k
                ? "border border-b-0 border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-accent)_18%,var(--wms-surface-elevated))] font-semibold text-[var(--wms-accent)] dark:bg-[var(--wms-surface-elevated)] dark:text-[var(--wms-accent)]"
                : "text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {error ? (
        <p className="font-mono text-xs text-red-400/90">
          {error instanceof Error ? error.message : "Load failed"}
        </p>
      ) : null}

      {tab === "bins" ? (
        <div className="space-y-4 rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80 p-5">
          <p className="font-mono text-sm leading-relaxed text-[var(--wms-fg)]/90">
            Inserts the same Orlando warehouse bin grid as local <code className="text-[var(--wms-accent)]">db:seed</code>{" "}
            (~675 codes: aisles × sections 01–05 × L/C/R). Existing codes are left unchanged (
            <code className="text-[var(--wms-muted)]">ON CONFLICT DO NOTHING</code>).
          </p>
          <label className="block font-mono text-[0.65rem] uppercase text-[var(--wms-muted)]">
            Location code
            <input
              value={binLocationCode}
              onChange={(e) => setBinLocationCode(e.target.value)}
              placeholder="001"
              className="mt-1 w-full max-w-xs rounded border border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-muted)_12%,var(--wms-surface-elevated))] px-3 py-2 font-mono text-sm text-[var(--wms-fg)]"
            />
          </label>
          <button
            type="button"
            disabled={binsBusy}
            onClick={() => void ensureOrlandoBins()}
            className="rounded-lg border border-[var(--wms-accent)]/50 bg-[var(--wms-accent)] px-5 py-2.5 font-mono text-xs font-semibold text-[var(--wms-accent-fg)] shadow-sm hover:opacity-90 disabled:opacity-40"
          >
            {binsBusy ? "Working…" : "Ensure Orlando bin grid"}
          </button>
          {binsToast ? (
            <p className="font-mono text-xs text-[var(--wms-muted)]">{binsToast}</p>
          ) : null}
        </div>
      ) : null}

      {tab === "rfid" ? (
        <div className="space-y-4 rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80 p-5">
          {data?.hints.env_company_prefix ? (
            <p className="rounded border border-amber-700/40 bg-[color-mix(in_srgb,#b45309_14%,var(--wms-surface-elevated))] px-3 py-2 font-mono text-[0.65rem] text-amber-950 dark:border-amber-800/50 dark:bg-amber-950/20 dark:text-amber-200/90">
              <code className="font-semibold text-amber-800 dark:text-amber-400/90">WMS_COMPANY_PREFIX</code> is set in the
              environment — it overrides stored tenant defaults for commissioning.
            </p>
          ) : null}
          <label className="block font-mono text-[0.65rem] uppercase text-[var(--wms-muted)]">
            Company prefix (20-bit)
            <input
              value={rfidForm.company_prefix}
              onChange={(e) =>
                setRfidForm((f) => ({ ...f, company_prefix: e.target.value }))
              }
              className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-muted)_12%,var(--wms-surface-elevated))] px-3 py-2 font-mono text-sm text-[var(--wms-fg)]"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block font-mono text-[0.65rem] uppercase text-[var(--wms-muted)]">
              Item bits
              <input
                value={rfidForm.item_bits}
                onChange={(e) => setRfidForm((f) => ({ ...f, item_bits: e.target.value }))}
                className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-muted)_12%,var(--wms-surface-elevated))] px-3 py-2 font-mono text-sm text-[var(--wms-fg)]"
              />
            </label>
            <label className="block font-mono text-[0.65rem] uppercase text-[var(--wms-muted)]">
              Serial bits
              <input
                value={rfidForm.serial_bits}
                onChange={(e) => setRfidForm((f) => ({ ...f, serial_bits: e.target.value }))}
                className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-muted)_12%,var(--wms-surface-elevated))] px-3 py-2 font-mono text-sm text-[var(--wms-fg)]"
              />
            </label>
          </div>
          <label className="block font-mono text-[0.65rem] uppercase text-[var(--wms-muted)]">
            Default printer (host:port / URI)
            <input
              value={rfidForm.printer_default}
              onChange={(e) =>
                setRfidForm((f) => ({ ...f, printer_default: e.target.value }))
              }
              placeholder="192.168.1.3:80 / PSTPRNT"
              className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-muted)_12%,var(--wms-surface-elevated))] px-3 py-2 font-mono text-sm text-[var(--wms-fg)]"
            />
          </label>
          <button
            type="button"
            disabled={busy || !data}
            onClick={() => void saveRfid()}
            className="rounded-lg border border-[var(--wms-accent)]/50 bg-[var(--wms-accent)] px-5 py-2.5 font-mono text-xs font-semibold text-[var(--wms-accent-fg)] shadow-sm hover:opacity-90 disabled:opacity-40"
          >
            Save RFID defaults
          </button>
        </div>
      ) : null}

      {toast ? (
        <p className="font-mono text-xs text-[var(--wms-muted)]">{toast}</p>
      ) : null}
    </div>
  );
}
