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

type Tab = "rfid" | "integrations";

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
  const [lsForm, setLsForm] = useState({
    client_id: "",
    account_id: "",
    domain_prefix: "",
  });
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const sp = new URLSearchParams(window.location.search);
    const err = sp.get("ls_error");
    if (err) {
      setToast(`Lightspeed OAuth: ${decodeURIComponent(err)}`);
      setTab("integrations");
      window.history.replaceState({}, "", "/infrastructure/settings");
    }
  }, []);

  useEffect(() => {
    if (!data) return;
    setRfidForm({
      company_prefix: String(data.rfid.company_prefix),
      item_bits: String(data.rfid.item_bits),
      serial_bits: String(data.rfid.serial_bits),
      printer_default: data.rfid.printer_default,
    });
    setLsForm({
      client_id: data.integrations.lightspeed.client_id,
      account_id: data.integrations.lightspeed.account_id,
      domain_prefix: data.integrations.lightspeed.domain_prefix,
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

  const saveLs = async () => {
    setBusy(true);
    setToast(null);
    try {
      const res = await fetch("/api/infrastructure/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          integrations: {
            lightspeed: {
              client_id: lsForm.client_id.trim(),
              account_id: lsForm.account_id.trim(),
              domain_prefix: lsForm.domain_prefix.trim(),
            },
          },
        }),
      });
      const j = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? "Save failed");
      await mutate();
      setToast("Integration identifiers saved. Secrets stay in environment variables.");
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex gap-2 border-b border-slate-800 pb-2">
        {(
          [
            ["rfid", "RFID defaults"],
            ["integrations", "Integrations"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={`rounded-t-md px-4 py-2 font-mono text-xs uppercase tracking-wide ${
              tab === k
                ? "border border-b-0 border-slate-700 bg-zinc-900 text-teal-300/90"
                : "text-slate-500 hover:text-slate-300"
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

      {tab === "rfid" ? (
        <div className="space-y-4 rounded-lg border border-slate-800 bg-zinc-950/80 p-5">
          {data?.hints.env_company_prefix ? (
            <p className="rounded border border-amber-800/50 bg-amber-950/20 px-3 py-2 font-mono text-[0.65rem] text-amber-200/90">
              <code className="text-amber-400/90">WMS_COMPANY_PREFIX</code> is set in the
              environment — it overrides stored tenant defaults for commissioning.
            </p>
          ) : null}
          <label className="block font-mono text-[0.65rem] uppercase text-slate-500">
            Company prefix (20-bit)
            <input
              value={rfidForm.company_prefix}
              onChange={(e) =>
                setRfidForm((f) => ({ ...f, company_prefix: e.target.value }))
              }
              className="mt-1 w-full rounded border border-slate-700 bg-zinc-900 px-3 py-2 font-mono text-sm text-slate-100"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block font-mono text-[0.65rem] uppercase text-slate-500">
              Item bits
              <input
                value={rfidForm.item_bits}
                onChange={(e) => setRfidForm((f) => ({ ...f, item_bits: e.target.value }))}
                className="mt-1 w-full rounded border border-slate-700 bg-zinc-900 px-3 py-2 font-mono text-sm text-slate-100"
              />
            </label>
            <label className="block font-mono text-[0.65rem] uppercase text-slate-500">
              Serial bits
              <input
                value={rfidForm.serial_bits}
                onChange={(e) => setRfidForm((f) => ({ ...f, serial_bits: e.target.value }))}
                className="mt-1 w-full rounded border border-slate-700 bg-zinc-900 px-3 py-2 font-mono text-sm text-slate-100"
              />
            </label>
          </div>
          <label className="block font-mono text-[0.65rem] uppercase text-slate-500">
            Default printer (host:port / URI)
            <input
              value={rfidForm.printer_default}
              onChange={(e) =>
                setRfidForm((f) => ({ ...f, printer_default: e.target.value }))
              }
              placeholder="192.168.1.3:80 / PSTPRNT"
              className="mt-1 w-full rounded border border-slate-700 bg-zinc-900 px-3 py-2 font-mono text-sm text-slate-100"
            />
          </label>
          <button
            type="button"
            disabled={busy || !data}
            onClick={() => void saveRfid()}
            className="rounded-lg border border-teal-600/45 bg-teal-950/25 px-5 py-2.5 font-mono text-xs text-teal-200 hover:bg-teal-900/20 disabled:opacity-40"
          >
            Save RFID defaults
          </button>
        </div>
      ) : (
        <div className="space-y-4 rounded-lg border border-slate-800 bg-zinc-950/80 p-5">
          <p className="font-mono text-[0.65rem] leading-relaxed text-slate-500">
            Store non-secret Lightspeed identifiers in the tenant record.{" "}
            <strong className="text-slate-400">Client secret and refresh token</strong> should live
            in Coolify / <code className="text-slate-600">.env</code> (
            <code className="text-slate-600">LS_CLIENT_SECRET</code>,{" "}
            <code className="text-slate-600">LS_REFRESH_TOKEN</code>) — never commit them. Catalog
            sync uses <strong className="text-slate-400">R-Series</strong> (Account ID + OAuth, same
            as carbon-gen) when those are set; domain prefix is only required for Retail X-Series
            storefront API.
          </p>
          <label className="block font-mono text-[0.65rem] uppercase text-slate-500">
            Client ID
            <input
              value={lsForm.client_id}
              onChange={(e) => setLsForm((f) => ({ ...f, client_id: e.target.value }))}
              autoComplete="off"
              className="mt-1 w-full rounded border border-slate-700 bg-zinc-900 px-3 py-2 font-mono text-sm text-slate-100"
            />
          </label>
          <label className="block font-mono text-[0.65rem] uppercase text-slate-500">
            Account ID
            <input
              value={lsForm.account_id}
              onChange={(e) => setLsForm((f) => ({ ...f, account_id: e.target.value }))}
              className="mt-1 w-full rounded border border-slate-700 bg-zinc-900 px-3 py-2 font-mono text-sm text-slate-100"
            />
          </label>
          <label className="block font-mono text-[0.65rem] uppercase text-slate-500">
            Domain prefix
            <input
              value={lsForm.domain_prefix}
              onChange={(e) => setLsForm((f) => ({ ...f, domain_prefix: e.target.value }))}
              placeholder="your-store"
              className="mt-1 w-full rounded border border-slate-700 bg-zinc-900 px-3 py-2 font-mono text-sm text-slate-100"
            />
          </label>
          <div className="rounded border border-slate-800 bg-zinc-900/40 px-3 py-2 font-mono text-[0.6rem] text-slate-500">
            Client secret (env):{" "}
            {data?.integrations.lightspeed.client_secret_configured_env ? (
              <span className="text-emerald-400/90">configured</span>
            ) : (
              <span className="text-amber-400/90">not set</span>
            )}
          </div>
          <div className="rounded border border-slate-800 bg-zinc-900/50 px-3 py-3 font-mono text-[0.65rem] leading-relaxed text-slate-400">
            <strong className="text-slate-300">Connect Lightspeed (redirect flow)</strong> — sends you
            to Lightspeed login, then returns a page with a <code className="text-slate-500">refresh token</code>{" "}
            to paste as <code className="text-slate-500">LS_REFRESH_TOKEN</code>. In the Lightspeed dev app,
            register redirect URL{" "}
            <code className="text-violet-400/90">…/api/lightspeed/callback</code> (same as{" "}
            <code className="text-slate-500">LS_REDIRECT_URI</code> if you set it).
            <div className="mt-2">
              <a
                href="/api/lightspeed/auth"
                className="inline-flex rounded-md border border-violet-600/50 bg-violet-950/30 px-3 py-1.5 text-violet-200 hover:bg-violet-900/25"
              >
                Start OAuth
              </a>
            </div>
          </div>
          <button
            type="button"
            disabled={busy || !data}
            onClick={() => void saveLs()}
            className="rounded-lg border border-violet-600/45 bg-violet-950/25 px-5 py-2.5 font-mono text-xs text-violet-200 hover:bg-violet-900/20 disabled:opacity-40"
          >
            Save integration fields
          </button>
        </div>
      )}

      {toast ? (
        <p className="font-mono text-xs text-slate-400">{toast}</p>
      ) : null}
    </div>
  );
}
