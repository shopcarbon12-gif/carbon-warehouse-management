"use client";

import useSWR from "swr";
import { useMemo, useState } from "react";

type Row = {
  sku: string;
  name: string;
  expected_ls: number;
  wms_found: number;
  missing: number;
  extra: number;
};

type Summary = {
  total_expected: number;
  wms_total: number;
  missing_total: number;
  extra_total: number;
  rows: Row[];
};

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to load compare data");
  return res.json() as Promise<Summary>;
};

function rowsToCsv(rows: Row[]) {
  const h = ["SKU", "Name", "Expected_LS", "Found_WMS", "Missing", "Extra"];
  const lines = [h.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.sku,
        `"${(r.name || "").replace(/"/g, '""')}"`,
        r.expected_ls,
        r.wms_found,
        r.missing,
        r.extra,
      ].join(","),
    );
  }
  return lines.join("\n");
}

export function InventoryCompareWorkspace() {
  const { data, error, mutate } = useSWR("/api/reports/pos-compare", fetcher);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const toggle = (sku: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sku)) next.delete(sku);
      else next.add(sku);
      return next;
    });
  };

  const varianceRows = useMemo(() => (data?.rows ?? []).filter((r) => r.missing > 0 || r.extra > 0), [data]);

  const pullLs = async () => {
    await fetch("/api/integrations/lightspeed/pull", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    await mutate();
  };

  const pushLs = async () => {
    const skus = varianceRows.filter((r) => selected.has(r.sku)).map((r) => r.sku);
    await fetch("/api/integrations/lightspeed/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skus: skus.length ? skus : varianceRows.map((r) => r.sku) }),
    });
    await mutate();
  };

  const importCsv = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".csv,text/csv";
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        const text = String(r.result ?? "");
        const skus = new Set<string>();
        for (const line of text.split(/\r?\n/).slice(1)) {
          const cell = line.split(",")[0]?.trim();
          if (cell) skus.add(cell.replace(/^"|"$/g, ""));
        }
        setSelected(skus);
      };
      r.readAsText(f);
    };
    input.click();
  };

  const exportCsv = () => {
    const rows = data?.rows ?? [];
    const blob = new Blob([rowsToCsv(rows)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "inventory-compare.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (error) return <p className="font-mono text-xs text-red-500/90">{(error as Error).message}</p>;
  if (!data) return <p className="font-mono text-xs text-[var(--wms-muted)]">Loading…</p>;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ["Total expected (LS)", data.total_expected],
          ["WMS total", data.wms_total],
          ["Missing", data.missing_total],
          ["Extra", data.extra_total],
        ].map(([label, val]) => (
          <div key={String(label)} className="rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-4 py-3 dark:border-[var(--wms-border)]">
            <div className="font-mono text-[0.6rem] uppercase text-[var(--wms-muted)]">{label}</div>
            <div className="mt-1 font-mono text-xl font-semibold tabular-nums text-[var(--wms-fg)]">{val as number}</div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => void pullLs()} className="rounded-lg border border-[var(--wms-border)] px-3 py-1.5 font-mono text-xs dark:border-[var(--wms-border)]">
          Pull from LS
        </button>
        <button type="button" onClick={() => void pushLs()} className="rounded-lg border border-[var(--wms-border)] px-3 py-1.5 font-mono text-xs dark:border-[var(--wms-border)]">
          Push to LS
        </button>
        <button type="button" onClick={importCsv} className="rounded-lg border border-[var(--wms-border)] px-3 py-1.5 font-mono text-xs dark:border-[var(--wms-border)]">
          Import CSV
        </button>
        <button type="button" onClick={exportCsv} className="rounded-lg border border-[var(--wms-border)] px-3 py-1.5 font-mono text-xs dark:border-[var(--wms-border)]">
          Export CSV
        </button>
      </div>
      <p className="font-mono text-[0.65rem] text-[var(--wms-muted)]">
        Push uses variance rows only. With row checkboxes, only selected SKUs are sent in the payload; if none selected, all variance rows go.
      </p>

      <div className="overflow-x-auto rounded-xl border border-[var(--wms-border)] dark:border-[var(--wms-border)]">
        <table className="w-full min-w-[900px] text-left text-xs">
          <thead>
            <tr className="border-b border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] font-mono text-[0.55rem] uppercase text-[var(--wms-muted)]">
              <th className="w-10 px-2 py-2"> </th>
              <th className="px-2 py-2">SKU</th>
              <th className="px-2 py-2">Name</th>
              <th className="px-2 py-2 text-right tabular-nums">Expected</th>
              <th className="px-2 py-2 text-right tabular-nums">Found</th>
              <th className="px-2 py-2 text-right tabular-nums">Missing</th>
              <th className="px-2 py-2 text-right tabular-nums">Extra</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--wms-border)]/80 font-mono">
            {data.rows.map((r) => {
              const hot = r.missing > 0 || r.extra > 0;
              return (
                <tr key={r.sku} className={hot ? "bg-amber-500/5" : ""}>
                  <td className="px-2 py-1.5">
                    {hot ? (
                      <input type="checkbox" checked={selected.has(r.sku)} onChange={() => toggle(r.sku)} aria-label={`Select ${r.sku}`} />
                    ) : null}
                  </td>
                  <td className="px-2 py-1.5">{r.sku}</td>
                  <td className="max-w-[240px] truncate px-2 py-1.5 text-[var(--wms-muted)]">{r.name}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{r.expected_ls}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{r.wms_found}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-amber-600/90">{r.missing}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-teal-600/90">{r.extra}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
