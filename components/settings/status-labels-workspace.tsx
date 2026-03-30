"use client";

import { useEffect, useState, type ReactNode } from "react";
import useSWR from "swr";
import { Pencil } from "lucide-react";
import type { StatusLabelRow } from "@/lib/queries/status-labels";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? res.statusText);
  }
  return res.json() as Promise<StatusLabelRow[]>;
};

function Hint({ text }: { text: string }) {
  return (
    <span
      className="ml-1 inline-flex h-4 w-4 shrink-0 cursor-help items-center justify-center rounded-full bg-blue-600 text-[0.55rem] font-bold leading-none text-white dark:bg-blue-600"
      title={text}
    >
      i
    </span>
  );
}

function FlagCell({ on }: { on: boolean }) {
  return (
    <span
      className={`font-mono text-xs tabular-nums ${on ? "text-emerald-500/95" : "text-[var(--wms-muted)]"}`}
      aria-label={on ? "Yes" : "No"}
    >
      {on ? "✓" : "—"}
    </span>
  );
}

type FormState = {
  name: string;
  legacyId: string;
  displayLabel: string;
  includeInInventory: boolean;
  hideInSearchFilters: boolean;
  hideInItemDetails: boolean;
  displayInGroupPage: boolean;
  autoDisplayIfTagsPresent: boolean;
  allowInstantStolenApi: boolean;
  preventLiveOnTransferReceive: boolean;
  preventChangeDuringAuditRequest: boolean;
  preventLiveAfterInventoryUploadScript: boolean;
};

function emptyForm(): FormState {
  return {
    name: "",
    legacyId: "",
    displayLabel: "",
    includeInInventory: false,
    hideInSearchFilters: false,
    hideInItemDetails: false,
    displayInGroupPage: false,
    autoDisplayIfTagsPresent: false,
    allowInstantStolenApi: false,
    preventLiveOnTransferReceive: false,
    preventChangeDuringAuditRequest: false,
    preventLiveAfterInventoryUploadScript: false,
  };
}

function rowToForm(row: StatusLabelRow): FormState {
  return {
    name: row.name,
    legacyId: row.legacy_id != null ? String(row.legacy_id) : "",
    displayLabel: row.display_label ?? "",
    includeInInventory: row.include_in_inventory,
    hideInSearchFilters: row.hide_in_search_filters,
    hideInItemDetails: row.hide_in_item_details,
    displayInGroupPage: row.display_in_group_page,
    autoDisplayIfTagsPresent: row.auto_display_if_tags_present,
    allowInstantStolenApi: row.allow_instant_stolen_api,
    preventLiveOnTransferReceive: row.prevent_live_on_transfer_receive,
    preventChangeDuringAuditRequest: row.prevent_change_during_audit_request,
    preventLiveAfterInventoryUploadScript: row.prevent_live_after_inventory_upload_script,
  };
}

function buildPayload(form: FormState, legacy: number | null) {
  return {
    name: form.name.trim(),
    legacyId: legacy,
    displayLabel: form.displayLabel.trim(),
    includeInInventory: form.includeInInventory,
    hideInSearchFilters: form.hideInSearchFilters,
    hideInItemDetails: form.hideInItemDetails,
    displayInGroupPage: form.displayInGroupPage,
    autoDisplayIfTagsPresent: form.autoDisplayIfTagsPresent,
    allowInstantStolenApi: form.allowInstantStolenApi,
    preventLiveOnTransferReceive: form.preventLiveOnTransferReceive,
    preventChangeDuringAuditRequest: form.preventChangeDuringAuditRequest,
    preventLiveAfterInventoryUploadScript: form.preventLiveAfterInventoryUploadScript,
  };
}

export function StatusLabelsWorkspace() {
  const { data, error, isLoading, mutate } = useSWR<StatusLabelRow[]>(
    "/api/settings/status-labels",
    fetcher,
    { revalidateOnFocus: false },
  );
  const [addOpen, setAddOpen] = useState(false);
  const [editRow, setEditRow] = useState<StatusLabelRow | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [formBusy, setFormBusy] = useState(false);

  const parseLegacyPayload = (): { ok: true; value: number | null } | { ok: false } => {
    const t = form.legacyId.trim();
    if (!t) return { ok: true, value: null };
    const n = Number.parseInt(t, 10);
    if (!Number.isFinite(n) || n < 1) return { ok: false };
    return { ok: true, value: n };
  };

  const openAdd = () => {
    setForm(emptyForm());
    setFormError(null);
    setAddOpen(true);
  };

  const openEdit = (row: StatusLabelRow) => {
    setForm(rowToForm(row));
    setFormError(null);
    setEditRow(row);
  };

  const closeModals = () => {
    setAddOpen(false);
    setEditRow(null);
    setFormError(null);
  };

  const submitCreate = async () => {
    setFormError(null);
    if (!form.name.trim()) {
      setFormError("Name is required.");
      return;
    }
    const legP = parseLegacyPayload();
    if (!legP.ok) {
      setFormError("System ID must be a positive integer or empty.");
      return;
    }
    setFormBusy(true);
    try {
      const res = await fetch("/api/settings/status-labels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload(form, legP.value)),
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

  const submitEdit = async () => {
    if (!editRow) return;
    setFormError(null);
    if (!form.name.trim()) {
      setFormError("Name is required.");
      return;
    }
    const legP = parseLegacyPayload();
    if (!legP.ok) {
      setFormError("System ID must be a positive integer or empty.");
      return;
    }
    setFormBusy(true);
    try {
      const res = await fetch("/api/settings/status-labels", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: editRow.id, ...buildPayload(form, legP.value) }),
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

  const deleteRow = async () => {
    if (!editRow) return;
    if (
      !window.confirm(
        `Delete status “${editRow.name}”? This cannot be undone.`,
      )
    ) {
      return;
    }
    try {
      const res = await fetch(
        `/api/settings/status-labels?id=${encodeURIComponent(String(editRow.id))}`,
        { method: "DELETE" },
      );
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? "Delete failed");
      await mutate();
      closeModals();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Delete failed");
    }
  };

  useEffect(() => {
    if (!addOpen && !editRow) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeModals();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [addOpen, editRow]);

  const modalTitle =
    editRow != null
      ? `Manage Status Label: System ID ${editRow.legacy_id ?? "—"}`
      : "Add status label";

  const chk = (key: keyof FormState, label: ReactNode) => (
    <label className="flex cursor-pointer items-start gap-2.5 font-mono text-xs text-[var(--wms-fg)]">
      <input
        type="checkbox"
        checked={Boolean(form[key])}
        onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.checked }))}
        className="mt-0.5 rounded border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] text-[var(--wms-accent)]"
      />
      <span>{label}</span>
    </label>
  );

  const formModal = (onSubmit: () => void) => (
    <>
      <button
        type="button"
        aria-label="Close"
        className="fixed inset-0 z-[60] bg-black/70 dark:bg-black/75"
        onClick={closeModals}
      />
      <div className="fixed inset-0 z-[70] flex items-center justify-center overflow-y-auto p-4">
        <div
          className="my-4 w-full max-w-lg rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] shadow-2xl dark:border-[var(--wms-border)]"
          role="dialog"
          aria-labelledby="status-label-dialog-title"
        >
          <div className="border-b border-[var(--wms-border)] px-4 py-3 dark:border-[var(--wms-border)]">
            <h2
              id="status-label-dialog-title"
              className="text-sm font-semibold tracking-tight text-[var(--wms-fg)]"
            >
              {modalTitle}
            </h2>
          </div>
          <div className="max-h-[min(70vh,560px)] space-y-3 overflow-y-auto p-4">
            <label className="block font-mono text-[0.65rem] uppercase tracking-wider text-[var(--wms-muted)]">
              Name
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-sm text-[var(--wms-fg)] dark:border-[var(--wms-border)]"
                autoComplete="off"
              />
            </label>
            <label className="block font-mono text-[0.65rem] uppercase tracking-wider text-[var(--wms-muted)]">
              Label
              <input
                type="text"
                value={form.displayLabel}
                onChange={(e) => setForm((f) => ({ ...f, displayLabel: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-sm text-[var(--wms-fg)] dark:border-[var(--wms-border)]"
                placeholder="Optional display label"
                autoComplete="off"
              />
            </label>
            {!editRow ? (
              <label className="block font-mono text-[0.65rem] uppercase tracking-wider text-[var(--wms-muted)]">
                System ID (optional)
                <input
                  type="text"
                  inputMode="numeric"
                  value={form.legacyId}
                  onChange={(e) => setForm((f) => ({ ...f, legacyId: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-sm text-[var(--wms-fg)] dark:border-[var(--wms-border)]"
                  placeholder="e.g. 2625"
                />
              </label>
            ) : (
              <label className="block font-mono text-[0.65rem] uppercase tracking-wider text-[var(--wms-muted)]">
                System ID
                <input
                  type="text"
                  inputMode="numeric"
                  value={form.legacyId}
                  onChange={(e) => setForm((f) => ({ ...f, legacyId: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-sm text-[var(--wms-fg)] dark:border-[var(--wms-border)]"
                />
              </label>
            )}
            <div className="space-y-2.5 border-t border-[var(--wms-border)] pt-3 dark:border-[var(--wms-border)]">
              {chk("autoDisplayIfTagsPresent", "Auto display if tags present")}
              {chk("hideInSearchFilters", "Hide in search filters")}
              {chk("hideInItemDetails", "Hide in Item Details")}
            </div>
            <fieldset className="space-y-2 border-t border-[var(--wms-border)] pt-3 dark:border-[var(--wms-border)]">
              <legend className="mb-1 font-mono text-[0.65rem] uppercase tracking-wider text-[var(--wms-muted)]">
                Inventory
              </legend>
              <label className="flex cursor-pointer items-center gap-2 font-mono text-xs text-[var(--wms-fg)]">
                <input
                  type="radio"
                  name="inv"
                  checked={form.includeInInventory}
                  onChange={() => setForm((f) => ({ ...f, includeInInventory: true }))}
                  className="border-[var(--wms-border)] text-[var(--wms-accent)]"
                />
                Include in Inventory
              </label>
              <label className="flex cursor-pointer items-center gap-2 font-mono text-xs text-[var(--wms-fg)]">
                <input
                  type="radio"
                  name="inv"
                  checked={!form.includeInInventory}
                  onChange={() => setForm((f) => ({ ...f, includeInInventory: false }))}
                  className="border-[var(--wms-border)] text-[var(--wms-accent)]"
                />
                Do not include in Inventory
              </label>
            </fieldset>
            <div className="space-y-2.5 border-t border-[var(--wms-border)] pt-3 dark:border-[var(--wms-border)]">
              {chk(
                "displayInGroupPage",
                "Display in Group Page - Ignore Inv. Status",
              )}
              {chk(
                "allowInstantStolenApi",
                "Allow status change via instant stolen API even if not considered in-inventory",
              )}
              {chk(
                "preventLiveOnTransferReceive",
                <>
                  Prevent this status from changing to Live during transfer receiving
                  <Hint text="When receiving a transfer, this status will not auto-change to Live." />
                </>,
              )}
              {chk(
                "preventChangeDuringAuditRequest",
                <>
                  Prevent this status from changing during the Audit Inventory Request module
                  <Hint text="Audit workflows will not alter items in this status." />
                </>,
              )}
              {chk(
                "preventLiveAfterInventoryUploadScript",
                "Prevent this status from changing to Live when the post-script runs after the inventory upload",
              )}
            </div>
            {formError ? (
              <p className="font-mono text-xs text-red-500/90">{formError}</p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--wms-border)] px-4 py-3 dark:border-[var(--wms-border)]">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={closeModals}
                className="rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-4 py-2 font-mono text-xs font-medium text-[var(--wms-fg)] hover:bg-[var(--wms-border)]/30 dark:border-[var(--wms-border)]"
              >
                Close
              </button>
              {editRow ? (
                <button
                  type="button"
                  onClick={() => void deleteRow()}
                  className="rounded-lg px-3 py-2 font-mono text-xs text-red-500/90 hover:underline"
                >
                  Delete
                </button>
              ) : null}
            </div>
            <button
              type="button"
              disabled={formBusy}
              onClick={() => void onSubmit()}
              className="rounded-lg bg-blue-600 px-5 py-2 font-mono text-xs font-semibold text-white shadow hover:bg-blue-500 disabled:opacity-50 dark:bg-blue-600"
            >
              {formBusy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </>
  );

  if (error) {
    return (
      <p className="font-mono text-sm text-red-500/90">
        {error instanceof Error ? error.message : "Failed to load status labels"}
      </p>
    );
  }

  if (isLoading || !data) {
    return <p className="font-mono text-xs text-[var(--wms-muted)]">Loading…</p>;
  }

  const th =
    "px-2 py-2.5 text-center font-mono text-[0.55rem] font-semibold uppercase leading-tight tracking-wide text-[var(--wms-muted)]";

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={openAdd}
          className="rounded-lg bg-[var(--wms-accent)] px-4 py-2 font-mono text-xs font-semibold text-[var(--wms-accent-fg)] hover:opacity-90"
        >
          Add
        </button>
      </div>

      <div className="overflow-x-auto rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] dark:border-[var(--wms-border)]">
        <table className="w-full min-w-[1100px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] dark:border-[var(--wms-border)]">
              <th className={`${th} pl-3 text-left`} title="System ID (legacy)">
                System ID
              </th>
              <th className={`${th} min-w-[8rem] text-left`}>Status name</th>
              <th className={th} title="Auto display if tags present">
                Auto
              </th>
              <th className={th} title="Hide in search filters">
                H.Srch
              </th>
              <th className={th} title="Hide in item details">
                H.Dtl
              </th>
              <th className={th} title="Include in inventory">
                Inv
              </th>
              <th className={th} title="Display in group page">
                Grp
              </th>
              <th className={th} title="Instant stolen API">
                Stolen
              </th>
              <th className={th} title="Prevent Live on transfer receive">
                Xfer
              </th>
              <th className={th} title="Prevent change during audit">
                Aud
              </th>
              <th className={th} title="Prevent Live after upload script">
                Upld
              </th>
              <th className={`${th} pr-3 text-right`}>Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--wms-border)]/80 dark:divide-[var(--wms-border)]/80">
            {data.map((row) => (
              <tr key={row.id} className="text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)]/50">
                <td className="px-3 py-2 font-mono text-xs tabular-nums text-[var(--wms-muted)]">
                  {row.legacy_id ?? "—"}
                </td>
                <td className="px-2 py-2 font-medium">{row.name}</td>
                <td className="px-2 py-2 text-center">
                  <FlagCell on={row.auto_display_if_tags_present} />
                </td>
                <td className="px-2 py-2 text-center">
                  <FlagCell on={row.hide_in_search_filters} />
                </td>
                <td className="px-2 py-2 text-center">
                  <FlagCell on={row.hide_in_item_details} />
                </td>
                <td className="px-2 py-2 text-center">
                  <FlagCell on={row.include_in_inventory} />
                </td>
                <td className="px-2 py-2 text-center">
                  <FlagCell on={row.display_in_group_page} />
                </td>
                <td className="px-2 py-2 text-center">
                  <FlagCell on={row.allow_instant_stolen_api} />
                </td>
                <td className="px-2 py-2 text-center">
                  <FlagCell on={row.prevent_live_on_transfer_receive} />
                </td>
                <td className="px-2 py-2 text-center">
                  <FlagCell on={row.prevent_change_during_audit_request} />
                </td>
                <td className="px-2 py-2 text-center">
                  <FlagCell on={row.prevent_live_after_inventory_upload_script} />
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    onClick={() => openEdit(row)}
                    title="Edit"
                    className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-blue-600 text-white shadow-sm transition-colors hover:bg-blue-500 dark:bg-blue-600"
                  >
                    <Pencil className="h-4 w-4" strokeWidth={2.25} aria-hidden />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {addOpen ? formModal(submitCreate) : null}
      {editRow ? formModal(submitEdit) : null}
    </div>
  );
}
