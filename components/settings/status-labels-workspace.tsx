"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { Pencil } from "lucide-react";
import type { StatusLabelRow } from "@/lib/queries/status-labels";
import { STATUS_LABEL_NAME_TOOLTIPS } from "@/lib/settings/status-label-tooltips";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? res.statusText);
  }
  return res.json() as Promise<StatusLabelRow[]>;
};

function yn(v: boolean) {
  return v ? "Yes" : "No";
}

function RuleSummary({ row }: { row: StatusLabelRow }) {
  return (
    <div className="mt-4 space-y-3 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] p-4 font-mono text-xs text-[var(--wms-fg)]">
      <p className="text-[10px] font-bold uppercase tracking-widest text-[var(--wms-muted)]">
        Hard-wired rule summary (read-only)
      </p>
      <ul className="list-inside list-disc space-y-1.5 text-[var(--wms-fg)]/90">
        <li>
          <strong>Web / Shopify sellable:</strong> {yn(row.is_sellable)} — quantity sync follows this flag.
        </li>
        <li>
          <strong>Handheld / antenna:</strong>{" "}
          {row.is_visible_to_scanner
            ? "Reads are processed (beeps, counts, sessions)."
            : "Ghost mode — hardware IGNORES reads (no beep, no count)."}
        </li>
        <li>
          <strong>Search & reporting (UI):</strong> {row.is_visible_in_ui ? "Visible" : "Hidden"}.
        </li>
        <li>
          <strong>Super Admin lock:</strong>{" "}
          {row.super_admin_locked
            ? "Staff cannot change items in this status without Super Admin."
            : "Staff may change away per bulk rules."}
        </li>
        <li>
          <strong>System only:</strong>{" "}
          {row.is_system_only
            ? "Hidden from staff status pickers; Super Admin may still assign."
            : "Shown in staff pickers (where applicable)."}
        </li>
      </ul>
    </div>
  );
}

export function StatusLabelsWorkspace() {
  const { data, error, isLoading, mutate } = useSWR<StatusLabelRow[]>(
    "/api/settings/status-labels",
    fetcher,
    { revalidateOnFocus: false },
  );
  const [editRow, setEditRow] = useState<StatusLabelRow | null>(null);
  const [displayLabel, setDisplayLabel] = useState("");
  const [legacyId, setLegacyId] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [formBusy, setFormBusy] = useState(false);

  useEffect(() => {
    if (editRow) {
      setDisplayLabel(editRow.display_label ?? "");
      setLegacyId(editRow.legacy_id != null ? String(editRow.legacy_id) : "");
    }
  }, [editRow]);

  const closeModals = () => {
    setEditRow(null);
    setFormError(null);
  };

  const submitEdit = async () => {
    if (!editRow) return;
    setFormError(null);
    const t = legacyId.trim();
    let leg: number | null = null;
    if (t) {
      const n = Number.parseInt(t, 10);
      if (!Number.isFinite(n) || n < 1) {
        setFormError("System ID must be a positive integer or empty.");
        return;
      }
      leg = n;
    }
    setFormBusy(true);
    try {
      const res = await fetch("/api/settings/status-labels", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: editRow.id,
          displayLabel: displayLabel.trim(),
          legacyId: leg,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? "Save failed");
      await mutate();
      closeModals();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setFormBusy(false);
    }
  };

  const th = "px-2 py-2 text-left text-[10px] font-bold uppercase tracking-wider text-[var(--wms-muted)]";

  if (isLoading) {
    return <p className="font-mono text-sm text-[var(--wms-muted)]">Loading status brain…</p>;
  }
  if (error) {
    return <p className="font-mono text-sm text-red-400/90">{(error as Error).message}</p>;
  }
  const rows = data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <p className="font-mono text-xs text-[var(--wms-muted)]">
        Clean 10 — flags are fixed in the database seed. Edit display text and legacy system ID only.
      </p>

      <div className="overflow-x-auto rounded-lg border border-[var(--wms-border)]">
        <table className="w-full min-w-[960px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]">
              <th className={`${th} pl-3`}>Status</th>
              <th className={th} title="Integration id">
                Sys ID
              </th>
              <th className={th}>Web sellable</th>
              <th className={th}>Scanner</th>
              <th className={th}>UI visible</th>
              <th className={th}>Icons</th>
              <th className={`${th} pr-3 text-right`}>Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--wms-border)]/80">
            {rows.map((row) => {
              const tip = STATUS_LABEL_NAME_TOOLTIPS[row.name] ?? "";
              const ghost = !row.is_visible_to_scanner;
              return (
                <tr key={row.id} className="text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)]/50">
                  <td className="px-3 py-2">
                    <span className="font-medium" title={tip || undefined}>
                      {row.name}
                    </span>
                  </td>
                  <td className="px-2 py-2 font-mono text-xs tabular-nums text-[var(--wms-muted)]">
                    {row.legacy_id ?? "—"}
                  </td>
                  <td className="px-2 py-2 text-center font-mono text-xs">{yn(row.is_sellable)}</td>
                  <td className="px-2 py-2 text-center font-mono text-xs">
                    {row.is_visible_to_scanner ? "Yes" : "Ignore"}
                  </td>
                  <td className="px-2 py-2 text-center font-mono text-xs">{yn(row.is_visible_in_ui)}</td>
                  <td
                    className="px-2 py-2 text-center text-lg"
                    title={[
                      row.super_admin_locked ? "Super Admin lock" : "",
                      ghost ? "Ghost (handheld ignores)" : "",
                      row.is_system_only ? "System-only picker" : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  >
                    {row.super_admin_locked ? "👑" : ""}
                    {ghost ? "👻" : ""}
                    {row.is_system_only ? "🤖" : ""}
                    {!row.super_admin_locked && !ghost && !row.is_system_only ? "—" : ""}
                  </td>
                  <td className="px-2 py-2 text-right">
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded-md border border-[var(--wms-border)] px-2 py-1 font-mono text-xs text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)]"
                      onClick={() => setEditRow(row)}
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden />
                      View / edit label
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editRow ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal
          aria-labelledby="status-edit-title"
        >
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)] p-6 shadow-xl">
            <h2 id="status-edit-title" className="text-lg font-semibold text-[var(--wms-fg)]">
              {editRow.name}
            </h2>
            <p className="mt-1 font-mono text-xs text-[var(--wms-muted)]" title={STATUS_LABEL_NAME_TOOLTIPS[editRow.name]}>
              {STATUS_LABEL_NAME_TOOLTIPS[editRow.name] ?? "No tooltip."}
            </p>

            <RuleSummary row={editRow} />

            <div className="mt-6 space-y-3">
              <label className="flex flex-col gap-1 font-mono text-xs text-[var(--wms-muted)]">
                Display label (optional UI string)
                <input
                  className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-background)] px-3 py-2 text-sm text-[var(--wms-fg)]"
                  value={displayLabel}
                  onChange={(e) => setDisplayLabel(e.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1 font-mono text-xs text-[var(--wms-muted)]">
                Legacy system ID
                <input
                  className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-background)] px-3 py-2 text-sm text-[var(--wms-fg)]"
                  value={legacyId}
                  onChange={(e) => setLegacyId(e.target.value)}
                  placeholder="empty = none"
                />
              </label>
            </div>

            {formError ? <p className="mt-3 font-mono text-sm text-red-400/90">{formError}</p> : null}

            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-md border border-[var(--wms-border)] px-4 py-2 font-mono text-sm"
                onClick={closeModals}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={formBusy}
                className="rounded-md bg-emerald-600 px-4 py-2 font-mono text-sm font-semibold text-white disabled:opacity-50"
                onClick={() => void submitEdit()}
              >
                {formBusy ? "Saving…" : "Save presentation"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
