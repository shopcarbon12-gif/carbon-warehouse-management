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

function LightspeedLiveReadiness({
  data,
  lsForm,
  publicOrigin,
}: {
  data: InfrastructureSettingsDto | undefined;
  lsForm: { client_id: string; account_id: string; domain_prefix: string };
  publicOrigin: string;
}) {
  if (!data) return null;
  const clientId = (lsForm.client_id || data.integrations.lightspeed.client_id || "").trim();
  const accountId = (lsForm.account_id || data.integrations.lightspeed.account_id || "").trim();
  const secretOk = data.hints.env_ls_client_secret;
  const refreshOk = data.hints.env_ls_refresh_token;
  const rSeriesLive = Boolean(clientId && accountId && secretOk && refreshOk);

  const missing: string[] = [];
  if (!clientId) missing.push("Client ID (saved here or LS_CLIENT_ID in Coolify)");
  if (!accountId) missing.push("Account ID (saved here or LS_ACCOUNT_ID)");
  if (!secretOk) missing.push("LS_CLIENT_SECRET in Coolify (redeploy after changing)");
  if (!refreshOk) missing.push("LS_REFRESH_TOKEN in Coolify — use Start OAuth if you need a token");

  const callback =
    publicOrigin ? `${publicOrigin}/api/lightspeed/callback` : "{https://your-wms-host}/api/lightspeed/callback";

  return (
    <div
      className={`rounded-lg border px-3 py-3 font-mono text-[0.65rem] leading-relaxed ${
        rSeriesLive
          ? "border-emerald-700/35 bg-[color-mix(in_srgb,#059669_16%,var(--wms-surface-elevated))] text-emerald-950 dark:border-emerald-800/60 dark:bg-emerald-950/25 dark:text-emerald-100/90"
          : "border-amber-700/35 bg-[color-mix(in_srgb,#b45309_14%,var(--wms-surface-elevated))] text-amber-950 dark:border-amber-800/60 dark:bg-amber-950/20 dark:text-amber-100/85"
      }`}
    >
      <p className="font-semibold uppercase tracking-wide text-[0.6rem] opacity-90">
        Lightspeed live catalog (R-Series)
      </p>
      <p className="mt-1">
        {rSeriesLive ? (
          <>
            <span className="font-medium text-emerald-800 dark:text-emerald-400">Ready for a real pull.</span> Open{" "}
            <a href="/inventory/sync" className="font-semibold text-[var(--wms-accent)] underline hover:opacity-90">
              Lightspeed Sync
            </a>{" "}
            and run Trigger manual sync. The result should not say simulated.
          </>
        ) : (
          <>
            <span className="font-medium text-amber-800 dark:text-amber-400">Not ready.</span> Catalog sync will use simulated products until
            everything below is set and Coolify has redeployed.
          </>
        )}
      </p>
      {!rSeriesLive ? (
        <ul className="mt-2 list-inside list-disc space-y-0.5 text-amber-900/90 dark:text-amber-200/80">
          {missing.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      ) : null}
      <ol className="mt-3 list-inside list-decimal space-y-1 border-t border-[var(--wms-border)] pt-2 text-[var(--wms-fg)]/90 sm:list-outside sm:pl-4">
        <li>
          In Coolify → WMS → Environment: LS_CLIENT_ID, LS_CLIENT_SECRET, LS_REFRESH_TOKEN, LS_ACCOUNT_ID
          (R-Series OAuth + account id — not the X-Series shop subdomain flow). Optional: LS_DOMAIN_PREFIX
          (e.g. us) for extra token URL candidates only.
        </li>
        <li>
          Lightspeed dev app redirect URL must match:{" "}
          <code className="break-all text-[var(--wms-accent)] dark:text-violet-300">{callback}</code>
        </li>
        <li>
          Optional: LS_REDIRECT_URI = same callback. Public base (carbon-gen order):{" "}
          <code className="text-[var(--wms-muted)]">NEXT_PUBLIC_BASE_URL</code> then{" "}
          <code className="text-[var(--wms-muted)]">WMS_APP_PUBLIC_BASE_URL</code>.
        </li>
        <li>Save integration fields below, then Redeploy WMS in Coolify so the container loads secrets.</li>
        <li>Start OAuth → copy refresh token into LS_REFRESH_TOKEN → Redeploy again if needed.</li>
      </ol>
    </div>
  );
}

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
  const [publicOrigin, setPublicOrigin] = useState("");

  useEffect(() => {
    if (typeof window === "undefined") return;
    setPublicOrigin(window.location.origin);
  }, []);

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
      <div className="flex gap-2 border-b border-[var(--wms-border)] pb-2">
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
      ) : (
        <div className="space-y-4 rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80 p-5">
          <LightspeedLiveReadiness
            data={data}
            lsForm={lsForm}
            publicOrigin={publicOrigin}
          />
          <p className="font-mono text-[0.65rem] leading-relaxed text-[var(--wms-muted)]">
            Store non-secret Lightspeed identifiers in the tenant record (or rely on the same keys in
            Coolify env). <strong className="text-[var(--wms-muted)]">LS_CLIENT_SECRET</strong> and{" "}
            <strong className="text-[var(--wms-muted)]">LS_REFRESH_TOKEN</strong> must be set in Coolify only — never
            commit them. Live catalog sync uses <strong className="text-[var(--wms-muted)]">R-Series</strong>{" "}
            (<code className="text-[var(--wms-muted)]">api.lightspeedapp.com</code>) when Account ID + OAuth are
            complete. Domain prefix is for token endpoints (often <code className="text-[var(--wms-muted)]">us</code>{" "}
            like carbon-gen) and for Retail X-Series if you use that path.
          </p>
          <label className="block font-mono text-[0.65rem] uppercase text-[var(--wms-muted)]">
            Client ID
            <input
              value={lsForm.client_id}
              onChange={(e) => setLsForm((f) => ({ ...f, client_id: e.target.value }))}
              autoComplete="off"
              className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-muted)_12%,var(--wms-surface-elevated))] px-3 py-2 font-mono text-sm text-[var(--wms-fg)]"
            />
          </label>
          <label className="block font-mono text-[0.65rem] uppercase text-[var(--wms-muted)]">
            Account ID
            <input
              value={lsForm.account_id}
              onChange={(e) => setLsForm((f) => ({ ...f, account_id: e.target.value }))}
              className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-muted)_12%,var(--wms-surface-elevated))] px-3 py-2 font-mono text-sm text-[var(--wms-fg)]"
            />
          </label>
          <label className="block font-mono text-[0.65rem] uppercase text-[var(--wms-muted)]">
            Domain prefix
            <input
              value={lsForm.domain_prefix}
              onChange={(e) => setLsForm((f) => ({ ...f, domain_prefix: e.target.value }))}
              placeholder="your-store"
              className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-muted)_12%,var(--wms-surface-elevated))] px-3 py-2 font-mono text-sm text-[var(--wms-fg)]"
            />
          </label>
          <div className="rounded border border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-muted)_10%,var(--wms-surface-elevated))] px-3 py-2 font-mono text-[0.6rem] text-[var(--wms-muted)]">
            <span className="block">
              LS_CLIENT_SECRET (Coolify):{" "}
              {data?.hints.env_ls_client_secret ? (
                <span className="text-emerald-400/90">set</span>
              ) : (
                <span className="text-amber-400/90">missing</span>
              )}
            </span>
            <span className="block">
              LS_REFRESH_TOKEN (Coolify):{" "}
              {data?.hints.env_ls_refresh_token ? (
                <span className="text-emerald-400/90">set</span>
              ) : (
                <span className="text-amber-400/90">missing</span>
              )}
            </span>
          </div>
          <div className="rounded border border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-muted)_10%,var(--wms-surface-elevated))] px-3 py-3 font-mono text-[0.65rem] leading-relaxed text-[var(--wms-muted)]">
            <strong className="text-[var(--wms-fg)]">Connect Lightspeed (redirect flow)</strong> — sends you
            to Lightspeed login, then returns a page with a <code className="text-[var(--wms-muted)]">refresh token</code>{" "}
            to paste as <code className="text-[var(--wms-muted)]">LS_REFRESH_TOKEN</code>. In the Lightspeed dev app,
            register redirect URL{" "}
            <code className="text-violet-400/90">…/api/lightspeed/callback</code> (same as{" "}
            <code className="text-[var(--wms-muted)]">LS_REDIRECT_URI</code> if you set it).
            <div className="mt-2">
              <a
                href="/api/lightspeed/auth"
                className="inline-flex rounded-md border border-[var(--wms-accent)]/50 bg-[var(--wms-accent)] px-3 py-1.5 font-semibold text-[var(--wms-accent-fg)] shadow-sm hover:opacity-90"
              >
                Start OAuth
              </a>
            </div>
          </div>
          <button
            type="button"
            disabled={busy || !data}
            onClick={() => void saveLs()}
            className="rounded-lg border border-[var(--wms-accent)]/50 bg-[var(--wms-accent)] px-5 py-2.5 font-mono text-xs font-semibold text-[var(--wms-accent-fg)] shadow-sm hover:opacity-90 disabled:opacity-40"
          >
            Save integration fields
          </button>
        </div>
      )}

      {toast ? (
        <p className="font-mono text-xs text-[var(--wms-muted)]">{toast}</p>
      ) : null}
    </div>
  );
}
