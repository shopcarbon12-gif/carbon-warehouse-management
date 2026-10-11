"use client";

import { useMemo, useState } from "react";
import { Languages, RefreshCw } from "lucide-react";
import { fmtWhen, useChannelJob, useChannelStatus } from "./use-channel-job";

type Change = {
  product: string;
  productId: string;
  locale: string;
  key: "title" | "body_html" | "meta_title" | "meta_description";
  reason: string;
  before: string | null;
  after: string;
};
type Result = {
  model: string;
  locales: string[];
  products: number;
  checked_fields: number;
  changes: Change[];
  titles_reviewed: number;
  titles_fixed: number;
  errors: string[];
};

const FIELD: Record<Change["key"], string> = {
  title: "Title",
  body_html: "Description",
  meta_title: "SEO title",
  meta_description: "SEO description",
};
const LANG: Record<string, string> = { es: "Spanish", "pt-BR": "Portuguese", pt: "Portuguese" };

const plain = (s: string | null) =>
  (s ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Integrations → Shopify: "Translate". Checks every active product in every
 * store language and fixes missing, out-of-date and wrong translations with
 * Claude, using the Carbon rules (brand never translated, model names in
 * English, store glossary), then reviews the titles it touched.
 */
export function ShopifyTranslatePanel() {
  const { data: status, mutate } = useChannelStatus();
  const { job, running, err, start } = useChannelJob<Result>("translate", status?.translate?.id, () => void mutate());
  const [fullCheck, setFullCheck] = useState(false);
  const [lang, setLang] = useState<string>("all");
  const [open, setOpen] = useState(false);

  const result = job?.result ?? null;
  const changes = useMemo(
    () => (result?.changes ?? []).filter((c) => lang === "all" || c.locale === lang),
    [result, lang],
  );
  const ready = status?.connected.claude !== false;

  return (
    <div className="space-y-4 rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80 p-5">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] text-[var(--wms-accent)]">
          <Languages className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <h3 className="font-mono text-sm font-semibold text-[var(--wms-fg)]">Translate (Spanish + Portuguese)</h3>
          <p className="mt-0.5 font-mono text-[0.7rem] leading-relaxed text-[var(--wms-muted)]">
            Checks every active product&apos;s title, description and SEO text in each store language. Fills what
            is missing, updates what changed in English, and fixes wrong translations — the brand Carbon is never
            translated, model names and slogans stay in English, garment words follow the store glossary. A second
            check reviews the titles it wrote. Set products get the &quot;Complete the Look&quot; image in their
            language. Run it after adding or editing products, or after Shopify&apos;s Auto-translate.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 font-mono text-[0.7rem] sm:grid-cols-3">
        <Stat label="AI" value={status ? (status.connected.claude ? status.connected.claude_model : "not set up") : "…"} ok={status?.connected.claude} />
        <Stat label="Last run" value={fmtWhen(status?.translate?.finished_at ?? status?.translate?.created_at)} />
        <Stat
          label="Last result"
          value={result ? `${result.changes.length} fixed · ${result.products} products` : job?.status === "failed" ? "failed" : "—"}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={running || !ready}
          onClick={() => void start({ fullTitleCheck: fullCheck })}
          title={ready ? "Check and fix all translations" : "Set ANTHROPIC_API_KEY in Coolify first"}
          className="inline-flex items-center gap-2 rounded-lg border border-[var(--wms-accent)]/50 bg-[var(--wms-accent)] px-5 py-2.5 font-mono text-xs font-semibold text-[var(--wms-accent-fg)] shadow-sm hover:opacity-90 disabled:opacity-40"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${running ? "animate-spin" : ""}`} />
          {running ? "Translating…" : "Translate"}
        </button>
        <label className="inline-flex items-center gap-2 font-mono text-[0.7rem] text-[var(--wms-muted)]">
          <input type="checkbox" checked={fullCheck} disabled={running} onChange={(e) => setFullCheck(e.target.checked)} />
          Also re-check every existing title (slower)
        </label>
        {err ? <span className="font-mono text-xs text-red-400/90">{err}</span> : null}
      </div>

      {job && running ? <Progress pct={job.pct} message={job.message ?? `${job.done}/${job.total}`} /> : null}
      {job?.status === "failed" ? <p className="font-mono text-xs text-red-400/90">{job.error ?? "Translation failed"}</p> : null}

      {job?.status === "completed" && result ? (
        <div className="space-y-3">
          <p className="font-mono text-[0.7rem] text-emerald-500/90">
            {job.message} · {result.checked_fields} fields checked · {result.titles_reviewed} titles reviewed
            {result.titles_fixed ? `, ${result.titles_fixed} corrected` : ""} · {fmtWhen(job.finished_at)}
          </p>
          {result.errors.length ? (
            <details className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 font-mono text-[0.7rem] text-amber-500">
              <summary className="cursor-pointer">{result.errors.length} item(s) could not be translated — left unchanged</summary>
              <ul className="mt-2 list-disc space-y-0.5 pl-5">
                {result.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </details>
          ) : null}
          {result.changes.length ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setOpen((v) => !v)}
                  className="rounded-md border border-[var(--wms-border)] px-3 py-1.5 font-mono text-[0.7rem] text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)]"
                >
                  {open ? "Hide" : "Show"} all {result.changes.length} changes
                </button>
                {open
                  ? ["all", ...result.locales].map((l) => (
                      <button
                        key={l}
                        type="button"
                        onClick={() => setLang(l)}
                        className={`rounded-md border px-2.5 py-1 font-mono text-[0.65rem] ${
                          lang === l
                            ? "border-[var(--wms-accent)] text-[var(--wms-accent)]"
                            : "border-[var(--wms-border)] text-[var(--wms-muted)]"
                        }`}
                      >
                        {l === "all" ? "All languages" : (LANG[l] ?? l)}
                      </button>
                    ))
                  : null}
              </div>
              {open ? (
                <div className="max-h-[32rem] overflow-auto rounded-md border border-[var(--wms-border)]">
                  <table className="w-full border-collapse font-mono text-[0.68rem]">
                    <thead className="sticky top-0 bg-[var(--wms-surface-elevated)] text-left text-[var(--wms-muted)]">
                      <tr>
                        <th className="px-2 py-1.5">Product</th>
                        <th className="px-2 py-1.5">Language · field</th>
                        <th className="px-2 py-1.5">Before</th>
                        <th className="px-2 py-1.5">After</th>
                        <th className="px-2 py-1.5">Why</th>
                      </tr>
                    </thead>
                    <tbody>
                      {changes.map((c, i) => (
                        <tr key={i} className="border-t border-[var(--wms-border)] align-top">
                          <td className="px-2 py-1.5 text-[var(--wms-fg)]">{c.product}</td>
                          <td className="whitespace-nowrap px-2 py-1.5 text-[var(--wms-muted)]">
                            {LANG[c.locale] ?? c.locale} · {FIELD[c.key]}
                          </td>
                          <td className="max-w-[16rem] px-2 py-1.5 text-[var(--wms-muted)]">
                            <span className="line-clamp-3">{plain(c.before) || "—"}</span>
                          </td>
                          <td className="max-w-[16rem] px-2 py-1.5 text-[var(--wms-fg)]">
                            <span className="line-clamp-3">{plain(c.after)}</span>
                          </td>
                          <td className="px-2 py-1.5 text-[var(--wms-muted)]">{c.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function Progress({ pct, message }: { pct: number; message: string }) {
  return (
    <div className="space-y-1">
      <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--wms-surface-elevated)]">
        <div className="h-full rounded-full bg-[var(--wms-accent)] transition-[width] duration-300" style={{ width: `${Math.max(2, pct)}%` }} />
      </div>
      <p className="font-mono text-[0.65rem] text-[var(--wms-muted)]">
        {message} · {pct}%
      </p>
    </div>
  );
}

export function Stat({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/40 px-3 py-2">
      <div className="text-[0.55rem] uppercase tracking-wide text-[var(--wms-muted)]">{label}</div>
      <div
        className={`mt-0.5 truncate ${ok === false ? "text-amber-500" : ok === true ? "text-emerald-500" : "text-[var(--wms-fg)]"}`}
        title={value}
      >
        {value}
      </div>
    </div>
  );
}
