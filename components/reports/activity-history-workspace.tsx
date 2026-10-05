"use client";

import { Fragment, useMemo, useState } from "react";
import useSWR from "swr";
import useSWRInfinite from "swr/infinite";
import { ChevronDown, ChevronRight, Download, Search } from "lucide-react";
import { ACTIVITY_MODULES, SOURCE_LABEL } from "@/lib/activity-catalog";
import type { ActivityRow } from "@/lib/server/activity-feed";
import { useUrlParam } from "@/lib/use-url-param";
import { useDebouncedValue } from "@/components/reports/use-debounced-value";
import { DataTableContainer } from "@/components/shared/data-table";

type Page = { rows: ActivityRow[]; nextCursor: string | null };
type Facets = { users: { id: string; email: string; name: string | null }[] };

const fetcher = async (url: string) => {
  const res = await fetch(url);
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((j as { error?: string }).error ?? "Failed to load");
  return j;
};

const SOURCES = ["web", "web_app", "handheld", "shopify_webhook", "machine", "external"] as const;

const fieldCls =
  "rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1.5 font-mono text-xs text-[var(--wms-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--wms-accent)]/40 max-md:min-h-11 max-md:w-full max-md:text-base";
const labelCls = "font-mono text-[0.6rem] uppercase tracking-wider text-[var(--wms-muted)] max-md:text-xs";

/** Local calendar day → ISO instant (start of that day; `next` = start of the following day). */
function dayIso(day: string, next = false): string | null {
  const m = day.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + (next ? 1 : 0));
  return d.toISOString();
}

function when(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  return {
    date: d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }),
    time: d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" }),
  };
}

export function ActivityHistoryWorkspace() {
  const [q, setQ] = useUrlParam("q");
  const [from, setFrom] = useUrlParam("from");
  const [to, setTo] = useUrlParam("to");
  const [user, setUser] = useUrlParam("user");
  const [module, setModule] = useUrlParam("module");
  const [source, setSource] = useUrlParam("source");
  const [readers, setReaders] = useUrlParam("readers");
  const [failed, setFailed] = useUrlParam("failed");
  const debouncedQ = useDebouncedValue(q ?? "", 400);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const { data: facets } = useSWR<Facets>("/api/reports/activity?facets=1", fetcher, { revalidateOnFocus: false });

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (debouncedQ.trim()) p.set("q", debouncedQ.trim());
    const f = from ? dayIso(from) : null;
    const t = to ? dayIso(to, true) : null;
    if (f) p.set("from", f);
    if (t) p.set("to", t);
    if (user) p.set("user", user);
    if (module) p.set("module", module);
    if (source) p.set("source", source);
    if (readers) p.set("readers", "1");
    if (failed) p.set("failed", "1");
    return p.toString();
  }, [debouncedQ, from, to, user, module, source, readers, failed]);

  const { data, error, isLoading, isValidating, size, setSize } = useSWRInfinite<Page>(
    (i, prev) => {
      if (prev && !prev.nextCursor) return null;
      const p = new URLSearchParams(query);
      p.set("limit", "100");
      if (i > 0 && prev?.nextCursor) p.set("cursor", prev.nextCursor);
      return `/api/reports/activity?${p.toString()}`;
    },
    fetcher,
    { revalidateOnFocus: true, revalidateFirstPage: true, refreshInterval: 30_000 },
  );

  const rows = useMemo(() => (data ?? []).flatMap((p) => p.rows), [data]);
  const hasMore = !!data?.[data.length - 1]?.nextCursor;
  const loadingMore = isValidating && size > (data?.length ?? 0);
  const filtered = Boolean(q || from || to || user || module || source || readers || failed);

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const clearAll = () => {
    for (const set of [setQ, setFrom, setTo, setUser, setModule, setSource, setReaders, setFailed]) set(null);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] p-3">
        <div className="flex flex-wrap items-end gap-2">
          <label className="relative flex min-w-[14rem] flex-1 items-center max-md:w-full">
            <Search className="pointer-events-none absolute left-3 h-4 w-4 text-[var(--wms-muted)]" strokeWidth={1.75} aria-hidden />
            <input
              id="activity-q"
              type="search"
              value={q ?? ""}
              onChange={(e) => setQ(e.target.value || null)}
              placeholder="Search EPC, SKU, product, user, page…"
              className={`${fieldCls} w-full py-2 pl-9 pr-3`}
              autoComplete="off"
            />
          </label>
          <label className="flex flex-col gap-1 max-md:w-full">
            <span className={labelCls}>From</span>
            <input id="activity-from" type="date" value={from ?? ""} onChange={(e) => setFrom(e.target.value || null)} className={fieldCls} />
          </label>
          <label className="flex flex-col gap-1 max-md:w-full">
            <span className={labelCls}>To</span>
            <input id="activity-to" type="date" value={to ?? ""} onChange={(e) => setTo(e.target.value || null)} className={fieldCls} />
          </label>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 max-md:w-full">
            <span className={labelCls}>User</span>
            <select id="activity-user" value={user ?? ""} onChange={(e) => setUser(e.target.value || null)} className={fieldCls}>
              <option value="">Everyone</option>
              {facets?.users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name ? `${u.name} (${u.email})` : u.email}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 max-md:w-full">
            <span className={labelCls}>Module</span>
            <select id="activity-module" value={module ?? ""} onChange={(e) => setModule(e.target.value || null)} className={fieldCls}>
              <option value="">All modules</option>
              {ACTIVITY_MODULES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 max-md:w-full">
            <span className={labelCls}>Source</span>
            <select id="activity-source" value={source ?? ""} onChange={(e) => setSource(e.target.value || null)} className={fieldCls}>
              <option value="">All sources</option>
              {SOURCES.map((s) => (
                <option key={s} value={s}>
                  {SOURCE_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 px-1 py-1.5 font-mono text-xs text-[var(--wms-fg)] max-md:min-h-11">
            <input id="activity-readers" type="checkbox" checked={!!readers} onChange={(e) => setReaders(e.target.checked ? "1" : null)} className="max-md:h-5 max-md:w-5" />
            Show reader movements
          </label>
          <label className="flex items-center gap-2 px-1 py-1.5 font-mono text-xs text-[var(--wms-fg)] max-md:min-h-11">
            <input id="activity-failed" type="checkbox" checked={!!failed} onChange={(e) => setFailed(e.target.checked ? "1" : null)} className="max-md:h-5 max-md:w-5" />
            Failed / blocked only
          </label>
          <div className="ml-auto flex items-center gap-2 max-md:ml-0 max-md:w-full">
            {filtered ? (
              <button
                type="button"
                onClick={clearAll}
                className="rounded-md px-2 py-1.5 font-mono text-xs text-[var(--wms-accent)] hover:underline max-md:min-h-11"
              >
                Clear filters
              </button>
            ) : null}
            <a
              href={`/api/reports/activity?${query}${query ? "&" : ""}format=csv`}
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-1.5 font-mono text-xs text-[var(--wms-fg)] hover:border-[var(--wms-accent)]/50 max-md:min-h-11 max-md:flex-1 max-md:justify-center"
            >
              <Download className="h-3.5 w-3.5" aria-hidden />
              Export CSV
            </a>
          </div>
        </div>
      </div>

      {error ? <p className="font-mono text-xs text-red-500/90">{String((error as Error).message)}</p> : null}

      <DataTableContainer maxHeight="min(72vh, 760px)">
        <table className="w-full min-w-[1180px] max-md:min-w-[560px] border-collapse text-left text-sm">
          <thead className="sticky top-0 z-10 bg-[var(--wms-surface-elevated)] font-mono text-[0.6rem] max-md:text-xs uppercase text-[var(--wms-muted)]">
            <tr className="border-b border-[var(--wms-border)]">
              <th className="w-8 px-2 py-3" aria-label="Expand" />
              <th className="w-[8.5rem] px-3 py-3">When</th>
              <th className="w-[11rem] px-3 py-3">Who</th>
              <th className="w-[9rem] px-3 py-3 max-md:hidden">Module</th>
              <th className="px-3 py-3">What happened</th>
              <th className="w-[15rem] px-3 py-3">Item</th>
              <th className="w-[12rem] px-3 py-3 max-md:hidden">Source</th>
              <th className="w-[6.5rem] px-3 py-3 max-md:hidden">Result</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--wms-border)]/80">
            {isLoading && !data ? (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-[var(--wms-muted)]">
                  Loading…
                </td>
              </tr>
            ) : !rows.length ? (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-[var(--wms-muted)]">
                  {filtered ? "Nothing matches these filters." : "No activity yet."}
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const isOpen = open.has(r.id);
                const w = when(r.at);
                return (
                  <Fragment key={r.id}>
                    <tr className={`align-top text-[var(--wms-fg)] ${r.outcome === "failed" ? "bg-red-500/[0.06]" : ""}`}>
                      <td className="px-2 py-2.5">
                        <button
                          type="button"
                          onClick={() => toggle(r.id)}
                          aria-expanded={isOpen}
                          aria-label={isOpen ? "Hide details" : "Show details"}
                          className="rounded p-0.5 text-[var(--wms-muted)] hover:text-[var(--wms-fg)] max-md:flex max-md:min-h-11 max-md:min-w-11 max-md:items-center max-md:justify-center"
                        >
                          {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </button>
                      </td>
                      <td className="px-3 py-2.5 font-mono text-xs tabular-nums">
                        <div>{w.time}</div>
                        <div className="text-[var(--wms-muted)]">{w.date}</div>
                      </td>
                      <td className="px-3 py-2.5 text-xs">
                        <div className="break-words font-medium">{r.actor || "—"}</div>
                        {r.user?.email && r.user.email !== r.actor ? (
                          <div className="break-all font-mono text-[0.65rem] text-[var(--wms-muted)] max-md:text-xs">{r.user.email}</div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2.5 font-mono text-xs text-[var(--wms-muted)] max-md:hidden">{r.module}</td>
                      <td className="px-3 py-2.5 text-xs">
                        <div className="font-medium">{r.action}</div>
                        {r.change && (r.change.from || r.change.to) ? (
                          <div className="mt-0.5 font-mono">
                            {r.change.from ? <span className="text-red-400/90">{r.change.from}</span> : null}
                            {r.change.from ? <span className="mx-1">→</span> : null}
                            <span className="wms-status-success">{r.change.to ?? "—"}</span>
                          </div>
                        ) : r.summary ? (
                          <div className="mt-0.5 break-words font-mono text-[0.65rem] text-[var(--wms-muted)] max-md:text-xs">{r.summary}</div>
                        ) : null}
                        {r.reason ? <div className="mt-0.5 text-[0.65rem] text-[var(--wms-muted)] max-md:text-xs">{r.reason}</div> : null}
                        {r.outcome === "failed" && r.error ? (
                          <div className="mt-0.5 break-words font-mono text-[0.65rem] text-red-400 max-md:text-xs">{r.error}</div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2.5 text-xs">
                        {r.item?.product || r.item?.sku ? (
                          <div className="break-words">
                            {[r.item.product, r.item.color, r.item.size].filter(Boolean).join(" · ")}
                          </div>
                        ) : null}
                        {r.item?.sku ? <div className="font-mono text-[0.65rem] text-[var(--wms-muted)] max-md:text-xs">SKU {r.item.sku}</div> : null}
                        {r.item?.epc ? <div className="break-all font-mono text-[0.65rem] text-[var(--wms-muted)] max-md:text-xs">{r.item.epc}</div> : null}
                        {r.itemCount ? <div className="font-mono text-[0.65rem] text-[var(--wms-muted)] max-md:text-xs">{r.itemCount} tags</div> : null}
                        {!r.item && !r.itemCount ? <span className="text-[var(--wms-muted)]">—</span> : null}
                      </td>
                      <td className="px-3 py-2.5 text-xs max-md:hidden">
                        <div>{r.source}</div>
                        {r.sourceDetail ? (
                          <div className="break-all font-mono text-[0.65rem] text-[var(--wms-muted)]">{r.sourceDetail}</div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2.5 font-mono text-xs max-md:hidden">
                        {r.outcome === "failed" ? (
                          <span className="text-red-400">Failed{r.status ? ` (${r.status})` : ""}</span>
                        ) : r.outcome === "ok" ? (
                          <span className="wms-status-success">Done</span>
                        ) : (
                          <span className="text-[var(--wms-muted)]">Recorded</span>
                        )}
                      </td>
                    </tr>
                    {isOpen ? (
                      <tr className="bg-[var(--wms-surface-elevated)]/60">
                        <td />
                        <td colSpan={7} className="px-3 pb-4 pt-1">
                          <RowDetails row={r} />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </DataTableContainer>

      <div className="flex items-center justify-between gap-3 font-mono text-xs text-[var(--wms-muted)]">
        <span>
          {rows.length} {rows.length === 1 ? "entry" : "entries"} shown
          {!readers ? " · reader movements hidden" : ""}
        </span>
        {hasMore ? (
          <button
            type="button"
            onClick={() => setSize(size + 1)}
            disabled={loadingMore}
            className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-1.5 text-[var(--wms-fg)] hover:border-[var(--wms-accent)]/50 disabled:opacity-50 max-md:min-h-11"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

const DETAIL_ORDER: [string, string][] = [
  ["method", "Request"],
  ["route", "Route"],
  ["path", "URL"],
  ["page", "Page"],
  ["source", "Source"],
  ["deviceId", "Device"],
  ["user_email", "Signed in as"],
  ["role", "Role"],
  ["ip", "IP address"],
  ["ua", "Browser / app"],
  ["status", "HTTP status"],
  ["ms", "Took (ms)"],
  ["error", "Error"],
];

function RowDetails({ row }: { row: ActivityRow }) {
  const d = row.details;
  const shown = new Set(DETAIL_ORDER.map(([k]) => k).concat(["v", "ok", "module", "label"]));
  const rest = Object.fromEntries(Object.entries(d).filter(([k, v]) => !shown.has(k) && v !== undefined && v !== null));
  const names = Object.entries(row.names);
  return (
    <div className="flex flex-col gap-3 text-xs">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 max-md:grid-cols-1">
        <dt className={labelCls}>When</dt>
        <dd className="font-mono">{new Date(row.at).toLocaleString()}</dd>
        <dt className={labelCls}>Who</dt>
        <dd>
          {row.actor || "—"}
          {row.user?.email ? <span className="ml-2 font-mono text-[var(--wms-muted)]">{row.user.email}</span> : null}
        </dd>
        <dt className={labelCls}>Module</dt>
        <dd>{row.module}</dd>
        {DETAIL_ORDER.map(([k, label]) =>
          d[k] !== undefined && d[k] !== null && d[k] !== "" ? (
            <Fragment key={k}>
              <dt className={labelCls}>{label}</dt>
              <dd className="break-all font-mono">{k === "source" ? (SOURCE_LABEL[String(d[k])] ?? String(d[k])) : String(d[k])}</dd>
            </Fragment>
          ) : null,
        )}
      </dl>
      {names.length ? (
        <div>
          <div className={labelCls}>Names for the ids below</div>
          <ul className="mt-1 flex flex-col gap-0.5 font-mono">
            {names.map(([id, n]) => (
              <li key={id} className="break-all">
                <span className="text-[var(--wms-muted)]">{id}</span> = {n}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {Object.keys(rest).length ? (
        <div>
          <div className={labelCls}>Everything recorded</div>
          <pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] p-2 font-mono text-[0.65rem] leading-relaxed max-md:text-xs">
            {JSON.stringify(rest, null, 2)}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
