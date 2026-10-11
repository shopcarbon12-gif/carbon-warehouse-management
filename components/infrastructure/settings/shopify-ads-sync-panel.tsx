"use client";

import { useState } from "react";
import useSWR from "swr";
import { Megaphone, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { fmtWhen, jsonFetcher, useChannelJob, useChannelStatus } from "./use-channel-job";
import { Progress, Stat } from "./shopify-translate-panel";

type GroupSync = {
  at: string;
  products: number;
  variants: number;
  google_listings: number | null;
  meta_count: number | null;
  google_campaigns: string[];
  meta_ad_sets: string[];
  warnings: string[];
};
type Group = {
  id: string;
  slug: string;
  name: string;
  product_types: string[];
  name_contains: string[];
  name_excludes: string[];
  include_groups: string[];
  in_stock_only: boolean;
  google_label_slot: number | null;
  google_label_value: string | null;
  meta_set_name: string | null;
  meta_set_id: string | null;
  active: boolean;
  sort_order: number;
  last_sync: GroupSync | null;
};
type Result = {
  products: number;
  channels: { names: string[]; published: number; failed: number };
  google: { configured: boolean; listings: number; labelled: number; cleared: number; failed: number; errors: string[] };
  meta: { configured: boolean; catalog: number | null };
  warnings: string[];
};

/**
 * Integrations → Shopify: "Sync ads". Keeps every ad product group current on
 * every channel — Shopify sales channels, Google Merchant Center labels (any
 * Google campaign that filters on the label gets the products) and Meta
 * catalog product sets (any Meta ad set that uses the set gets them).
 */
export function ShopifyAdsSyncPanel() {
  const { data: status, mutate } = useChannelStatus();
  const { data: gdata, mutate: mutateGroups } = useSWR<{ groups: Group[] }>("/api/shopify/ad-groups", jsonFetcher, {
    revalidateOnFocus: false,
  });
  const { job, running, err, start } = useChannelJob<Result>("ads", status?.ads?.id, () => {
    void mutate();
    void mutateGroups();
  });
  const [editing, setEditing] = useState<Partial<Group> | null>(null);
  const groups = gdata?.groups ?? [];
  const result = job?.result ?? null;

  return (
    <div className="space-y-4 rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80 p-5">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] text-[var(--wms-accent)]">
          <Megaphone className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <h3 className="font-mono text-sm font-semibold text-[var(--wms-fg)]">Sync ads (Google + Meta)</h3>
          <p className="mt-0.5 font-mono text-[0.7rem] leading-relaxed text-[var(--wms-muted)]">
            Puts every active product on every Shopify sales channel, then keeps each ad product group below up to
            date: Google Merchant Center gets the group&apos;s label on its products, Meta gets the group as a
            catalog product set. Any campaign — today&apos;s or a future one — that picks a group&apos;s label
            (Google) or product set (Meta) advertises exactly those products. For a new campaign, add a group,
            press Sync ads, then choose it in Google Ads / Meta Ads Manager.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 font-mono text-[0.7rem] sm:grid-cols-4">
        <Stat label="Google Merchant" value={status ? (status.connected.google_merchant ? "connected" : "not set up") : "…"} ok={status?.connected.google_merchant} />
        <Stat label="Google Ads" value={status ? (status.connected.google_ads ? "connected" : "not set up") : "…"} ok={status?.connected.google_ads} />
        <Stat label="Meta" value={status ? (status.connected.meta ? "connected" : "not set up") : "…"} ok={status?.connected.meta} />
        <Stat label="Last sync" value={fmtWhen(status?.ads?.finished_at ?? status?.ads?.created_at)} />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={running}
          onClick={() => void start()}
          className="inline-flex items-center gap-2 rounded-lg border border-[var(--wms-accent)]/50 bg-[var(--wms-accent)] px-5 py-2.5 font-mono text-xs font-semibold text-[var(--wms-accent-fg)] shadow-sm hover:opacity-90 disabled:opacity-40"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${running ? "animate-spin" : ""}`} />
          {running ? "Syncing…" : "Sync ads"}
        </button>
        {err ? <span className="font-mono text-xs text-red-400/90">{err}</span> : null}
      </div>

      {job && running ? <Progress pct={job.pct} message={job.message ?? "Working"} /> : null}
      {job?.status === "failed" ? <p className="font-mono text-xs text-red-400/90">{job.error ?? "Sync failed"}</p> : null}
      {job?.status === "completed" && result ? (
        <div className="space-y-1 font-mono text-[0.7rem]">
          <p className="text-emerald-500/90">
            {job.message} · {fmtWhen(job.finished_at)}
          </p>
          <p className="text-[var(--wms-muted)]">
            Sales channels: {result.channels.names.join(", ")}
            {result.channels.failed ? ` · ${result.channels.failed} could not be published` : ""}
          </p>
          {result.google.configured ? (
            <p className="text-[var(--wms-muted)]">
              Google: {result.google.listings} listings checked · {result.google.labelled} labelled ·{" "}
              {result.google.cleared} labels removed{result.google.failed ? ` · ${result.google.failed} failed` : ""}
            </p>
          ) : null}
          {result.meta.configured && result.meta.catalog !== null ? (
            <p className="text-[var(--wms-muted)]">Meta catalog: {result.meta.catalog} items</p>
          ) : null}
          {[...result.warnings, ...result.google.errors].map((w, i) => (
            <p key={i} className="text-amber-500">
              {w}
            </p>
          ))}
        </div>
      ) : null}

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="font-mono text-xs font-semibold text-[var(--wms-fg)]">Ad product groups</h4>
          <button
            type="button"
            onClick={() =>
              setEditing({ name: "", product_types: [], name_contains: [], name_excludes: [], include_groups: [], in_stock_only: true, active: true, google_label_slot: 0, sort_order: (groups.length + 1) * 10 })
            }
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--wms-border)] px-3 py-1.5 font-mono text-[0.7rem] text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)]"
          >
            <Plus className="h-3.5 w-3.5" /> Add group
          </button>
        </div>
        {groups.map((g) => (
          <GroupCard key={g.id} g={g} onEdit={() => setEditing(g)} />
        ))}
        {!groups.length ? <p className="font-mono text-[0.7rem] text-[var(--wms-muted)]">No groups yet.</p> : null}
      </div>

      {editing ? (
        <GroupEditor
          group={editing}
          groups={groups}
          onClose={() => setEditing(null)}
          onSaved={(gs) => {
            void mutateGroups({ groups: gs }, { revalidate: false });
            setEditing(null);
          }}
        />
      ) : null}
    </div>
  );
}

function GroupCard({ g, onEdit }: { g: Group; onEdit: () => void }) {
  const s = g.last_sync;
  return (
    <div className={`rounded-md border border-[var(--wms-border)] p-3 font-mono text-[0.7rem] ${g.active ? "" : "opacity-60"}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-semibold text-[var(--wms-fg)]">
            {g.name}
            {!g.active ? <span className="ml-2 text-[var(--wms-muted)]">(off)</span> : null}
          </div>
          <div className="mt-0.5 text-[var(--wms-muted)]">
            {g.google_label_value ? `Google label: custom_label_${g.google_label_slot} = ${g.google_label_value}` : "Google: not labelled"}
            {" · "}
            {g.meta_set_name ? `Meta set: ${g.meta_set_name}` : "Meta: no set"}
            {g.in_stock_only ? " · in stock only" : ""}
          </div>
        </div>
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex items-center gap-1 rounded-md border border-[var(--wms-border)] px-2 py-1 text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)]"
        >
          <Pencil className="h-3 w-3" /> Edit
        </button>
      </div>
      <div className="mt-2 text-[var(--wms-muted)]">
        Rules: {[
          g.product_types.length ? `types ${g.product_types.join(", ")}` : null,
          g.name_contains.length ? `names containing ${g.name_contains.join(", ")}` : null,
          g.include_groups.length ? `plus groups ${g.include_groups.join(", ")}` : null,
        ]
          .filter(Boolean)
          .join(" · ") || "none"}
        {g.name_excludes.length ? ` · except names containing ${g.name_excludes.join(", ")}` : ""}
      </div>
      {s ? (
        <div className="mt-2 grid gap-1 sm:grid-cols-2">
          <div className="text-[var(--wms-fg)]">
            {s.products} products · {s.variants} sizes
            {s.google_listings !== null ? ` · Google ${s.google_listings} listings` : ""}
            {s.meta_count !== null && s.meta_count >= 0 ? ` · Meta ${s.meta_count} items` : ""}
          </div>
          <div className="text-[var(--wms-muted)]">synced {fmtWhen(s.at)}</div>
          <div className="text-[var(--wms-muted)] sm:col-span-2">
            Google campaigns: {s.google_campaigns.length ? s.google_campaigns.join("; ") : "none use this label yet"}
          </div>
          <div className="text-[var(--wms-muted)] sm:col-span-2">
            Meta ad sets: {s.meta_ad_sets.length ? s.meta_ad_sets.join("; ") : "none use this set yet"}
          </div>
          {s.warnings.map((w, i) => (
            <div key={i} className="text-amber-500 sm:col-span-2">
              {w}
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-2 text-[var(--wms-muted)]">Not synced yet — press Sync ads.</div>
      )}
    </div>
  );
}

function GroupEditor({
  group,
  groups,
  onClose,
  onSaved,
}: {
  group: Partial<Group>;
  groups: Group[];
  onClose: () => void;
  onSaved: (groups: Group[]) => void;
}) {
  const [f, setF] = useState({
    name: group.name ?? "",
    product_types: (group.product_types ?? []).join("\n"),
    name_contains: (group.name_contains ?? []).join("\n"),
    name_excludes: (group.name_excludes ?? []).join("\n"),
    include_groups: group.include_groups ?? [],
    in_stock_only: group.in_stock_only ?? true,
    google_on: Boolean(group.google_label_value) || !group.id,
    google_label_slot: group.google_label_slot ?? 0,
    google_label_value: group.google_label_value ?? "",
    meta_on: Boolean(group.meta_set_name) || !group.id,
    meta_set_name: group.meta_set_name ?? "",
    active: group.active ?? true,
    sort_order: group.sort_order ?? 100,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = (k: keyof typeof f, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const slugOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/shopify/ad-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: group.id,
          slug: group.slug ?? slugOf(f.name),
          name: f.name,
          product_types: f.product_types,
          name_contains: f.name_contains,
          name_excludes: f.name_excludes,
          include_groups: f.include_groups,
          in_stock_only: f.in_stock_only,
          google_label_slot: f.google_on ? f.google_label_slot : null,
          google_label_value: f.google_on ? f.google_label_value || slugOf(f.name) : null,
          meta_set_name: f.meta_on ? f.meta_set_name || `Ads · ${f.name}${f.in_stock_only ? " (in stock)" : ""}` : null,
          active: f.active,
          sort_order: f.sort_order,
        }),
      });
      const j = (await res.json()) as { groups?: Group[]; error?: string };
      if (!res.ok || !j.groups) throw new Error(j.error ?? "Could not save");
      onSaved(j.groups);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!group.id) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/shopify/ad-groups?id=${group.id}`, { method: "DELETE" });
      const j = (await res.json()) as { groups?: Group[]; error?: string };
      if (!res.ok || !j.groups) throw new Error(j.error ?? "Could not delete");
      onSaved(j.groups);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete");
      setBusy(false);
    }
  };

  const input = "w-full rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1.5 font-mono text-[0.72rem] text-[var(--wms-fg)]";
  const label = "block font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)]";
  return (
    <div className="space-y-3 rounded-md border border-[var(--wms-accent)]/40 bg-[var(--wms-surface-elevated)]/30 p-4">
      <h4 className="font-mono text-xs font-semibold text-[var(--wms-fg)]">{group.id ? `Edit "${group.name}"` : "New ad product group"}</h4>
      <div>
        <span className={label}>Name</span>
        <input className={input} value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Women jeans fall" />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <span className={label}>Product types (one per line)</span>
          <textarea className={`${input} h-32`} value={f.product_types} onChange={(e) => set("product_types", e.target.value)} placeholder={"WOMEN >> JEANS\nWOMEN >> DRESS"} />
        </div>
        <div>
          <span className={label}>…or name contains (one per line)</span>
          <textarea className={`${input} h-32`} value={f.name_contains} onChange={(e) => set("name_contains", e.target.value)} placeholder={"Kaia Jeans\nGyda"} />
        </div>
        <div>
          <span className={label}>Except names containing</span>
          <textarea className={`${input} h-32`} value={f.name_excludes} onChange={(e) => set("name_excludes", e.target.value)} placeholder="sweater" />
        </div>
      </div>
      {groups.filter((g) => g.id !== group.id).length ? (
        <div>
          <span className={label}>Also include every product of</span>
          <div className="mt-1 flex flex-wrap gap-3">
            {groups
              .filter((g) => g.id !== group.id)
              .map((g) => (
                <label key={g.id} className="inline-flex items-center gap-1.5 font-mono text-[0.7rem] text-[var(--wms-fg)]">
                  <input
                    type="checkbox"
                    checked={f.include_groups.includes(g.slug)}
                    onChange={(e) =>
                      set("include_groups", e.target.checked ? [...f.include_groups, g.slug] : f.include_groups.filter((s) => s !== g.slug))
                    }
                  />
                  {g.name}
                </label>
              ))}
          </div>
        </div>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label className="inline-flex items-center gap-1.5 font-mono text-[0.7rem] text-[var(--wms-fg)]">
            <input type="checkbox" checked={f.google_on} onChange={(e) => set("google_on", e.target.checked)} /> Label it in Google Merchant Center
          </label>
          {f.google_on ? (
            <div className="flex gap-2">
              <select className={`${input} w-28`} value={f.google_label_slot} onChange={(e) => set("google_label_slot", Number(e.target.value))}>
                {[0, 1, 2, 3, 4].map((s) => (
                  <option key={s} value={s}>
                    label {s}
                  </option>
                ))}
              </select>
              <input className={input} value={f.google_label_value} onChange={(e) => set("google_label_value", e.target.value)} placeholder={slugOf(f.name) || "label value"} />
            </div>
          ) : null}
        </div>
        <div className="space-y-1.5">
          <label className="inline-flex items-center gap-1.5 font-mono text-[0.7rem] text-[var(--wms-fg)]">
            <input type="checkbox" checked={f.meta_on} onChange={(e) => set("meta_on", e.target.checked)} /> Meta product set
          </label>
          {f.meta_on ? (
            <input className={input} value={f.meta_set_name} onChange={(e) => set("meta_set_name", e.target.value)} placeholder={`Ads · ${f.name || "group"}`} />
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap gap-4">
        <label className="inline-flex items-center gap-1.5 font-mono text-[0.7rem] text-[var(--wms-fg)]">
          <input type="checkbox" checked={f.in_stock_only} onChange={(e) => set("in_stock_only", e.target.checked)} /> In-stock sizes only
        </label>
        <label className="inline-flex items-center gap-1.5 font-mono text-[0.7rem] text-[var(--wms-fg)]">
          <input type="checkbox" checked={f.active} onChange={(e) => set("active", e.target.checked)} /> Active
        </label>
      </div>
      <p className="font-mono text-[0.65rem] text-[var(--wms-muted)]">
        Groups that share a Google label number should not overlap — a product holds one value per label number.
        Use a different number for a group that overlaps another (for example label 1 for a sale group).
      </p>
      {error ? <p className="font-mono text-xs text-red-400/90">{error}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy || !f.name.trim()}
          onClick={() => void save()}
          className="rounded-md border border-[var(--wms-accent)]/50 bg-[var(--wms-accent)] px-4 py-1.5 font-mono text-xs font-semibold text-[var(--wms-accent-fg)] disabled:opacity-40"
        >
          {busy ? "Saving…" : "Save group"}
        </button>
        <button type="button" onClick={onClose} className="rounded-md border border-[var(--wms-border)] px-4 py-1.5 font-mono text-xs text-[var(--wms-fg)]">
          Cancel
        </button>
        {group.id ? (
          confirmDelete ? (
            <span className="inline-flex items-center gap-2 font-mono text-[0.7rem] text-red-400">
              Delete this group? Campaigns using it stop getting products.
              <button type="button" disabled={busy} onClick={() => void remove()} className="rounded-md border border-red-500/50 px-2 py-1 text-red-400">
                Yes, delete
              </button>
              <button type="button" onClick={() => setConfirmDelete(false)} className="rounded-md border border-[var(--wms-border)] px-2 py-1 text-[var(--wms-fg)]">
                No
              </button>
            </span>
          ) : (
            <button type="button" onClick={() => setConfirmDelete(true)} className="ml-auto inline-flex items-center gap-1 rounded-md border border-red-500/40 px-3 py-1.5 font-mono text-xs text-red-400">
              <Trash2 className="h-3 w-3" /> Delete
            </button>
          )
        ) : null}
      </div>
    </div>
  );
}
