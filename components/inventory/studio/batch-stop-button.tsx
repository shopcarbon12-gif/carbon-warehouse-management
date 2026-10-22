"use client";

import { useState } from "react";
import type { BatchItemSummary, StopItemResult } from "@/lib/server/studio-batch";

/**
 * "■ Stop generating" for a product's night-batch runs (owner, 2026-10-22).
 *
 * Give it the product's batch runs (the Studio's `batchItems`, from
 * GET /api/studio/batch?matrixId=…). It shows while any of them is queued,
 * being sent, or with OpenAI; asks in-page; then calls
 * POST /api/studio/batch/<id>/stop for each and says plainly what happened
 * (removed for free, left out of the send, OpenAI batch cancelled, or — when
 * other products share the OpenAI batch — pictures thrown away but billed).
 */

const LIVE = new Set(["queued", "preparing", "submitted"]);

type Run = Pick<BatchItemSummary, "id" | "status"> & Partial<Pick<BatchItemSummary, "modelName" | "itemColour">>;

const btnStop =
  "rounded-md border border-[var(--wms-status-danger-fg)]/70 bg-[var(--wms-status-danger-fg)]/10 px-3 py-1.5 font-mono text-[0.78rem] uppercase tracking-wide text-[var(--wms-status-danger-fg)] hover:bg-[var(--wms-status-danger-fg)]/20 disabled:opacity-50 max-md:min-h-11";
const btnPlain =
  "rounded-md border border-[var(--wms-border)] px-3 py-1.5 font-mono text-[0.78rem] uppercase tracking-wide text-[var(--wms-fg)] disabled:opacity-50 max-md:min-h-11";

export function BatchStopButton({
  items,
  onStopped,
  disabled = false,
  className = "",
}: {
  /** This product's batch runs; only the queued / being-sent / with-OpenAI ones are stopped. */
  items: Run[];
  /** Called after the stop, so the parent reloads its batch list. */
  onStopped?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const live = items.filter((b) => LIVE.has(b.status));
  const [confirming, setConfirming] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [result, setResult] = useState<{ lines: string[]; error: boolean } | null>(null);

  if (!live.length && !result) return null;

  const queued = live.filter((b) => b.status === "queued").length;
  const sent = live.length - queued;

  const stop = async () => {
    setConfirming(false);
    setStopping(true);
    const lines: string[] = [];
    let error = false;
    for (const b of live) {
      const who = [b.modelName, b.itemColour].filter(Boolean).join(" · ");
      try {
        const r = await fetch(`/api/studio/batch/${encodeURIComponent(b.id)}/stop`, { method: "POST" });
        const j = (await r.json().catch(() => ({}))) as { item?: StopItemResult; error?: string };
        if (!r.ok || !j.item) throw new Error(j.error || `HTTP ${r.status}`);
        lines.push(`${who ? `${who}: ` : ""}${j.item.message}`);
      } catch (e) {
        error = true;
        lines.push(`${who ? `${who}: ` : ""}could not be stopped (${e instanceof Error ? e.message : "error"}).`);
      }
    }
    setResult({ lines, error });
    setStopping(false);
    onStopped?.();
  };

  return (
    <span className={`flex flex-wrap items-center gap-2 ${className}`}>
      {live.length ? (
        confirming ? (
          <span className="flex flex-wrap items-center gap-2 font-mono text-[0.72rem] text-[var(--wms-fg)]">
            <span>
              Stop {live.length} run{live.length === 1 ? "" : "s"}?
              {queued ? ` ${queued} not sent yet — free to stop.` : ""}
              {sent ? ` ${sent} already with OpenAI — panels it has finished are still billed.` : ""}
            </span>
            <button type="button" disabled={stopping} onClick={() => void stop()} className={btnStop}>
              Yes, stop
            </button>
            <button type="button" disabled={stopping} onClick={() => setConfirming(false)} className={btnPlain}>
              No
            </button>
          </span>
        ) : (
          <button
            type="button"
            disabled={disabled || stopping}
            onClick={() => {
              setResult(null);
              setConfirming(true);
            }}
            title="Stop this product's night-batch run — takes it out of the queue, or tells OpenAI to stop generating"
            className={btnStop}
          >
            {stopping ? "Stopping…" : "■ Stop generating"}
          </button>
        )
      ) : null}
      {result ? (
        <span
          role="status"
          className={`flex flex-col font-mono text-[0.72rem] ${result.error ? "text-[var(--wms-status-danger-fg)]" : "text-[var(--wms-muted)]"}`}
        >
          {result.lines.map((l, i) => (
            <span key={i}>{l}</span>
          ))}
        </span>
      ) : null}
    </span>
  );
}
