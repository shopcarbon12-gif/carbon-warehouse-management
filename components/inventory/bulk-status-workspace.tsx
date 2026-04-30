"use client";

import { useEffect, useRef, useState } from "react";
import { Radio, ScanLine } from "lucide-react";

import { bulkStatusOptionsForUi } from "@/lib/inventory/bulk-wms-status-options";
import { ReaderPicker } from "@/components/shared/reader-picker";

export function BulkStatusWorkspace({ isSuperAdmin }: { isSuperAdmin: boolean }) {
  const [raw, setRaw] = useState("");
  const options = bulkStatusOptionsForUi(isSuperAdmin);
  const [target, setTarget] = useState<string>(options[0]?.value ?? "in-stock");
  const [override, setOverride] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Scan controls — same pattern as transfer-out / cycle-counts. Scanned EPCs
  // append into the textarea so the existing bulk-status apply path keeps working.
  const [scanning, setScanning] = useState(false);
  const scanningRef = useRef(scanning);
  useEffect(() => {
    scanningRef.current = scanning;
  }, [scanning]);
  const [selectedReaders, setSelectedReaders] = useState<Set<string>>(() => new Set());
  const selectedReadersRef = useRef(selectedReaders);
  useEffect(() => {
    selectedReadersRef.current = selectedReaders;
  }, [selectedReaders]);

  useEffect(() => {
    const es = new EventSource("/api/edge/stream");
    es.onmessage = (ev) => {
      if (!scanningRef.current) return;
      if (!ev.data?.trim() || ev.data.startsWith(":")) return;
      let p: { epcs?: string[]; deviceId?: string };
      try {
        p = JSON.parse(ev.data) as { epcs?: string[]; deviceId?: string };
      } catch {
        return;
      }
      const sel = selectedReadersRef.current;
      if (sel.size > 0 && p.deviceId && !sel.has(p.deviceId)) return;
      const list = (p.epcs ?? [])
        .map((e) => e.replace(/\s/g, "").toUpperCase())
        .filter((e) => /^[0-9A-F]{24}$/.test(e));
      if (list.length === 0) return;
      setRaw((cur) => {
        const present = new Set(
          cur
            .split(/[\s,;\n]+/)
            .map((s) => s.trim().toUpperCase())
            .filter(Boolean),
        );
        const fresh = list.filter((e) => !present.has(e));
        if (fresh.length === 0) return cur;
        return cur.length === 0 ? fresh.join("\n") : `${cur}\n${fresh.join("\n")}`;
      });
    };
    return () => es.close();
  }, []);

  const run = async () => {
    const epcs = raw
      .split(/[\s,;\n]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    if (!epcs.length) {
      setMsg("Paste, scan, or upload EPCs (one per line or separated by spaces).");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/inventory/bulk-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ epcs, targetStatus: target, override }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
        updated?: number;
        code?: string;
      };
      if (!res.ok) throw new Error(j.error ?? "Request failed");
      setMsg(`Updated ${j.updated ?? 0} EPC(s) at the active location.`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <p className="font-mono text-xs text-[var(--wms-muted)]">
        {!isSuperAdmin
          ? "System workflow targets (in transit, pending visibility, pending transaction) are hidden — Super Admin only. Items in Super Admin–locked statuses cannot be changed here."
          : "Super Admin: all Clean 10 targets are available; use Override for risky transitions."}
      </p>
      <label className="flex flex-col gap-2 font-mono text-xs text-[var(--wms-muted)]">
        Target status
        <select
          className="rounded-md border border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-muted)_10%,var(--wms-surface-elevated))] px-3 py-2 font-mono text-sm text-[var(--wms-fg)]"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 font-mono text-xs text-[var(--wms-muted)]">
        <input
          type="checkbox"
          checked={override}
          onChange={(e) => setOverride(e.target.checked)}
          disabled={!isSuperAdmin}
        />
        Allow risky transitions (Super Admin only)
      </label>
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80 p-3">
        <button
          type="button"
          onClick={() => setScanning((s) => !s)}
          className={`inline-flex min-h-[3rem] min-w-[10rem] items-center justify-center gap-2 rounded-xl border px-5 py-3 font-mono text-sm font-semibold uppercase tracking-wide transition-colors ${
            scanning
              ? "border-amber-500/60 bg-amber-950/40 text-amber-100"
              : "border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] text-[var(--wms-fg)] hover:border-teal-500/40"
          }`}
        >
          <Radio
            className={`h-5 w-5 ${
              scanning ? "text-amber-400" : "text-[var(--wms-muted)]"
            }`}
          />
          {scanning ? "Scanning… (click to pause)" : "Start scan"}
        </button>
        <ReaderPicker selected={selectedReaders} onChange={setSelectedReaders} />
        <button
          type="button"
          disabled={raw.length === 0}
          onClick={() => {
            setRaw("");
            setScanning(false);
          }}
          className="inline-flex items-center gap-2 rounded-lg border border-[var(--wms-border)] px-4 py-2.5 font-mono text-xs text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)] disabled:opacity-40"
        >
          <ScanLine className="h-4 w-4" />
          Clear staged
        </button>
      </div>
      <textarea
        className="min-h-[180px] rounded-md border border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-muted)_8%,var(--wms-surface))] p-3 font-mono text-sm text-[var(--wms-fg)]"
        placeholder="EPCs… (paste here, or scan via Start scan)"
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => void run()}
        className="rounded-md border border-[var(--wms-accent)]/50 bg-[var(--wms-accent)] px-4 py-2 font-mono text-sm font-semibold text-[var(--wms-accent-fg)] shadow-sm hover:opacity-90 disabled:opacity-50"
      >
        {busy ? "Working…" : "Apply bulk status"}
      </button>
      {msg ? <p className="font-mono text-sm text-[var(--wms-fg)]">{msg}</p> : null}
    </div>
  );
}
