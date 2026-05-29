"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { Upload, Radio, Loader2 } from "lucide-react";

/**
 * Bulk Geiger — upload a CSV/XLSX EPC list, auto-resolve each EPC to its
 * catalog item (custom SKU + name/color/size), then "Send to handheld" to push
 * the selected EPCs to a handheld's Cloud + Geiger screen (device EPC queue).
 * EPCs that don't resolve stay in the table with N/A.
 */

const LOOKUP_CHUNK = 200;

type Row = {
  epc: string;
  sku: string | null;
  name: string | null;
  color: string | null;
  size: string | null;
  resolved: boolean;
};

type Handheld = {
  id: string;
  name: string;
  location_code: string | null;
  location_name: string | null;
};

const fetcher = async (url: string) => {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error("fetch failed");
  return r.json();
};

export function BulkGeigerWorkspace() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<"upload" | "send" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const { data: handhelds } = useSWR<Handheld[]>(
    "/api/infrastructure/devices/handhelds",
    fetcher,
    { revalidateOnFocus: false },
  );
  const [deviceId, setDeviceId] = useState<string>("");

  const onFile = useCallback(async (file: File) => {
    setBusy("upload");
    setErr(null);
    setMsg(null);
    setRows([]);
    setChecked(new Set());
    try {
      // 1) parse EPCs from the file (server: CSV + XLSX)
      const fd = new FormData();
      fd.append("file", file);
      const pres = await fetch("/api/rfid/bulk-geiger/parse", { method: "POST", body: fd });
      const pj = (await pres.json().catch(() => ({}))) as { epcs?: string[]; error?: string };
      if (!pres.ok) throw new Error(pj.error ?? "Parse failed");
      const epcs = pj.epcs ?? [];
      if (epcs.length === 0) {
        setErr("No EPCs found in the file.");
        return;
      }

      // 2) seed rows (all start unresolved → N/A), then enrich via lookup
      const base = new Map<string, Row>();
      for (const e of epcs) {
        base.set(e, { epc: e, sku: null, name: null, color: null, size: null, resolved: false });
      }
      for (let i = 0; i < epcs.length; i += LOOKUP_CHUNK) {
        const chunk = epcs.slice(i, i + LOOKUP_CHUNK);
        try {
          const lres = await fetch("/api/operations/transfers/lookup", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ epcs: chunk }),
          });
          if (!lres.ok) continue;
          const lj = (await lres.json()) as {
            rows?: { epc: string; sku: string | null; name: string | null; color: string | null; size: string | null }[];
          };
          for (const r of lj.rows ?? []) {
            const key = r.epc.toUpperCase();
            const cur = base.get(key);
            if (cur) {
              cur.sku = r.sku ?? null;
              cur.name = r.name ?? null;
              cur.color = r.color ?? null;
              cur.size = r.size ?? null;
              cur.resolved = true;
            }
          }
        } catch {
          /* leave chunk unresolved → N/A */
        }
      }
      const built = epcs.map((e) => base.get(e)!);
      setRows(built);
      // default: select everything
      setChecked(new Set(built.map((r) => r.epc)));
      const resolved = built.filter((r) => r.resolved).length;
      setMsg(`Loaded ${built.length} EPC(s) — ${resolved} resolved, ${built.length - resolved} N/A.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(null);
    }
  }, []);

  const allChecked = rows.length > 0 && checked.size === rows.length;
  const toggleAll = () => setChecked(allChecked ? new Set() : new Set(rows.map((r) => r.epc)));
  const toggleOne = (epc: string) =>
    setChecked((prev) => {
      const n = new Set(prev);
      if (n.has(epc)) n.delete(epc);
      else n.add(epc);
      return n;
    });

  const selectedEpcs = useMemo(() => rows.filter((r) => checked.has(r.epc)).map((r) => r.epc), [rows, checked]);

  const sendToHandheld = useCallback(async () => {
    if (!deviceId) {
      setErr("Pick a handheld first.");
      return;
    }
    if (selectedEpcs.length === 0) {
      setErr("Select at least one row.");
      return;
    }
    setBusy("send");
    setErr(null);
    setMsg(null);
    try {
      const res = await fetch(`/api/devices/${deviceId}/epc-queue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ epcs: selectedEpcs }),
      });
      const j = (await res.json().catch(() => ({}))) as { enqueued?: number; error?: string };
      if (!res.ok) throw new Error(j.error ?? "Send failed");
      const dev = handhelds?.find((h) => h.id === deviceId);
      setMsg(
        `Sent ${j.enqueued ?? selectedEpcs.length} EPC(s) to ${dev?.name ?? "handheld"} — open Cloud + Geiger on the device.`,
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Send failed");
    } finally {
      setBusy(null);
    }
  }, [deviceId, selectedEpcs, handhelds]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)] p-3">
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onFile(f);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => fileRef.current?.click()}
          className="inline-flex items-center gap-2 rounded-md border border-[var(--wms-accent)]/50 bg-[var(--wms-accent)]/15 px-4 py-2 font-mono text-sm font-semibold text-[var(--wms-fg)] hover:bg-[var(--wms-accent)]/25 disabled:opacity-50"
        >
          {busy === "upload" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          Import CSV / XLSX
        </button>

        <div className="mx-2 h-6 w-px bg-[var(--wms-border)]" />

        <select
          value={deviceId}
          onChange={(e) => setDeviceId(e.target.value)}
          className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 font-mono text-xs text-[var(--wms-fg)]"
        >
          <option value="">— Select handheld —</option>
          {(handhelds ?? []).map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
              {h.location_code ? ` · ${h.location_code}` : ""}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={busy !== null || selectedEpcs.length === 0 || !deviceId}
          onClick={() => void sendToHandheld()}
          className="inline-flex items-center gap-2 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-4 py-2 font-mono text-sm font-semibold text-[var(--wms-fg)] hover:bg-[var(--wms-surface)] disabled:opacity-50"
        >
          {busy === "send" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Radio className="h-4 w-4" />}
          Send to handheld ({selectedEpcs.length})
        </button>
      </div>

      {err ? (
        <div className="rounded-md border border-red-400/40 bg-red-400/10 px-3 py-2 font-mono text-xs text-red-300">{err}</div>
      ) : null}
      {msg ? (
        <div className="rounded-md border border-emerald-400/40 bg-emerald-400/10 px-3 py-2 font-mono text-xs text-emerald-300">{msg}</div>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-[var(--wms-border)]">
        <table className="w-full min-w-[680px] border-collapse font-mono text-xs">
          <thead className="bg-[var(--wms-surface-elevated)]/80 text-[0.6rem] uppercase tracking-wide text-[var(--wms-muted)]">
            <tr>
              <th className="w-10 px-3 py-2 text-left">
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={allChecked}
                  disabled={rows.length === 0}
                  onChange={toggleAll}
                  className="h-4 w-4 accent-[var(--wms-accent)]"
                />
              </th>
              <th className="px-3 py-2 text-left">EPC</th>
              <th className="px-3 py-2 text-left">Custom SKU</th>
              <th className="px-3 py-2 text-left">Item Description</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--wms-border)]/50">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-3 py-10 text-center text-[var(--wms-muted)]">
                  Import a CSV / XLSX of EPCs to begin.
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const desc = r.resolved
                  ? [r.name, r.color, r.size].filter((v) => v && v.trim()).join(" · ") || "—"
                  : "N/A";
                return (
                  <tr key={r.epc} className={`text-[var(--wms-fg)] ${!r.resolved ? "bg-amber-500/5" : ""}`}>
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label={`Select ${r.epc}`}
                        checked={checked.has(r.epc)}
                        onChange={() => toggleOne(r.epc)}
                        className="h-4 w-4 accent-[var(--wms-accent)]"
                      />
                    </td>
                    <td className="px-3 py-2 font-semibold text-teal-400/90">{r.epc}</td>
                    <td className="px-3 py-2">{r.resolved ? r.sku ?? "N/A" : "N/A"}</td>
                    <td className={`px-3 py-2 ${r.resolved ? "text-[var(--wms-fg)]" : "text-amber-300/80"}`}>{desc}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {rows.length > 0 ? (
        <p className="font-mono text-[0.65rem] text-[var(--wms-muted)]">
          {rows.length} row(s) · {selectedEpcs.length} selected · N/A rows are EPCs not found in this location&apos;s catalog.
        </p>
      ) : null}
    </div>
  );
}
