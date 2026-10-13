"use client";

/**
 * Cut groups — products made from the same pattern.
 *
 * The owner builds these by hand. A cut is one pattern, so one garment measured
 * per size covers every product in it: a reading saved from CarbonGradingAI is
 * written to every colour of that size AND the same size of every product in
 * the group (lib/server/grading-app.ts → saveScan). That is the whole point of
 * the page — fewer garments on the table for the same size guide.
 *
 * A product is in one group at most. Adding a product that already sits in
 * another group MOVES it (the API takes it out of the old one), so the search
 * result says which group a product is in before anything is clicked, and a
 * move asks first.
 *
 * The open group is bound to ?group= (lib/use-url-param.ts) so a refresh
 * reopens the same window. Unsaved edits stay in React state, never the URL.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { ImageIcon, Loader2, Plus, Save, Search, Trash2, X } from "lucide-react";

import {
  GRADING_PROFILES,
  PROFILE_BY_ID,
  sizeRank,
  type GradingProfile,
  type GradingProfileId,
  type ProfileGuess,
} from "@/lib/size-grading/grading-app-profiles";
import { useUrlParam } from "@/lib/use-url-param";
import { STORE_TZ } from "@/lib/orlando-time";
import { useDebouncedValue } from "@/components/reports/use-debounced-value";

type GroupRow = {
  id: string;
  name: string;
  profile: string | null;
  note: string | null;
  createdAt: string;
  products: number;
  sizesTotal: number;
  sizesMeasured: number;
  flagged: number;
};

type Member = {
  matrix_id: string;
  name: string | null;
  upc: string | null;
  vendor: string | null;
  image: string | null;
  category: string | null;
  subcategory_1: string | null;
  profileGuess?: ProfileGuess;
};

type ChartRow = {
  size: string;
  points_cm: Record<string, number>;
  measured_at: string;
  source: string;
  scan_id: string | null;
};

type GroupDetail = {
  id: string;
  name: string;
  profile: string | null;
  note: string | null;
  members: Member[];
  sizes: string[];
  chart: ChartRow[];
};

type SearchHit = {
  matrix_id: string;
  name: string | null;
  upc: string | null;
  vendor: string | null;
  category: string | null;
  subcategory_1: string | null;
  image: string | null;
  cut_group_id: string | null;
  cut_group: string | null;
  /** count(*) — arrives as a string from Postgres. */
  skus: number | string;
};

const fetcher = async (url: string) => {
  const res = await fetch(url, { cache: "no-store" });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((j as { error?: string }).error ?? "Failed to load");
  return j;
};

async function send(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string } & Record<string, unknown>;
  if (!res.ok || j.ok === false) throw new Error(j.error ?? `Could not save (${res.status})`);
  return j;
}

const OWN_TYPE = "Each product's own type";
const profileLabel = (id: string | null | undefined) =>
  id ? (PROFILE_BY_ID[id as GradingProfileId]?.label ?? id) : OWN_TYPE;

/** What the catalogue says a member is, in words. */
function guessLabel(g: ProfileGuess | undefined): string {
  if (!g) return "";
  if (g.kind === "profile") return PROFILE_BY_ID[g.profile]?.label ?? g.profile;
  if (g.kind === "not-measured") return g.why;
  return "Type not known from the catalogue";
}

/* The size chart's columns: the plain points only. A pair (sleeveL / sleeveR)
   is stored with its average under the plain key, and the chart is about the
   size, not about how straight one sleeve was laid. */
const CHART_KEYS = [
  "chest", "waist", "hip", "length", "hem", "shoulder", "sleeve", "cuff", "strap",
  "rise", "thigh", "knee", "inseam", "outseam", "legOpening", "sideLength",
] as const;

/** A point's name from the first profile that has it ("Body length", "Sleeve length"). */
function labelFrom(profiles: GradingProfile[], key: string): string {
  for (const p of profiles) {
    const own = p.points.find((x) => x.key === key);
    if (own) return own.label;
    const pair = p.points.find((x) => x.pairOf === key);
    if (pair) return pair.label.replace(/ [LR]$/, "");
  }
  return key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}

const SOURCE_LABEL: Record<string, string> = {
  app: "Phone app",
  web: "Size Grading page",
  "cut-group": "Copied within the group",
};

const DAY = new Intl.DateTimeFormat("en-US", { timeZone: STORE_TZ, month: "short", day: "numeric", year: "numeric" });
const day = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : DAY.format(d);
};

const fieldCls =
  "rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1.5 text-sm text-[var(--wms-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--wms-accent)]/40 max-md:min-h-11 max-md:text-base";
const plainBtn =
  "inline-flex items-center gap-1.5 rounded-md border border-[var(--wms-border)] px-3 py-1.5 text-sm text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)] disabled:opacity-40 max-md:min-h-11";
const softBtn = "wms-btn-accent-soft inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm disabled:opacity-40 max-md:min-h-11";

function Thumb({ src }: { src: string | null }) {
  return src ? (
    // A Shopify CDN image, not an asset next/image could optimise.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      loading="lazy"
      className="h-12 w-12 shrink-0 rounded border border-[var(--wms-border)]/60 object-cover"
    />
  ) : (
    <span
      className="flex h-12 w-12 shrink-0 items-center justify-center rounded border border-[var(--wms-border)]/60 text-[var(--wms-border)]"
      aria-hidden
    >
      <ImageIcon className="h-6 w-6" />
    </span>
  );
}

export function CutGroupsWorkspace() {
  const [groupId, setGroupId] = useUrlParam("group");
  const { data, error, isLoading, mutate } = useSWR<{ groups: GroupRow[] }>("/api/grading-app/cut-groups", fetcher);
  const groups = data?.groups ?? [];
  const close = useCallback(() => setGroupId(null), [setGroupId]);
  const refreshList = useCallback(() => void mutate(), [mutate]);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <NewGroupForm
        onCreated={(id) => {
          void mutate();
          setGroupId(id);
        }}
      />

      {error ? (
        <p className="text-sm text-[var(--wms-status-danger-fg)]">
          Could not load the cut groups — {error instanceof Error ? error.message : String(error)}
        </p>
      ) : null}

      <div className="min-w-0 overflow-hidden rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)]">
        <div className="flex items-center justify-between gap-2 border-b border-[var(--wms-border)] px-3 py-2">
          <h2 className="text-sm font-semibold text-[var(--wms-fg)]">Cut groups</h2>
          <span className="font-mono text-xs text-[var(--wms-muted)]">
            {isLoading ? "Loading…" : `${groups.length} group${groups.length === 1 ? "" : "s"}`}
          </span>
        </div>
        {isLoading ? (
          <p className="flex items-center gap-2 p-3 text-sm text-[var(--wms-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading cut groups…
          </p>
        ) : !groups.length ? (
          <p className="p-3 text-sm text-[var(--wms-muted)]">
            No cut groups yet. A cut group is a set of products made from the same pattern — measure one garment per
            size and every product in the group gets the numbers. Start one above.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className="text-left font-mono text-[0.68rem] uppercase tracking-wide text-[var(--wms-muted)]">
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Garment type</th>
                  <th className="px-3 py-2 text-right font-medium">Products</th>
                  <th className="px-3 py-2 font-medium">Sizes measured</th>
                  <th className="px-3 py-2 text-right font-medium">Needs check</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const pct = g.sizesTotal ? Math.round((g.sizesMeasured / g.sizesTotal) * 100) : 0;
                  return (
                    <tr
                      key={g.id}
                      onClick={() => setGroupId(g.id)}
                      className="cursor-pointer border-t border-[var(--wms-border)] hover:bg-[var(--wms-surface-elevated)]"
                    >
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setGroupId(g.id);
                          }}
                          className="text-left font-medium text-[var(--wms-fg)] hover:underline max-md:min-h-11"
                        >
                          {g.name}
                        </button>
                        {g.note ? (
                          <span className="block max-w-xs truncate text-xs text-[var(--wms-muted)]">{g.note}</span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-[var(--wms-muted)]">{profileLabel(g.profile)}</td>
                      <td className="px-3 py-2 text-right font-mono text-[var(--wms-fg)]">{g.products}</td>
                      <td className="px-3 py-2">
                        <span className="flex items-center gap-2">
                          <span className="font-mono text-[var(--wms-fg)]">
                            {g.sizesMeasured} / {g.sizesTotal}
                          </span>
                          <span className="h-1.5 w-20 overflow-hidden rounded bg-[var(--wms-border)]" aria-hidden>
                            <span
                              className="block h-full rounded bg-[var(--wms-status-success-fg)]"
                              style={{ width: `${pct}%` }}
                            />
                          </span>
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right">
                        {g.flagged ? (
                          <Link
                            href={`/inventory/size-grading/review?cutGroupId=${g.id}`}
                            onClick={(e) => e.stopPropagation()}
                            className="font-mono font-semibold text-[var(--wms-status-warning-fg)] hover:underline max-md:inline-flex max-md:min-h-11 max-md:items-center"
                            title="Open the scans of this group that need checking"
                          >
                            {g.flagged}
                          </Link>
                        ) : (
                          <span className="font-mono text-[var(--wms-muted)]">0</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {groupId ? <GroupWindow key={groupId} id={groupId} onClose={close} onChanged={refreshList} /> : null}
    </div>
  );
}

/* ───────────────────────────── new group ───────────────────────────── */

function NewGroupForm({ onCreated }: { onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [profile, setProfile] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const j = await send("/api/grading-app/cut-groups", "POST", { name: name.trim(), profile: profile || null });
      setName("");
      setProfile("");
      onCreated(String(j.id));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not create the group");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex min-w-0 flex-col gap-2 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <h2 className="text-sm font-semibold text-[var(--wms-fg)]">New cut group</h2>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-[14rem] flex-1 flex-col gap-1 max-md:w-full">
          <span className="font-mono text-[0.68rem] uppercase tracking-wide text-[var(--wms-muted)]">Name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            placeholder="e.g. Karina crop tank — all colours"
            autoComplete="off"
            className={fieldCls}
          />
        </label>
        <label className="flex flex-col gap-1 max-md:w-full">
          <span className="font-mono text-[0.68rem] uppercase tracking-wide text-[var(--wms-muted)]">Garment type</span>
          <select value={profile} onChange={(e) => setProfile(e.target.value)} className={fieldCls}>
            <option value="">{OWN_TYPE}</option>
            {GRADING_PROFILES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="wms-btn-primary wms-btn-sm max-md:min-h-11 max-md:w-full" disabled={busy || !name.trim()}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          {busy ? "Creating…" : "Create"}
        </button>
      </div>
      <p className="text-xs text-[var(--wms-muted)]">
        The garment type tells the phone which points to measure for every product in the group. Leave it on
        &quot;{OWN_TYPE}&quot; and each product uses what its catalogue category says.
      </p>
      {err ? <p className="text-sm text-[var(--wms-status-danger-fg)]">{err}</p> : null}
    </form>
  );
}

/* ───────────────────────────── group window ───────────────────────────── */

function GroupWindow({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { data, error, isLoading, mutate } = useSWR<{ group: GroupDetail }>(`/api/grading-app/cut-groups/${id}`, fetcher);
  const group = data?.group ?? null;

  /** Refetch this group and the list behind it (product counts, progress). */
  const changed = useCallback(async () => {
    await mutate();
    onChanged();
  }, [mutate, onChanged]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <button type="button" aria-label="Close" className="fixed inset-0 z-[60] bg-black/70" onClick={onClose} />
      <div className="pointer-events-none fixed inset-0 z-[70] flex items-center justify-center p-4 max-md:items-stretch max-md:p-0">
        <div
          role="dialog"
          aria-modal="true"
          aria-label={group ? `Cut group ${group.name}` : "Cut group"}
          className="pointer-events-auto flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] shadow-2xl max-md:h-full max-md:max-h-none max-md:max-w-none max-md:rounded-none max-md:border-0"
        >
          <div className="flex items-center justify-between gap-2 border-b border-[var(--wms-border)] px-4 py-3">
            <h2 className="min-w-0 truncate text-sm font-semibold text-[var(--wms-fg)]">
              {group ? group.name : "Cut group"}
            </h2>
            <button
              type="button"
              onClick={onClose}
              className="rounded p-2 text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)] max-md:-my-1.5 max-md:inline-flex max-md:min-h-11 max-md:min-w-11 max-md:items-center max-md:justify-center"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4 max-md:overscroll-contain max-md:pb-[max(1rem,env(safe-area-inset-bottom))]">
            {isLoading ? (
              <p className="flex items-center gap-2 text-sm text-[var(--wms-muted)]">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading the group…
              </p>
            ) : error || !group ? (
              <p className="text-sm text-[var(--wms-status-danger-fg)]">
                {error instanceof Error && error.message !== "Not found"
                  ? `Could not load this group — ${error.message}`
                  : "This cut group no longer exists."}
              </p>
            ) : (
              <>
                <GroupSettings
                  group={group}
                  onSaved={changed}
                  onDeleted={() => {
                    onChanged();
                    onClose();
                  }}
                />
                <GroupProducts group={group} onChanged={changed} />
                <GroupSizeChart group={group} />
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/* ───────────────────────── name / type / note ───────────────────────── */

function GroupSettings({
  group,
  onSaved,
  onDeleted,
}: {
  group: GroupDetail;
  onSaved: () => Promise<void>;
  onDeleted: () => void;
}) {
  /* Drafts are null until touched, so a refetch shows the saved values and an
     edit in progress is never overwritten by one. */
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [profileDraft, setProfileDraft] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const name = nameDraft ?? group.name;
  const profile = profileDraft ?? group.profile ?? "";
  const note = noteDraft ?? group.note ?? "";
  const nameChanged = nameDraft !== null && nameDraft.trim() !== group.name;
  const profileChanged = profileDraft !== null && profileDraft !== (group.profile ?? "");
  const noteChanged = noteDraft !== null && noteDraft.trim() !== (group.note ?? "");
  const dirty = nameChanged || profileChanged || noteChanged;

  const save = async () => {
    if (nameChanged && !name.trim()) {
      setErr("The group needs a name.");
      return;
    }
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const body: { name?: string; profile?: string | null; note?: string | null } = {};
      if (nameChanged) body.name = name.trim();
      if (profileChanged) body.profile = profile || null;
      if (noteChanged) body.note = note.trim() || null;
      await send(`/api/grading-app/cut-groups/${group.id}`, "PATCH", body);
      await onSaved();
      setNameDraft(null);
      setProfileDraft(null);
      setNoteDraft(null);
      setMsg("Saved.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setErr(null);
    try {
      await send(`/api/grading-app/cut-groups/${group.id}`, "DELETE");
      onDeleted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not delete the group");
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-2">
      <div className="grid gap-2 md:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[0.68rem] uppercase tracking-wide text-[var(--wms-muted)]">Name</span>
          <input
            type="text"
            value={name}
            maxLength={120}
            autoComplete="off"
            onChange={(e) => setNameDraft(e.target.value)}
            className={fieldCls}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[0.68rem] uppercase tracking-wide text-[var(--wms-muted)]">Garment type</span>
          <select value={profile} onChange={(e) => setProfileDraft(e.target.value)} className={fieldCls}>
            <option value="">{OWN_TYPE}</option>
            {GRADING_PROFILES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="flex flex-col gap-1">
        <span className="font-mono text-[0.68rem] uppercase tracking-wide text-[var(--wms-muted)]">Note</span>
        <textarea
          value={note}
          maxLength={500}
          rows={2}
          onChange={(e) => setNoteDraft(e.target.value)}
          placeholder="Anything worth knowing about this cut — e.g. which product to measure from."
          className={`${fieldCls} resize-y`}
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="wms-btn-primary wms-btn-sm max-md:min-h-11"
          disabled={busy || !dirty}
          onClick={() => void save()}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Save changes
        </button>
        {dirty ? (
          <button
            type="button"
            className={plainBtn}
            disabled={busy}
            onClick={() => {
              setNameDraft(null);
              setProfileDraft(null);
              setNoteDraft(null);
            }}
          >
            Undo changes
          </button>
        ) : null}
        <button
          type="button"
          className={`${plainBtn} ml-auto text-[var(--wms-status-danger-fg)]`}
          disabled={busy}
          onClick={() => setConfirmDelete(true)}
        >
          <Trash2 className="h-4 w-4" /> Delete group
        </button>
        {msg ? <span className="font-mono text-xs text-[var(--wms-status-success-fg)]">{msg}</span> : null}
        {err ? <span className="font-mono text-xs text-[var(--wms-status-danger-fg)]">{err}</span> : null}
      </div>
      {profileChanged ? (
        <p className="text-xs text-[var(--wms-status-warning-fg)]">
          The new type applies to the next scans: the phone will measure the points of &quot;{profileLabel(profile || null)}
          &quot; for every product in this group. Measurements already saved are not changed.
        </p>
      ) : null}

      {confirmDelete ? (
        <div className="rounded-md border border-[var(--wms-status-danger-fg)]/50 bg-[var(--wms-status-danger-fg)]/10 p-3">
          <p className="text-sm font-medium text-[var(--wms-fg)]">Delete the cut group &quot;{group.name}&quot;?</p>
          <p className="mt-1 text-sm text-[var(--wms-muted)]">
            Only the group goes. Its {group.members.length} product{group.members.length === 1 ? "" : "s"} and every
            measurement already saved on them stay exactly as they are — they just stop sharing new measurements with
            each other.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className="wms-btn-danger wms-btn-sm max-md:min-h-11" disabled={busy} onClick={() => void remove()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              Yes, delete the group
            </button>
            <button type="button" className={plainBtn} disabled={busy} onClick={() => setConfirmDelete(false)}>
              Keep it
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/* ───────────────────────────── products ───────────────────────────── */

function GroupProducts({ group, onChanged }: { group: GroupDetail; onChanged: () => Promise<void> }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const removeMember = async (m: Member) => {
    setBusyId(m.matrix_id);
    setErr(null);
    setMsg(null);
    try {
      await send(`/api/grading-app/cut-groups/${group.id}`, "POST", { remove: [m.matrix_id] });
      await onChanged();
      setMsg(`Took "${m.name ?? m.upc ?? "the product"}" out of the group. Its measurements stay on it.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not remove it");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-[var(--wms-fg)]">
        Products <span className="font-mono text-xs font-normal text-[var(--wms-muted)]">({group.members.length})</span>
      </h3>
      {group.members.length ? (
        <ul className="divide-y divide-[var(--wms-border)] rounded-md border border-[var(--wms-border)]">
          {group.members.map((m) => (
            <li key={m.matrix_id} className="flex flex-wrap items-center gap-3 p-2">
              <Thumb src={m.image} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-[var(--wms-fg)]">{m.name ?? "Unnamed product"}</span>
                <span className="block font-mono text-xs text-[var(--wms-muted)]">
                  UPC {m.upc ?? "—"}
                  {m.vendor ? ` · ${m.vendor}` : ""}
                </span>
                {m.profileGuess ? (
                  <span className="block text-xs text-[var(--wms-muted)]">Catalogue type: {guessLabel(m.profileGuess)}</span>
                ) : null}
              </span>
              <button
                type="button"
                className={plainBtn}
                disabled={busyId !== null}
                onClick={() => void removeMember(m)}
                title="Take this product out of the group — its measurements stay on it"
              >
                {busyId === m.matrix_id ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-[var(--wms-muted)]">No products in this group yet — add them below.</p>
      )}
      {msg ? <p className="text-sm text-[var(--wms-status-success-fg)]">{msg}</p> : null}
      {err ? <p className="text-sm text-[var(--wms-status-danger-fg)]">{err}</p> : null}
      <AddProducts
        group={group}
        onAdded={async (text) => {
          await onChanged();
          setErr(null);
          setMsg(text);
        }}
      />
    </section>
  );
}

function AddProducts({ group, onAdded }: { group: GroupDetail; onAdded: (message: string) => Promise<void> }) {
  const [q, setQ] = useState("");
  const query = useDebouncedValue(q.trim(), 350);
  const key = query.length >= 2 ? `/api/grading-app/cut-groups?search=${encodeURIComponent(query)}` : null;
  const { data, error, isLoading, mutate } = useSWR<{ products: SearchHit[] }>(key, fetcher, { revalidateOnFocus: false });
  const hits = data?.products ?? [];
  const [busyId, setBusyId] = useState<string | null>(null);
  /** A product that is in another group: asked about once before it is moved. */
  const [confirmMove, setConfirmMove] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const add = async (h: SearchHit) => {
    setBusyId(h.matrix_id);
    setErr(null);
    try {
      const j = (await send(`/api/grading-app/cut-groups/${group.id}`, "POST", { add: [h.matrix_id] })) as {
        moved?: { matrixId: string; from: string }[];
        copiedReadings?: number;
      };
      const label = h.name ?? h.upc ?? "the product";
      const from = j.moved?.find((x) => x.matrixId === h.matrix_id)?.from;
      const copied = Number(j.copiedReadings ?? 0);
      let text = `Added "${label}".`;
      if (from) text += ` It was taken out of "${from}".`;
      if (copied) text += ` ${copied} measurement${copied === 1 ? "" : "s"} this group already had were copied onto its sizes.`;
      setConfirmMove(null);
      await Promise.all([onAdded(text), mutate()]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not add it");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="mt-1 flex flex-col gap-2 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/40 p-2">
      <label className="relative flex items-center">
        <Search className="pointer-events-none absolute left-2.5 h-4 w-4 text-[var(--wms-muted)]" aria-hidden />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Add products — search by name, UPC or SKU"
          autoComplete="off"
          className={`${fieldCls} w-full pl-8`}
        />
      </label>
      {q.trim().length > 0 && q.trim().length < 2 ? (
        <p className="text-xs text-[var(--wms-muted)]">Type at least 2 letters.</p>
      ) : null}
      {key && isLoading ? (
        <p className="flex items-center gap-2 text-xs text-[var(--wms-muted)]">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Searching…
        </p>
      ) : null}
      {error ? (
        <p className="text-sm text-[var(--wms-status-danger-fg)]">
          Search failed — {error instanceof Error ? error.message : String(error)}
        </p>
      ) : null}
      {key && !isLoading && !error && !hits.length ? (
        <p className="text-xs text-[var(--wms-muted)]">Nothing found for &quot;{query}&quot;.</p>
      ) : null}
      {hits.length ? (
        <ul className="max-h-80 divide-y divide-[var(--wms-border)] overflow-y-auto rounded border border-[var(--wms-border)] bg-[var(--wms-surface)] max-md:max-h-[50dvh] max-md:overscroll-contain">
          {hits.map((h) => {
            const here = h.cut_group_id === group.id;
            const elsewhere = Boolean(h.cut_group_id) && !here;
            const asking = confirmMove === h.matrix_id;
            const skus = Number(h.skus) || 0;
            return (
              <li key={h.matrix_id} className="flex flex-col gap-2 p-2">
                <div className="flex flex-wrap items-center gap-3">
                  <Thumb src={h.image} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-[var(--wms-fg)]">{h.name ?? "Unnamed product"}</span>
                    <span className="block font-mono text-xs text-[var(--wms-muted)]">
                      UPC {h.upc ?? "—"}
                      {h.vendor ? ` · ${h.vendor}` : ""} · {skus} SKU{skus === 1 ? "" : "s"}
                    </span>
                    {here ? (
                      <span className="mt-0.5 inline-block rounded border border-[var(--wms-status-success-fg)]/40 px-1.5 py-0.5 font-mono text-[0.68rem] text-[var(--wms-status-success-fg)]">
                        already in this group
                      </span>
                    ) : elsewhere ? (
                      <span className="mt-0.5 inline-block rounded border border-[var(--wms-status-warning-fg)]/50 bg-[var(--wms-status-warning-fg)]/10 px-1.5 py-0.5 font-mono text-[0.68rem] text-[var(--wms-status-warning-fg)]">
                        in &quot;{h.cut_group}&quot;
                      </span>
                    ) : null}
                  </span>
                  {here ? null : elsewhere ? (
                    <button
                      type="button"
                      className={softBtn}
                      disabled={busyId !== null || asking}
                      onClick={() => setConfirmMove(h.matrix_id)}
                    >
                      Move here
                    </button>
                  ) : (
                    <button type="button" className={softBtn} disabled={busyId !== null} onClick={() => void add(h)}>
                      {busyId === h.matrix_id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                      Add
                    </button>
                  )}
                </div>
                {asking ? (
                  <div className="rounded border border-[var(--wms-status-warning-fg)]/50 bg-[var(--wms-status-warning-fg)]/10 p-2">
                    <p className="text-sm text-[var(--wms-fg)]">
                      This product is in &quot;{h.cut_group}&quot;. A product can only be in one group, so adding it
                      here takes it out of &quot;{h.cut_group}&quot;. Measurements already on it stay.
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button type="button" className={softBtn} disabled={busyId !== null} onClick={() => void add(h)}>
                        {busyId === h.matrix_id ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                        Move it here
                      </button>
                      <button type="button" className={plainBtn} disabled={busyId !== null} onClick={() => setConfirmMove(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {err ? <p className="text-sm text-[var(--wms-status-danger-fg)]">{err}</p> : null}
    </div>
  );
}

/* ───────────────────────────── size chart ───────────────────────────── */

function GroupSizeChart({ group }: { group: GroupDetail }) {
  /** Centimetres are what is stored; inches are a display conversion only. */
  const [unit, setUnit] = useState<"cm" | "in">("cm");

  /* Point names from the group's own type first, then the types its products
     are in the catalogue, then any type that has the point. */
  const profiles = useMemo(() => {
    const ids: string[] = [];
    if (group.profile) ids.push(group.profile);
    for (const m of group.members) if (m.profileGuess?.kind === "profile") ids.push(m.profileGuess.profile);
    const own = ids.map((id) => PROFILE_BY_ID[id as GradingProfileId]).filter(Boolean);
    return [...new Set([...own, ...GRADING_PROFILES])];
  }, [group.profile, group.members]);

  const keys = useMemo(
    () => CHART_KEYS.filter((k) => group.chart.some((r) => typeof r.points_cm?.[k] === "number")),
    [group.chart],
  );
  const bySize = useMemo(() => new Map(group.chart.map((r) => [r.size, r])), [group.chart]);
  /* Every size the group sells, in wearing order — plus any size that has a
     reading but no live SKU any more, so a number is never hidden. */
  const sizes = useMemo(
    () => [...new Set([...group.sizes, ...group.chart.map((r) => r.size)])].sort((a, b) => sizeRank(a) - sizeRank(b)),
    [group.sizes, group.chart],
  );
  const fmt = (cm: number | undefined) =>
    typeof cm === "number" && Number.isFinite(cm) ? (unit === "cm" ? cm : cm / 2.54).toFixed(1) : "—";

  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-[var(--wms-fg)]">Size chart</h3>
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex overflow-hidden rounded border border-[var(--wms-border)]">
            {(["cm", "in"] as const).map((u) => (
              <button
                key={u}
                type="button"
                onClick={() => setUnit(u)}
                className={`px-2.5 py-1 font-mono text-xs max-md:min-h-11 max-md:px-4 ${
                  unit === u
                    ? "bg-[var(--wms-accent)] font-semibold text-[var(--wms-accent-fg)]"
                    : "text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)]"
                }`}
              >
                {u === "cm" ? "cm" : "inches"}
              </button>
            ))}
          </span>
          <Link
            href={`/inventory/size-grading/review?cutGroupId=${group.id}&status=all`}
            className={plainBtn}
          >
            This group&apos;s scans
          </Link>
        </div>
      </div>
      {!sizes.length ? (
        <p className="text-sm text-[var(--wms-muted)]">No sizes yet — add products to the group first.</p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-md border border-[var(--wms-border)]">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left font-mono text-[0.68rem] uppercase tracking-wide text-[var(--wms-muted)]">
                  <th className="px-2 py-2 font-medium">Size</th>
                  {keys.map((k) => (
                    <th key={k} className="whitespace-nowrap px-2 py-2 text-right font-medium">
                      {labelFrom(profiles, k)}
                    </th>
                  ))}
                  <th className="whitespace-nowrap px-2 py-2 font-medium">Measured</th>
                </tr>
              </thead>
              <tbody>
                {sizes.map((s) => {
                  const r = bySize.get(s);
                  return (
                    <tr key={s} className="border-t border-[var(--wms-border)]">
                      <td className="px-2 py-1.5 font-mono font-semibold text-[var(--wms-fg)]">{s}</td>
                      {keys.map((k) => (
                        <td key={k} className="px-2 py-1.5 text-right font-mono text-[var(--wms-fg)]">
                          {fmt(r?.points_cm?.[k])}
                        </td>
                      ))}
                      <td className="whitespace-nowrap px-2 py-1.5 text-xs text-[var(--wms-muted)]">
                        {r ? (
                          <>
                            {day(r.measured_at)} · {SOURCE_LABEL[r.source] ?? r.source}
                            {r.scan_id ? (
                              <>
                                {" · "}
                                <Link
                                  href={`/inventory/size-grading/review?status=all&scan=${r.scan_id}`}
                                  className="text-[var(--wms-accent)] hover:underline max-md:inline-flex max-md:min-h-11 max-md:items-center"
                                >
                                  photo
                                </Link>
                              </>
                            ) : null}
                          </>
                        ) : (
                          <span className="text-[var(--wms-status-warning-fg)]">not measured yet</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-[var(--wms-muted)]">
            Flat measurements in {unit === "cm" ? "centimetres" : "inches"}, front side — the latest reading of each size
            from any product in the group. Sleeves and legs show the average of left and right.
          </p>
        </>
      )}
    </section>
  );
}
