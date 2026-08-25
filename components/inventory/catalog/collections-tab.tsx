"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Per-product Collections tab. Reuses the ported collection-mapping engine
 * (GET /api/shopify/collection-mapping?upc=… returns the full menu TREE, the
 * product's CURRENT Shopify membership, and the auto-map/suggestions; POST
 * action:"toggle-node" pushes one UPC group to Shopify). On open it scopes to
 * this product (parent UPC), runs the auto path (pre-selecting current +
 * suggested), shows current collections, and pushes on demand. The menu tree
 * hierarchy is preserved.
 */
type Node = {
  nodeKey: string;
  label: string;
  parentKey: string | null;
  depth: number;
  sortOrder: number;
  enabled: boolean;
  collectionId: string | null;
  collectionHandle: string | null;
  collectionTitle: string | null;
};
type CollectionOption = { id: string; title: string; handle: string };
type Row = {
  upc: string;
  title: string;
  itemType: string | null;
  collectionIds: string[];
  checkedNodeKeys: string[];
  currentDirectCollections: string[];
  autoMappedPaths: string[];
  suggestedPaths: string[];
  directCollectionsToAssign: string[];
  suggestedDirectCollections: string[];
  mappingDecision: string;
};
type ApiResp = { ok?: boolean; error?: string; warning?: string; nodes?: Node[]; collections?: CollectionOption[]; rows?: Row[] };
type Data = { nodes: Node[]; collections: CollectionOption[]; row: Row };

type Props = {
  upc: string | null;
  shopifyProductId: string | null;
  canManage: boolean;
  /** Called after a successful push so the parent can refresh its own view (e.g. the SEO tab's current-collections list). */
  onCollectionsChanged?: () => void;
};

const API = "/api/shopify/collection-mapping";

function normPath(p: string): string {
  return p.split(">").map((s) => s.trim()).filter(Boolean).join(" > ").toLowerCase();
}

export function CollectionsTab({ upc, shopifyProductId, canManage, onCollectionsChanged }: Props) {
  const [data, setData] = useState<Data | null>(null);
  const [busy, setBusy] = useState<"load" | "push" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [selNodes, setSelNodes] = useState<Set<string>>(new Set());
  const [selDirect, setSelDirect] = useState<Set<string>>(new Set());
  // Tree is collapsed by default to just the currently-assigned branches; the
  // operator expands nodes (or "Show all") to reveal and add others.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(
    async (refresh = false) => {
      if (!upc) return;
      setBusy("load");
      setErr(null);
      setMsg(null);
      try {
        const fetchOnce = async (doRefresh: boolean): Promise<ApiResp> => {
          const q = `${API}?upc=${encodeURIComponent(upc)}&pageSize=100${
            doRefresh ? "&refreshProducts=true&refreshCollections=true" : ""
          }`;
          const res = await fetch(q);
          const j = (await res.json().catch(() => ({}))) as ApiResp;
          if (!res.ok || j.ok === false) throw new Error(j.error ?? "Could not load collections");
          return j;
        };
        let j = await fetchOnce(refresh);
        let row = (j.rows ?? []).find((x) => x.upc === upc) ?? (j.rows ?? [])[0];
        // Freshly-linked product may not be in the cached product set yet — force
        // one live refresh from Shopify before giving up.
        if (!row && !refresh) {
          j = await fetchOnce(true);
          row = (j.rows ?? []).find((x) => x.upc === upc) ?? (j.rows ?? [])[0];
        }
        if (!row) throw new Error("This product isn't in the collection mapper yet.");
        setData({ nodes: j.nodes ?? [], collections: j.collections ?? [], row });
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Load failed");
        setData(null);
      } finally {
        setBusy(null);
      }
    },
    [upc],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Tree maps + path↔key translation + suggestion resolution.
  const tree = useMemo(() => {
    if (!data) return null;
    const byKey = new Map(data.nodes.map((n) => [n.nodeKey, n]));
    const children = new Map<string, Node[]>();
    for (const n of data.nodes) {
      const p = n.parentKey ?? "__root__";
      (children.get(p) ?? children.set(p, []).get(p)!).push(n);
    }
    for (const arr of children.values()) arr.sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
    const pathOf = (n: Node): string => {
      const parts: string[] = [];
      const seen = new Set<string>();
      let cur: Node | undefined = n;
      while (cur && !seen.has(cur.nodeKey)) {
        seen.add(cur.nodeKey);
        parts.unshift(cur.label);
        cur = cur.parentKey ? byKey.get(cur.parentKey) : undefined;
      }
      return parts.join(" > ");
    };
    const keyByPath = new Map<string, string>();
    for (const n of data.nodes) keyByPath.set(normPath(pathOf(n)), n.nodeKey);
    const handleToId = new Map(data.collections.map((c) => [c.handle, c.id]));
    const idToTitle = new Map(data.collections.map((c) => [c.id, c.title]));
    const handleToTitle = new Map(data.collections.map((c) => [c.handle, c.title]));

    // Only nodes that are enabled AND mapped to a Shopify collection can be
    // pushed — the server rejects any other nodeKey ("not mapped to a
    // collection"). Everything we select/send is filtered to this set.
    const assignableKeys = new Set(
      data.nodes.filter((n) => n.enabled && !!n.collectionId).map((n) => n.nodeKey),
    );

    const suggestedNodeKeys = new Set<string>();
    for (const p of [...data.row.autoMappedPaths, ...data.row.suggestedPaths]) {
      const k = keyByPath.get(normPath(p));
      if (k && assignableKeys.has(k)) suggestedNodeKeys.add(k);
    }
    const suggestedDirect = new Set<string>([
      ...data.row.directCollectionsToAssign,
      ...data.row.suggestedDirectCollections,
    ]);
    // Direct collections (not represented by a menu node) worth showing: current + suggested.
    const nodeHandles = new Set(data.nodes.map((n) => n.collectionHandle).filter(Boolean) as string[]);
    const directHandles = Array.from(
      new Set([...data.row.currentDirectCollections, ...suggestedDirect]),
    ).filter((h) => !nodeHandles.has(h));

    return { children, assignableKeys, suggestedNodeKeys, suggestedDirect, handleToId, idToTitle, handleToTitle, directHandles };
  }, [data]);

  // On fresh data: pre-check only CURRENT collections (suggested stay unchecked),
  // and auto-expand the branches that contain currently-assigned collections.
  useEffect(() => {
    if (!data || !tree) return;
    setSelNodes(new Set(data.row.checkedNodeKeys.filter((k) => tree.assignableKeys.has(k))));
    setSelDirect(new Set(data.row.currentDirectCollections.filter((h) => tree.handleToId.has(h))));
    const byKey = new Map(data.nodes.map((n) => [n.nodeKey, n] as const));
    const exp = new Set<string>();
    for (const k of data.row.checkedNodeKeys) {
      let cur = byKey.get(k);
      const seen = new Set<string>();
      while (cur && !seen.has(cur.nodeKey)) {
        seen.add(cur.nodeKey);
        exp.add(cur.nodeKey); // open this node (and, by walking up, all its ancestors)
        cur = cur.parentKey ? byKey.get(cur.parentKey) : undefined;
      }
    }
    setExpanded(exp);
    setShowAll(false);
  }, [data, tree]);

  // Currently-assigned collections as toggleable buttons, each linked to its tree
  // node (or direct handle). Clicking one marks it for REMOVAL on the next push.
  const currentButtons = useMemo(() => {
    const out: Array<{ kind: "node" | "direct"; key: string; title: string }> = [];
    if (!data || !tree) return out;
    const byKey = new Map(data.nodes.map((n) => [n.nodeKey, n] as const));
    for (const k of data.row.checkedNodeKeys) {
      if (!tree.assignableKeys.has(k)) continue; // only toggleable nodes (matches selNodes seeding)
      const n = byKey.get(k);
      if (n) out.push({ kind: "node", key: k, title: n.collectionTitle || n.label });
    }
    for (const h of data.row.currentDirectCollections) {
      out.push({ kind: "direct", key: h, title: tree.handleToTitle.get(h) || h });
    }
    const seen = new Set<string>();
    return out
      .filter((s) => {
        const t = s.title.toLowerCase();
        if (seen.has(t)) return false;
        seen.add(t);
        return true;
      })
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [data, tree]);

  // Suggested collections — shown as toggle buttons under the "Currently on
  // Shopify" section. Suggestions that are ALREADY assigned stay in the list and
  // are marked (glow), so the operator can see the suggestion is already applied.
  const suggestions = useMemo(() => {
    const out: Array<{ kind: "node" | "direct"; key: string; title: string }> = [];
    if (!data || !tree) return out;
    const byKey = new Map(data.nodes.map((n) => [n.nodeKey, n] as const));
    for (const k of tree.suggestedNodeKeys) {
      const n = byKey.get(k);
      if (n) out.push({ kind: "node", key: k, title: n.collectionTitle || n.label });
    }
    for (const h of tree.suggestedDirect) {
      if (!tree.handleToId.has(h)) continue; // skip collections that don't exist yet
      out.push({ kind: "direct", key: h, title: tree.handleToTitle.get(h) || h });
    }
    const seen = new Set<string>();
    return out.filter((s) => {
      const t = s.title.toLowerCase();
      if (seen.has(t)) return false;
      seen.add(t);
      return true;
    });
  }, [data, tree]);

  const toggleNode = (k: string) =>
    setSelNodes((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  const toggleDirect = (h: string) =>
    setSelDirect((prev) => {
      const next = new Set(prev);
      if (next.has(h)) next.delete(h);
      else next.add(h);
      return next;
    });
  const toggleExpand = (k: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const push = useCallback(async () => {
    if (!data || !tree || !upc) return;
    setBusy("push");
    setErr(null);
    setMsg(null);
    try {
      // Reconcile only within mapped/assignable nodes so we never send a nodeKey
      // the server would reject as "not mapped to a collection".
      const curNodes = new Set(data.row.checkedNodeKeys.filter((k) => tree.assignableKeys.has(k)));
      const curDirect = new Set(data.row.currentDirectCollections);
      const addNodes = [...selNodes].filter((k) => !curNodes.has(k) && tree.assignableKeys.has(k));
      const remNodes = [...curNodes].filter((k) => !selNodes.has(k));
      const toGid = (h: string) => tree.handleToId.get(h);
      const addDirect = [...selDirect].filter((h) => !curDirect.has(h)).map(toGid).filter(Boolean) as string[];
      const remDirect = [...curDirect].filter((h) => !selDirect.has(h)).map(toGid).filter(Boolean) as string[];

      const warnings: string[] = [];
      const send = async (checked: boolean, nodeKeys: string[], directCollectionIds: string[]) => {
        if (!nodeKeys.length && !directCollectionIds.length) return;
        const r = await fetch(API, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "toggle-node",
            productId: `upc:${upc}`,
            checked,
            nodeKeys,
            directCollectionIds,
            uncheckPolicy: "keep-descendants",
          }),
        });
        const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; warning?: string };
        if (!r.ok) throw new Error(j.error ?? "Push failed");
        // The route returns HTTP 200 with ok:false + a warning when Shopify
        // reports userErrors — collect it as a note, not a hard failure.
        if (j.ok === false && j.warning) warnings.push(j.warning);
      };

      await send(true, addNodes, addDirect);
      await send(false, remNodes, remDirect);
      const added = addNodes.length + addDirect.length;
      const removed = remNodes.length + remDirect.length;
      if (warnings.length) setMsg(`Pushed +${added} / −${removed}. Note: ${warnings.slice(0, 2).join(" · ")}`);
      else if (!added && !removed) setMsg("Already in sync — nothing to push.");
      else setMsg(`Pushed to Shopify — +${added} / −${removed} collection(s).`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Push failed");
    } finally {
      // Always re-read the true membership from Shopify so the UI reflects what
      // actually applied (even after a partial failure); notify the parent too.
      await load();
      onCollectionsChanged?.();
    }
  }, [data, tree, upc, selNodes, selDirect, load, onCollectionsChanged]);

  if (!shopifyProductId) {
    return (
      <div className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/40 p-4 font-mono text-[0.85rem] text-[var(--wms-muted)]">
        Publish this product to Shopify first (use{" "}
        <span className="text-[var(--wms-accent)]">✔ Check &amp; Publish</span>), then map its
        collections here.
      </div>
    );
  }

  const decisionChip = (d: string) =>
    d === "AUTO_MAPPED"
      ? "text-[var(--wms-status-success-fg)] border-[var(--wms-status-success-fg)]/40"
      : d === "SUGGESTED"
        ? "text-[var(--wms-accent)] border-[var(--wms-accent)]/40"
        : "text-[var(--wms-muted)] border-[var(--wms-border)]";

  // Recursive tree renderer (hierarchy preserved).
  const renderNodes = (parentKey: string): React.ReactNode => {
    if (!data || !tree) return null;
    const kids = tree.children.get(parentKey) ?? [];
    if (!kids.length) return null;
    // Show EVERY collection (nothing hidden); a node's children render only when
    // the node is expanded. Current branches start expanded (see the load effect).
    return (
      <ul className={parentKey === "__root__" ? "space-y-0.5" : "ml-4 space-y-0.5 border-l border-[var(--wms-border)]/60 pl-2"}>
        {kids.map((n) => {
          const assignable = n.enabled && !!n.collectionId;
          const checked = selNodes.has(n.nodeKey);
          const isSuggested = tree.suggestedNodeKeys.has(n.nodeKey);
          const hasKids = (tree.children.get(n.nodeKey)?.length ?? 0) > 0;
          const isOpen = showAll || expanded.has(n.nodeKey);
          return (
            <li key={n.nodeKey} className="py-0.5">
              <div className="flex items-center gap-1.5">
                {hasKids ? (
                  <button
                    type="button"
                    onClick={() => toggleExpand(n.nodeKey)}
                    title={isOpen ? "Collapse" : "Expand"}
                    className="w-4 shrink-0 font-mono text-[0.9rem] text-[var(--wms-muted)] hover:text-[var(--wms-fg)] max-md:flex max-md:min-h-11 max-md:w-11 max-md:items-center max-md:justify-center"
                  >
                    {isOpen ? "▾" : "▸"}
                  </button>
                ) : (
                  <span className="inline-block w-4 shrink-0 max-md:w-11" />
                )}
                {assignable ? (
                  <button
                    type="button"
                    disabled={!canManage || busy !== null}
                    onClick={() => toggleNode(n.nodeKey)}
                    title={checked ? "Assigned — click to unassign on next push" : "Click to assign on next push"}
                    className={
                      checked
                        ? "rounded-md border border-teal-400 bg-teal-500/15 px-2 py-0.5 font-mono text-[0.82rem] font-semibold text-teal-200 shadow-[0_0_10px_rgba(45,212,191,0.55)] transition disabled:opacity-50 max-md:py-2"
                        : "rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] px-2 py-0.5 font-mono text-[0.82rem] text-[var(--wms-fg)] transition hover:bg-[var(--wms-surface-elevated)] disabled:opacity-50 max-md:py-2"
                    }
                  >
                    {n.label}
                  </button>
                ) : (
                  <span className="font-mono text-[0.82rem] font-semibold text-[var(--wms-muted)]">{n.label}</span>
                )}
                {isSuggested && !checked ? (
                  <span className="rounded border border-[var(--wms-accent)]/40 px-1 font-mono text-[0.62rem] uppercase text-[var(--wms-accent)]">suggested</span>
                ) : null}
              </div>
              {hasKids && isOpen ? renderNodes(n.nodeKey) : null}
            </li>
          );
        })}
      </ul>
    );
  };

  return (
    <div className="space-y-3">
      {/* Header + push */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-mono text-[0.78rem] uppercase tracking-wide text-[var(--wms-fg)]">Collections</span>
        {data ? (
          <span className={`rounded border px-1.5 py-0.5 font-mono text-[0.68rem] uppercase ${decisionChip(data.row.mappingDecision)}`}>
            {data.row.mappingDecision.replace("_", " ").toLowerCase()}
          </span>
        ) : null}
        <span className="font-mono text-[0.68rem] text-[var(--wms-muted)]">UPC {upc ?? "—"}</span>
        <div className="flex-1" />
        <button
          type="button"
          disabled={!canManage || busy !== null}
          onClick={() => void load(true)}
          title="Refresh from Shopify and re-run the auto suggestions"
          className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] px-3 py-1.5 font-mono text-[0.74rem] uppercase tracking-wide text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)] disabled:opacity-50"
        >
          {busy === "load" ? "…" : "↻ Re-run auto"}
        </button>
        <button
          type="button"
          disabled={!canManage || busy !== null || !data}
          onClick={() => void push()}
          className="rounded-md border border-[var(--wms-accent)] bg-[var(--wms-accent)] px-3 py-1.5 font-mono text-[0.74rem] uppercase tracking-wide text-[var(--wms-accent-fg)] hover:brightness-110 disabled:opacity-50"
        >
          {busy === "push" ? "Pushing…" : "⤴ Push to Shopify"}
        </button>
      </div>

      {/* Currently on Shopify */}
      <div className="rounded-lg border border-teal-400/50 bg-teal-500/5 p-3 shadow-[0_0_18px_rgba(45,212,191,0.18)]">
        <span className="mb-2 block font-mono text-[0.84rem] font-bold uppercase tracking-wider text-teal-300">
          ★ Currently on Shopify
        </span>
        {currentButtons.length ? (
          <div className="flex flex-wrap gap-2">
            {currentButtons.map((c) => {
              const stillAssigned = c.kind === "node" ? selNodes.has(c.key) : selDirect.has(c.key);
              return (
                <button
                  key={`${c.kind}:${c.key}`}
                  type="button"
                  disabled={!canManage || busy !== null}
                  onClick={() => (c.kind === "node" ? toggleNode(c.key) : toggleDirect(c.key))}
                  title={
                    stillAssigned
                      ? "Assigned — click to remove it on the next push"
                      : "Marked for removal on the next push — click to keep it"
                  }
                  className={
                    stillAssigned
                      ? "rounded-md border border-teal-400 bg-teal-500/15 px-2.5 py-1 font-mono text-[0.84rem] font-semibold text-teal-100 shadow-[0_0_10px_rgba(45,212,191,0.5)] transition disabled:opacity-50 max-md:py-2"
                      : "rounded-md border border-red-400/60 bg-red-500/10 px-2.5 py-1 font-mono text-[0.84rem] text-red-200 line-through transition disabled:opacity-50 max-md:py-2"
                  }
                >
                  {c.title}
                </button>
              );
            })}
          </div>
        ) : (
          <span className="font-mono text-[0.78rem] text-[var(--wms-muted)]">None yet — empty.</span>
        )}

        {suggestions.length ? (
          <div className="mt-3 border-t border-teal-400/20 pt-2.5">
            <span className="mb-1.5 block font-mono text-[0.74rem] uppercase tracking-wide text-[var(--wms-muted)]">
              Suggestions — click to add, then Push to Shopify
            </span>
            <div className="flex flex-wrap gap-2">
              {suggestions.map((s) => {
                const selected = s.kind === "node" ? selNodes.has(s.key) : selDirect.has(s.key);
                return (
                  <button
                    key={`${s.kind}:${s.key}`}
                    type="button"
                    disabled={!canManage || busy !== null}
                    onClick={() => (s.kind === "node" ? toggleNode(s.key) : toggleDirect(s.key))}
                    title={selected ? "Will be added on next push" : "Click to add on next push"}
                    className={
                      selected
                        ? "rounded-md border border-teal-400 bg-teal-500/15 px-2.5 py-1 font-mono text-[0.68rem] font-semibold text-teal-100 shadow-[0_0_10px_rgba(45,212,191,0.5)] transition disabled:opacity-50 max-md:py-2"
                        : "rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] px-2.5 py-1 font-mono text-[0.68rem] text-[var(--wms-fg)] transition hover:bg-[var(--wms-surface-elevated)] disabled:opacity-50 max-md:py-2"
                    }
                  >
                    {selected ? "✓ " : "+ "}
                    {s.title}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>

      {/* The tree */}
      {busy === "load" && !data ? (
        <p className="font-mono text-[0.74rem] text-[var(--wms-muted)]">Loading collections & suggestions…</p>
      ) : data && tree ? (
        <div className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="font-mono text-[0.68rem] uppercase tracking-wide text-[var(--wms-muted)]">
              Collection tree · all collections · <span className="text-teal-300">assigned branches expanded</span>
            </span>
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-0.5 font-mono text-[0.68rem] uppercase tracking-wide text-[var(--wms-accent)] hover:bg-[var(--wms-surface)]"
            >
              {showAll ? "▾ Collapse all" : "▸ Expand all"}
            </button>
          </div>
          <div className="max-h-[62vh] overflow-y-auto pr-2">{renderNodes("__root__")}</div>

          {tree.directHandles.length ? (
            <div className="mt-3 border-t border-[var(--wms-border)]/60 pt-2">
              <span className="mb-1 block font-mono text-[0.68rem] uppercase tracking-wide text-[var(--wms-muted)]">
                Other collections (not in menu tree)
              </span>
              {tree.directHandles.map((h) => (
                <label key={h} className="flex items-center gap-2 py-0.5 max-md:py-2">
                  <input
                    type="checkbox"
                    checked={selDirect.has(h)}
                    disabled={!canManage || busy !== null || !tree.handleToId.has(h)}
                    onChange={() => toggleDirect(h)}
                    className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-[var(--wms-accent)] max-md:h-5 max-md:w-5"
                  />
                  <span className="font-mono text-[0.82rem] text-[var(--wms-fg)]">{tree.handleToTitle.get(h) ?? h}</span>
                  {data.row.currentDirectCollections.includes(h) ? (
                    <span className="rounded border border-[var(--wms-status-success-fg)]/40 px-1 font-mono text-[0.62rem] uppercase text-[var(--wms-status-success-fg)]">current</span>
                  ) : (
                    <span className="rounded border border-[var(--wms-accent)]/40 px-1 font-mono text-[0.62rem] uppercase text-[var(--wms-accent)]">suggested</span>
                  )}
                  {!tree.handleToId.has(h) ? (
                    <span className="font-mono text-[0.62rem] text-[var(--wms-muted)]">(collection not created)</span>
                  ) : null}
                </label>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {err ? <p className="font-mono text-[0.74rem] text-[var(--wms-status-danger-fg)]">{err}</p> : null}
      {msg ? <p className="font-mono text-[0.74rem] text-[var(--wms-status-success-fg)]">{msg}</p> : null}
    </div>
  );
}
