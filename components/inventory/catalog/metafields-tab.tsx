"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from "react";

/**
 * Metafields panel (M4) — custom text + Google-feed tiers pushed to Shopify.
 * Rendered inside the SEO tab. Its "AI fill from hero" and "push" actions are
 * exposed imperatively (via ref) so the SEO tab can drive them from its single
 * combined "Optimize with AI" / "Push to Shopify" buttons. Collections now live
 * in their own tab.
 */
type Props = {
  matrixId: string;
  shopifyProductId: string | null;
  canManage: boolean;
  /** Show this panel's own AI-fill / push buttons. Off when the SEO tab drives them. */
  showActions?: boolean;
};

export type MetafieldsHandle = {
  aiFill: (signal?: AbortSignal) => Promise<void>;
  push: () => Promise<void>;
};

const label = "block text-[0.74rem] uppercase tracking-wide text-[var(--wms-muted)] mb-1";
const field =
  "w-full rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] px-2 py-1.5 font-mono text-[0.85rem] text-[var(--wms-fg)] max-md:text-base";

export const MetafieldsTab = forwardRef<MetafieldsHandle, Props>(function MetafieldsTab(
  { matrixId, shopifyProductId, canManage, showActions = true },
  ref,
) {
  const [values, setValues] = useState({
    fullDescription: "",
    gender: "",
    ageGroup: "",
    condition: "",
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!shopifyProductId) return;
    let alive = true;
    void (async () => {
      try {
        const r = await fetch(`/api/shopify/metafields?matrixId=${matrixId}`);
        const j = (await r.json().catch(() => ({}))) as { values?: Record<string, string> };
        if (alive && j.values) {
          setValues((v) => ({ ...v, ...j.values }));
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      alive = false;
    };
  }, [matrixId, shopifyProductId]);

  const aiFill = useCallback(async (signal?: AbortSignal) => {
    setBusy("ai");
    setErr(null);
    setMsg(null);
    try {
      const r = await fetch("/api/shopify/metafields/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matrixId }),
        signal,
      });
      const j = (await r.json().catch(() => ({}))) as { values?: Record<string, string>; error?: string };
      if (!r.ok || !j.values) throw new Error(j.error ?? "AI scan failed");
      setValues((v) => ({ ...v, ...j.values }));
      setMsg("Filled from the hero image — review, then push.");
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return; // cancelled — not an error
      setErr(e instanceof Error ? e.message : "AI scan failed");
    } finally {
      setBusy(null);
    }
  }, [matrixId]);

  const push = useCallback(async () => {
    setBusy("push");
    setErr(null);
    setMsg(null);
    try {
      const r = await fetch("/api/shopify/metafields", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matrixId, values }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string; pushed?: number };
      if (!r.ok) throw new Error(j.error ?? "Push failed");
      setMsg(`Pushed ${j.pushed ?? 0} metafield(s) to Shopify.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Push failed");
    } finally {
      setBusy(null);
    }
  }, [matrixId, values]);

  useImperativeHandle(ref, () => ({ aiFill, push }), [aiFill, push]);

  if (!shopifyProductId) {
    return (
      <div className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/40 p-4 font-mono text-[0.85rem] text-[var(--wms-muted)]">
        Publish this product to Shopify first (use{" "}
        <span className="text-[var(--wms-accent)]">✔ Check &amp; Publish</span>), then set metafields
        here.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/40">
        <div className="border-b border-[var(--wms-border)]/70 bg-[var(--wms-surface-elevated)]/70 px-3 py-1.5 font-mono text-[0.74rem] uppercase tracking-wide text-[var(--wms-muted)]">
          Metafields · custom + Google feed
        </div>
        <div className="space-y-3 p-3">
          <div>
            <span className={label}>Full description (custom.short_descriptions_)</span>
            <textarea
              className={field}
              rows={3}
              value={values.fullDescription}
              onChange={(e) => setValues((v) => ({ ...v, fullDescription: e.target.value }))}
            />
          </div>
          <div className="grid grid-cols-3 gap-3 max-sm:grid-cols-1">
            <div>
              <span className={label}>Gender (Google)</span>
              <select
                className={field}
                value={values.gender}
                onChange={(e) => setValues((v) => ({ ...v, gender: e.target.value }))}
              >
                <option value="">—</option>
                <option>male</option>
                <option>female</option>
                <option>unisex</option>
              </select>
            </div>
            <div>
              <span className={label}>Age group (Google)</span>
              <select
                className={field}
                value={values.ageGroup}
                onChange={(e) => setValues((v) => ({ ...v, ageGroup: e.target.value }))}
              >
                <option value="">—</option>
                <option>adult</option>
                <option>kids</option>
                <option>toddler</option>
                <option>infant</option>
                <option>newborn</option>
              </select>
            </div>
            <div>
              <span className={label}>Condition (Google)</span>
              <select
                className={field}
                value={values.condition}
                onChange={(e) => setValues((v) => ({ ...v, condition: e.target.value }))}
              >
                <option value="">—</option>
                <option>new</option>
                <option>used</option>
                <option>refurbished</option>
              </select>
            </div>
          </div>
          {showActions ? (
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={!canManage || busy !== null}
                onClick={() => void aiFill()}
                title="Scan the product's hero image and fill these fields"
                className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] px-3 py-1.5 font-mono text-[0.78rem] uppercase tracking-wide text-[var(--wms-accent)] hover:bg-[var(--wms-surface-elevated)] disabled:opacity-50"
              >
                {busy === "ai" ? "Scanning…" : "✨ AI fill from hero"}
              </button>
              <button
                type="button"
                disabled={!canManage || busy !== null}
                onClick={() => void push()}
                className="rounded-md border border-[var(--wms-accent)]/60 bg-[var(--wms-accent)]/15 px-3 py-1.5 font-mono text-[0.78rem] uppercase tracking-wide text-[var(--wms-fg)] hover:bg-[var(--wms-accent)]/25 disabled:opacity-50"
              >
                {busy === "push" ? "Pushing…" : "⤴ Push metafields"}
              </button>
              <span className="font-mono text-[0.68rem] text-[var(--wms-muted)]">
                Google fields apply to every variant.
              </span>
            </div>
          ) : (
            <span className="font-mono text-[0.68rem] text-[var(--wms-muted)]">
              Filled by ✦ Optimize with AI · saved by ⤴ Push to Shopify (above). Google fields apply
              to every variant.
            </span>
          )}
        </div>
      </div>

      {msg ? <p className="font-mono text-[0.74rem] text-[var(--wms-status-success-fg)]">{msg}</p> : null}
      {err ? <p className="font-mono text-[0.74rem] text-[var(--wms-status-danger-fg)]">{err}</p> : null}
    </div>
  );
});
