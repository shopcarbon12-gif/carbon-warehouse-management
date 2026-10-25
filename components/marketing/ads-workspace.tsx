"use client";

import { useState } from "react";
import useSWR from "swr";
import { btn, card, fetcher, field, label, send } from "./marketing-shared";

/**
 * Social → Ads. Every Meta and Google campaign with its status, daily budget
 * and the last 7 days. Pause, resume and budget changes each ask first —
 * nothing here creates or launches a campaign.
 */

type Campaign = {
  platform: "meta" | "google";
  id: string;
  name: string;
  status: "active" | "paused" | "other";
  rawStatus: string;
  objective: string | null;
  dailyBudget: number | null;
  budgetId: string | null;
  spend7: number;
  impressions7: number;
  clicks7: number;
  conversions7: number;
  conversionValue7: number;
};
type Ads = { meta: Campaign[]; google: Campaign[]; errors: { meta: string | null; google: string | null } };
type Ask = { c: Campaign; action: "pause" | "resume" | "budget"; budget?: string };

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const nf = new Intl.NumberFormat("en-US");

export function MarketingAdsWorkspace() {
  const { data, error, mutate, isLoading } = useSWR<Ads>("/api/marketing/ads", fetcher);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);

  async function apply() {
    if (!ask) return;
    setBusy(true);
    setMsg(null);
    try {
      await send("/api/marketing/ads", "PATCH", {
        platform: ask.c.platform,
        id: ask.c.id,
        action: ask.action,
        ...(ask.action === "budget" ? { dailyBudget: Number(ask.budget), budgetId: ask.c.budgetId } : {}),
        confirm: true,
      });
      setMsg({ text: ask.action === "pause" ? `Paused “${ask.c.name}”.` : ask.action === "resume" ? `Resumed “${ask.c.name}” — it spends again.` : `Daily budget of “${ask.c.name}” is now ${usd.format(Number(ask.budget))}.` });
      setAsk(null);
      await mutate();
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Something went wrong", err: true });
    } finally {
      setBusy(false);
    }
  }

  function section(title: string, list: Campaign[], err: string | null) {
    const spend = list.reduce((a, c) => a + c.spend7, 0);
    const value = list.reduce((a, c) => a + c.conversionValue7, 0);
    return (
      <section className={`${card} flex flex-col gap-2 overflow-x-auto`}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-[var(--wms-fg)]">{title}</h2>
          <span className="text-xs text-[var(--wms-muted)]">
            Last 7 days: {usd.format(spend)} spent{value ? ` · ${usd.format(value)} in sales (${(value / Math.max(spend, 0.01)).toFixed(2)}× back)` : ""}
          </span>
        </div>
        {err && <p className="text-xs text-[var(--wms-status-danger-fg)]">{err}</p>}
        {list.length ? (
          <table className="w-full min-w-[720px] text-left text-xs">
            <thead>
              <tr className="text-[var(--wms-muted)]">
                <th className="py-1 pr-2">Campaign</th>
                <th className="py-1 pr-2">Status</th>
                <th className="py-1 pr-2 text-right">Daily budget</th>
                <th className="py-1 pr-2 text-right">Spent (7d)</th>
                <th className="py-1 pr-2 text-right">Clicks</th>
                <th className="py-1 pr-2 text-right">Sales</th>
                <th className="py-1 pr-2 text-right">Sales value</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.id} className="border-t border-[var(--wms-border)] text-[var(--wms-fg)]">
                  <td className="py-1.5 pr-2">
                    {c.name}
                    <span className="block text-[0.66rem] text-[var(--wms-muted)]">{c.objective}</span>
                  </td>
                  <td className={`py-1.5 pr-2 ${c.status === "active" ? "text-emerald-700 dark:text-emerald-300" : "text-[var(--wms-muted)]"}`}>
                    {c.status === "active" ? "Running" : c.status === "paused" ? "Paused" : c.rawStatus.toLowerCase().replace(/_/g, " ")}
                  </td>
                  <td className="py-1.5 pr-2 text-right">{c.dailyBudget != null ? usd.format(c.dailyBudget) : <span className="text-[var(--wms-muted)]">on ad sets</span>}</td>
                  <td className="py-1.5 pr-2 text-right">{usd.format(c.spend7)}</td>
                  <td className="py-1.5 pr-2 text-right">{nf.format(c.clicks7)}</td>
                  <td className="py-1.5 pr-2 text-right">{c.conversions7 ? nf.format(Math.round(c.conversions7 * 10) / 10) : "—"}</td>
                  <td className="py-1.5 pr-2 text-right">{c.conversionValue7 ? usd.format(c.conversionValue7) : "—"}</td>
                  <td className="py-1.5 text-right whitespace-nowrap">
                    {c.status === "active" && (
                      <button type="button" className={`${btn} border-[var(--wms-border)]`} onClick={() => setAsk({ c, action: "pause" })}>
                        Pause
                      </button>
                    )}
                    {c.status === "paused" && (
                      <button type="button" className={`${btn} border-[var(--wms-border)]`} onClick={() => setAsk({ c, action: "resume" })}>
                        Resume
                      </button>
                    )}{" "}
                    {c.dailyBudget != null && (
                      <button type="button" className={`${btn} border-[var(--wms-border)]`} onClick={() => setAsk({ c, action: "budget", budget: String(c.dailyBudget) })}>
                        Budget
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          !err && <p className="text-xs text-[var(--wms-muted)]">{isLoading ? "Loading…" : "No campaigns."}</p>
        )}
      </section>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-3 p-3 max-md:p-2">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-[var(--wms-fg)]">Social · Ads</h1>
          <p className="text-xs text-[var(--wms-muted)]">Meta and Google campaigns, read live. Every change asks first; nothing here launches a campaign.</p>
        </div>
        <button type="button" className={`${btn} border-[var(--wms-border)]`} onClick={() => void mutate()}>
          Refresh
        </button>
      </header>
      {msg && <p className={`text-xs ${msg.err ? "text-[var(--wms-status-danger-fg)]" : "text-emerald-700 dark:text-emerald-300"}`}>{msg.text}</p>}
      {error && <p className="text-xs text-[var(--wms-status-danger-fg)]">{error.message}</p>}
      {section("Meta (Facebook & Instagram)", data?.meta ?? [], data?.errors.meta ?? null)}
      {section("Google (Search, Shopping, Performance Max, YouTube)", data?.google ?? [], data?.errors.google ?? null)}

      {ask && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4 max-md:items-stretch max-md:p-0" onClick={() => !busy && setAsk(null)}>
          <div className={`${card} flex w-full max-w-md flex-col gap-3 max-md:max-w-none max-md:rounded-none`} onClick={(e) => e.stopPropagation()}>
            <span className={label}>{ask.c.platform === "meta" ? "Meta" : "Google"} · {ask.c.name}</span>
            {ask.action === "budget" ? (
              <>
                <p className="text-sm text-[var(--wms-fg)]">New daily budget (now {usd.format(ask.c.dailyBudget ?? 0)}):</p>
                <input
                  className={field}
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  enterKeyHint="done"
                  value={ask.budget ?? ""}
                  onChange={(e) => setAsk({ ...ask, budget: e.target.value.replace(/[^0-9.]/g, "") })}
                />
                <p className="text-xs text-[var(--wms-muted)]">This changes what the campaign may spend each day, starting now.</p>
              </>
            ) : (
              <p className="text-sm text-[var(--wms-fg)]">
                {ask.action === "pause" ? "Pause this campaign? It stops spending now." : `Resume this campaign? It starts spending again${ask.c.dailyBudget ? ` (up to ${usd.format(ask.c.dailyBudget)} a day)` : ""}.`}
              </p>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                className={`${btn} ${ask.action === "pause" ? "border-[var(--wms-border)]" : "border-emerald-600 bg-emerald-600 text-white"}`}
                disabled={busy || (ask.action === "budget" && !(Number(ask.budget) >= 1 && Number(ask.budget) <= 1000))}
                onClick={() => void apply()}
              >
                {busy ? "Working…" : ask.action === "pause" ? "Yes, pause" : ask.action === "resume" ? "Yes, resume" : "Yes, change budget"}
              </button>
              <button type="button" className={`${btn} border-[var(--wms-border)]`} disabled={busy} onClick={() => setAsk(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
