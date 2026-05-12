"use client";

import { useMemo, useState } from "react";
import {
  useAntennaTestStream,
  type AntennaTestRow,
} from "@/components/antenna-test/use-antenna-test-stream";
import { AlertTriangle, Play, Square, Trash2, Info } from "lucide-react";

type FormState = {
  bridgeIp: string;
  bridgePort: number;
  antennaNumber: number;
  powerDbm: number;
  readTimeMs: number;
};

const DEFAULTS: FormState = {
  bridgeIp: "",
  bridgePort: 10002,
  antennaNumber: 1,
  powerDbm: 30,
  readTimeMs: 1000,
};

export function ReaderRawTestWorkspace() {
  const [form, setForm] = useState<FormState>(DEFAULTS);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);

  const { rows, stats, status, lifecycleReason, clear } = useAntennaTestStream(
    sessionId,
    paused,
    "/api/admin/reader-raw-test/direct/stream",
  );

  async function startTest() {
    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(form.bridgeIp)) {
      setError("Enter a valid IPv4 address (private range only).");
      return;
    }
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      const r = await fetch("/api/admin/reader-raw-test/direct/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bridgeIp: form.bridgeIp,
          bridgePort: form.bridgePort,
          antennaNumber: form.antennaNumber,
          powerDbm: form.powerDbm,
          readTimeMs: form.readTimeMs,
        }),
      });
      const body = await r.json();
      if (!r.ok) {
        setError(body?.error ?? `HTTP ${r.status}`);
        return;
      }
      setSessionId(body.sessionId as string);
      setInfo(
        `Binary spawned against ${body.bridgeIp}:${body.bridgePort}. ` +
          `If no reads appear, the bridge may still be held by production — ` +
          `pause this reader in Hardware Config (prod) and retry.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start");
    } finally {
      setBusy(false);
    }
  }

  async function stopTest() {
    if (!sessionId) return;
    setBusy(true);
    try {
      await fetch("/api/admin/reader-raw-test/direct/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
    } catch (e) {
      console.warn("stop failed", e);
    } finally {
      setSessionId(null);
      setBusy(false);
    }
  }

  const sortedRows = useMemo(() => {
    const arr = Array.from(rows.values());
    arr.sort((a, b) => b.lastSeenMs - a.lastSeenMs);
    return arr;
  }, [rows]);

  const isLive = status === "live" || status === "armed";

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 font-mono text-[11px] leading-relaxed text-amber-200">
        <Info className="h-4 w-4 shrink-0" />
        <div>
          <strong className="text-amber-100">Pause the reader in production first.</strong>{" "}
          The WIZnet bridge is single-client — if prod is still talking to it,
          the binary on this dev machine cannot connect. After you Stop here,
          re-enable the reader in prod.
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)] p-3">
        <label className="flex items-center gap-2 font-mono text-[11px] text-[var(--wms-muted)]">
          <span className="uppercase tracking-wider">Bridge IP</span>
          <input
            type="text"
            placeholder="192.168.1.77"
            value={form.bridgeIp}
            onChange={(e) => setForm((f) => ({ ...f, bridgeIp: e.target.value.trim() }))}
            disabled={isLive || busy}
            className="w-32 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1.5 font-mono text-xs text-[var(--wms-fg)] disabled:opacity-50"
          />
        </label>
        <label className="flex items-center gap-2 font-mono text-[11px] text-[var(--wms-muted)]">
          <span className="uppercase tracking-wider">Port</span>
          <input
            type="number"
            min={1}
            max={65535}
            value={form.bridgePort}
            onChange={(e) => setForm((f) => ({ ...f, bridgePort: Number(e.target.value) }))}
            disabled={isLive || busy}
            className="w-20 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1.5 font-mono text-xs text-[var(--wms-fg)] disabled:opacity-50"
          />
        </label>
        <label className="flex items-center gap-2 font-mono text-[11px] text-[var(--wms-muted)]">
          <span className="uppercase tracking-wider">Ant</span>
          <input
            type="number"
            min={1}
            max={8}
            value={form.antennaNumber}
            onChange={(e) => setForm((f) => ({ ...f, antennaNumber: Number(e.target.value) }))}
            disabled={isLive || busy}
            className="w-16 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1.5 font-mono text-xs text-[var(--wms-fg)] disabled:opacity-50"
          />
        </label>
        <label className="flex items-center gap-2 font-mono text-[11px] text-[var(--wms-muted)]">
          <span className="uppercase tracking-wider">Power dBm</span>
          <input
            type="number"
            min={0}
            max={33}
            step={0.5}
            value={form.powerDbm}
            onChange={(e) => setForm((f) => ({ ...f, powerDbm: Number(e.target.value) }))}
            disabled={isLive || busy}
            className="w-20 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1.5 font-mono text-xs text-[var(--wms-fg)] disabled:opacity-50"
          />
        </label>
        <label className="flex items-center gap-2 font-mono text-[11px] text-[var(--wms-muted)]">
          <span className="uppercase tracking-wider">Read ms</span>
          <input
            type="number"
            min={250}
            max={5000}
            step={50}
            value={form.readTimeMs}
            onChange={(e) => setForm((f) => ({ ...f, readTimeMs: Number(e.target.value) }))}
            disabled={isLive || busy}
            className="w-24 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1.5 font-mono text-xs text-[var(--wms-fg)] disabled:opacity-50"
          />
        </label>
        <div className="ml-auto">
          {isLive ? (
            <button
              type="button"
              onClick={stopTest}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-1.5 font-mono text-xs uppercase tracking-wider text-red-200 hover:bg-red-500/20 disabled:opacity-50"
            >
              <Square className="h-3.5 w-3.5" /> Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={startTest}
              disabled={busy || !form.bridgeIp}
              className="inline-flex items-center gap-2 rounded-md border border-teal-500/40 bg-teal-500/10 px-3 py-1.5 font-mono text-xs uppercase tracking-wider text-teal-200 hover:bg-teal-500/20 disabled:opacity-50"
            >
              <Play className="h-3.5 w-3.5" /> Start
            </button>
          )}
        </div>
      </div>

      {error ? (
        <div className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 font-mono text-xs text-red-200">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <div>{error}</div>
        </div>
      ) : null}

      {info ? (
        <div className="flex items-start gap-2 rounded-md border border-teal-500/40 bg-teal-500/10 p-3 font-mono text-xs text-teal-200">
          <Info className="h-4 w-4 shrink-0" />
          <div>{info}</div>
        </div>
      ) : null}

      {lifecycleReason && (status === "ended" || status === "armed") ? (
        <div
          className={`flex items-start gap-2 rounded-md border p-3 font-mono text-xs ${
            status === "ended"
              ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
              : "border-zinc-500/40 bg-zinc-500/10 text-zinc-300"
          }`}
        >
          <Info className="h-4 w-4 shrink-0" />
          <div>
            <strong className="uppercase tracking-wider">
              {status === "ended" ? "Binary exited" : "Binary said"}:
            </strong>{" "}
            {lifecycleReason}
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
        <span
          className={`inline-flex items-center gap-1 rounded px-2 py-1 uppercase tracking-wider ${
            status === "live"
              ? "bg-emerald-400/15 text-emerald-300"
              : status === "armed"
                ? "bg-amber-400/15 text-amber-300"
                : status === "ended"
                  ? "bg-zinc-500/15 text-zinc-300"
                  : "bg-zinc-500/10 text-zinc-400"
          }`}
        >
          {status}
        </span>
        <span className="rounded bg-[var(--wms-surface-elevated)] px-2 py-1 text-[var(--wms-muted)]">
          unique: <strong className="text-[var(--wms-fg)]">{rows.size}</strong>
        </span>
        <span className="rounded bg-[var(--wms-surface-elevated)] px-2 py-1 text-[var(--wms-muted)]">
          reads: <strong className="text-[var(--wms-fg)]">{stats.totalReads}</strong>
        </span>
        {stats.droppedBadCrc > 0 ? (
          <span className="rounded bg-amber-500/10 px-2 py-1 text-amber-300">
            crc dropped: {stats.droppedBadCrc}
          </span>
        ) : null}
        {isLive ? (
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            className="rounded border border-[var(--wms-border)] px-2 py-1 uppercase tracking-wider text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
          >
            {paused ? "Resume table" : "Freeze table"}
          </button>
        ) : null}
        {rows.size > 0 && !isLive ? (
          <button
            type="button"
            onClick={clear}
            className="inline-flex items-center gap-1 rounded border border-[var(--wms-border)] px-2 py-1 uppercase tracking-wider text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
          >
            <Trash2 className="h-3 w-3" /> Clear
          </button>
        ) : null}
      </div>

      <div className="overflow-auto rounded-lg border border-[var(--wms-border)]">
        <table className="w-full font-mono text-[11px]">
          <thead className="bg-[var(--wms-surface)] text-[var(--wms-muted)]">
            <tr>
              <th className="px-3 py-2 text-left uppercase tracking-wider">EPC (hex)</th>
              <th className="px-3 py-2 text-right uppercase tracking-wider">Ant</th>
              <th className="px-3 py-2 text-right uppercase tracking-wider">Reads</th>
              <th className="px-3 py-2 text-right uppercase tracking-wider">RSSI now</th>
              <th className="px-3 py-2 text-right uppercase tracking-wider">RSSI best</th>
              <th className="px-3 py-2 text-right uppercase tracking-wider">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-[var(--wms-muted)]">
                  {isLive
                    ? "Waiting for the chip to emit a tag…"
                    : "Type a bridge IP, set power, click Start."}
                </td>
              </tr>
            ) : (
              sortedRows.map((r) => <RawRow key={r.epcHex} row={r} />)
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RawRow({ row }: { row: AntennaTestRow }) {
  const ageMs = Date.now() - row.lastSeenMs;
  const ageLabel = ageMs < 1000 ? "just now" : `${Math.round(ageMs / 1000)}s ago`;
  return (
    <tr className="border-t border-[var(--wms-border)] text-[var(--wms-fg)]">
      <td className="px-3 py-1.5">{row.epcHex}</td>
      <td className="px-3 py-1.5 text-right">{row.antennaNumber}</td>
      <td className="px-3 py-1.5 text-right">{row.reads}</td>
      <td className="px-3 py-1.5 text-right">{row.rssiDbm.toFixed(1)}</td>
      <td className="px-3 py-1.5 text-right">{row.bestRssiDbm.toFixed(1)}</td>
      <td className="px-3 py-1.5 text-right text-[var(--wms-muted)]">{ageLabel}</td>
    </tr>
  );
}
