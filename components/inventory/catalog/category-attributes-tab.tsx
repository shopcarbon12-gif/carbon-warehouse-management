"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Shopify category attributes (taxonomy metafields) — Neckline, Dress style,
 * Fabric, Sleeve length, Target gender, Occasion, Care, etc. Values are Shopify
 * taxonomy metaobjects; the AI picks valid ones from the hero image + title and
 * pushes them as proper metaobject references. Rendered inside the SEO tab.
 */
type Allowed = { name: string; gid: string };
type Attr = { key: string; label: string; allowed: Allowed[]; current: string[] };
type Props = { matrixId: string; shopifyProductId: string | null; canManage: boolean };

const chip =
  "inline-flex items-center gap-1 rounded border border-[var(--wms-accent)]/40 bg-[var(--wms-accent)]/10 px-1.5 py-0.5 font-mono text-[0.6rem] text-[var(--wms-fg)]";
const selCls =
  "rounded border border-[var(--wms-border)] bg-[var(--wms-surface)] px-1.5 py-0.5 font-mono text-[0.6rem] text-[var(--wms-fg)]";

export function CategoryAttributesTab({ matrixId, shopifyProductId, canManage }: Props) {
  const [category, setCategory] = useState<{ id: string; name: string } | null>(null);
  const [attrs, setAttrs] = useState<Attr[]>([]);
  const [sel, setSel] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!shopifyProductId) {
      setLoaded(true);
      return;
    }
    setBusy("load");
    setErr(null);
    try {
      const r = await fetch(`/api/shopify/category-attributes?matrixId=${matrixId}`);
      const j = (await r.json().catch(() => ({}))) as { category?: { id: string; name: string } | null; attributes?: Attr[]; error?: string };
      if (!r.ok) throw new Error(j.error ?? "Could not load category attributes");
      setCategory(j.category ?? null);
      setAttrs(j.attributes ?? []);
      const init: Record<string, string[]> = {};
      for (const a of j.attributes ?? []) init[a.key] = [...(a.current ?? [])];
      setSel(init);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Load failed");
    } finally {
      setBusy(null);
      setLoaded(true);
    }
  }, [matrixId, shopifyProductId]);

  useEffect(() => {
    void load();
  }, [load]);

  const aiFill = useCallback(async () => {
    setBusy("ai");
    setErr(null);
    setMsg(null);
    try {
      const r = await fetch("/api/shopify/category-attributes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matrixId, action: "suggest" }),
      });
      const j = (await r.json().catch(() => ({}))) as {
        category?: { id: string; name: string } | null;
        attributes?: Attr[];
        suggestions?: Record<string, string[]>;
        assignedCategory?: boolean;
        error?: string;
      };
      if (!r.ok) throw new Error(j.error ?? "AI fill failed");
      const sugg = j.suggestions ?? {};
      if (j.category !== undefined) setCategory(j.category ?? null);
      if (j.attributes) {
        setAttrs(j.attributes);
        // Rebuild selection: current values, overlaid with AI suggestions.
        const init: Record<string, string[]> = {};
        for (const a of j.attributes) init[a.key] = [...(a.current ?? [])];
        for (const [k, v] of Object.entries(sugg)) init[k] = v;
        setSel(init);
      } else {
        setSel((prev) => {
          const next = { ...prev };
          for (const [k, v] of Object.entries(sugg)) next[k] = v;
          return next;
        });
      }
      const n = Object.keys(sugg).length;
      const catNote = j.assignedCategory ? `Set category "${j.category?.name ?? ""}". ` : "";
      setMsg(
        n
          ? `${catNote}AI filled ${n} attribute(s) — review, then push.`
          : `${catNote}${j.attributes && j.attributes.length ? "No attributes could be confidently determined." : "No matching Shopify category found — set one in Shopify."}`,
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : "AI fill failed");
    } finally {
      setBusy(null);
    }
  }, [matrixId]);

  const push = useCallback(async () => {
    setBusy("push");
    setErr(null);
    setMsg(null);
    try {
      const r = await fetch("/api/shopify/category-attributes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matrixId, action: "push", values: sel }),
      });
      const j = (await r.json().catch(() => ({}))) as { pushed?: number; cleared?: number; warnings?: string[]; error?: string };
      if (!r.ok) throw new Error(j.error ?? "Push failed");
      if (j.warnings?.length) setErr(`Some failed: ${j.warnings.slice(0, 3).join(" · ")}`);
      else setMsg(`Pushed ${j.pushed ?? 0} attribute(s) to Shopify${j.cleared ? `, cleared ${j.cleared}` : ""}.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Push failed");
    } finally {
      setBusy(null);
    }
  }, [matrixId, sel]);

  const addVal = (key: string, gid: string) =>
    setSel((prev) => ({ ...prev, [key]: Array.from(new Set([...(prev[key] ?? []), gid])) }));
  const removeVal = (key: string, gid: string) =>
    setSel((prev) => ({ ...prev, [key]: (prev[key] ?? []).filter((g) => g !== gid) }));

  if (!shopifyProductId) {
    return (
      <div className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/40 p-4 font-mono text-xs text-[var(--wms-muted)]">
        Publish or link this product to Shopify first, then fill its category attributes here.
      </div>
    );
  }

  return (
    <div className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/40">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--wms-border)]/70 bg-[var(--wms-surface-elevated)]/70 px-3 py-1.5">
        <span className="font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-muted)]">Category attributes</span>
        {category ? (
          <span className="rounded border border-[var(--wms-border)] px-1.5 py-0.5 font-mono text-[0.55rem] text-[var(--wms-fg)]">{category.name}</span>
        ) : null}
        <div className="flex-1" />
        <button
          type="button"
          disabled={!canManage || busy !== null}
          onClick={() => void aiFill()}
          title="Assign a Shopify category if missing, then scan the hero + title and fill attributes from the allowed values"
          className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] px-3 py-1.5 font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-accent)] hover:bg-[var(--wms-surface-elevated)] disabled:opacity-50"
        >
          {busy === "ai" ? "Scanning…" : "✨ AI fill category attributes"}
        </button>
        <button
          type="button"
          disabled={!canManage || busy !== null || !attrs.length}
          onClick={() => void push()}
          className="rounded-md border border-[var(--wms-accent)]/60 bg-[var(--wms-accent)]/15 px-3 py-1.5 font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-fg)] hover:bg-[var(--wms-accent)]/25 disabled:opacity-50"
        >
          {busy === "push" ? "Pushing…" : "⤴ Push to Shopify"}
        </button>
      </div>

      <div className="p-3">
        {busy === "load" && !loaded ? (
          <p className="font-mono text-[0.6rem] text-[var(--wms-muted)]">Loading category attributes…</p>
        ) : loaded && !category ? (
          <p className="font-mono text-[0.6rem] text-[var(--wms-muted)]">
            No Shopify category set. Click{" "}
            <span className="text-[var(--wms-accent)]">✨ AI fill category attributes</span> to
            auto-assign one and fill the fields.
          </p>
        ) : loaded && !attrs.length ? (
          <p className="font-mono text-[0.6rem] text-[var(--wms-muted)]">No fillable category attributes for this category.</p>
        ) : (
          <div className="space-y-2">
            {attrs.map((a) => {
              const nameByGid = new Map(a.allowed.map((v) => [v.gid, v.name]));
              const selected = sel[a.key] ?? [];
              const remaining = a.allowed.filter((v) => !selected.includes(v.gid));
              return (
                <div key={a.key} className="grid grid-cols-[130px_1fr] items-start gap-2">
                  <span className="pt-1 font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-muted)]">{a.label}</span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {selected.map((gid) => (
                      <span key={gid} className={chip}>
                        {nameByGid.get(gid) ?? "?"}
                        <button
                          type="button"
                          onClick={() => removeVal(a.key, gid)}
                          className="text-[var(--wms-status-danger-fg)]"
                          aria-label="Remove"
                        >
                          ✕
                        </button>
                      </span>
                    ))}
                    <select
                      className={selCls}
                      value=""
                      disabled={!canManage || remaining.length === 0}
                      onChange={(e) => {
                        if (e.target.value) addVal(a.key, e.target.value);
                        e.target.value = "";
                      }}
                    >
                      <option value="">＋ add…</option>
                      {remaining.map((v) => (
                        <option key={v.gid} value={v.gid}>
                          {v.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {err ? (
          <p className="mt-2 font-mono text-[0.6rem] text-[var(--wms-status-danger-fg)]">{err}</p>
        ) : msg ? (
          <p className="mt-2 font-mono text-[0.6rem] text-[var(--wms-status-success-fg)]">{msg}</p>
        ) : null}
      </div>
    </div>
  );
}
