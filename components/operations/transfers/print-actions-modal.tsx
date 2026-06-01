"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { X, Printer } from "lucide-react";

type PrinterRow = {
  id: string;
  name: string;
  network_address: string | null;
  status_online: boolean;
};

// Synthetic option that maps to the same default the /rfid/commissioning page
// uses (DEFAULT_RFID_COMMISSION_SETTINGS.printerLine). Always shown so the
// modal still works on tenants that haven't registered any printer devices.
const COMMISSIONING_DEFAULT_OPTION = {
  id: "__commissioning_default__",
  name: "Default (Commissioning)",
  network_address: "192.168.1.3:80 / PSTPRNT",
  status_online: true,
};

const fetcher = async (url: string) => {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? r.statusText);
  }
  return r.json();
};

type Props = {
  open: boolean;
  epc: string | null;
  onClose: () => void;
};

/**
 * Print Actions popup — shortcut from Transfer In drawer rows. Lists configured
 * printers at the operator's location and reprints the row's existing EPC label
 * via /api/rfid/reprint. Uses the same ZPL builder as /rfid/commissioning so
 * label dimensions / format stay consistent — this modal does not edit any
 * settings, it just dispatches the print job.
 */
export function PrintActionsModal({ open, epc, onClose }: Props) {
  const { data, error: loadErr } = useSWR<{ rows: PrinterRow[] }>(
    open ? "/api/devices/printers" : null,
    fetcher,
  );
  // Always include the commissioning default so the modal works even when
  // no printer devices are registered for this location.
  const printers: PrinterRow[] = [
    ...(data?.rows ?? []),
    COMMISSIONING_DEFAULT_OPTION,
  ];

  const [printerId, setPrinterId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Default-select: first online registered printer if any, else commissioning default.
  useEffect(() => {
    if (!open) return;
    setMsg(null);
    setErr(null);
    const registered = data?.rows ?? [];
    const online = registered.find((p) => p.status_online);
    setPrinterId((online ?? registered[0])?.id ?? COMMISSIONING_DEFAULT_OPTION.id);
  }, [open, data]);

  if (!open) return null;

  const reprint = async () => {
    if (!epc) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const body: Record<string, unknown> = { epc };
      if (printerId === COMMISSIONING_DEFAULT_OPTION.id) {
        body.printerLine = COMMISSIONING_DEFAULT_OPTION.network_address;
      } else if (printerId) {
        body.printerId = printerId;
      }
      const res = await fetch("/api/rfid/reprint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
        ok?: boolean;
      };
      if (!res.ok || !j.ok) {
        setErr(j.error ?? "Print failed");
        return;
      }
      setMsg("Sent to printer.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Print failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        aria-label="Close"
        className="fixed inset-0 z-[80] bg-black/60"
        onClick={() => !busy && onClose()}
      />
      <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
        <div
          role="dialog"
          aria-modal="true"
          className="w-full max-w-md rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] shadow-2xl"
        >
          <div className="flex items-center justify-between border-b border-[var(--wms-border)] px-4 py-3">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--wms-fg)]">
              <Printer className="h-4 w-4 text-[var(--wms-accent)]" />
              Print Actions
            </h2>
            <button
              type="button"
              onClick={() => !busy && onClose()}
              className="rounded p-1 text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)]"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="space-y-3 px-4 py-4">
            <div>
              <label className="mb-1 block font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)]">
                EPC
              </label>
              <div className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/60 px-3 py-2 font-mono text-xs text-[var(--wms-fg)]">
                {epc ?? "—"}
              </div>
            </div>
            <div>
              <label className="mb-1 block font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)]">
                Select Printer
              </label>
              {loadErr ? (
                <p className="font-mono text-xs text-red-400/90">
                  Failed to load printers.
                </p>
              ) : (
                <select
                  value={printerId}
                  onChange={(e) => setPrinterId(e.target.value)}
                  className="w-full rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-sm text-[var(--wms-fg)]"
                >
                  {printers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.network_address ? ` — ${p.network_address}` : ""}
                      {p.status_online ? "" : "  (offline)"}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <p className="font-mono text-[0.6rem] text-[var(--wms-muted)]">
              Uses the label dimensions and ZPL format from{" "}
              <a
                className="text-[var(--wms-accent)] hover:underline"
                href="/tags-labels/print"
                target="_blank"
                rel="noopener"
              >
                /tags-labels/print
              </a>
              . This modal does not change any settings.
            </p>
            {msg ? (
              <p className="font-mono text-xs text-emerald-300/90">{msg}</p>
            ) : null}
            {err ? <p className="font-mono text-xs text-red-400/90">{err}</p> : null}
          </div>
          <div className="flex gap-2 border-t border-[var(--wms-border)] px-4 py-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => onClose()}
              className="flex-1 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] py-2 font-mono text-xs text-[var(--wms-fg)] hover:opacity-90 disabled:opacity-50"
            >
              Close
            </button>
            <button
              type="button"
              disabled={busy || !epc}
              onClick={() => void reprint()}
              className="flex-1 rounded-md border border-[var(--wms-accent)]/50 bg-[var(--wms-accent)] py-2 font-mono text-xs font-semibold text-[var(--wms-accent-fg)] hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Printing…" : "Reprint"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
