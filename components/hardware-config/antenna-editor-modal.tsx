"use client";

import { useEffect, useState } from "react";
import { X, Zap } from "lucide-react";
import type { HardwareAntennaRow, HardwareReaderRow } from "@/lib/server/hardware-config";

type Props = {
  open: boolean;
  /** Parent reader (always required — antennas don't exist without one). */
  parent: HardwareReaderRow | null;
  /** When set, the form is in EDIT mode. Otherwise CREATE mode. */
  editing: HardwareAntennaRow | null;
  onClose: () => void;
  onSaved: () => void;
};

export function AntennaEditorModal({
  open,
  parent,
  editing,
  onClose,
  onSaved,
}: Props) {
  const [antennaNumber, setAntennaNumber] = useState("1");
  const [name, setName] = useState("Antenna 1");
  const [powerDbm, setPowerDbm] = useState("30");
  const [enabled, setEnabled] = useState(true);
  const [position, setPosition] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !parent) return;
    if (editing) {
      const cfg = editing.config as {
        antenna_number?: number;
        transmit_power_dbm?: number;
        enabled?: boolean;
        position_description?: string;
      };
      setAntennaNumber(String(cfg.antenna_number ?? 1));
      setName(editing.name);
      setPowerDbm(String(cfg.transmit_power_dbm ?? 30));
      setEnabled(cfg.enabled !== false);
      setPosition(cfg.position_description ?? "");
    } else {
      // Suggest the next free antenna number on this parent
      const used = new Set(
        parent.antennas
          .map((a) => (a.config as { antenna_number?: number }).antenna_number)
          .filter((n): n is number => typeof n === "number"),
      );
      let next = 1;
      while (used.has(next)) next += 1;
      setAntennaNumber(String(next));
      setName(`Antenna ${next}`);
      setPowerDbm("30");
      setEnabled(true);
      setPosition("");
    }
    setErr(null);
  }, [open, parent, editing]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open || !parent) return null;

  const save = async () => {
    if (!name.trim()) {
      setErr("Antenna name is required");
      return;
    }
    const num = Number(antennaNumber);
    if (!Number.isInteger(num) || num < 1 || num > 32) {
      setErr("Antenna number must be between 1 and 32");
      return;
    }
    const power = Number(powerDbm);
    if (!Number.isFinite(power) || power < 0 || power > 33) {
      setErr("Power must be 0 to 33 dBm");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const body = {
        parentDeviceId: parent.id,
        name: name.trim(),
        antennaNumber: num,
        transmitPowerDbm: power,
        enabled,
        positionDescription: position.trim(),
      };
      const url = editing
        ? `/api/hardware-config/antennas/${encodeURIComponent(editing.id)}`
        : "/api/hardware-config/antennas";
      const method = editing ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? "Save failed");
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const powerNum = Number(powerDbm);
  const powerLabel =
    Number.isFinite(powerNum) && powerNum > 0
      ? `${powerNum} dBm  ≈  ${Math.round(Math.pow(10, powerNum / 10))} mW`
      : "0 mW";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)] p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-mono text-sm font-semibold text-[var(--wms-fg)]">
            {editing ? "Edit antenna" : "Add antenna"}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="mb-3 font-mono text-[0.65rem] text-[var(--wms-muted)]">
          Parent reader: <span className="text-[var(--wms-fg)]">{parent.name}</span>
        </p>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block font-mono text-[0.65rem] uppercase tracking-wider text-[var(--wms-muted)]">
                Antenna #
              </label>
              <input
                type="number"
                min={1}
                max={32}
                value={antennaNumber}
                onChange={(e) => setAntennaNumber(e.target.value)}
                className={inputCls}
              />
            </div>
            <div>
              <label className="mb-1 block font-mono text-[0.65rem] uppercase tracking-wider text-[var(--wms-muted)]">
                Name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={256}
                className={inputCls}
              />
            </div>
          </div>

          <div>
            <label className="mb-1 flex items-center justify-between font-mono text-[0.65rem] uppercase tracking-wider text-[var(--wms-muted)]">
              <span className="flex items-center gap-1">
                <Zap className="h-3 w-3" /> Transmit power
              </span>
              <span className="font-semibold normal-case text-[var(--wms-fg)]">{powerLabel}</span>
            </label>
            <input
              type="range"
              min={0}
              max={33}
              step={0.5}
              value={powerDbm}
              onChange={(e) => setPowerDbm(e.target.value)}
              className="w-full accent-[var(--wms-accent)]"
            />
            <div className="mt-1 flex items-center gap-2">
              <input
                type="number"
                min={0}
                max={33}
                step={0.5}
                value={powerDbm}
                onChange={(e) => setPowerDbm(e.target.value)}
                className={`${inputCls} max-w-24`}
              />
              <span className="font-mono text-[0.6rem] text-[var(--wms-muted)]">
                dBm (0 = off, 30 = max EU/US, 33 = max some regions)
              </span>
            </div>
          </div>

          <label className="flex items-center gap-2 font-mono text-xs text-[var(--wms-fg)]">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="h-3.5 w-3.5 accent-[var(--wms-accent)]"
            />
            Enabled (Carbon CDM will read on this antenna)
          </label>

          <div>
            <label className="mb-1 block font-mono text-[0.65rem] uppercase tracking-wider text-[var(--wms-muted)]">
              Position description (optional)
            </label>
            <textarea
              value={position}
              onChange={(e) => setPosition(e.target.value)}
              maxLength={2000}
              rows={2}
              placeholder="e.g. Aimed at receiving conveyor, mounted overhead at door 1"
              className={inputCls}
            />
          </div>

          {err ? (
            <p className="font-mono text-[0.7rem] text-red-400/90">{err}</p>
          ) : null}
        </div>

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded border border-[var(--wms-border)] px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)] hover:text-[var(--wms-fg)] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded border border-[var(--wms-accent)]/50 bg-[var(--wms-accent)] px-3 py-1.5 font-mono text-[0.65rem] font-semibold uppercase tracking-wide text-[var(--wms-accent-fg)] hover:opacity-90 disabled:opacity-60"
          >
            {busy ? "Saving..." : editing ? "Save changes" : "Add antenna"}
          </button>
        </div>
      </div>
    </div>
  );
}

const inputCls =
  "w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1.5 font-mono text-xs text-[var(--wms-fg)] focus:border-[var(--wms-accent)] focus:outline-none";
