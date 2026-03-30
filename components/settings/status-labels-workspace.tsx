"use client";

import { useCallback, useEffect, useState } from "react";
import useSWR from "swr";
import { X } from "lucide-react";
import type { StatusLabelRow } from "@/lib/queries/status-labels";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? res.statusText);
  }
  return res.json() as Promise<StatusLabelRow[]>;
};

type BoolKey =
  | "includeInInventory"
  | "hideInSearchFilters"
  | "hideInItemDetails"
  | "displayInGroupPage";

function Toggle({
  checked,
  disabled,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-10 shrink-0 rounded-full border transition-colors ${
        checked
          ? "border-teal-500/60 bg-teal-600/35"
          : "border-slate-600 bg-slate-800/80"
      } ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:border-slate-500"}`}
    >
      <span
        className={`pointer-events-none absolute top-0.5 h-5 w-5 rounded-full bg-slate-100 shadow transition-transform ${
          checked ? "translate-x-4" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

type FormState = {
  name: string;
  legacyId: string;
  includeInInventory: boolean;
  hideInSearchFilters: boolean;
  hideInItemDetails: boolean;
  displayInGroupPage: boolean;
};

function emptyForm(): FormState {
  return {
    name: "",
    legacyId: "",
    includeInInventory: false,
    hideInSearchFilters: false,
    hideInItemDetails: false,
    displayInGroupPage: false,
  };
}

function rowToForm(row: StatusLabelRow): FormState {
  return {
    name: row.name,
    legacyId: row.legacy_id != null ? String(row.legacy_id) : "",
    includeInInventory: row.include_in_inventory,
    hideInSearchFilters: row.hide_in_search_filters,
    hideInItemDetails: row.hide_in_item_details,
    displayInGroupPage: row.display_in_group_page,
  };
}

export function StatusLabelsWorkspace() {
  const { data, error, isLoading, mutate } = useSWR<StatusLabelRow[]>(
    "/api/settings/status-labels",
    fetcher,
    { revalidateOnFocus: false },
  );
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [addOpen, setAddOpen] = useState(false);
  const [editRow, setEditRow] = useState<StatusLabelRow | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [formBusy, setFormBusy] = useState(false);

  const patchBool = useCallback(
    async (id: number, field: BoolKey, value: boolean) => {
      const key = `${id}:${field}`;
      setPending((p) => ({ ...p, [key]: true }));
      try {
        const body: Record<string, unknown> = { id, [field]: value };
        const res = await fetch("/api/settings/status-labels", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? res.statusText);
        }
        await mutate();
      } finally {
        setPending((p) => {
          const next = { ...p };
          delete next[key];
          return next;
        });
      }
    },
    [mutate],
  );

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

  const parseLegacyPayload = (): { ok: true; value: number | null } | { ok: false } => {
    const t = form.legacyId.trim();
    if (!t) return { ok: true, value: null };
    const n = Number.parseInt(t, 10);
    if (!Number.isFinite(n) || n < 1) return { ok: false };
    return { ok: true, value: n };
  };

  const submitCreate = async () => {
    setFormError(null);
    if (!form.name.trim()) {
      setFormError("Status name is required.");
      return;
    }
    const legP = parseLegacyPayload();
    if (!legP.ok) {
      setFormError("Legacy ID must be a positive integer or empty.");
      return;
    }
    setFormBusy(true);
    try {
      const res = await fetch("/api/settings/status-labels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          legacyId: legP.value,
          includeInInventory: form.includeInInventory,
          hideInSearchFilters: form.hideInSearchFilters,
          hideInItemDetails: form.hideInItemDetails,
          displayInGroupPage: form.displayInGroupPage,
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

  const submitEdit = async () => {
    if (!editRow) return;
    setFormError(null);
    if (!form.name.trim()) {
      setFormError("Status name is required.");
      return;
    }
    const legP = parseLegacyPayload();
    if (!legP.ok) {
      setFormError("Legacy ID must be a positive integer or empty.");
      return;
    }
    setFormBusy(true);
    try {
      const res = await fetch("/api/settings/status-labels", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: editRow.id,
          name: form.name.trim(),
          legacyId: legP.value,
          includeInInventory: form.includeInInventory,
          hideInSearchFilters: form.hideInSearchFilters,
          hideInItemDetails: form.hideInItemDetails,
          displayInGroupPage: form.displayInGroupPage,
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

  const deleteRow = async (row: StatusLabelRow) => {
    if (
      !window.confirm(
        `Delete status label “${row.name}”? This cannot be undone.`,
      )
    ) {
      return;
    }
    try {
      const res = await fetch(
        `/api/settings/status-labels?id=${encodeURIComponent(String(row.id))}`,
        { method: "DELETE" },
      );
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? "Delete failed");
      await mutate();
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

  const formModal = (title: string, onSubmit: () => void) => (
    <>
      <button
        type="button"
        aria-label="Close"
        className="fixed inset-0 z-[60] bg-black/70"
        onClick={closeModals}
      />
      <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
        <div
          className="w-full max-w-md rounded-xl border border-slate-800 bg-zinc-950 shadow-2xl"
          role="dialog"
          aria-labelledby="status-label-dialog-title"
        >
          <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
            <h2 id="status-label-dialog-title" className="text-sm font-semibold text-slate-100">
              {title}
            </h2>
            <button
              type="button"
              onClick={closeModals}
              className="rounded p-2 text-slate-500 hover:bg-zinc-800"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="space-y-4 p-4">
            <label className="block font-mono text-[0.65rem] uppercase text-slate-500">
              Status name
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                className="mt-1 w-full rounded-md border border-slate-700 bg-zinc-900 px-3 py-2 font-mono text-sm text-slate-100"
                autoComplete="off"
              />
            </label>
            <label className="block font-mono text-[0.65rem] uppercase text-slate-500">
              Legacy ID (optional)
              <input
                type="text"
                inputMode="numeric"
                value={form.legacyId}
                onChange={(e) => setForm((f) => ({ ...f, legacyId: e.target.value }))}
                className="mt-1 w-full rounded-md border border-slate-700 bg-zinc-900 px-3 py-2 font-mono text-sm text-slate-100"
                placeholder="e.g. 2624"
              />
            </label>
            <div className="space-y-2 font-mono text-xs text-slate-300">
              {(
                [
                  ["includeInInventory", "Include in inventory"],
                  ["hideInSearchFilters", "Hide in search filters"],
                  ["hideInItemDetails", "Hide in item details"],
                  ["displayInGroupPage", "Display in group page"],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={form[key]}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, [key]: e.target.checked }))
                    }
                    className="rounded border-slate-600 bg-zinc-900 text-teal-500"
                  />
                  {label}
                </label>
              ))}
            </div>
            {formError ? <p className="font-mono text-xs text-red-400/90">{formError}</p> : null}
            <div className="flex justify-end gap-2 border-t border-slate-800 pt-4">
              <button
                type="button"
                onClick={closeModals}
                className="rounded-md border border-slate-600 px-4 py-2 font-mono text-xs text-slate-300 hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={formBusy}
                onClick={() => void onSubmit()}
                className="rounded-md bg-teal-600 px-4 py-2 font-mono text-xs font-semibold text-white hover:bg-teal-500 disabled:opacity-50"
              >
                {formBusy ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );

  if (error) {
    return (
      <p className="font-mono text-sm text-red-400/90">
        {error instanceof Error ? error.message : "Failed to load status labels"}
      </p>
    );
  }

  if (isLoading || !data) {
    return <p className="font-mono text-xs text-slate-500">Loading…</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={openAdd}
          className="rounded-md bg-teal-600 px-4 py-2 font-mono text-xs font-semibold text-white shadow-sm hover:bg-teal-500"
        >
          Add
        </button>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-800 bg-zinc-950/60">
        <table className="w-full min-w-[980px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-slate-800 bg-zinc-900/80 font-mono text-[0.6rem] uppercase tracking-wide text-slate-500">
              <th className="px-3 py-3">Status name</th>
              <th className="px-3 py-3 text-center">Include in inventory</th>
              <th className="px-3 py-3 text-center">Hide in search filters</th>
              <th className="px-3 py-3 text-center">Hide in item details</th>
              <th className="px-3 py-3 text-center">Display in group page</th>
              <th className="px-3 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/90">
            {data.map((row) => (
              <tr key={row.id} className="text-slate-200 hover:bg-zinc-900/40">
                <td className="px-3 py-2.5 font-medium text-slate-100">{row.name}</td>
                <td className="px-3 py-2.5 text-center">
                  <Toggle
                    checked={row.include_in_inventory}
                    disabled={!!pending[`${row.id}:includeInInventory`]}
                    ariaLabel={`Include ${row.name} in inventory`}
                    onChange={(v) => void patchBool(row.id, "includeInInventory", v)}
                  />
                </td>
                <td className="px-3 py-2.5 text-center">
                  <Toggle
                    checked={row.hide_in_search_filters}
                    disabled={!!pending[`${row.id}:hideInSearchFilters`]}
                    ariaLabel={`Hide ${row.name} in search filters`}
                    onChange={(v) => void patchBool(row.id, "hideInSearchFilters", v)}
                  />
                </td>
                <td className="px-3 py-2.5 text-center">
                  <Toggle
                    checked={row.hide_in_item_details}
                    disabled={!!pending[`${row.id}:hideInItemDetails`]}
                    ariaLabel={`Hide ${row.name} in item details`}
                    onChange={(v) => void patchBool(row.id, "hideInItemDetails", v)}
                  />
                </td>
                <td className="px-3 py-2.5 text-center">
                  <Toggle
                    checked={row.display_in_group_page}
                    disabled={!!pending[`${row.id}:displayInGroupPage`]}
                    ariaLabel={`Display ${row.name} on group page`}
                    onChange={(v) => void patchBool(row.id, "displayInGroupPage", v)}
                  />
                </td>
                <td className="px-3 py-2.5 text-right font-mono text-xs">
                  <button
                    type="button"
                    onClick={() => openEdit(row)}
                    className="text-teal-400/90 hover:underline"
                  >
                    Edit
                  </button>
                  <span className="mx-2 text-slate-600" aria-hidden>
                    |
                  </span>
                  <button
                    type="button"
                    onClick={() => void deleteRow(row)}
                    className="text-red-400/85 hover:underline"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {addOpen ? formModal("Add status label", submitCreate) : null}
      {editRow ? formModal("Edit status label", submitEdit) : null}
    </div>
  );
}
