"use client";

import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import type { BatchItemSummary, BatchOverview } from "@/lib/server/studio-batch";

type Report = { items: BatchItemSummary[]; overview: BatchOverview };
const fetcher = async (url: string): Promise<Report> => {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(response.status === 403 ? "Studio batches require administrator access." : "Could not load batch status. Please refresh.");
  return response.json();
};
const date = (value: string | null) => value ? new Date(value).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " ET" : "—";
const statusLabel = (item: BatchItemSummary) => {
  if (item.status === "submitted") {
    if (item.batchStatus === "completed") return "Saving results";
    return (item.batchStatus ?? "submitted").replaceAll("_", " ");
  }
  return item.status.replaceAll("_", " ");
};

export function StudioBatchesReportWorkspace() {
  const { data, error, isLoading, isValidating, mutate } = useSWR("/api/studio/batch", fetcher, { refreshInterval: 15000, revalidateOnFocus: true });
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState("");
  const [checkError, setCheckError] = useState("");
  const items = data?.items ?? [];
  const rows = items.filter((item) => {
    const matches = `${item.productName ?? ""} ${item.itemColour ?? ""} ${item.modelName ?? ""} ${item.runTag}`.toLowerCase().includes(search.trim().toLowerCase());
    const matchesStatus = status === "all" || (status === "active" ? ["queued", "preparing", "submitted"].includes(item.status) : status === "issues" ? Boolean(item.error || item.failed.length || item.status === "failed") : ["ready", "loaded"].includes(item.status));
    return matches && matchesStatus;
  });
  async function checkNow() {
    setChecking(true);
    setNotice("");
    setCheckError("");
    try {
      const response = await fetch("/api/studio/batch/poll", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not check batches.");
      setNotice("Checking with OpenAI. Status refreshes automatically every 15 seconds.");
      await mutate();
    } catch (e) {
      setCheckError(e instanceof Error ? e.message : "Could not check batches.");
    } finally {
      setChecking(false);
    }
  }
  const buttonClass = "rounded-lg border border-[var(--wms-border)] px-3 py-2 text-sm disabled:opacity-50";
  return (
    <div className="flex flex-col gap-4 text-[var(--wms-fg)]">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={buttonClass} disabled={checking || !data} onClick={checkNow}>{checking ? "Checking…" : "Check now"}</button>
        <button type="button" className={buttonClass} disabled={isValidating} onClick={() => void mutate()}>Refresh</button>
        <span className="text-xs text-[var(--wms-muted)]">Auto-refresh: every 15 seconds · Batch completion can take up to 24 hours</span>
      </div>
      {notice ? <p role="status" className="text-sm">{notice}</p> : null}
      {error || checkError ? <p role="alert" className="text-sm text-red-500">{checkError || error.message}</p> : null}
      {data ? <div className="flex flex-wrap gap-4 rounded-lg border border-[var(--wms-border)] p-4 text-sm">
        <span><strong>{data.overview.queuedRuns}</strong> queued runs / {data.overview.queuedPanels} panels</span>
        <span><strong>{data.overview.open.length}</strong> active batches / {data.overview.open.reduce((n, batch) => n + batch.requestCount, 0)} panels</span>
        <span>Latest {items.length} runs: <strong>{items.reduce((n, item) => n + item.ready.length, 0)}</strong> panels ready · <strong>{items.reduce((n, item) => n + item.failed.length, 0)}</strong> panels failed</span>
      </div> : null}
      <div className="flex flex-wrap gap-3">
        <input aria-label="Search batch runs" placeholder="Search product, colour, model or run…" value={search} onChange={(event) => setSearch(event.target.value)} className="min-w-64 flex-1 rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)] px-3 py-2 text-sm" />
        <select aria-label="Filter batch status" value={status} onChange={(event) => setStatus(event.target.value)} className="rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)] px-3 py-2 text-sm">
          <option value="all">All statuses</option><option value="active">Active</option><option value="ready">Ready / loaded</option><option value="issues">With issues</option>
        </select>
      </div>
      {isLoading ? <p role="status">Loading batches…</p> : null}
      {data ? <>
        <p className="text-xs text-[var(--wms-muted)]">Showing {rows.length} of the latest {items.length} runs. Open Studio to review or load finished images. All times Eastern.</p>
        <div className="overflow-x-auto rounded-lg border border-[var(--wms-border)]">
          <table className="w-full text-left text-sm">
            <thead className="bg-[var(--wms-surface-elevated)]"><tr>{["Product / run", "Colour / model", "Status", "Panels", "Queued / submitted", "Results"].map((label) => <th key={label} className="px-4 py-3">{label}</th>)}</tr></thead>
            <tbody>{rows.map((item) => <tr key={item.id} className="border-t border-[var(--wms-border)] align-top">
              <td className="px-4 py-3"><Link href={`/inventory/catalog?matrix=${encodeURIComponent(item.matrixId)}`} className="font-medium text-[var(--wms-accent)] underline">{item.productName || "Open product"}</Link><div className="mt-1 font-mono text-xs text-[var(--wms-muted)]">{item.runTag}</div></td>
              <td className="px-4 py-3">{item.itemColour || "—"}<div className="text-xs text-[var(--wms-muted)]">{item.modelName || "—"}</div></td>
              <td className="px-4 py-3"><span className="capitalize">{statusLabel(item)}</span>{item.error ? <p className="mt-1 max-w-xs text-xs text-red-500">{item.error}</p> : null}</td>
              <td className="px-4 py-3"><div>{item.ready.length}/{item.panels.length} ready</div><div className="text-xs text-[var(--wms-muted)]">Requested: {item.panels.join(", ")}</div>{item.ready.length ? <div className="text-xs">Ready: {item.ready.join(", ")}</div> : null}{item.failed.map((failure) => <p key={failure.panel} className="mt-1 max-w-xs text-xs text-red-500">Panel {failure.panel}: {failure.error}</p>)}</td>
              <td className="whitespace-nowrap px-4 py-3 text-xs">{date(item.addedAt)}<div className="mt-1 text-[var(--wms-muted)]">Sent: {date(item.submittedAt)}</div></td>
              <td className="max-w-sm px-4 py-3">{item.folder ? <><a href={`https://www.dropbox.com/home${item.folder.split("/").map(encodeURIComponent).join("/")}`} target="_blank" rel="noreferrer" className="text-[var(--wms-accent)] underline">Open Dropbox folder</a><p className="mt-1 break-all text-xs text-[var(--wms-muted)]">{item.folder}</p></> : <span className="text-[var(--wms-muted)]">{item.status === "cancelled" ? "Cancelled" : "No saved images yet"}</span>}</td>
            </tr>)}</tbody>
          </table>
          {!rows.length ? <p className="p-6 text-sm text-[var(--wms-muted)]">No batch runs match this view.</p> : null}
        </div>
      </> : null}
    </div>
  );
}
