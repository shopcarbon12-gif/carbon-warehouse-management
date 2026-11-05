"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Full SEO panel (SEO tab) — the per-product version of the Nov 2026 catalog
 * pass (lib/server/seo-full.ts). Shows the latest run, the owner notes and any
 * colour-name suggestions (with Apply), and can start a run. New products and
 * products whose photos/colours change are run automatically by the worker.
 */
type ColourFix = { from: string; to: string; why: string; photos?: number[] };
type Run = {
  id: string;
  status: string;
  trigger: string;
  created_at: string;
  finished_at: string | null;
  error: string | null;
  colour_fix: ColourFix[] | null;
  owner_notes: string | null;
  confidence: string | null;
  done: string[] | null;
  progress_message: string | null;
};

const STATUS: Record<string, string> = {
  baseline: "Done in the Nov 2026 catalog pass",
  queued: "Waiting for the worker…",
  running: "Running…",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
};

const when = (s: string | null) => (s ? new Date(s).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "");

export function FullSeoPanel({ matrixId, canManage }: { matrixId: string; canManage: boolean }) {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [configured, setConfigured] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/shopify/seo/full?matrixId=${encodeURIComponent(matrixId)}`, { cache: "no-store" });
      const j = (await r.json()) as { runs?: Run[]; configured?: boolean; error?: string };
      if (!r.ok) throw new Error(j.error || "Could not load");
      setRuns(j.runs || []);
      setConfigured(j.configured !== false);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not load");
    }
  }, [matrixId]);

  useEffect(() => {
    void load();
  }, [load]);

  const latest = runs?.[0];
  const active = latest && (latest.status === "queued" || latest.status === "running");
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [active, load]);

  const runNow = async () => {
    setBusy("run");
    setMsg(null);
    try {
      const r = await fetch("/api/shopify/seo/full", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ matrixId }) });
      const j = (await r.json()) as { error?: string; already?: boolean };
      if (!r.ok) throw new Error(j.error || "Could not start");
      setMsg(j.already ? "A run is already queued." : "Queued — it takes about 2–4 minutes.");
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not start");
    } finally {
      setBusy(null);
    }
  };

  const apply = async (f: ColourFix) => {
    const key = `${f.from}>${f.to}`;
    if (armed !== key) {
      setArmed(key);
      return;
    }
    setBusy(key);
    setArmed(null);
    setMsg(null);
    try {
      const r = await fetch("/api/shopify/seo/full/colour", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ matrixId, from: f.from, to: f.to }) });
      const j = (await r.json()) as { error?: string; renamed?: { skus: number }[] };
      if (!r.ok) throw new Error(j.error || "Rename failed");
      const n = (j.renamed || []).reduce((a, x) => a + x.skus, 0);
      setMsg(`${f.from} → ${f.to}: ${n} SKU(s) renamed${(j.renamed || []).length > 1 ? " (set pieces too)" : ""}. Publishing, then the SEO is rewritten with the new name. Reprint the tags.`);
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Rename failed");
    } finally {
      setBusy(null);
    }
  };

  const fixes = latest?.status === "done" ? latest.colour_fix || [] : [];

  return (
    <div className="rounded-lg border border-[var(--wms-accent)]/40 bg-[var(--wms-accent)]/5 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[0.74rem] font-bold uppercase tracking-wider text-[var(--wms-fg)]">★ Full SEO</span>
        <span className="font-mono text-[0.72rem] text-[var(--wms-muted)]">
          photos → copy, every alt, attributes, ES/PT, tags, feed — same as the Nov 2026 catalog pass
        </span>
        <div className="flex-1" />
        <button
          type="button"
          disabled={!canManage || !configured || busy !== null || Boolean(active)}
          onClick={() => void runNow()}
          title="Run the full SEO pass on this product now (new products and photo changes run automatically)"
          className="rounded-md border border-[var(--wms-accent)]/60 bg-[var(--wms-accent)]/15 px-3 py-1 font-mono text-[0.74rem] uppercase tracking-wide text-[var(--wms-fg)] hover:bg-[var(--wms-accent)]/25 disabled:opacity-50 max-md:min-h-11"
        >
          {busy === "run" ? "Starting…" : active ? "Running…" : "Run now"}
        </button>
      </div>

      <div className="mt-1.5 font-mono text-[0.74rem] text-[var(--wms-muted)]">
        {runs === null ? (
          "Loading…"
        ) : !latest ? (
          "Not run yet — it runs by itself within 30 minutes of the product having photos on Shopify."
        ) : (
          <>
            <span className={latest.status === "failed" ? "text-[var(--wms-status-danger-fg)]" : latest.status === "done" || latest.status === "baseline" ? "text-[var(--wms-status-success-fg)]" : ""}>
              {STATUS[latest.status] || latest.status}
            </span>{" "}
            · {when(latest.finished_at || latest.created_at)}
            {latest.trigger !== "baseline" ? ` · ${latest.trigger === "watch" ? "automatic" : latest.trigger}` : ""}
            {active && latest.progress_message ? ` · ${latest.progress_message}` : ""}
          </>
        )}
      </div>

      {latest?.status === "done" && latest.done?.length ? (
        <div className="mt-1 font-mono text-[0.72rem] text-[var(--wms-muted)]">{latest.done.join(" · ")}</div>
      ) : null}
      {latest?.status === "failed" && latest.error ? (
        <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap font-mono text-[0.7rem] text-[var(--wms-status-danger-fg)]">{latest.error}</pre>
      ) : null}

      {fixes.length ? (
        <div className="mt-2 space-y-1.5">
          <span className="block font-mono text-[0.72rem] font-bold uppercase tracking-wider text-amber-300">Colour name looks wrong</span>
          {fixes.map((f) => {
            const key = `${f.from}>${f.to}`;
            return (
              <div key={key} className="flex flex-wrap items-center gap-2 rounded-md border border-amber-400/40 bg-amber-500/5 px-2 py-1.5">
                <span className="font-mono text-[0.78rem] text-[var(--wms-fg)]">
                  {f.from} → <b>{f.to}</b>
                </span>
                <span className="min-w-0 flex-1 font-mono text-[0.72rem] text-[var(--wms-muted)]">
                  {f.why}
                  {f.photos?.length ? ` (photos ${f.photos.map((n) => `#${n}`).join(", ")})` : ""}
                </span>
                <button
                  type="button"
                  disabled={!canManage || busy !== null}
                  onClick={() => void apply(f)}
                  className="rounded-md border border-amber-400/70 bg-amber-500/15 px-2.5 py-1 font-mono text-[0.72rem] uppercase tracking-wide text-[var(--wms-fg)] hover:bg-amber-500/25 disabled:opacity-50 max-md:min-h-11"
                >
                  {busy === key ? "Renaming…" : armed === key ? "Confirm rename" : "Apply"}
                </button>
              </div>
            );
          })}
        </div>
      ) : null}

      {latest?.status === "done" && latest.owner_notes?.trim() ? (
        <div className="mt-2 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/40 px-2 py-1.5 font-mono text-[0.72rem] text-[var(--wms-fg)]">
          <span className="font-bold uppercase tracking-wider text-[var(--wms-muted)]">Notes for you · </span>
          {latest.owner_notes}
        </div>
      ) : null}

      {!configured ? <div className="mt-1 font-mono text-[0.72rem] text-[var(--wms-status-danger-fg)]">AI is not configured on this server (ANTHROPIC_API_KEY).</div> : null}
      {msg ? <div className="mt-1 font-mono text-[0.72rem] text-[var(--wms-fg)]">{msg}</div> : null}
    </div>
  );
}
