"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Metafields tab (M4) — custom text + Google-feed tiers pushed to Shopify, plus
 * a "create new collection" affordance (product→collection assignment already
 * happens automatically on publish via the taxonomy mapper).
 */
type Props = { matrixId: string; shopifyProductId: string | null; canManage: boolean };

const label = "block text-[0.6rem] uppercase tracking-wide text-[var(--wms-muted)] mb-1";
const field =
  "w-full rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] px-2 py-1.5 font-mono text-xs text-[var(--wms-fg)]";

export function MetafieldsTab({ matrixId, shopifyProductId, canManage }: Props) {
  const [values, setValues] = useState({
    fullDescription: "",
    gender: "",
    ageGroup: "",
    condition: "",
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [newCollection, setNewCollection] = useState("");

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

  const createCollection = useCallback(async () => {
    const title = newCollection.trim();
    if (!title) return;
    setBusy("collection");
    setErr(null);
    setMsg(null);
    try {
      const r = await fetch("/api/shopify/collections/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string; handle?: string };
      if (!r.ok) throw new Error(j.error ?? "Create failed");
      setMsg(`Created collection "${title}".`);
      setNewCollection("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(null);
    }
  }, [newCollection]);

  if (!shopifyProductId) {
    return (
      <div className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/40 p-4 font-mono text-xs text-[var(--wms-muted)]">
        Publish this product to Shopify first (use{" "}
        <span className="text-[var(--wms-accent)]">✔ Check &amp; Publish</span>), then set metafields
        here.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/40">
        <div className="border-b border-[var(--wms-border)]/70 bg-[var(--wms-surface-elevated)]/70 px-3 py-1.5 font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-muted)]">
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
          <div className="grid grid-cols-3 gap-3">
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
          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={!canManage || busy !== null}
              onClick={() => void push()}
              className="rounded-md border border-[var(--wms-accent)]/60 bg-[var(--wms-accent)]/15 px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-fg)] hover:bg-[var(--wms-accent)]/25 disabled:opacity-50"
            >
              {busy === "push" ? "Pushing…" : "⤴ Push metafields"}
            </button>
            <span className="font-mono text-[0.55rem] text-[var(--wms-muted)]">
              Google fields apply to every variant.
            </span>
          </div>
        </div>
      </div>

      <div className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/40">
        <div className="border-b border-[var(--wms-border)]/70 bg-[var(--wms-surface-elevated)]/70 px-3 py-1.5 font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-muted)]">
          Collections
        </div>
        <div className="space-y-2 p-3">
          <p className="font-mono text-[0.6rem] text-[var(--wms-muted)]">
            Products are auto-assigned to collections on publish. Create a new collection:
          </p>
          <div className="flex gap-2">
            <input
              className={field}
              placeholder="New collection title…"
              value={newCollection}
              onChange={(e) => setNewCollection(e.target.value)}
            />
            <button
              type="button"
              disabled={!canManage || busy !== null || !newCollection.trim()}
              onClick={() => void createCollection()}
              className="whitespace-nowrap rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)] disabled:opacity-50"
            >
              {busy === "collection" ? "…" : "＋ Create"}
            </button>
          </div>
        </div>
      </div>

      {msg ? <p className="font-mono text-[0.6rem] text-[var(--wms-status-success-fg)]">{msg}</p> : null}
      {err ? <p className="font-mono text-[0.6rem] text-[var(--wms-status-danger-fg)]">{err}</p> : null}
    </div>
  );
}
