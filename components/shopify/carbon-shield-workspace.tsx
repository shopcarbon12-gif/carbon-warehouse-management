"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import type { ShieldReport } from "@/lib/server/shield/report";

/**
 * Shopify → Carbon Shield (owner 2026-10-20). The storefront bot guard:
 * who is visiting shopcarbon.com, how many are bots and why, what the ads
 * really bought, and the switches + rules. Blockify (Premium) runs alongside
 * for countries / VPN; this adds server-farm blocking, pixel silencing and
 * the numbers.
 */

const fetcher = async (u: string) => {
  const r = await fetch(u, { cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error || `HTTP ${r.status}`);
  return j as ShieldReport;
};

const REASONS: Record<string, string> = {
  allow_rule: "Allowed by hand",
  good_bot: "Verified crawler",
  block_rule: "Blocked by hand",
  fake_crawler: "Pretends to be Google / Bing / Meta",
  automation: "Automation / headless browser",
  datacenter: "Server farm (data center)",
  country: "Country you don't ship to",
  too_fast: "Too many pages too fast",
};
const SOURCES: Record<string, string> = {
  direct: "Direct (no referrer)",
  "ad:meta": "Meta ad click",
  "ad:google": "Google ad click",
  "ad:tiktok": "TikTok ad click",
  google: "Google search",
  facebook: "Facebook",
  instagram: "Instagram",
  bing: "Bing",
  tiktok: "TikTok",
  pinterest: "Pinterest",
  other: "Other websites",
};
const MODES: { id: ShieldReport["settings"]["mode"]; label: string; hint: string }[] = [
  { id: "off", label: "Off", hint: "The theme script does nothing." },
  { id: "monitor", label: "Monitor only", hint: "Every visit is checked and logged. Nobody is blocked." },
  { id: "enforce", label: "Blocking on", hint: "Bots are blocked and hidden from your ad pixels." },
];

const ET = "America/New_York";
function when(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", { timeZone: ET, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function ago(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");

const card = "min-w-0 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] p-3";
const th = "px-2 py-1.5 text-left font-mono text-[0.66rem] font-semibold uppercase tracking-wide text-[var(--wms-muted)]";
const td = "px-2 py-1.5 align-top text-[0.8rem] text-[var(--wms-fg)]";
const btn =
  "rounded-md border px-2.5 py-1 font-mono text-[0.72rem] uppercase tracking-wide disabled:opacity-50 max-md:min-h-11 max-md:px-3";

export function CarbonShieldWorkspace() {
  const { data, error, mutate, isLoading } = useSWR<ShieldReport>("/api/shopify/carbon-shield", fetcher, {
    refreshInterval: 30_000,
    revalidateOnFocus: false,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);
  const [confirmEnforce, setConfirmEnforce] = useState(false);

  async function call(key: string, url: string, init: RequestInit, ok: string) {
    setBusy(key);
    setMsg(null);
    try {
      const r = await fetch(url, { headers: { "Content-Type": "application/json" }, ...init });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setMsg({ text: ok });
      await mutate();
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Something went wrong", err: true });
    } finally {
      setBusy(null);
    }
  }
  const saveSettings = (patch: Record<string, unknown>, ok = "Saved — applies to the next page view.") =>
    call("settings", "/api/shopify/carbon-shield/settings", { method: "PATCH", body: JSON.stringify(patch) }, ok);
  const addRule = (kind: string, value: string, action: "allow" | "block", note?: string) =>
    call(`rule:${kind}:${value}`, "/api/shopify/carbon-shield/rules", {
      method: "POST",
      body: JSON.stringify({ kind, value, action, note }),
    }, action === "allow" ? `Allowed ${value}.` : `Blocked ${value}.`);

  if (error && !data) return <p className="p-4 font-mono text-xs text-[var(--wms-status-danger-fg)]">Could not load Carbon Shield: {error.message}</p>;
  if (isLoading || !data) return <p className="p-4 font-mono text-xs text-[var(--wms-muted)]">Loading Carbon Shield…</p>;

  const s = data.settings;
  const day = data.windows.day;
  const week = data.windows.week;
  const real = (w: typeof day) => Math.max(0, w.visitors - w.botVisitors);
  const blocking = s.mode === "enforce";
  const botWord = blocking ? "blocked" : "would be blocked";

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {/* Header + mode */}
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--wms-border)] pb-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight text-[var(--wms-fg)]">Carbon Shield</h1>
          <p className="mt-1 max-w-2xl font-mono text-xs text-[var(--wms-muted)]">
            Checks every visit to shopcarbon.com. Bots from server farms, automation tools and countries you don&apos;t ship to are
            kept off the store and out of your Meta and Google ad data. Blockify runs alongside for VPNs and fraud orders.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div role="radiogroup" aria-label="Carbon Shield mode" className="flex overflow-hidden rounded-md border border-[var(--wms-border)]">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={s.mode === m.id}
                disabled={busy !== null}
                onClick={() => {
                  if (m.id === s.mode) return;
                  if (m.id === "enforce") setConfirmEnforce(true);
                  else void saveSettings({ mode: m.id }, `Carbon Shield: ${m.label}.`);
                }}
                className={`px-3 py-1.5 font-mono text-[0.72rem] uppercase tracking-wide max-md:min-h-11 ${
                  s.mode === m.id
                    ? m.id === "enforce"
                      ? "bg-[var(--wms-accent)] text-[var(--wms-accent-fg)]"
                      : "bg-[var(--wms-surface-elevated)] text-[var(--wms-fg)]"
                    : "text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
          <p className="font-mono text-[0.68rem] text-[var(--wms-muted)]">{MODES.find((m) => m.id === s.mode)?.hint}</p>
        </div>
      </div>

      {confirmEnforce ? (
        <div className="rounded-md border border-amber-500/60 bg-amber-950/20 p-3 font-mono text-xs text-[var(--wms-fg)]">
          <p>
            Turn blocking on? In the last 7 days {week.botVisitors} of {week.visitors} visitors ({pct(week.botVisitors, week.visitors)}) would
            have been blocked. Check the &quot;Flagged visitors&quot; list below first — anyone wrongly flagged can be allowed with one click.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => {
                setConfirmEnforce(false);
                void saveSettings({ mode: "enforce" }, "Blocking is on.");
              }}
              className={`${btn} border-[var(--wms-accent)] bg-[var(--wms-accent)] text-[var(--wms-accent-fg)]`}
            >
              Yes, turn blocking on
            </button>
            <button type="button" onClick={() => setConfirmEnforce(false)} className={`${btn} border-[var(--wms-border)] text-[var(--wms-fg)]`}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {msg ? (
        <p className={`font-mono text-xs ${msg.err ? "text-[var(--wms-status-danger-fg)]" : "text-[var(--wms-status-success-fg)]"}`}>{msg.text}</p>
      ) : null}

      {/* Health */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 font-mono text-[0.72rem] text-[var(--wms-muted)]">
        <span>
          Storefront script:{" "}
          {data.status.lastCheckAt ? (
            <b className="text-[var(--wms-status-success-fg)]">
              working · last visit {ago(data.status.lastCheckAt)} · {data.status.checksLastHour} in the last hour
            </b>
          ) : (
            <b className="text-[var(--wms-status-warning-fg)]">no visits received yet — the theme script is not installed</b>
          )}
        </span>
        <span>
          IP data: {data.status.ipdbVersion ? <b className="text-[var(--wms-fg)]">{data.status.ipdbVersion}</b> : <b className="text-[var(--wms-status-warning-fg)]">not loaded yet</b>}
          {data.status.ipdbRefreshedAt ? ` · refreshed ${ago(data.status.ipdbRefreshedAt)}` : ""}
        </span>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void call("refresh", "/api/shopify/carbon-shield/refresh", { method: "POST" }, "IP data refreshed.")}
          className={`${btn} border-[var(--wms-border)] text-[var(--wms-fg)]`}
        >
          {busy === "refresh" ? "Refreshing… (~30 s)" : "Refresh IP data"}
        </button>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {(
          [
            ["Visitors · 24 h", day.visitors, `${week.visitors} in 7 days`],
            ["Real people · 24 h", real(day), `${pct(real(day), day.visitors)} of visitors · ${pct(real(week), week.visitors)} over 7 days`],
            [`Bots ${botWord} · 24 h`, day.botVisitors, `${week.botVisitors} in 7 days (${pct(week.botVisitors, week.visitors)})`],
            ["Verified crawlers · 24 h", day.goodBotViews, "Google, Bing, Apple, Meta — always allowed (page views)"],
          ] as const
        ).map(([label, value, sub]) => (
          <div key={label} className={card}>
            <p className="font-mono text-[0.66rem] uppercase tracking-wide text-[var(--wms-muted)]">{label}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-[var(--wms-fg)]">{value.toLocaleString()}</p>
            <p className="mt-0.5 font-mono text-[0.68rem] text-[var(--wms-muted)]">{sub}</p>
          </div>
        ))}
      </div>

      {/* Ad clicks */}
      {data.ads.length ? (
        <div className={card}>
          <p className="font-mono text-[0.72rem] font-semibold uppercase tracking-wide text-[var(--wms-fg)]">Ad clicks · 7 days — how many were real</p>
          <div className="mt-2 flex flex-wrap gap-x-8 gap-y-2">
            {data.ads.map((a) => (
              <p key={a.ad} className="text-sm text-[var(--wms-fg)]">
                <b className="capitalize">{a.ad}</b>: {a.visitors} visitors · <b>{a.visitors - a.botVisitors}</b> real ·{" "}
                <span className={a.botVisitors ? "text-[var(--wms-status-warning-fg)]" : ""}>{a.botVisitors} bots ({pct(a.botVisitors, a.visitors)})</span>
              </p>
            ))}
          </div>
        </div>
      ) : null}

      <Chart daily={data.daily} />

      <div className="grid gap-3 lg:grid-cols-2">
        <Table
          title={`Why bots were flagged · 7 days`}
          empty="No bots flagged yet."
          head={["Reason", "Visitors", "Page views"]}
          rows={data.reasons.map((r) => [REASONS[r.reason] ?? r.reason, r.visitors, r.views])}
        />
        <Table
          title="Where visitors come from · 7 days"
          empty="No visits yet."
          head={["Source", "Visitors", "Bots"]}
          rows={data.sources.map((r) => [SOURCES[r.source] ?? r.source, r.visitors, `${r.botVisitors} (${pct(r.botVisitors, r.visitors)})`])}
        />
        <Table
          title="Countries · 7 days"
          empty="No visits yet."
          head={["Country", "Visitors", "Bots"]}
          rows={data.countries.map((r) => [r.country ?? "Unknown", r.visitors, `${r.botVisitors} (${pct(r.botVisitors, r.visitors)})`])}
        />
        <div className={`${card} lg:col-span-2`}>
          <p className="mb-2 font-mono text-[0.72rem] font-semibold uppercase tracking-wide text-[var(--wms-fg)]">Networks · 7 days</p>
          {data.networks.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[30rem] border-collapse">
                <thead>
                  <tr>
                    <th className={th}>Network</th>
                    <th className={th}>Visitors</th>
                    <th className={th}>Bots</th>
                    <th className={th} />
                  </tr>
                </thead>
                <tbody>
                  {data.networks.map((n) => {
                    const rule = data.rules.find((r) => r.kind === "asn" && r.value === String(n.asn));
                    return (
                      <tr key={String(n.asn)} className="border-t border-[var(--wms-border)]">
                        <td className={td}>
                          {n.org ?? "Unknown"} {n.asn ? <span className="font-mono text-[0.68rem] text-[var(--wms-muted)]">AS{n.asn}</span> : null}
                        </td>
                        <td className={`${td} tabular-nums`}>{n.visitors}</td>
                        <td className={`${td} tabular-nums`}>{n.botVisitors}</td>
                        <td className={`${td} whitespace-nowrap text-right`}>
                          {n.asn ? (
                            rule ? (
                              <span className="font-mono text-[0.68rem] text-[var(--wms-muted)]">{rule.action === "allow" ? "allowed" : "blocked"} by hand</span>
                            ) : (
                              <span className="flex justify-end gap-1">
                                <button type="button" disabled={busy !== null} onClick={() => void addRule("asn", String(n.asn), "block", n.org ?? undefined)} className={`${btn} border-[var(--wms-border)] text-[var(--wms-status-danger-fg)]`}>
                                  Block
                                </button>
                                <button type="button" disabled={busy !== null} onClick={() => void addRule("asn", String(n.asn), "allow", n.org ?? undefined)} className={`${btn} border-[var(--wms-border)] text-[var(--wms-fg)]`}>
                                  Allow
                                </button>
                              </span>
                            )
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="font-mono text-xs text-[var(--wms-muted)]">No visits yet.</p>
          )}
        </div>
      </div>

      <Flagged report={data} busy={busy} onAllow={(kind, value, note) => void addRule(kind, value, "allow", note)} blocking={blocking} />

      <Rules report={data} busy={busy} onAdd={addRule} onDelete={(id) => void call(`del:${id}`, `/api/shopify/carbon-shield/rules/${id}`, { method: "DELETE" }, "Rule removed.")} />

      <Settings settings={s} busy={busy} onSave={(patch) => void saveSettings(patch)} />

      <p className="font-mono text-[0.66rem] text-[var(--wms-muted)]">
        IP data: <a className="underline" href="https://db-ip.com" target="_blank" rel="noreferrer">IP Geolocation by DB-IP</a> (CC BY 4.0), Google,
        Bing and Apple published crawler ranges. Raw visits are kept 7 days; daily totals are kept.
        {s.updatedAt ? ` Settings last changed ${when(s.updatedAt)}${s.updatedBy ? ` by ${s.updatedBy}` : ""}.` : ""}
      </p>
    </div>
  );
}

function Table({ title, head, rows, empty }: { title: string; head: string[]; rows: (string | number)[][]; empty: string }) {
  return (
    <div className={card}>
      <p className="mb-2 font-mono text-[0.72rem] font-semibold uppercase tracking-wide text-[var(--wms-fg)]">{title}</p>
      {rows.length ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[18rem] border-collapse">
            <thead>
              <tr>
                {head.map((h) => (
                  <th key={h} className={th}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-[var(--wms-border)]">
                  {r.map((c, j) => (
                    <td key={j} className={`${td} ${j ? "tabular-nums" : ""}`}>
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="font-mono text-xs text-[var(--wms-muted)]">{empty}</p>
      )}
    </div>
  );
}

function Chart({ daily }: { daily: ShieldReport["daily"] }) {
  const max = Math.max(1, ...daily.map((d) => d.allow + d.block));
  return (
    <div className={card}>
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        <p className="font-mono text-[0.72rem] font-semibold uppercase tracking-wide text-[var(--wms-fg)]">Page views per day · 30 days</p>
        <span className="flex items-center gap-1 font-mono text-[0.68rem] text-[var(--wms-muted)]">
          <i className="inline-block h-2.5 w-2.5 rounded-sm bg-[var(--wms-accent)]" /> real
        </span>
        <span className="flex items-center gap-1 font-mono text-[0.68rem] text-[var(--wms-muted)]">
          <i className="inline-block h-2.5 w-2.5 rounded-sm bg-amber-500" /> bots
        </span>
      </div>
      {daily.length ? (
        <div className="flex h-32 items-end gap-1 overflow-x-auto">
          {daily.map((d) => (
            <div key={d.day} title={`${d.day}: ${d.allow} real, ${d.block} bots`} className="flex h-full min-w-[0.6rem] flex-1 flex-col justify-end">
              <div className="w-full rounded-t-sm bg-amber-500" style={{ height: `${(d.block / max) * 100}%` }} />
              <div className="w-full bg-[var(--wms-accent)]" style={{ height: `${(d.allow / max) * 100}%` }} />
            </div>
          ))}
        </div>
      ) : (
        <p className="font-mono text-xs text-[var(--wms-muted)]">The chart fills in from the first full day of checks.</p>
      )}
    </div>
  );
}

function Flagged({
  report,
  busy,
  onAllow,
  blocking,
}: {
  report: ShieldReport;
  busy: string | null;
  onAllow: (kind: "ip" | "visitor", value: string, note?: string) => void;
  blocking: boolean;
}) {
  const [q, setQ] = useState("");
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return report.recent;
    return report.recent.filter((r) =>
      [r.ip, r.visitorId, r.country, r.org, r.path, r.source, ...r.reasons].some((x) => (x ?? "").toLowerCase().includes(t)),
    );
  }, [q, report.recent]);
  const allowed = (r: ShieldReport["recent"][number]) =>
    report.rules.some((x) => x.action === "allow" && ((x.kind === "ip" && x.value === r.ip) || (x.kind === "visitor" && r.visitorId?.startsWith(x.value))));
  return (
    <div className={card}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-[0.72rem] font-semibold uppercase tracking-wide text-[var(--wms-fg)]">
          Flagged visitors · 48 h · {blocking ? "blocked" : "would be blocked"}
        </p>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search IP, reference, network, page…"
          aria-label="Search flagged visitors"
          className="w-full max-w-xs rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1 font-mono text-xs text-[var(--wms-fg)] max-md:min-h-11 max-md:max-w-none max-md:text-base"
        />
      </div>
      <p className="mb-2 font-mono text-[0.68rem] text-[var(--wms-muted)]">
        A customer who sees &quot;Access restricted&quot; gets a reference code — search it here and press Allow.
      </p>
      {rows.length ? (
        <div className="max-h-[32rem] overflow-auto">
          <table className="w-full min-w-[44rem] border-collapse">
            <thead className="sticky top-0 bg-[var(--wms-surface)]">
              <tr>
                {["When (ET)", "Country", "Network", "Why", "Page", "Source", ""].map((h) => (
                  <th key={h} className={th}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.visitorId ?? r.ip}-${r.at}`} className="border-t border-[var(--wms-border)]">
                  <td className={`${td} whitespace-nowrap`}>{when(r.at)}</td>
                  <td className={td}>{r.country ?? "—"}</td>
                  <td className={td}>
                    {r.org ?? "—"}
                    <span className="block font-mono text-[0.66rem] text-[var(--wms-muted)]">
                      {r.ip ?? "no IP"}
                      {r.visitorId ? ` · ref ${r.visitorId.slice(0, 8)}` : ""}
                    </span>
                  </td>
                  <td className={td}>{r.reasons.map((x) => REASONS[x] ?? x).join(" · ")}</td>
                  <td className={`${td} max-w-[12rem] break-words font-mono text-[0.7rem]`}>{r.path ?? "—"}</td>
                  <td className={td}>{SOURCES[r.source ?? ""] ?? r.source ?? "—"}</td>
                  <td className={`${td} min-w-[8.5rem] whitespace-nowrap text-right`}>
                    {allowed(r) ? (
                      <span className="font-mono text-[0.68rem] text-[var(--wms-status-success-fg)]">allowed</span>
                    ) : (
                      <span className="flex flex-col items-end gap-1">
                        {r.ip ? (
                          <button type="button" disabled={busy !== null} onClick={() => onAllow("ip", r.ip as string, r.org ?? undefined)} className={`${btn} border-[var(--wms-border)] text-[var(--wms-fg)]`}>
                            Allow IP
                          </button>
                        ) : null}
                        {r.visitorId ? (
                          <button type="button" disabled={busy !== null} onClick={() => onAllow("visitor", (r.visitorId as string).slice(0, 8), r.org ?? undefined)} className={`${btn} border-[var(--wms-border)] text-[var(--wms-fg)]`}>
                            Allow visitor
                          </button>
                        ) : null}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="font-mono text-xs text-[var(--wms-muted)]">{q ? "Nothing matches." : "No bots flagged in the last 48 hours."}</p>
      )}
    </div>
  );
}

const RULE_KINDS: { id: string; label: string; placeholder: string }[] = [
  { id: "ip", label: "IP address", placeholder: "203.0.113.7" },
  { id: "cidr", label: "IP range", placeholder: "203.0.113.0/24" },
  { id: "asn", label: "Network (AS number)", placeholder: "16509" },
  { id: "country", label: "Country", placeholder: "BR" },
  { id: "ua", label: "Browser text", placeholder: "HeadlessChrome" },
  { id: "visitor", label: "Visitor reference", placeholder: "first 8 characters" },
];

function Rules({
  report,
  busy,
  onAdd,
  onDelete,
}: {
  report: ShieldReport;
  busy: string | null;
  onAdd: (kind: string, value: string, action: "allow" | "block", note?: string) => Promise<void>;
  onDelete: (id: string) => void;
}) {
  const [kind, setKind] = useState("ip");
  const [value, setValue] = useState("");
  const [action, setAction] = useState<"allow" | "block">("allow");
  const [note, setNote] = useState("");
  const field =
    "rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1 font-mono text-xs text-[var(--wms-fg)] max-md:min-h-11 max-md:text-base";
  return (
    <div className={card}>
      <p className="mb-1 font-mono text-[0.72rem] font-semibold uppercase tracking-wide text-[var(--wms-fg)]">Rules</p>
      <p className="mb-2 font-mono text-[0.68rem] text-[var(--wms-muted)]">&quot;Allow&quot; always wins over every automatic check (use it for your office, staff phones, a customer who was blocked).</p>
      <form
        className="mb-3 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!value.trim()) return;
          void onAdd(kind, value.trim(), action, note.trim() || undefined).then(() => {
            setValue("");
            setNote("");
          });
        }}
      >
        <select aria-label="Rule type" value={kind} onChange={(e) => setKind(e.target.value)} className={field}>
          {RULE_KINDS.map((k) => (
            <option key={k.id} value={k.id}>
              {k.label}
            </option>
          ))}
        </select>
        <input aria-label="Rule value" value={value} onChange={(e) => setValue(e.target.value)} placeholder={RULE_KINDS.find((k) => k.id === kind)?.placeholder} className={`${field} w-44`} />
        <select aria-label="Allow or block" value={action} onChange={(e) => setAction(e.target.value as "allow" | "block")} className={field}>
          <option value="allow">Allow</option>
          <option value="block">Block</option>
        </select>
        <input aria-label="Note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className={`${field} w-48`} />
        <button type="submit" disabled={busy !== null || !value.trim()} className={`${btn} border-[var(--wms-accent)]/60 bg-[var(--wms-accent)]/15 text-[var(--wms-fg)]`}>
          Add rule
        </button>
      </form>
      {report.rules.length ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] border-collapse">
            <thead>
              <tr>
                {["Rule", "Value", "Note", "Added", ""].map((h) => (
                  <th key={h} className={th}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.rules.map((r) => (
                <tr key={r.id} className="border-t border-[var(--wms-border)]">
                  <td className={td}>
                    <b className={r.action === "allow" ? "text-[var(--wms-status-success-fg)]" : "text-[var(--wms-status-danger-fg)]"}>{r.action === "allow" ? "Allow" : "Block"}</b>{" "}
                    {RULE_KINDS.find((k) => k.id === r.kind)?.label ?? r.kind}
                  </td>
                  <td className={`${td} font-mono`}>{r.value}</td>
                  <td className={td}>{r.note ?? ""}</td>
                  <td className={`${td} whitespace-nowrap`}>{when(r.createdAt)}</td>
                  <td className={`${td} text-right`}>
                    <button type="button" disabled={busy !== null} onClick={() => onDelete(r.id)} className={`${btn} border-[var(--wms-border)] text-[var(--wms-status-danger-fg)]`}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="font-mono text-xs text-[var(--wms-muted)]">No rules yet.</p>
      )}
    </div>
  );
}

function Settings({
  settings,
  busy,
  onSave,
}: {
  settings: ShieldReport["settings"];
  busy: string | null;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  const [countries, setCountries] = useState(settings.allowedCountries.join(", "));
  const [maxPages, setMaxPages] = useState(String(settings.maxPagesPerMinute));
  const toggles: [keyof ShieldReport["settings"], string, string][] = [
    ["blockDatacenter", "Block server farms", "Amazon, Google Cloud, Microsoft, DigitalOcean, OVH, Hetzner, Linode and other hosting networks."],
    ["blockAutomation", "Block automation", "Headless browsers, scripts and scraping tools (and anything pretending to be Google)."],
    ["blockCountries", "Block other countries", "Backup for Blockify's country rule — only the countries below get in."],
    ["blockFast", "Block visitors loading pages too fast", "More pages per minute than a person can read."],
    ["silencePixels", "Hide blocked visitors from ad pixels", "Tells Shopify \"no tracking\" for them, so Meta / Google / TikTok don't learn from bots."],
  ];
  const field =
    "rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1 font-mono text-xs text-[var(--wms-fg)] max-md:min-h-11 max-md:text-base";
  return (
    <div className={card}>
      <p className="mb-2 font-mono text-[0.72rem] font-semibold uppercase tracking-wide text-[var(--wms-fg)]">Checks</p>
      <div className="flex flex-col gap-2">
        {toggles.map(([key, label, hint]) => (
          <label key={key} className="flex cursor-pointer items-start gap-2 text-sm text-[var(--wms-fg)] max-md:min-h-11">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 accent-[var(--wms-accent)] max-md:h-5 max-md:w-5"
              checked={Boolean(settings[key])}
              disabled={busy !== null}
              onChange={(e) => onSave({ [key]: e.target.checked })}
            />
            <span>
              {label}
              <span className="block font-mono text-[0.68rem] text-[var(--wms-muted)]">{hint}</span>
            </span>
          </label>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 font-mono text-[0.68rem] uppercase tracking-wide text-[var(--wms-muted)]">
          Countries allowed (2-letter codes)
          <input value={countries} onChange={(e) => setCountries(e.target.value)} className={`${field} w-56`} />
        </label>
        <label className="flex flex-col gap-1 font-mono text-[0.68rem] uppercase tracking-wide text-[var(--wms-muted)]">
          Max pages per minute
          <input
            value={maxPages}
            onChange={(e) => setMaxPages(e.target.value)}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="off"
            enterKeyHint="done"
            className={`${field} w-24`}
          />
        </label>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => {
            const list = countries
              .split(/[\s,]+/)
              .map((c) => c.trim().toUpperCase())
              .filter((c) => /^[A-Z]{2}$/.test(c));
            const n = Number(maxPages);
            onSave({ allowedCountries: list, ...(Number.isInteger(n) && n >= 5 && n <= 1000 ? { maxPagesPerMinute: n } : {}) });
          }}
          className={`${btn} border-[var(--wms-accent)]/60 bg-[var(--wms-accent)]/15 text-[var(--wms-fg)]`}
        >
          Save
        </button>
      </div>
    </div>
  );
}
