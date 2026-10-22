"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { useUrlParam } from "@/lib/use-url-param";
import { decodeEntities } from "@/lib/server/visitors/rules";
import type { VisitorDetail, VisitorEventRow, VisitorFilter, VisitorList, VisitorRow } from "@/lib/server/visitors/report";

/**
 * Shopify → Visitors (owner 2026-10-21). Who is on shopcarbon.com right now
 * and everything each real visitor did — pages, cart adds, checkout, email
 * signups, orders — kept 90 days after they leave (Tawk.to forgets them).
 * The owner can give any visitor a nickname and a private note. Bots are
 * never recorded (Carbon Shield decides). No screen recording.
 */

const fetcher = async <T,>(u: string): Promise<T> => {
  const r = await fetch(u, { cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error || `HTTP ${r.status}`);
  return j as T;
};

const STORE = "https://shopcarbon.com";
const ET = "America/New_York";
const FILTER_LABELS: Record<VisitorFilter, string> = {
  all: "Everyone",
  named: "Named",
  returning: "Came back",
  ads: "From ads",
  cart: "Cart, no order",
  ordered: "Ordered",
};
const SOURCES: Record<string, string> = {
  direct: "Direct",
  internal: "Direct",
  "ad:meta": "Meta ad",
  "ad:google": "Google ad",
  "ad:tiktok": "TikTok ad",
  google: "Google search",
  facebook: "Facebook",
  instagram: "Instagram",
  bing: "Bing",
  tiktok: "TikTok",
  pinterest: "Pinterest",
  other: "Another website",
};
const source = (s: string | null) => (s ? (SOURCES[s] ?? s) : "—");

let regionNames: Intl.DisplayNames | null = null;
function countryName(code: string | null): string {
  if (!code) return "Unknown country";
  try {
    regionNames ??= new Intl.DisplayNames(["en"], { type: "region" });
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}
/** City and state from the IP (city level at best — never a street), then the country. */
function placeName(v: { city?: string | null; region_code?: string | null; country: string | null }): string {
  if (!v.city) return countryName(v.country);
  if ((v.country === "US" || v.country === "CA") && v.region_code) return `${v.city}, ${v.region_code}`;
  return `${v.city}, ${countryName(v.country)}`;
}
function mapLink(v: { city?: string | null; region?: string | null; country: string | null }): string | null {
  if (!v.city) return null;
  return `https://www.openstreetmap.org/search?query=${encodeURIComponent([v.city, v.region, countryName(v.country)].filter(Boolean).join(", "))}`;
}
function when(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { timeZone: ET, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { timeZone: ET, hour: "numeric", minute: "2-digit" });
}
function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
function span(fromIso: string, toIso: string): string {
  const m = Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 60000);
  return m < 1 ? "under a minute" : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const pageName = (title: string | null, path: string | null) =>
  decodeEntities(title ?? "").replace(/\s*[|–—-]\s*CARBON\s*$/i, "").trim() || path || "a page";

const card = "min-w-0 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] p-3";
const btn =
  "rounded-md border px-2.5 py-1 font-mono text-[0.72rem] uppercase tracking-wide disabled:opacity-50 max-md:min-h-11 max-md:px-3";
const field =
  "rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1 text-sm text-[var(--wms-fg)] max-md:min-h-11 max-md:text-base";

export function VisitorsWorkspace() {
  const [view, setView] = useState<"live" | "all">("live");
  const [filter, setFilter] = useState<VisitorFilter>("all");
  const [bots, setBots] = useState(false);
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useUrlParam("visitor");

  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 350);
    return () => clearTimeout(t);
  }, [q]);

  const url = `/api/shopify/visitors?view=${view}&filter=${filter}&q=${encodeURIComponent(query)}${bots ? "&bots=1" : ""}`;
  const { data, error, isLoading } = useSWR<VisitorList>(url, fetcher, {
    refreshInterval: view === "live" ? 15_000 : 60_000,
    revalidateOnFocus: false,
    keepPreviousData: true,
  });

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-col gap-1 border-b border-[var(--wms-border)] pb-3">
        <h1 className="text-lg font-semibold tracking-tight text-[var(--wms-fg)]">Visitors</h1>
        <p className="max-w-3xl font-mono text-xs text-[var(--wms-muted)]">
          Who is on shopcarbon.com right now, and everything each visitor did — pages, cart, checkout, email signups, orders — kept 90
          days after they leave. Real people only: bots are left out. Give anyone a nickname; names appear when a shopper logs in, signs
          up for emails or orders. One-page visits gone in seconds, typed straight onto a product page, are counted as likely bots and left
          out (tick Show likely bots to see them).
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        <div className={card}>
          <p className="font-mono text-[0.66rem] uppercase tracking-wide text-[var(--wms-muted)]">On the site now</p>
          <p className="mt-1 flex items-center gap-2 text-2xl font-semibold tabular-nums text-[var(--wms-fg)]">
            <span className={`inline-block h-2.5 w-2.5 rounded-full ${data?.liveNow ? "bg-emerald-500" : "bg-[var(--wms-border)]"}`} aria-hidden />
            {data ? data.liveNow : "—"}
          </p>
        </div>
        {(
          [
            ["Visitors today", data?.today.visitors],
            ["Pages viewed", data?.today.pageViews],
            ["Added to cart", data?.today.cartAdds],
            ["Checkouts started", data?.today.checkouts],
            ["Orders", data?.today.orders],
          ] as const
        ).map(([label, n]) => (
          <div key={label} className={card}>
            <p className="font-mono text-[0.66rem] uppercase tracking-wide text-[var(--wms-muted)]">{label}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-[var(--wms-fg)]">{n ?? "—"}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label="Which visitors" className="flex overflow-hidden rounded-md border border-[var(--wms-border)]">
          {(
            [
              ["live", "On the site now"],
              ["all", "Everyone (90 days)"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={view === id}
              onClick={() => setView(id)}
              className={`px-3 py-1.5 font-mono text-[0.72rem] uppercase tracking-wide max-md:min-h-11 ${
                view === id ? "bg-[var(--wms-accent)] text-[var(--wms-accent-fg)]" : "text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          {(Object.keys(FILTER_LABELS) as VisitorFilter[]).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={`${btn} ${
                filter === f ? "border-[var(--wms-accent)] text-[var(--wms-fg)]" : "border-[var(--wms-border)] text-[var(--wms-muted)]"
              }`}
            >
              {FILTER_LABELS[f]}
            </button>
          ))}
        </div>
        <input
          id="visitors-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search nickname, name, email, product, city, country…"
          className={`${field} w-72 max-md:w-full`}
        />
        <label className="flex cursor-pointer items-center gap-2 font-mono text-[0.72rem] text-[var(--wms-muted)] max-md:min-h-11">
          <input
            id="visitors-show-bots"
            type="checkbox"
            className="h-4 w-4 accent-[var(--wms-accent)] max-md:h-5 max-md:w-5"
            checked={bots}
            onChange={(e) => setBots(e.target.checked)}
          />
          Show likely bots{data?.botsToday ? ` (${data.botsToday} today)` : ""}
        </label>
      </div>

      <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)]">
        <div className={`${card} p-0`}>
          {error && !data ? (
            <p className="p-3 font-mono text-xs text-[var(--wms-status-danger-fg)]">Could not load visitors: {error.message}</p>
          ) : isLoading && !data ? (
            <p className="p-3 font-mono text-xs text-[var(--wms-muted)]">Loading visitors…</p>
          ) : data && data.rows.length ? (
            <>
              <ul className="divide-y divide-[var(--wms-border)]">
                {data.rows.map((v) => (
                  <VisitorItem key={v.visitorId} v={v} active={selected === v.visitorId} onOpen={() => setSelected(v.visitorId)} />
                ))}
              </ul>
              {data.total > data.rows.length ? (
                <p className="border-t border-[var(--wms-border)] p-3 font-mono text-[0.68rem] text-[var(--wms-muted)]">
                  Showing the latest {data.rows.length} of {data.total.toLocaleString()} — search or filter to find others.
                </p>
              ) : null}
            </>
          ) : (
            <p className="p-3 font-mono text-xs text-[var(--wms-muted)]">
              {view === "live" ? "Nobody is on the store right now." : query ? "Nobody matches." : "No visitors recorded yet."}
            </p>
          )}
        </div>

        {selected ? (
          <VisitorPanel id={selected} onClose={() => setSelected(null)} onOpen={(id) => setSelected(id)} />
        ) : (
          <div className={`${card} hidden lg:block`}>
            <p className="font-mono text-xs text-[var(--wms-muted)]">Pick a visitor to see everything they did.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function VisitorItem({ v, active, onOpen }: { v: VisitorRow; active: boolean; onOpen: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className={`flex w-full min-w-0 flex-col gap-1 px-3 py-2.5 text-left hover:bg-[var(--wms-surface-elevated)] max-md:min-h-11 ${
          active ? "bg-[var(--wms-surface-elevated)]" : ""
        }`}
      >
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          {v.live ? <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-emerald-500" title="On the site now" /> : null}
          <span className="truncate text-sm font-semibold text-[var(--wms-fg)]">{v.label}</span>
          {v.nickname && (v.customerName || v.email) ? (
            <span className="truncate font-mono text-[0.68rem] text-[var(--wms-muted)]">{v.customerName ?? v.email}</span>
          ) : null}
          {v.orders ? <Badge tone="good">{v.orders === 1 ? "Ordered" : `${v.orders} orders`} · {money(v.revenue)}</Badge> : null}
          {!v.orders && v.cartAdds ? <Badge tone="warn">Cart · no order</Badge> : null}
          {v.visits > 1 ? <Badge>{v.visits} visits</Badge> : null}
          {v.likelyBot ? <Badge tone="warn">Likely bot</Badge> : null}
          <span className="ml-auto shrink-0 font-mono text-[0.68rem] text-[var(--wms-muted)]">{v.live ? "now" : ago(v.lastSeen)}</span>
        </span>
        <span className="truncate font-mono text-[0.7rem] text-[var(--wms-muted)]">
          {placeName(v)} · {v.device ?? "?"}
          {v.browser ? ` · ${v.browser}` : ""} · {source(v.firstSource)} · {v.pageViews} page{v.pageViews === 1 ? "" : "s"}
        </span>
        <span className="truncate text-[0.78rem] text-[var(--wms-fg)]">
          {v.live ? "Looking at " : "Last: "}
          {pageName(v.lastTitle, v.lastPath)}
        </span>
      </button>
    </li>
  );
}

function Badge({ children, tone }: { children: React.ReactNode; tone?: "good" | "warn" }) {
  const c =
    tone === "good"
      ? "border-emerald-500/50 text-[var(--wms-status-success-fg)]"
      : tone === "warn"
        ? "border-amber-500/50 text-[var(--wms-status-warning-fg)]"
        : "border-[var(--wms-border)] text-[var(--wms-muted)]";
  return <span className={`rounded border px-1.5 py-px font-mono text-[0.62rem] uppercase tracking-wide ${c}`}>{children}</span>;
}

function VisitorPanel({ id, onClose, onOpen }: { id: string; onClose: () => void; onOpen: (id: string) => void }) {
  const { data, error, mutate } = useSWR<VisitorDetail>(`/api/shopify/visitors/${encodeURIComponent(id)}`, fetcher, {
    refreshInterval: 20_000,
    revalidateOnFocus: false,
  });
  return (
    <div className="max-lg:fixed max-lg:inset-0 max-lg:z-[60] max-lg:flex max-lg:flex-col max-lg:bg-[var(--wms-bg)] max-lg:pb-[env(safe-area-inset-bottom)]">
      <div className={`${card} flex min-h-0 flex-col gap-3 max-lg:flex-1 max-lg:overflow-y-auto max-lg:overscroll-contain max-lg:rounded-none max-lg:border-0 lg:sticky lg:top-3 lg:max-h-[calc(100vh-1.5rem)] lg:overflow-y-auto`}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-mono text-[0.66rem] uppercase tracking-wide text-[var(--wms-muted)]">Visitor</p>
            <h2 className="truncate text-base font-semibold text-[var(--wms-fg)]">{data ? data.visitor.label : "…"}</h2>
          </div>
          <button type="button" onClick={onClose} className={`${btn} border-[var(--wms-border)] text-[var(--wms-fg)]`}>
            Close
          </button>
        </div>
        {error && !data ? <p className="font-mono text-xs text-[var(--wms-status-danger-fg)]">{error.message}</p> : null}
        {data ? (
          <>
            <Labels key={data.visitor.visitorId} d={data} onSaved={() => void mutate()} />
            <Facts d={data} />
            {data.otherDevices.length ? (
              <div>
                <p className="mb-1 font-mono text-[0.66rem] uppercase tracking-wide text-[var(--wms-muted)]">Same person on other devices</p>
                <div className="flex flex-wrap gap-1">
                  {data.otherDevices.map((o) => (
                    <button key={o.visitorId} type="button" onClick={() => onOpen(o.visitorId)} className={`${btn} border-[var(--wms-border)] text-[var(--wms-fg)] normal-case`}>
                      {o.label} · {o.device ?? "?"} · {ago(o.lastSeen)}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            <Journey events={data.events} />
          </>
        ) : null}
      </div>
    </div>
  );
}

function Labels({ d, onSaved }: { d: VisitorDetail; onSaved: () => void }) {
  const [nickname, setNickname] = useState(d.visitor.nickname ?? "");
  const [note, setNote] = useState(d.visitor.note ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);
  const dirty = nickname.trim() !== (d.visitor.nickname ?? "") || note.trim() !== (d.visitor.note ?? "");
  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch(`/api/shopify/visitors/${encodeURIComponent(d.visitor.visitorId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nickname: nickname.trim() || null, note: note.trim() || null }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setMsg({ text: "Saved." });
      onSaved();
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Could not save", err: true });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1 font-mono text-[0.66rem] uppercase tracking-wide text-[var(--wms-muted)]">
        Nickname
        <input
          id="visitor-nickname"
          value={nickname}
          maxLength={60}
          onChange={(e) => setNickname(e.target.value)}
          placeholder="e.g. Miami regular"
          className={field}
        />
      </label>
      <label className="flex flex-col gap-1 font-mono text-[0.66rem] uppercase tracking-wide text-[var(--wms-muted)]">
        Private note
        <textarea
          id="visitor-note"
          value={note}
          maxLength={1000}
          rows={2}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Only you see this"
          className={`${field} resize-y`}
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy || !dirty}
          onClick={() => void save()}
          className={`${btn} border-[var(--wms-accent)]/60 bg-[var(--wms-accent)]/15 text-[var(--wms-fg)]`}
        >
          {busy ? "Saving…" : "Save"}
        </button>
        {msg ? (
          <span className={`font-mono text-xs ${msg.err ? "text-[var(--wms-status-danger-fg)]" : "text-[var(--wms-status-success-fg)]"}`}>{msg.text}</span>
        ) : null}
        <span className="font-mono text-[0.62rem] text-[var(--wms-muted)]">Keep nicknames neutral — no looks, age, race, religion or health.</span>
      </div>
    </div>
  );
}

function Facts({ d }: { d: VisitorDetail }) {
  const v = d.visitor;
  const rows: [string, React.ReactNode][] = [
    ["Name", v.customerName ?? "—"],
    ["Email", v.email ?? "—"],
    ["Status", v.live ? <span className="text-[var(--wms-status-success-fg)]">On the site now</span> : `Last seen ${when(v.lastSeen)} (${ago(v.lastSeen)})${v.likelyBot ? " · likely bot (one page, gone in seconds)" : ""}`],
    ["First visit", `${when(v.firstSeen)} · from ${source(v.firstSource)}`],
    ["Landed on", v.landingPath ?? "—"],
    ["Visits", `${v.visits} visit${v.visits === 1 ? "" : "s"} · ${v.pageViews} page${v.pageViews === 1 ? "" : "s"}`],
    ["Shopping", `${v.cartAdds} added to cart · ${v.checkouts} checkout${v.checkouts === 1 ? "" : "s"} · ${v.orders} order${v.orders === 1 ? "" : "s"}${v.orders ? ` (${money(v.revenue)})` : ""}`],
    ["Device", [v.device, v.os, v.browser].filter(Boolean).join(" · ") || "—"],
    [
      "Where",
      <>
        {placeName(v)}
        {v.city ? ` (${countryName(v.country)}, from the IP — the city area, not a street)` : ""}
        {v.network ? ` · ${v.network}` : ""}
        {mapLink(v) ? (
          <>
            {" · "}
            <a href={mapLink(v)!} target="_blank" rel="noreferrer" className="text-[var(--wms-accent)] hover:underline">
              map
            </a>
          </>
        ) : null}
      </>,
    ],
    ["IP address", v.ip ?? "—"],
  ];
  return (
    <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-[0.8rem]">
      {rows.map(([k, val]) => (
        <div key={k} className="contents">
          <dt className="font-mono text-[0.68rem] uppercase tracking-wide text-[var(--wms-muted)]">{k}</dt>
          <dd className="min-w-0 break-words text-[var(--wms-fg)]">{val}</dd>
        </div>
      ))}
    </dl>
  );
}

function describe(e: VisitorEventRow): React.ReactNode {
  const dt = (e.detail ?? {}) as Record<string, unknown>;
  if (e.kind === "view") {
    return (
      <>
        Viewed{" "}
        {e.path ? (
          <a href={`${STORE}${e.path}`} target="_blank" rel="noreferrer" className="underline decoration-[var(--wms-border)] underline-offset-2">
            {pageName(e.title, e.path)}
          </a>
        ) : (
          pageName(e.title, e.path)
        )}
      </>
    );
  }
  if (e.kind === "cart_add") {
    const qty = typeof dt.qty === "number" ? dt.qty : 1;
    const price = typeof dt.price === "number" ? ` · ${money(dt.price)}` : "";
    return (
      <span className="text-[var(--wms-status-warning-fg)]">
        Added to cart: {String(dt.title ?? "a product")}
        {dt.variant ? ` (${String(dt.variant)})` : ""} × {qty}
        {price}
      </span>
    );
  }
  if (e.kind === "checkout") return <span className="text-[var(--wms-status-warning-fg)]">Started checkout</span>;
  if (e.kind === "signup") return <span>Signed up for emails ({String(dt.form ?? "popup")}) · {String(dt.email ?? "")}</span>;
  const total = typeof dt.total === "number" ? ` · ${money(dt.total)}` : "";
  return (
    <span className="font-semibold text-[var(--wms-status-success-fg)]">
      Ordered {String(dt.order ?? "")}
      {total}
    </span>
  );
}

function Journey({ events }: { events: VisitorEventRow[] }) {
  // Newest visit first; inside a visit, in the order it happened.
  const visits = useMemo(() => {
    const by = new Map<number, VisitorEventRow[]>();
    for (const e of events) by.set(e.visit, [...(by.get(e.visit) ?? []), e]);
    return [...by.entries()].sort((a, b) => b[0] - a[0]).map(([n, list]) => ({ n, list: [...list].reverse() }));
  }, [events]);
  if (!visits.length) return <p className="font-mono text-xs text-[var(--wms-muted)]">Nothing recorded yet.</p>;
  return (
    <div className="flex flex-col gap-3">
      <p className="font-mono text-[0.66rem] uppercase tracking-wide text-[var(--wms-muted)]">What they did</p>
      {visits.map(({ n, list }) => {
        const first = list[0];
        const last = list[list.length - 1];
        const from = list.find((e) => e.kind === "view" && e.source && e.source !== "internal")?.source ?? null;
        return (
          <div key={n} className="rounded-md border border-[var(--wms-border)]">
            <p className="border-b border-[var(--wms-border)] px-2 py-1.5 font-mono text-[0.68rem] text-[var(--wms-muted)]">
              Visit {n} · {when(first.at)} · {span(first.at, last.at)}
              {from ? ` · from ${source(from)}` : ""}
            </p>
            <ol className="flex flex-col">
              {list.map((e, i) => (
                <li key={`${e.at}-${i}`} className="flex gap-2 px-2 py-1 text-[0.8rem] text-[var(--wms-fg)]">
                  <span className="w-16 shrink-0 font-mono text-[0.68rem] tabular-nums text-[var(--wms-muted)]">{clock(e.at)}</span>
                  <span className="min-w-0 break-words">{describe(e)}</span>
                </li>
              ))}
            </ol>
          </div>
        );
      })}
    </div>
  );
}
