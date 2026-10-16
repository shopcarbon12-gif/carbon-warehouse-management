"use client";

import { useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { Download, Pencil, Plus, Search, Trash2, Upload, X } from "lucide-react";
import { useUrlParam } from "@/lib/use-url-param";

/* Zone Management (owner, 2026-10-16). A zone ("Store", …) is put on SPECIFIC
   tags — per EPC — by scanning them (handheld) or pasting / importing them
   here. Bins never change. One zone per tag; it clears by itself when the tag
   is sold, moves to another location or stops being LIVE. */

type Zone = { id: string; name: string; count: number; createdAt: string };
type TagDetails = {
  epc: string;
  serial: string | null;
  product: string | null;
  sku: string | null;
  color: string | null;
  size: string | null;
  retailPrice: string | null;
  status: string | null;
  statusLabel: string | null;
  bin: string | null;
  extraBins: string[];
  location: string | null;
  zone: string | null;
  zoneAssignedAt: string | null;
  lastSeenAt: string | null;
  lastSeenReaderZone: string | null;
  firstSeenAt: string | null;
  source: string | null;
};
type ZoneTag = TagDetails & { assignedBy: string | null };
type Skipped = { epc: string; reason: string | null; reasonText: string | null; details: TagDetails };
type AssignResult = { zone: string; assigned: number; moved: number; alreadyInZone: number; skipped: Skipped[] };

const fetcher = async (url: string) => {
  const r = await fetch(url, { credentials: "same-origin" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error ?? "Request failed");
  return j;
};

const fmt = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("en-US", {
        timeZone: "America/New_York",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "—";
const bins = (d: TagDetails) => (d.bin ? `${d.bin}${d.extraBins.length ? ` (+ ${d.extraBins.join(", ")})` : ""}` : d.extraBins.join(", ") || "—");

function downloadCsv(name: string, header: string[], rows: (string | number | null)[][]) {
  const esc = (v: string | number | null) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [header, ...rows].map((r) => r.map(esc).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

const btn =
  "inline-flex items-center gap-1.5 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-1.5 font-mono text-xs font-semibold text-[var(--wms-fg)] hover:bg-[color-mix(in_srgb,var(--wms-muted)_22%,var(--wms-surface-elevated))] disabled:opacity-40 max-md:min-h-11";
const accentBtn =
  "inline-flex items-center gap-1.5 rounded-md border border-[var(--wms-accent)]/45 bg-[color-mix(in_srgb,var(--wms-accent)_18%,var(--wms-surface-elevated))] px-3 py-1.5 font-mono text-xs font-semibold text-[var(--wms-accent)] hover:opacity-90 disabled:opacity-40 max-md:min-h-11";

export function ZonesManager() {
  const { data, error, mutate } = useSWR<{ zones: Zone[]; canManage: boolean }>("/api/assigned-zones", fetcher, {
    revalidateOnFocus: true,
    refreshInterval: 20_000,
  });
  const zones = useMemo(() => data?.zones ?? [], [data?.zones]);
  const canManage = data?.canManage ?? false;
  const [zoneParam, setZoneParam] = useUrlParam("zone");
  const selected = zones.find((z) => z.id === zoneParam) ?? zones[0] ?? null;

  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const call = async (url: string, method: string, body?: unknown) => {
    const r = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) throw new Error((j.error as string) ?? "Request failed");
    return j;
  };

  const createZone = async () => {
    if (!newName.trim() || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const j = (await call("/api/assigned-zones", "POST", { name: newName.trim() })) as { zone: { id: string } };
      setNewName("");
      await mutate();
      setZoneParam(j.zone.id);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(false);
    }
  };

  const renameZone = async (z: Zone) => {
    const name = window.prompt(`Rename zone "${z.name}" to:`, z.name);
    if (!name || name.trim() === z.name) return;
    try {
      await call(`/api/assigned-zones/${z.id}`, "PATCH", { name: name.trim() });
      await mutate();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Rename failed");
    }
  };

  const deleteZone = async (z: Zone) => {
    if (!window.confirm(`Delete zone "${z.name}"? Its ${z.count} tag${z.count === 1 ? "" : "s"} lose the zone (bins stay as they are).`)) return;
    try {
      await call(`/api/assigned-zones/${z.id}`, "DELETE");
      setZoneParam(null);
      await mutate();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Delete failed");
    }
  };

  if (error) {
    return <p className="font-mono text-sm text-red-400">Could not load zones: {String(error.message ?? error)}</p>;
  }

  return (
    <div className="grid min-w-0 gap-4 md:grid-cols-[260px_minmax(0,1fr)]">
      <aside className="min-w-0 space-y-3">
        <p className="font-mono text-xs leading-relaxed text-[var(--wms-muted)]">
          A zone is put on <strong>specific tags</strong> (scan them on the handheld, or paste / import here). Bins
          stay as they are. One zone per tag; it clears when the tag is sold, moves location or stops being LIVE.
        </p>
        {canManage ? (
          <div className="flex gap-2">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void createZone();
              }}
              placeholder="New zone, e.g. Store"
              maxLength={60}
              className="min-w-0 flex-1 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1.5 font-mono text-xs text-[var(--wms-fg)] max-md:min-h-11"
            />
            <button type="button" className={accentBtn} disabled={!newName.trim() || busy} onClick={() => void createZone()}>
              <Plus className="h-3.5 w-3.5" />
              Add
            </button>
          </div>
        ) : null}
        <ul className="divide-y divide-[var(--wms-border)]/70 rounded-md border border-[var(--wms-border)]">
          {zones.length === 0 ? (
            <li className="px-3 py-4 font-mono text-xs text-[var(--wms-muted)]">
              {data ? "No zones yet." : "Loading…"}
            </li>
          ) : (
            zones.map((z) => (
              <li
                key={z.id}
                className={`flex items-center gap-2 px-3 py-2 font-mono text-sm ${
                  selected?.id === z.id ? "bg-[color-mix(in_srgb,var(--wms-accent)_12%,transparent)]" : ""
                }`}
              >
                <button type="button" onClick={() => setZoneParam(z.id)} className="min-w-0 flex-1 truncate text-left text-[var(--wms-fg)]">
                  {z.name}
                </button>
                <span className="tabular-nums text-[var(--wms-muted)]">{z.count}</span>
                {canManage ? (
                  <>
                    <button type="button" title="Rename" onClick={() => void renameZone(z)} className="text-[var(--wms-muted)] hover:text-[var(--wms-fg)]">
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button type="button" title="Delete zone" onClick={() => void deleteZone(z)} className="text-[var(--wms-muted)] hover:text-red-400">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </>
                ) : null}
              </li>
            ))
          )}
        </ul>
        {msg ? <p className="font-mono text-xs text-amber-300">{msg}</p> : null}
      </aside>

      <section className="min-w-0">
        {selected ? <ZoneDetail key={selected.id} zone={selected} onChanged={() => void mutate()} /> : null}
      </section>
    </div>
  );
}

function ZoneDetail({ zone, onChanged }: { zone: Zone; onChanged: () => void }) {
  const { data, mutate, isLoading } = useSWR<{ rows: ZoneTag[] }>(`/api/assigned-zones/${zone.id}/epcs`, fetcher, {
    revalidateOnFocus: true,
    refreshInterval: 20_000,
  });
  const rows = useMemo(() => data?.rows ?? [], [data?.rows]);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [paste, setPaste] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<AssignResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const shown = useMemo(() => {
    const t = q.trim().toUpperCase();
    if (!t) return rows;
    return rows.filter((r) =>
      [r.epc, r.product, r.sku, r.color, r.size, r.bin, ...r.extraBins].some((v) => (v ?? "").toUpperCase().includes(t)),
    );
  }, [rows, q]);

  const assign = async (epcs: string[]) => {
    if (epcs.length === 0) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/assigned-zones/${zone.id}/assign`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ epcs }),
      });
      const j = (await r.json().catch(() => ({}))) as AssignResult & { error?: string };
      if (!r.ok) throw new Error(j.error ?? "Assign failed");
      setResult(j);
      setPaste("");
      setAdding(false);
      await mutate();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Assign failed");
    } finally {
      setBusy(false);
    }
  };

  const fromText = (text: string) =>
    [...new Set(text.split(/[\s,;]+/).map((s) => s.trim().toUpperCase()).filter((s) => /^[0-9A-F]{24}$/.test(s)))];

  const importFile = async (file: File) => {
    setBusy(true);
    setErr(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch("/api/rfid/bulk-geiger/parse", { method: "POST", body: fd });
      const j = (await r.json().catch(() => ({}))) as { epcs?: string[]; error?: string };
      if (!r.ok) throw new Error(j.error ?? "Could not read the file");
      setBusy(false);
      await assign(j.epcs ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Import failed");
      setBusy(false);
    }
  };

  const removePicked = async () => {
    const epcs = [...picked];
    if (epcs.length === 0) return;
    if (!window.confirm(`Remove ${epcs.length} tag${epcs.length === 1 ? "" : "s"} from ${zone.name}? Bins stay as they are.`)) return;
    setBusy(true);
    try {
      const r = await fetch("/api/assigned-zones/remove", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ epcs, zoneId: zone.id }),
      });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Remove failed");
      setPicked(new Set());
      await mutate();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Remove failed");
    } finally {
      setBusy(false);
    }
  };

  const allPicked = shown.length > 0 && shown.every((r) => picked.has(r.epc));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-mono text-base font-semibold text-[var(--wms-fg)]">
          {zone.name} <span className="text-[var(--wms-muted)]">· {rows.length} LIVE tag{rows.length === 1 ? "" : "s"}</span>
        </h2>
        <div className="ml-auto flex flex-wrap gap-2">
          <button type="button" className={accentBtn} onClick={() => setAdding((v) => !v)} disabled={busy}>
            <Plus className="h-3.5 w-3.5" /> Add tags
          </button>
          <button type="button" className={btn} disabled={busy} onClick={() => fileRef.current?.click()}>
            <Upload className="h-3.5 w-3.5" /> Import CSV / XLSX
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.xlsx,.xls,text/csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void importFile(f);
            }}
          />
          <button
            type="button"
            className={btn}
            disabled={rows.length === 0}
            onClick={() =>
              downloadCsv(
                `zone-${zone.name}.csv`,
                ["EPC", "Product", "Color", "Size", "SKU", "Bin", "Status", "Assigned by", "Assigned at (ET)", "Last seen (ET)", "Reader zone last heard", "Serial"],
                rows.map((r) => [r.epc, r.product, r.color, r.size, r.sku, bins(r), r.statusLabel, r.assignedBy, fmt(r.zoneAssignedAt), fmt(r.lastSeenAt), r.lastSeenReaderZone, r.serial]),
              )
            }
          >
            <Download className="h-3.5 w-3.5" /> Export CSV
          </button>
          <button type="button" className={btn} disabled={picked.size === 0 || busy} onClick={() => void removePicked()}>
            <X className="h-3.5 w-3.5" /> Remove {picked.size || ""}
          </button>
        </div>
      </div>

      {adding ? (
        <div className="space-y-2 rounded-md border border-[var(--wms-border)] p-3">
          <p className="font-mono text-xs text-[var(--wms-muted)]">
            Paste EPCs (one per line, or separated by spaces / commas). Only LIVE tags of this location are assigned;
            the rest are listed with the reason.
          </p>
          <textarea
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            rows={5}
            className="w-full rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] p-2 font-mono text-xs text-[var(--wms-fg)]"
            placeholder="F0A0B30E4F9C8440000191A0"
          />
          <button type="button" className={accentBtn} disabled={busy || fromText(paste).length === 0} onClick={() => void assign(fromText(paste))}>
            Assign {fromText(paste).length || ""} to {zone.name}
          </button>
        </div>
      ) : null}

      {err ? <p className="font-mono text-xs text-red-400">{err}</p> : null}

      {result ? (
        <div className="space-y-2 rounded-md border border-[var(--wms-border)] p-3 font-mono text-xs">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-[var(--wms-fg)]">
              {result.assigned + result.moved} assigned to {result.zone}
              {result.moved ? ` (${result.moved} moved from another zone)` : ""}
              {result.alreadyInZone ? ` · ${result.alreadyInZone} already there` : ""}
              {` · ${result.skipped.length} couldn't be assigned`}
            </span>
            {result.skipped.length ? (
              <button
                type="button"
                className={btn}
                onClick={() =>
                  downloadCsv(
                    `zone-${result.zone}-not-assigned.csv`,
                    ["EPC", "Why", "Product", "Color", "Size", "SKU", "Price", "Status", "Bin", "Location", "Current zone", "Last seen (ET)", "Reader zone last heard", "First seen (ET)", "Serial", "Source"],
                    result.skipped.map((s) => [
                      s.epc,
                      s.reasonText,
                      s.details.product,
                      s.details.color,
                      s.details.size,
                      s.details.sku,
                      s.details.retailPrice,
                      s.details.statusLabel ?? "Not in WMS",
                      bins(s.details),
                      s.details.location,
                      s.details.zone,
                      fmt(s.details.lastSeenAt),
                      s.details.lastSeenReaderZone,
                      fmt(s.details.firstSeenAt),
                      s.details.serial,
                      s.details.source,
                    ]),
                  )
                }
              >
                <Download className="h-3.5 w-3.5" /> Export not assigned
              </button>
            ) : null}
            <button type="button" className="ml-auto text-[var(--wms-muted)] hover:text-[var(--wms-fg)]" onClick={() => setResult(null)}>
              <X className="h-4 w-4" />
            </button>
          </div>
          {result.skipped.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-left">
                <thead className="uppercase text-[var(--wms-muted)]">
                  <tr>
                    <th className="px-2 py-1">EPC</th>
                    <th className="px-2 py-1">Why</th>
                    <th className="px-2 py-1">Product</th>
                    <th className="px-2 py-1">Status</th>
                    <th className="px-2 py-1">Bin</th>
                    <th className="px-2 py-1">Location / zone</th>
                    <th className="px-2 py-1">Last seen</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--wms-border)]/70">
                  {result.skipped.map((s) => (
                    <tr key={s.epc}>
                      <td className="px-2 py-1 text-teal-400/85">{s.epc}</td>
                      <td className="px-2 py-1 text-amber-300">{s.reasonText}</td>
                      <td className="px-2 py-1">
                        {[s.details.product, s.details.color, s.details.size].filter(Boolean).join(" · ") || "—"}
                        {s.details.sku ? <span className="text-[var(--wms-muted)]"> ({s.details.sku})</span> : null}
                      </td>
                      <td className="px-2 py-1">{s.details.statusLabel ?? "—"}</td>
                      <td className="px-2 py-1">{bins(s.details)}</td>
                      <td className="px-2 py-1">
                        {s.details.location ?? "—"}
                        {s.details.zone ? ` · ${s.details.zone}` : ""}
                      </td>
                      <td className="px-2 py-1 text-[var(--wms-muted)]">
                        {fmt(s.details.lastSeenAt)}
                        {s.details.lastSeenReaderZone ? ` · ${s.details.lastSeenReaderZone} reader` : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}

      <label className="flex items-center gap-2 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1.5">
        <Search className="h-4 w-4 text-[var(--wms-muted)]" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search EPC, product, SKU, bin…"
          className="min-w-0 flex-1 bg-transparent font-mono text-xs text-[var(--wms-fg)] outline-none"
        />
      </label>

      <div className="overflow-x-auto rounded-md border border-[var(--wms-border)]">
        <table className="w-full min-w-[820px] text-left font-mono text-xs">
          <thead className="bg-[var(--wms-surface-elevated)] uppercase text-[var(--wms-muted)]">
            <tr>
              <th className="w-8 px-3 py-2">
                <input
                  type="checkbox"
                  checked={allPicked}
                  onChange={() =>
                    setPicked((prev) => {
                      const next = new Set(prev);
                      for (const r of shown) {
                        if (allPicked) next.delete(r.epc);
                        else next.add(r.epc);
                      }
                      return next;
                    })
                  }
                />
              </th>
              <th className="px-3 py-2">Product</th>
              <th className="px-3 py-2">Color</th>
              <th className="px-3 py-2">Size</th>
              <th className="px-3 py-2">Bin</th>
              <th className="px-3 py-2">Assigned</th>
              <th className="px-3 py-2">Last seen</th>
              <th className="px-3 py-2">EPC</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--wms-border)]/70 text-[var(--wms-fg)]">
            {isLoading && rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-[var(--wms-muted)]">Loading…</td>
              </tr>
            ) : shown.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-[var(--wms-muted)]">
                  {rows.length === 0 ? `No tags in ${zone.name} yet — scan them on the handheld (Bin Management → Zone Management) or Add tags.` : "No match."}
                </td>
              </tr>
            ) : (
              shown.map((r) => (
                <tr key={r.epc} className="hover:bg-[var(--wms-surface-elevated)]/50">
                  <td className="px-3 py-1.5">
                    <input
                      type="checkbox"
                      checked={picked.has(r.epc)}
                      onChange={() =>
                        setPicked((prev) => {
                          const next = new Set(prev);
                          if (next.has(r.epc)) next.delete(r.epc);
                          else next.add(r.epc);
                          return next;
                        })
                      }
                    />
                  </td>
                  <td className="item-name px-3 py-1.5">{r.product ?? "—"}</td>
                  <td className="px-3 py-1.5">{r.color ?? "—"}</td>
                  <td className="px-3 py-1.5">{r.size ?? "—"}</td>
                  <td className="px-3 py-1.5">{bins(r)}</td>
                  <td className="px-3 py-1.5 text-[var(--wms-muted)]">
                    {fmt(r.zoneAssignedAt)}
                    {r.assignedBy ? ` · ${r.assignedBy}` : ""}
                  </td>
                  <td className="px-3 py-1.5 text-[var(--wms-muted)]">{fmt(r.lastSeenAt)}</td>
                  <td className="px-3 py-1.5 tabular-nums text-teal-400/85">{r.epc}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
