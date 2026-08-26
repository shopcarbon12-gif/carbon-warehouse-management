"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { ArrowRight, PackagePlus, Pencil, Plus, Search, X } from "lucide-react";
import { BinEditorDrawer, type BinRow } from "./bin-editor-drawer";
import { useUrlParam } from "@/lib/use-url-param";

/**
 * Shelf Map tab content for `/overview/locations`.
 *
 * Renders the 5×3 physical-rack grid for one (aisle, section) at the
 * operator's active location. Each cell is one bin; each line inside a
 * cell is one (sku_prefix, color) group with a total qty across sizes.
 *
 *   shelf 05 ── L | C | R
 *   shelf 04 ── L | C | R
 *   ...
 *   shelf 01 ── L | C | R
 *
 * Per-line: Move (popover with target-bin picker) or ✕ Remove (clean).
 * Per-cell: status dot toggle, ✎ edit (existing drawer hooks via prop).
 * Empty cells get a "+ Add bin" link wired to the upsert API.
 * Bins not matching the `<digit><letter><2-digit><LCR>` shape land in
 * an "Unmapped" panel below the grid.
 */

type ShelfMapBin = {
  id: string;
  code: string;
  status: string;
  lines: { sku_prefix: string; name: string; color: string | null; qty: number }[];
};
type ShelfMapNav = { aisle: string; section: string; bin_count: number };
type UnmappedBin = { id: string; code: string; status: string; in_stock_count: number };
type NavPayload = {
  location: { id: string; code: string; name: string } | null;
  navigation: ShelfMapNav[];
  unmapped: UnmappedBin[];
};
type SectionPayload = { aisle: string; section: string; bins: ShelfMapBin[] };

const fetcher = async (url: string) => {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string; hint?: string };
    const parts = [j.error, j.hint].filter((x): x is string => Boolean(x?.trim()));
    throw new Error(parts.length ? parts.join(" — ") : res.statusText);
  }
  return res.json();
};

export function ShelfMap({
  canManage = false,
}: {
  canManage?: boolean;
}) {
  const {
    data: nav,
    error: navError,
    mutate: mutateNav,
  } = useSWR<NavPayload>("/api/overview/locations/sections", fetcher, {
    revalidateOnFocus: false,
  });

  // Operator-explicit selection. Null = "let the effective value default to
  // the first available (aisle, section) from nav data." Doing it this way
  // means we derive the effective value during render (no setState-in-effect
  // lint violation) AND the operator's choice still overrides defaults.
  const [explicitAisle, setExplicitAisle] = useState<string | null>(null);
  const [explicitSection, setExplicitSection] = useState<string | null>(null);

  const aisleOptions = useMemo(() => {
    if (!nav?.navigation) return [] as string[];
    return [...new Set(nav.navigation.map((n) => n.aisle))].sort((a, b) =>
      a.localeCompare(b, "en", { numeric: true }),
    );
  }, [nav]);

  const aisle = explicitAisle ?? aisleOptions[0] ?? "";

  const sectionOptions = useMemo(() => {
    if (!nav?.navigation || !aisle) return [] as string[];
    return [...new Set(nav.navigation.filter((n) => n.aisle === aisle).map((n) => n.section))].sort();
  }, [nav, aisle]);

  const section =
    explicitSection && sectionOptions.includes(explicitSection)
      ? explicitSection
      : sectionOptions[0] ?? "";

  const setAisle = (a: string) => {
    setExplicitAisle(a);
    setExplicitSection(null); // re-default the section for the new aisle
  };
  const setSection = (s: string) => setExplicitSection(s);

  const sectionKey = aisle && section ? `/api/overview/locations/sections?aisle=${encodeURIComponent(aisle)}&section=${encodeURIComponent(section)}` : null;
  const { data: sectionData, error: sectionError, mutate: mutateSection } = useSWR<SectionPayload>(
    sectionKey,
    fetcher,
    { revalidateOnFocus: false },
  );

  // Build a code → bin map so we can place each cell into its (shelf, position) slot.
  const sectionByCode = useMemo(() => {
    const m = new Map<string, ShelfMapBin>();
    for (const b of sectionData?.bins ?? []) m.set(b.code, b);
    return m;
  }, [sectionData]);

  const [moving, setMoving] = useState<{
    fromBin: ShelfMapBin;
    line: ShelfMapBin["lines"][number];
  } | null>(null);
  const [removing, setRemoving] = useState<{
    bin: ShelfMapBin;
    line: ShelfMapBin["lines"][number];
  } | null>(null);
  const [adding, setAdding] = useState<ShelfMapBin | null>(null);
  // BinEditorDrawer (reused from the List tab) lives in the URL so a manual
  // refresh reopens it: ?bin=<bin id> → edit, ?bin=new → add. Same key as
  // the List tab — the two tabs are never mounted at the same time. The
  // "+ Add 1A05R" preset code is transient (not in the URL).
  const [binParam, setBinParam] = useUrlParam("bin");
  const [presetCode, setPresetCode] = useState<string | undefined>(undefined);

  // Derive the bin being edited from what this tab has loaded (current
  // section cells + the unmapped panel). Same synthesized BinRow shape the
  // old openEditBin built.
  const editingBin = useMemo<BinRow | null>(() => {
    if (!binParam || binParam === "new") return null;
    const hit =
      sectionData?.bins.find((b) => b.id === binParam) ??
      nav?.unmapped.find((b) => b.id === binParam);
    if (!hit) return null;
    return {
      id: hit.id,
      code: hit.code,
      capacity: null,
      in_stock_count: 0,
      status: hit.status,
      bin_items: null,
    };
  }, [binParam, sectionData, nav]);
  const drawerMode: "add" | "edit" | null =
    binParam === "new" ? "add" : editingBin ? "edit" : null;

  const openEditBin = (b: { id: string; code: string; status: string }) => {
    setBinParam(b.id);
  };
  const openAddBin = (preset?: { code?: string }) => {
    setPresetCode(preset?.code);
    setBinParam("new");
  };
  const closeDrawer = () => {
    setBinParam(null);
    setPresetCode(undefined);
  };

  const refreshAll = () => {
    void mutateSection();
    void mutateNav();
  };

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="sticky top-0 z-20 flex flex-wrap items-end justify-between gap-3 rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)] p-3 max-md:top-12">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[0.65rem] uppercase tracking-wider text-[var(--wms-muted)]">
              Aisle
            </span>
            <select
              value={aisle}
              onChange={(e) => setAisle(e.target.value)}
              disabled={aisleOptions.length === 0}
              className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-sm text-[var(--wms-fg)] disabled:opacity-50 max-md:min-h-11 max-md:text-base"
            >
              {aisleOptions.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[0.65rem] uppercase tracking-wider text-[var(--wms-muted)]">
              Section
            </span>
            <select
              value={section}
              onChange={(e) => setSection(e.target.value)}
              disabled={sectionOptions.length === 0}
              className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-sm text-[var(--wms-fg)] disabled:opacity-50 max-md:min-h-11 max-md:text-base"
            >
              {sectionOptions.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="font-mono text-base font-semibold text-[var(--wms-fg)]">
          Section <span className="text-[var(--wms-accent)]">{aisle}{section}</span>
          <span className="ml-3 font-normal text-xs text-[var(--wms-muted)]">
            {sectionData ? `${sectionData.bins.length} bin${sectionData.bins.length === 1 ? "" : "s"}` : ""}
          </span>
        </div>
      </div>

      {navError ? (
        <p className="font-mono text-sm text-red-600 dark:text-red-400/90">
          {navError instanceof Error ? navError.message : "Failed to load shelf map"}
        </p>
      ) : null}
      {sectionError ? (
        <p className="font-mono text-sm text-red-600 dark:text-red-400/90">
          {sectionError instanceof Error ? sectionError.message : "Failed to load section"}
        </p>
      ) : null}

      {nav && nav.navigation.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--wms-border)] bg-[var(--wms-surface)]/60 p-8 text-center">
          <p className="font-mono text-sm text-[var(--wms-muted)]">
            No bins at this location yet match the <span className="text-[var(--wms-fg)]">&lt;digit&gt;&lt;letter&gt;&lt;NN&gt;&lt;LCR&gt;</span> shape.
          </p>
          <p className="mt-2 font-mono text-xs text-[var(--wms-muted)]">
            Add bins on the List tab (e.g. <code className="text-[var(--wms-fg)]">1A01L</code>) to populate the Shelf Map.
          </p>
        </div>
      ) : null}

      {/* The 3×5 grid.
          Mobile: the outer div allows horizontal scroll so the rack
          mental model (shelf 05 top → 01 floor, L/C/R columns) stays
          intact even on a 360px viewport. min-w on the inner grid
          keeps cells readable; sm+ removes the min-width and behaves
          like a normal full-width grid. */}
      {aisle && section ? (
        <div className="-mx-3 overflow-x-auto px-3 sm:mx-0 sm:overflow-visible sm:px-0 max-sm:snap-x max-sm:snap-mandatory max-sm:scroll-px-3">
          <div className="grid min-w-[680px] grid-cols-[44px_minmax(0,1fr)] gap-2 sm:min-w-0 sm:grid-cols-[64px_minmax(0,1fr)] sm:gap-3">
          {/* row labels column */}
          <div className="grid grid-rows-5 gap-2 pt-1 sm:gap-3 max-sm:snap-start">
            {["05", "04", "03", "02", "01"].map((shelf, i) => (
              <div
                key={shelf}
                className="flex items-center justify-end border-r border-dashed border-[var(--wms-border)] pr-1.5 font-mono text-[10px] text-[var(--wms-muted)] sm:pr-2 sm:text-xs"
              >
                <span className="text-xs font-semibold text-[var(--wms-fg)] sm:text-sm">{shelf}</span>
                <span className="ml-1 hidden sm:inline">{i === 0 ? "top" : i === 4 ? "floor" : ""}</span>
              </div>
            ))}
          </div>
          {/* the grid cells */}
          <div className="grid grid-cols-3 grid-rows-5 gap-2 sm:gap-3">
            {["05", "04", "03", "02", "01"].flatMap((shelf) =>
              (["L", "C", "R"] as const).map((pos) => {
                const code = `${aisle}${section}${shelf}${pos}`;
                const bin = sectionByCode.get(code);
                return (
                  <CellView
                    key={code}
                    code={code}
                    bin={bin}
                    canManage={canManage}
                    onMove={(line) => setMoving({ fromBin: bin!, line })}
                    onRemove={(line) => setRemoving({ bin: bin!, line })}
                    onAddItem={() => bin && setAdding(bin)}
                    onEditBin={() => bin && openEditBin(bin)}
                    onAddBin={() => openAddBin({ code })}
                    onToggleStatus={async () => {
                      if (!bin || !nav?.location?.id) return;
                      const next = bin.status === "inactive" ? "active" : "inactive";
                      await fetch("/api/locations/bins", {
                        method: "POST",
                        credentials: "same-origin",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          binId: bin.id,
                          locationId: nav.location.id,
                          code: bin.code,
                          status: next,
                        }),
                      });
                      refreshAll();
                    }}
                  />
                );
              }),
            )}
          </div>
          </div>
        </div>
      ) : null}

      {/* Unmapped bins panel */}
      {nav?.unmapped && nav.unmapped.length > 0 ? (
        <UnmappedPanel bins={nav.unmapped} onEdit={openEditBin} />
      ) : null}

      {moving ? (
        <MoveDialog
          fromBin={moving.fromBin}
          line={moving.line}
          onClose={() => setMoving(null)}
          onDone={() => {
            setMoving(null);
            refreshAll();
          }}
        />
      ) : null}

      {adding ? (
        <AddItemDialog
          bin={adding}
          onClose={() => setAdding(null)}
          onDone={() => {
            setAdding(null);
            refreshAll();
          }}
        />
      ) : null}

      {removing ? (
        <RemoveDialog
          bin={removing.bin}
          line={removing.line}
          onClose={() => setRemoving(null)}
          onDone={() => {
            setRemoving(null);
            refreshAll();
          }}
        />
      ) : null}

      {/* Bin editor drawer (shared with List tab — same component, separate
          instance). Wired via local state so add/edit work directly from
          a Shelf Map cell. */}
      <BinEditorDrawer
        open={drawerMode !== null}
        mode={drawerMode}
        editingBin={drawerMode === "edit" ? editingBin : null}
        presetCode={drawerMode === "add" ? presetCode : undefined}
        locationId={nav?.location?.id ?? ""}
        locationLabel={nav?.location ? `${nav.location.code} · ${nav.location.name}` : ""}
        onClose={closeDrawer}
        onSaved={() => {
          closeDrawer();
          refreshAll();
        }}
      />
    </div>
  );
}

/* ===== cell ============================================================ */

function CellView({
  code,
  bin,
  canManage,
  onMove,
  onRemove,
  onAddItem,
  onEditBin,
  onAddBin,
  onToggleStatus,
}: {
  code: string;
  bin: ShelfMapBin | undefined;
  canManage: boolean;
  onMove: (line: ShelfMapBin["lines"][number]) => void;
  onRemove: (line: ShelfMapBin["lines"][number]) => void;
  onAddItem: () => void;
  onEditBin: () => void;
  onAddBin: () => void;
  onToggleStatus: () => void;
}) {
  if (!bin) {
    return (
      <div className="flex min-h-[210px] flex-col items-stretch overflow-hidden rounded-lg border border-dashed border-[var(--wms-border)] bg-[var(--wms-surface)]/40 max-sm:snap-start">
        <div className="flex items-center justify-between border-b border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono">
          <span className="flex items-center gap-2 text-sm text-[var(--wms-muted)]">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-[var(--wms-muted)]/40" />
            {code}
          </span>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-6 text-center">
          <p className="font-mono text-xs text-[var(--wms-muted)]">No bin here yet.</p>
          <button
            type="button"
            onClick={onAddBin}
            className="inline-flex items-center gap-1 font-mono text-xs text-[var(--wms-accent)] hover:underline max-md:min-h-11 max-md:px-3"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={2} /> Add {code}
          </button>
        </div>
      </div>
    );
  }

  const isInactive = bin.status === "inactive";
  return (
    <div
      className={`flex min-h-[210px] flex-col overflow-hidden rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)] max-sm:snap-start ${
        isInactive ? "opacity-60" : ""
      }`}
    >
      <div className="flex items-center justify-between border-b border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2">
        <span className="flex items-center gap-2 font-mono text-sm font-semibold text-[var(--wms-fg)]">
          <button
            type="button"
            onClick={onToggleStatus}
            title="Toggle active/inactive"
            aria-label="Toggle active/inactive"
            className={`inline-block h-2.5 w-2.5 rounded-full max-md:relative max-md:after:absolute max-md:after:-inset-4 max-md:after:content-[''] ${
              isInactive ? "bg-[var(--wms-warn)]" : "bg-[var(--wms-ok)]"
            }`}
          />
          {bin.code}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onEditBin}
            className="rounded p-1.5 text-[var(--wms-muted)] hover:bg-[var(--wms-border)] hover:text-[var(--wms-fg)] max-md:-my-2 max-md:inline-flex max-md:min-h-11 max-md:min-w-11 max-md:items-center max-md:justify-center"
            title="Edit bin"
            aria-label="Edit bin"
          >
            <Pencil className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
        </div>
      </div>
      <div className="flex-1 space-y-0.5 overflow-y-auto px-2 py-2 font-mono text-xs">
        {isInactive ? (
          <p className="px-1 py-2 text-[var(--wms-muted)]">inactive</p>
        ) : bin.lines.length === 0 ? (
          <p className="px-1 py-2 text-[var(--wms-muted)]">empty bin</p>
        ) : (
          bin.lines.map((line) => (
            <div
              key={`${line.sku_prefix}|${line.color ?? ""}`}
              className="group flex items-center gap-2 rounded px-1 py-1 hover:bg-[var(--wms-surface-elevated)]/60"
            >
              <span className="flex-1 truncate">
                <span className="text-[var(--wms-accent)]">{line.sku_prefix}</span>
                <span className="text-[var(--wms-muted)]"> · </span>
                <span className="text-[var(--wms-fg)]">{line.name}</span>
                <span className="text-[var(--wms-muted)]"> · </span>
                <span className="text-[var(--wms-warn)]">{line.color ?? "—"}</span>
                <span className="text-[var(--wms-muted)]"> · qty </span>
                <span className="font-semibold text-[var(--wms-fg)]">{line.qty}</span>
              </span>
              <span className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 max-md:opacity-100">
                <button
                  type="button"
                  onClick={() => onMove(line)}
                  className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-0.5 text-[0.65rem] text-[var(--wms-fg)] hover:border-[var(--wms-accent)]/60 max-md:min-h-11 max-md:px-3 max-md:text-xs"
                  title={`Move ${line.sku_prefix} · ${line.color ?? ""} to another bin`}
                >
                  Move
                </button>
                {canManage ? (
                  <button
                    type="button"
                    onClick={() => onRemove(line)}
                    className="rounded border border-red-500/50 bg-red-500/15 px-1.5 py-0.5 text-red-300 hover:bg-red-500/25 max-md:inline-flex max-md:min-h-11 max-md:min-w-11 max-md:items-center max-md:justify-center"
                    title="Remove this line from the bin"
                    aria-label="Remove"
                  >
                    <X className="h-3 w-3" strokeWidth={2.5} />
                  </button>
                ) : null}
              </span>
            </div>
          ))
        )}
      </div>
      {!isInactive ? (
        <button
          type="button"
          onClick={onAddItem}
          className="mx-2 mb-2 inline-flex items-center justify-center gap-1 rounded border border-dashed border-[var(--wms-border)] py-1 text-[11px] text-[var(--wms-muted)] hover:border-[var(--wms-accent)]/60 hover:text-[var(--wms-accent)] max-md:min-h-11 max-md:text-xs"
        >
          <PackagePlus className="h-3 w-3" strokeWidth={2} />
          Add item
        </button>
      ) : null}
    </div>
  );
}

/* ===== unmapped ======================================================== */

function UnmappedPanel({
  bins,
  onEdit,
}: {
  bins: UnmappedBin[];
  onEdit?: (bin: { id: string; code: string; status: string }) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/70">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 font-mono text-xs uppercase tracking-wider text-[var(--wms-muted)] hover:text-[var(--wms-fg)] max-md:min-h-11"
      >
        <span>{open ? "▾" : "▸"} Unmapped bins ({bins.length})</span>
        <span className="text-[0.65rem] normal-case">
          Codes that don&apos;t match &lt;digit&gt;&lt;letter&gt;&lt;NN&gt;&lt;LCR&gt;
        </span>
      </button>
      {open ? (
        <ul className="divide-y divide-[var(--wms-border)]/60 border-t border-[var(--wms-border)]/60">
          {bins.map((b) => (
            <li key={b.id} className="flex items-center justify-between px-3 py-2 font-mono text-xs">
              <span>
                <span className="text-[var(--wms-fg)]">{b.code}</span>
                <span className="ml-2 text-[var(--wms-muted)]">
                  {b.status} · {b.in_stock_count} EPC{b.in_stock_count === 1 ? "" : "s"}
                </span>
              </span>
              {onEdit ? (
                <button
                  type="button"
                  onClick={() => onEdit(b)}
                  className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1 text-[0.65rem] text-[var(--wms-fg)] hover:border-[var(--wms-accent)]/60 max-md:min-h-11 max-md:px-3 max-md:text-xs"
                >
                  Edit
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/* ===== move dialog ===================================================== */

type BinOption = { id: string; code: string; status: string };

function MoveDialog({
  fromBin,
  line,
  onClose,
  onDone,
}: {
  fromBin: ShelfMapBin;
  line: ShelfMapBin["lines"][number];
  onClose: () => void;
  onDone: () => void;
}) {
  // Pull every bin at the active location so the operator can move across
  // sections (e.g. 1A05L → 2B03C) in one popover. The list comes from the
  // existing /api/locations/bins endpoint — same source as the List tab.
  const { data: bins, isLoading } = useSWR<BinOption[]>(
    "/api/locations/bins",
    fetcher,
    { revalidateOnFocus: false },
  );

  const [target, setTarget] = useState<BinOption | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Autofocus only on hover-capable (desktop) devices — on phones the
  // software keyboard would pop over the target-bin list the operator
  // needs to read before typing.
  useEffect(() => {
    if (window.matchMedia("(hover: hover)").matches) inputRef.current?.focus();
  }, []);

  const candidates = useMemo(() => {
    const norm = q.trim().toUpperCase();
    return (bins ?? [])
      .filter((b) => b.id !== fromBin.id && b.status !== "inactive")
      .filter((b) => !norm || b.code.toUpperCase().includes(norm))
      .sort((a, b) => a.code.localeCompare(b.code, "en", { numeric: true }))
      .slice(0, 80);
  }, [bins, fromBin.id, q]);

  const submit = async () => {
    if (!target) {
      setErr("Pick a target bin first");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/locations/bins/move", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skuPrefix: line.sku_prefix,
          sourceBinId: fromBin.id,
          targetBinId: target.id,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string; moved?: number };
      if (!res.ok) throw new Error(j.error ?? "Move failed");
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Move failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Move to bin" onClose={onClose}>
      <div className="space-y-3 px-4 py-4">
        <div className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] p-3 font-mono text-xs">
          <p>
            <span className="text-[var(--wms-accent)]">{line.sku_prefix}</span>
            <span className="text-[var(--wms-muted)]"> · </span>
            <span className="text-[var(--wms-fg)]">{line.name}</span>
            <span className="text-[var(--wms-muted)]"> · </span>
            <span className="text-[var(--wms-warn)]">{line.color ?? "—"}</span>
          </p>
          <p className="mt-1 text-[var(--wms-muted)]">
            From <span className="text-[var(--wms-fg)]">{fromBin.code}</span>
            <ArrowRight className="mx-1 inline h-3 w-3" />
            target —{" "}
            <span className="text-[var(--wms-fg)]">qty {line.qty}</span> EPC{line.qty === 1 ? "" : "s"} across all sizes
          </p>
        </div>

        <label className="flex items-center gap-2 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1.5 focus-within:border-[var(--wms-accent)]/60">
          <Search className="h-4 w-4 shrink-0 text-[var(--wms-muted)]" strokeWidth={2} />
          <input
            ref={inputRef}
            type="text"
            autoComplete="off"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Type to filter target bins (e.g. 1A03)"
            className="flex-1 bg-transparent font-mono text-sm text-[var(--wms-fg)] outline-none placeholder:text-[var(--wms-muted)]/70 max-md:text-base"
          />
        </label>

        <div className="max-h-60 overflow-y-auto rounded-md border border-[var(--wms-border)]">
          {isLoading ? (
            <p className="px-3 py-4 text-center font-mono text-xs text-[var(--wms-muted)]">
              Loading bins…
            </p>
          ) : candidates.length === 0 ? (
            <p className="px-3 py-4 text-center font-mono text-xs text-[var(--wms-muted)]">
              {q ? `No active bins match "${q}".` : "No other active bins at this location."}
            </p>
          ) : (
            <ul className="divide-y divide-[var(--wms-border)]/60">
              {candidates.map((b) => (
                <li key={b.id}>
                  <button
                    type="button"
                    onClick={() => setTarget(b)}
                    className={`w-full px-3 py-2 text-left font-mono text-xs hover:bg-[var(--wms-surface-elevated)] max-md:min-h-11 max-md:text-sm ${
                      target?.id === b.id
                        ? "bg-[color-mix(in_srgb,var(--wms-accent)_15%,var(--wms-surface-elevated))]"
                        : ""
                    }`}
                  >
                    <span className="text-[var(--wms-accent)]">{b.code}</span>
                    <span className="ml-2 text-[var(--wms-muted)]">{b.status}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {err ? <p className="font-mono text-xs text-red-400">{err}</p> : null}
      </div>
      <div className="flex justify-end gap-2 border-t border-[var(--wms-border)] px-4 py-3 max-md:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-xs text-[var(--wms-fg)] max-md:min-h-11 max-md:px-4"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={busy || !target}
          className="wms-btn-accent-soft rounded-md px-3 py-2 font-mono text-xs disabled:opacity-50 max-md:min-h-11 max-md:px-4"
        >
          {busy ? "Moving…" : `Move to ${target?.code ?? "…"}`}
        </button>
      </div>
    </Modal>
  );
}

/* ===== remove dialog =================================================== */

function RemoveDialog({
  bin,
  line,
  onClose,
  onDone,
}: {
  bin: ShelfMapBin;
  line: ShelfMapBin["lines"][number];
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/locations/bins/${bin.id}/clean`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skuPrefix: line.sku_prefix }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string; cleared?: number };
      if (!res.ok) throw new Error(j.error ?? "Remove failed");
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Remove failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Remove from bin" onClose={onClose}>
      <div className="px-4 py-4 font-mono text-sm text-[var(--wms-fg)]">
        Remove{" "}
        <span className="text-[var(--wms-accent)]">{line.sku_prefix}</span>{" "}
        ·{" "}
        <span className="text-[var(--wms-warn)]">{line.color ?? "—"}</span>{" "}
        (qty {line.qty}) from{" "}
        <span className="text-[var(--wms-fg)]">{bin.code}</span>?
        <p className="mt-2 text-xs text-[var(--wms-muted)]">
          Logged as clean_bin · the matching EPCs return to homeless (bin_id = NULL).
        </p>
        {err ? <p className="mt-2 text-xs text-red-400">{err}</p> : null}
      </div>
      <div className="flex justify-end gap-2 border-t border-[var(--wms-border)] px-4 py-3 max-md:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-xs text-[var(--wms-fg)] max-md:min-h-11 max-md:px-4"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="rounded-md border border-red-500/50 bg-red-500 px-3 py-2 font-mono text-xs font-semibold text-white disabled:opacity-50 max-md:min-h-11 max-md:px-4"
        >
          {busy ? "Removing…" : "Confirm"}
        </button>
      </div>
    </Modal>
  );
}

/* ===== add-item dialog (searchable SKU combo) ========================== */

type SkuMatch = { sku_prefix: string; name: string | null; color: string | null };

function AddItemDialog({
  bin,
  onClose,
  onDone,
}: {
  bin: ShelfMapBin;
  onClose: () => void;
  onDone: () => void;
}) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<SkuMatch | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Debounce the query — typeahead fires after ~180ms of stillness so we
  // don't hammer the DB while the operator types "BLACK WASHED".
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 180);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    // Desktop-only autofocus: phones must not get the keyboard popped over
    // the dialog before the operator has read it.
    if (!window.matchMedia("(hover: hover)").matches) return;
    setTimeout(() => inputRef.current?.focus(), 30);
  }, []);

  const { data, isLoading } = useSWR<{ rows: SkuMatch[] }>(
    debounced.length > 0 && !picked
      ? `/api/overview/locations/sku-search?q=${encodeURIComponent(debounced)}`
      : null,
    fetcher,
    { revalidateOnFocus: false },
  );
  const matches = data?.rows ?? [];

  useEffect(() => {
    setActiveIdx(0);
  }, [debounced]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (matches.length === 0) return;
    if (e.key === "ArrowDown") {
      setActiveIdx((i) => Math.min(matches.length - 1, i + 1));
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      setActiveIdx((i) => Math.max(0, i - 1));
      e.preventDefault();
    } else if (e.key === "Enter") {
      const m = matches[activeIdx];
      if (m) setPicked(m);
      e.preventDefault();
    }
  };

  const submit = async () => {
    if (!picked) return;
    setBusy(true);
    setErr(null);
    try {
      // "Add to bin" = sweep ALL in-stock EPCs of this (UPC, color) group
      // — every size, whether homeless or currently in another bin — into
      // this bin. sourceBinId="any" mirrors the catalog "📦 Bin" button.
      // Previously this only moved homeless EPCs (sourceBinId=null), which
      // silently no-op'd whenever the operator picked a color that was
      // already shelved elsewhere — the bug the operator hit.
      const res = await fetch("/api/locations/bins/move", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skuPrefix: picked.sku_prefix,
          sourceBinId: "any",
          targetBinId: bin.id,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
        moved?: number;
      };
      if (!res.ok) throw new Error(j.error ?? "Add failed");
      const moved = Number(j.moved ?? 0);
      if (moved === 0) {
        setErr(
          `No in-stock EPCs found for ${picked.sku_prefix} · ${picked.color ?? "—"}. Nothing to assign.`,
        );
        return;
      }
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Add failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Add item to ${bin.code}`} onClose={onClose}>
      <div className="space-y-3 px-4 py-4 font-mono text-xs">
        <p className="leading-relaxed text-[var(--wms-muted)]">
          Pick a SKU prefix (UPC + color). Every homeless in-stock EPC of that
          group, across all sizes, gets assigned to this bin.
        </p>

        {picked ? (
          <div className="flex items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2">
            <span className="text-[var(--wms-accent)]">{picked.sku_prefix}</span>
            <span className="text-[var(--wms-muted)]">·</span>
            <span className="text-[var(--wms-fg)]">{picked.name ?? "—"}</span>
            <span className="text-[var(--wms-muted)]">·</span>
            <span className="uppercase text-[var(--wms-warn)]">
              {picked.color ?? "—"}
            </span>
            <button
              type="button"
              onClick={() => {
                setPicked(null);
                setTimeout(() => inputRef.current?.focus(), 0);
              }}
              className="ml-auto text-[var(--wms-muted)] hover:text-red-400"
              title="Clear selection"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <div>
            <label className="mb-1 block uppercase tracking-wide text-[var(--wms-muted)]">
              Type to search SKU, name, or color
            </label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--wms-muted)]" />
              <input
                ref={inputRef}
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="e.g. BLACK WASHED, MILO, C111710…"
                className="w-full rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] py-2 pl-7 pr-3 text-[var(--wms-fg)] outline-none focus:border-[var(--wms-accent)] max-md:min-h-11 max-md:text-base"
              />
            </div>
            {debounced && !isLoading && matches.length === 0 ? (
              <p className="mt-2 px-2 text-[var(--wms-muted)]">
                No SKU matches &quot;{debounced}&quot;.
              </p>
            ) : null}
            {matches.length > 0 ? (
              <ul className="mt-2 max-h-60 overflow-y-auto rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]">
                {matches.map((m, i) => (
                  <li
                    key={`${m.sku_prefix}-${m.color ?? ""}-${i}`}
                    onClick={() => setPicked(m)}
                    onMouseEnter={() => setActiveIdx(i)}
                    className={`cursor-pointer px-3 py-1.5 max-md:py-3 max-md:text-sm ${
                      i === activeIdx
                        ? "bg-[color-mix(in_srgb,var(--wms-accent)_22%,var(--wms-surface-elevated))]"
                        : ""
                    }`}
                  >
                    <span className="text-[var(--wms-accent)]">
                      {m.sku_prefix}
                    </span>
                    <span className="text-[var(--wms-muted)]"> · </span>
                    <span className="text-[var(--wms-fg)]">
                      {m.name ?? "—"}
                    </span>
                    <span className="text-[var(--wms-muted)]"> · </span>
                    <span className="uppercase text-[var(--wms-warn)]">
                      {m.color ?? "—"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        )}

        {err ? <p className="text-red-400">{err}</p> : null}
      </div>
      <div className="flex justify-end gap-2 border-t border-[var(--wms-border)] px-4 py-3 max-md:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-xs text-[var(--wms-fg)] max-md:min-h-11 max-md:px-4"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || !picked}
          className="wms-btn-accent-soft rounded-md px-3 py-2 font-mono text-xs disabled:opacity-50 max-md:min-h-11 max-md:px-4"
        >
          {busy ? "Assigning…" : "Assign"}
        </button>
      </div>
    </Modal>
  );
}

/* ===== generic modal =================================================== */

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
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
  return (
    <>
      <button
        type="button"
        aria-label="Close"
        className="fixed inset-0 z-[60] bg-black/70"
        onClick={onClose}
      />
      <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 max-md:items-stretch max-md:p-0">
        <div className="flex max-h-[min(90vh,720px)] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] shadow-2xl max-md:h-full max-md:max-h-none max-md:max-w-none max-md:rounded-none max-md:border-0">
          <div className="flex items-center justify-between border-b border-[var(--wms-border)] px-4 py-3">
            <h3 className="text-sm font-semibold text-[var(--wms-fg)]">{title}</h3>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded p-2 text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)] max-md:-my-1.5 max-md:inline-flex max-md:min-h-11 max-md:min-w-11 max-md:items-center max-md:justify-center"
            >
              <X className="h-4 w-4" strokeWidth={2} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto max-md:overscroll-contain">{children}</div>
        </div>
      </div>
    </>
  );
}

/* ===== exported helpers used by parent page =========================== */

/** Re-exported for the parent page so it can also trigger a refresh. */
export const REFRESH_KEYS = {
  nav: "/api/overview/locations/sections",
  section: (aisle: string, section: string) =>
    `/api/overview/locations/sections?aisle=${encodeURIComponent(aisle)}&section=${encodeURIComponent(section)}`,
};
