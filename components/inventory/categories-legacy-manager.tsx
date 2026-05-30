"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { ArrowRight, ChevronLeft, ChevronRight, Plus, Trash2, X } from "lucide-react";

/**
 * Category manager popup for /inventory/categories. The page itself is empty
 * except for the top-right "Legacy" button; clicking it opens this windowed
 * popup that mirrors the Lightspeed category manager:
 *
 *   list   → every parent category, each with its subcategories indented.
 *            A "+ New Category" button (top-right) opens the new-parent form.
 *   new    → a single "Category Name" field + Save Changes (creates a parent).
 *   detail → click a parent: rename it, delete it, and add/list subcategories.
 *
 * Backed by /api/inventory/categories (+ /[id]) against the WMS-owned
 * `categories` table. Nothing here touches items or Lightspeed.
 */

type Sub = { id: string; name: string };
type Category = { id: string; name: string; subcategories: Sub[] };

const fetcher = async (url: string): Promise<{ categories: Category[] }> => {
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

type View = "list" | "new" | "detail";

export function CategoriesLegacyManager() {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex min-h-[60vh] flex-col">
      <div className="flex justify-end">
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

function CategoryManagerModal({ onClose }: { onClose: () => void }) {
  const { data, error, isLoading, mutate } = useSWR("/api/inventory/categories", fetcher, {
    revalidateOnFocus: false,
  });
  const categories = useMemo(() => data?.categories ?? [], [data]);

  const [view, setView] = useState<View>("list");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo(
    () => categories.find((c) => c.id === selectedId) ?? null,
    [categories, selectedId],
  );

  // Esc closes; lock body scroll while the popup is up.
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
          <div className="flex items-center gap-1.5 font-mono text-xs text-[var(--wms-muted)]">
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
            {view === "detail" && selected ? (
              <>
                <ChevronRight className="h-3.5 w-3.5" />
                <span className="text-[var(--wms-fg)]">Category: {selected.name}</span>
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
              onBack={goList}
              onChanged={() => mutate()}
              onDeleted={async () => {
                await mutate();
                goList();
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
  onNew,
  onOpen,
}: {
  categories: Category[];
  isLoading: boolean;
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
        <ul className="divide-y divide-[var(--wms-border)]/70">
          {categories.map((c) => (
            <li key={c.id} className="px-2 py-1.5">
              <button
                type="button"
                onClick={() => onOpen(c.id)}
                className="group flex w-full items-center justify-between rounded-md px-3 py-2 text-left hover:bg-[var(--wms-surface-elevated)]"
              >
                <span className="text-sm font-semibold uppercase tracking-wide text-[var(--wms-fg)]">
                  {c.name}
                </span>
                <ChevronRight className="h-4 w-4 text-[var(--wms-muted)] group-hover:text-[var(--wms-accent)]" />
              </button>
              {c.subcategories.length > 0 ? (
                <ul className="mb-1 mt-0.5 space-y-0.5 pl-3">
                  {c.subcategories.map((s) => (
                    <li
                      key={s.id}
                      className="flex items-center gap-2 px-3 py-1 font-mono text-xs text-[var(--wms-muted)]"
                    >
                      <ArrowRight className="h-3.5 w-3.5 shrink-0 text-[var(--wms-secondary)]" />
                      <span className="uppercase tracking-wide">{s.name}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
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

/* -------------------------------------------------------- parent detail */

function DetailView({
  category,
  onBack,
  onChanged,
  onDeleted,
}: {
  category: Category;
  onBack: () => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(category.name);
  const [subName, setSubName] = useState("");
  const [busy, setBusy] = useState<null | "rename" | "delete" | "add" | string>(null);
  const [err, setErr] = useState<string | null>(null);

  // Keep the rename field in sync if the underlying row changes (e.g. after a
  // successful rename refetch returns the canonical value).
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
    if (!window.confirm(`Delete “${category.name}” and all its subcategories?`)) return;
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

  const addSub = async () => {
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
      setErr(e instanceof Error ? e.message : "Add subcategory failed");
    } finally {
      setBusy(null);
    }
  };

  const removeSub = async (sub: Sub) => {
    setBusy(`sub:${sub.id}`);
    setErr(null);
    try {
      await mutateJson(`/api/inventory/categories/${sub.id}`, "DELETE");
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete subcategory failed");
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

      {/* Add subcategory */}
      <div className="border-t border-[var(--wms-border)] px-5 py-4">
        <h4 className="mb-2 font-mono text-[0.65rem] uppercase tracking-wider text-[var(--wms-muted)]">
          Add Subcategory
        </h4>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={subName}
            maxLength={128}
            onChange={(e) => setSubName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addSub();
            }}
            placeholder="Name"
            className="w-full max-w-sm rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 text-sm text-[var(--wms-fg)] focus:border-[var(--wms-accent)] focus:outline-none"
          />
          <button
            type="button"
            onClick={addSub}
            disabled={busy === "add" || !subName.trim()}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-xs font-semibold uppercase tracking-wide text-[var(--wms-fg)] hover:border-[var(--wms-accent)] hover:text-[var(--wms-accent)] disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            {busy === "add" ? "Adding…" : "Add Subcategory"}
          </button>
        </div>
      </div>

      {/* Subcategories list */}
      <div className="border-t border-[var(--wms-border)] px-5 py-4">
        <h4 className="mb-2 font-mono text-[0.65rem] uppercase tracking-wider text-[var(--wms-muted)]">
          Subcategories
        </h4>
        {category.subcategories.length === 0 ? (
          <p className="font-mono text-xs text-[var(--wms-muted)]">No subcategories yet.</p>
        ) : (
          <ul className="divide-y divide-[var(--wms-border)]/70">
            {category.subcategories.map((s) => (
              <li key={s.id} className="flex items-center justify-between py-2">
                <span className="flex items-center gap-2 font-mono text-sm text-[var(--wms-fg)]">
                  <ArrowRight className="h-3.5 w-3.5 text-[var(--wms-secondary)]" />
                  <span className="uppercase tracking-wide">{s.name}</span>
                </span>
                <button
                  type="button"
                  onClick={() => removeSub(s)}
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
