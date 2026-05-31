"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { ArrowRight, ChevronDown, ChevronLeft, ChevronRight, Plus, Share2, Trash2, X } from "lucide-react";

/**
 * Category manager popup for /inventory/categories. The page itself is empty
 * except for the top-right "Legacy" button; clicking it opens this windowed
 * popup that mirrors the Lightspeed category manager.
 *
 *   list   → the category tree (up to 3 levels). Every node is clickable
 *            (opens its detail), shows its item count, and — when it has
 *            children — a left collapse/expand toggle. Subcategories keep the
 *            "→" marker. A "+ New Category" button (top-right) adds a parent.
 *   new    → a single "Category Name" field + Save Changes (creates a parent).
 *   detail → click any node: rename it, delete it, and add/list children
 *            (children themselves are clickable to drill deeper, up to level 3).
 *
 * Backed by /api/inventory/categories (+ /[id]). Nothing here touches items or
 * Lightspeed; item counts are derived read-only from the catalog.
 */

const MAX_DEPTH = 3;

type Node = { id: string; name: string; count: number; children: Node[] };

const fetcher = async (url: string): Promise<{ categories: Node[] }> => {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? res.statusText);
  }
  return res.json();
};

async function mutateJson(url: string, method: string, body?: unknown): Promise<void> {
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? "Request failed");
  }
}

/** Depth-first search returning the node and its ancestor path (root → node). */
function findPath(roots: Node[], id: string, trail: Node[] = []): Node[] | null {
  for (const n of roots) {
    const next = [...trail, n];
    if (n.id === id) return next;
    const deeper = findPath(n.children, id, next);
    if (deeper) return deeper;
  }
  return null;
}

type View = "list" | "new" | "detail";

export function CategoriesLegacyManager() {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex min-h-[60vh] flex-col">
      <div className="flex justify-end gap-2">
        <Link
          href="/inventory/categories/collection-mapping"
          className="inline-flex items-center gap-2 rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-4 py-2 font-mono text-xs font-semibold uppercase tracking-wide text-[var(--wms-fg)] hover:border-[var(--wms-accent)] hover:text-[var(--wms-accent)]"
        >
          <Share2 className="h-4 w-4" />
          Collection Mapping
        </Link>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-4 py-2 font-mono text-xs font-semibold uppercase tracking-wide text-[var(--wms-fg)] hover:border-[var(--wms-accent)] hover:text-[var(--wms-accent)]"
        >
          Legacy
        </button>
      </div>
      {open ? <CategoryManagerModal onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

export function CategoryManagerModal({ onClose }: { onClose: () => void }) {
  const { data, error, isLoading, mutate } = useSWR("/api/inventory/categories", fetcher, {
    revalidateOnFocus: false,
  });
  const categories = useMemo(() => data?.categories ?? [], [data]);

  const [view, setView] = useState<View>("list");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const path = useMemo(
    () => (selectedId ? findPath(categories, selectedId) : null),
    [categories, selectedId],
  );
  const selected = path ? path[path.length - 1] : null;
  const selectedDepth = path ? path.length - 1 : 0; // 0 = parent, 1 = sub, 2 = sub-sub

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const toggleCollapse = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const goList = () => {
    setSelectedId(null);
    setView("list");
  };
  const openDetail = (id: string) => {
    setSelectedId(id);
    setView("detail");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] shadow-2xl">
        {/* Breadcrumb bar + close */}
        <div className="flex items-center justify-between gap-3 border-b border-[var(--wms-border)] px-5 py-3">
          <div className="flex flex-wrap items-center gap-1.5 font-mono text-xs text-[var(--wms-muted)]">
            <span>Inventory</span>
            <ChevronRight className="h-3.5 w-3.5" />
            <button
              type="button"
              onClick={goList}
              className={view === "list" ? "text-[var(--wms-fg)]" : "hover:text-[var(--wms-fg)]"}
            >
              Categories
            </button>
            {view === "new" ? (
              <>
                <ChevronRight className="h-3.5 w-3.5" />
                <span className="text-[var(--wms-fg)]">Category: New</span>
              </>
            ) : null}
            {view === "detail" && path ? (
              <>
                <ChevronRight className="h-3.5 w-3.5" />
                <span className="text-[var(--wms-fg)]">
                  Category: {path.map((n) => n.name).join(" ▸ ")}
                </span>
              </>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {error ? (
            <p className="px-5 py-4 font-mono text-xs text-red-400/90">
              {error instanceof Error ? error.message : "Failed to load categories"}
            </p>
          ) : null}

          {view === "list" ? (
            <ListView
              categories={categories}
              isLoading={isLoading}
              collapsed={collapsed}
              onToggle={toggleCollapse}
              onNew={() => setView("new")}
              onOpen={openDetail}
            />
          ) : null}

          {view === "new" ? (
            <NewCategoryView
              onCancel={goList}
              onSaved={async (id) => {
                await mutate();
                openDetail(id);
              }}
            />
          ) : null}

          {view === "detail" && selected ? (
            <DetailView
              category={selected}
              depth={selectedDepth}
              onBack={goList}
              onOpenChild={openDetail}
              onChanged={() => mutate()}
              onDeleted={async () => {
                await mutate();
                if (path && path.length > 1) openDetail(path[path.length - 2].id);
                else goList();
              }}
            />
          ) : null}

          {view === "detail" && !selected && !isLoading ? (
            <div className="px-5 py-8 text-center font-mono text-xs text-[var(--wms-muted)]">
              Category no longer exists.
              <button onClick={goList} className="ml-2 text-[var(--wms-accent)] hover:underline">
                Back
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- list */

function ListView({
  categories,
  isLoading,
  collapsed,
  onToggle,
  onNew,
  onOpen,
}: {
  categories: Node[];
  isLoading: boolean;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  onNew: () => void;
  onOpen: (id: string) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-end border-b border-[var(--wms-border)] px-5 py-3">
        <button
          type="button"
          onClick={onNew}
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--wms-accent)]/50 bg-[var(--wms-accent)] px-3 py-1.5 font-mono text-xs font-semibold uppercase tracking-wide text-[var(--wms-accent-fg)] hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          New Category
        </button>
      </div>

      {isLoading ? (
        <p className="px-5 py-8 text-center font-mono text-xs text-[var(--wms-muted)]">Loading…</p>
      ) : categories.length === 0 ? (
        <p className="px-5 py-10 text-center font-mono text-xs text-[var(--wms-muted)]">
          No categories yet. Click “New Category” to create one.
        </p>
      ) : (
        <ul className="py-1">
          {categories.map((c) => (
            <TreeRow
              key={c.id}
              node={c}
              depth={0}
              collapsed={collapsed}
              onToggle={onToggle}
              onOpen={onOpen}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** One row of the category tree, rendered recursively for its children. */
function TreeRow({
  node,
  depth,
  collapsed,
  onToggle,
  onOpen,
}: {
  node: Node;
  depth: number;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  const hasChildren = node.children.length > 0;
  const isCollapsed = collapsed.has(node.id);
  const isParent = depth === 0;

  return (
    <li>
      <div
        className="group flex items-center gap-1 rounded-md px-2 hover:bg-[var(--wms-surface-elevated)]"
        style={{ paddingLeft: `${8 + depth * 22}px` }}
      >
        {/* Left collapse/expand toggle — only on nodes that have children. */}
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggle(node.id)}
            aria-label={isCollapsed ? "Expand" : "Collapse"}
            aria-expanded={!isCollapsed}
            className="shrink-0 rounded p-1 text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
          >
            {isCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
        ) : (
          <span className="inline-block w-6 shrink-0" />
        )}

        {/* Subcategory marker (kept as the existing arrow for depth >= 1). */}
        {depth >= 1 ? (
          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-[var(--wms-secondary)]" />
        ) : null}

        {/* Name — clickable, opens the detail view for this node. */}
        <button
          type="button"
          onClick={() => onOpen(node.id)}
          className="flex min-w-0 flex-1 items-center justify-between gap-2 py-2 text-left"
        >
          <span
            className={
              isParent
                ? "truncate text-sm font-semibold uppercase tracking-wide text-[var(--wms-fg)]"
                : "truncate font-mono text-xs uppercase tracking-wide text-[var(--wms-fg)]/90"
            }
          >
            {node.name}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <span
              className="rounded-full border border-[var(--wms-border)] bg-[var(--wms-surface)] px-2 py-0.5 font-mono text-[0.6rem] tabular-nums text-[var(--wms-muted)]"
              title="Items in this category"
            >
              {node.count}
            </span>
            <ChevronRight className="h-4 w-4 text-[var(--wms-muted)] group-hover:text-[var(--wms-accent)]" />
          </span>
        </button>
      </div>

      {hasChildren && !isCollapsed ? (
        <ul>
          {node.children.map((ch) => (
            <TreeRow
              key={ch.id}
              node={ch}
              depth={depth + 1}
              collapsed={collapsed}
              onToggle={onToggle}
              onOpen={onOpen}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/* ----------------------------------------------------------- new parent */

function NewCategoryView({
  onCancel,
  onSaved,
}: {
  onCancel: () => void;
  onSaved: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setErr("Category name is required");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/inventory/categories", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string; category?: { id: string } };
      if (!res.ok || !j.category) throw new Error(j.error ?? "Save failed");
      onSaved(j.category.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="flex items-center gap-2 border-b border-[var(--wms-border)] px-5 py-3">
        <button
          type="button"
          onClick={save}
          disabled={busy || !name.trim()}
          className="rounded-md border border-[var(--wms-accent)]/50 bg-[var(--wms-accent)] px-3 py-1.5 font-mono text-xs font-semibold uppercase tracking-wide text-[var(--wms-accent-fg)] hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save Changes"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 font-mono text-xs text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
        >
          <ChevronLeft className="h-4 w-4" />
          Back
        </button>
      </div>

      <div className="flex items-center gap-6 px-5 py-6">
        <label className="w-40 shrink-0 font-medium text-[var(--wms-fg)]">Category Name</label>
        <input
          autoFocus
          type="text"
          value={name}
          maxLength={128}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
          }}
          placeholder="Category Name"
          className="w-full max-w-sm rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 text-sm text-[var(--wms-fg)] focus:border-[var(--wms-accent)] focus:outline-none"
        />
      </div>
      {err ? <p className="px-5 pb-4 font-mono text-xs text-red-400/90">{err}</p> : null}
    </div>
  );
}

/* --------------------------------------------------------------- detail */

function DetailView({
  category,
  depth,
  onBack,
  onOpenChild,
  onChanged,
  onDeleted,
}: {
  category: Node;
  depth: number;
  onBack: () => void;
  onOpenChild: (id: string) => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(category.name);
  const [subName, setSubName] = useState("");
  const [busy, setBusy] = useState<null | "rename" | "delete" | "add" | string>(null);
  const [err, setErr] = useState<string | null>(null);

  const canAddChild = depth < MAX_DEPTH - 1; // level 3 nodes can't go deeper
  const childLabel = depth === 0 ? "Subcategory" : "Sub-subcategory";

  useEffect(() => {
    setName(category.name);
  }, [category.name]);

  const rename = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setErr("Category name is required");
      return;
    }
    setBusy("rename");
    setErr(null);
    try {
      await mutateJson(`/api/inventory/categories/${category.id}`, "PATCH", { name: trimmed });
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Rename failed");
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    const childWord = category.children.length > 0 ? " and everything under it" : "";
    if (!window.confirm(`Delete “${category.name}”${childWord}?`)) return;
    setBusy("delete");
    setErr(null);
    try {
      await mutateJson(`/api/inventory/categories/${category.id}`, "DELETE");
      onDeleted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
      setBusy(null);
    }
  };

  const addChild = async () => {
    const trimmed = subName.trim();
    if (!trimmed) return;
    setBusy("add");
    setErr(null);
    try {
      await mutateJson("/api/inventory/categories", "POST", {
        name: trimmed,
        parentId: category.id,
      });
      setSubName("");
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Add failed");
    } finally {
      setBusy(null);
    }
  };

  const removeChild = async (child: Node) => {
    setBusy(`sub:${child.id}`);
    setErr(null);
    try {
      await mutateJson(`/api/inventory/categories/${child.id}`, "DELETE");
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-2 border-b border-[var(--wms-border)] px-5 py-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={rename}
            disabled={busy === "rename" || !name.trim() || name.trim() === category.name}
            className="rounded-md border border-[var(--wms-accent)]/50 bg-[var(--wms-accent)] px-3 py-1.5 font-mono text-xs font-semibold uppercase tracking-wide text-[var(--wms-accent-fg)] hover:opacity-90 disabled:opacity-50"
          >
            {busy === "rename" ? "Saving…" : "Save Changes"}
          </button>
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 font-mono text-xs text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
          >
            <ChevronLeft className="h-4 w-4" />
            Back
          </button>
        </div>
        <button
          type="button"
          onClick={remove}
          disabled={busy === "delete"}
          className="inline-flex items-center gap-1.5 rounded-md border border-red-500/40 px-3 py-1.5 font-mono text-xs font-semibold uppercase tracking-wide text-red-400 hover:bg-red-500/10 disabled:opacity-50"
        >
          <Trash2 className="h-4 w-4" />
          {busy === "delete" ? "Deleting…" : "Delete"}
        </button>
      </div>

      {/* Category name */}
      <div className="flex items-center gap-6 px-5 py-5">
        <label className="w-40 shrink-0 font-medium text-[var(--wms-fg)]">Category Name</label>
        <input
          type="text"
          value={name}
          maxLength={128}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") rename();
          }}
          className="w-full max-w-sm rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 text-sm text-[var(--wms-fg)] focus:border-[var(--wms-accent)] focus:outline-none"
        />
      </div>

      {/* Add child */}
      {canAddChild ? (
        <div className="border-t border-[var(--wms-border)] px-5 py-4">
          <h4 className="mb-2 font-mono text-[0.65rem] uppercase tracking-wider text-[var(--wms-muted)]">
            Add {childLabel}
          </h4>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={subName}
              maxLength={128}
              onChange={(e) => setSubName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addChild();
              }}
              placeholder="Name"
              className="w-full max-w-sm rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 text-sm text-[var(--wms-fg)] focus:border-[var(--wms-accent)] focus:outline-none"
            />
            <button
              type="button"
              onClick={addChild}
              disabled={busy === "add" || !subName.trim()}
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-xs font-semibold uppercase tracking-wide text-[var(--wms-fg)] hover:border-[var(--wms-accent)] hover:text-[var(--wms-accent)] disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />
              {busy === "add" ? "Adding…" : `Add ${childLabel}`}
            </button>
          </div>
        </div>
      ) : null}

      {/* Children list */}
      <div className="border-t border-[var(--wms-border)] px-5 py-4">
        <h4 className="mb-2 font-mono text-[0.65rem] uppercase tracking-wider text-[var(--wms-muted)]">
          {depth === 0 ? "Subcategories" : "Sub-subcategories"}
        </h4>
        {category.children.length === 0 ? (
          <p className="font-mono text-xs text-[var(--wms-muted)]">None yet.</p>
        ) : (
          <ul className="divide-y divide-[var(--wms-border)]/70">
            {category.children.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-2 py-1">
                <button
                  type="button"
                  onClick={() => onOpenChild(s.id)}
                  className="group flex min-w-0 flex-1 items-center gap-2 py-1 text-left"
                >
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-[var(--wms-secondary)]" />
                  <span className="truncate font-mono text-sm uppercase tracking-wide text-[var(--wms-fg)] group-hover:text-[var(--wms-accent)]">
                    {s.name}
                  </span>
                  <span className="rounded-full border border-[var(--wms-border)] px-2 py-0.5 font-mono text-[0.6rem] tabular-nums text-[var(--wms-muted)]">
                    {s.count}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => removeChild(s)}
                  disabled={busy === `sub:${s.id}`}
                  aria-label={`Delete ${s.name}`}
                  className="rounded p-1 text-[var(--wms-muted)] hover:text-red-400 disabled:opacity-50"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {err ? <p className="px-5 pb-4 font-mono text-xs text-red-400/90">{err}</p> : null}
    </div>
  );
}
