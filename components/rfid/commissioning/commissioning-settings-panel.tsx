"use client";

import { ChevronDown, ChevronRight, Settings2 } from "lucide-react";

export type RfidCommissionSettings = {
  companyPrefix: number;
  itemRefBits: number;
  serialBits: number;
  /** Single editable line, e.g. `192.168.1.3:80 / PSTPRNT` */
  printerLine: string;
  labelWidthDots: number;
  labelHeightDots: number;
};

export const DEFAULT_RFID_COMMISSION_SETTINGS: RfidCommissionSettings = {
  companyPrefix: 1_044_991,
  itemRefBits: 40,
  serialBits: 36,
  printerLine: "192.168.1.3:80 / PSTPRNT",
  labelWidthDots: 812,
  labelHeightDots: 594,
};

/** Parse `host:port / uri` for API `printerIp` / port / URI. */
export function parsePrinterLine(line: string): {
  host: string;
  port: number;
  uri: string;
} {
  const t = line.trim();
  const m = t.match(/^(.+):(\d+)\s*\/\s*(.+)$/);
  if (!m) {
    return { host: "192.168.1.3", port: 80, uri: "PSTPRNT" };
  }
  const port = Number.parseInt(m[2], 10);
  return {
    host: m[1].trim(),
    port: Number.isFinite(port) && port > 0 ? port : 80,
    uri: m[3].trim() || "PSTPRNT",
  };
}

type Props = {
  open: boolean;
  onToggle: () => void;
  value: RfidCommissionSettings;
  onChange: (next: RfidCommissionSettings) => void;
};

export function CommissioningSettingsPanel({ open, onToggle, value, onChange }: Props) {
  const patch = (partial: Partial<RfidCommissionSettings>) =>
    onChange({ ...value, ...partial });

  return (
    <div className="rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left font-mono text-xs font-medium uppercase tracking-wider text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)]/80"
      >
        <span className="inline-flex items-center gap-2">
          <Settings2 className="h-4 w-4" strokeWidth={2} />
          RFID / printer settings
        </span>
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0" />
        )}
      </button>
      {open ? (
        <div className="space-y-4 border-t border-[var(--wms-border)] px-4 py-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block font-mono text-[0.65rem] uppercase text-[var(--wms-muted)]">
              Prefix (20-bit company prefix)
              <input
                type="text"
                readOnly
                value={String(value.companyPrefix)}
                className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/60 px-2 py-2 font-mono text-sm text-[var(--wms-muted)]"
              />
            </label>
            <div className="flex gap-2">
              <label className="block flex-1 font-mono text-[0.65rem] uppercase text-[var(--wms-muted)]">
                Bits — item
                <input
                  type="number"
                  readOnly
                  value={value.itemRefBits}
                  className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/60 px-2 py-2 font-mono text-sm text-[var(--wms-muted)]"
                />
              </label>
              <label className="block flex-1 font-mono text-[0.65rem] uppercase text-[var(--wms-muted)]">
                Bits — serial
                <input
                  type="number"
                  readOnly
                  value={value.serialBits}
                  className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/60 px-2 py-2 font-mono text-sm text-[var(--wms-muted)]"
                />
              </label>
            </div>
          </div>
          <label className="block font-mono text-[0.65rem] uppercase text-[var(--wms-muted)]">
            Printer <span className="text-[var(--wms-muted)]">(host:port / URI)</span>
            <input
              type="text"
              value={value.printerLine}
              onChange={(e) => patch({ printerLine: e.target.value })}
              placeholder="192.168.1.3:80 / PSTPRNT"
              className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 font-mono text-sm text-[var(--wms-fg)]"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block font-mono text-[0.65rem] uppercase text-[var(--wms-muted)]">
              Label width (dots)
              <input
                type="number"
                min={100}
                value={value.labelWidthDots}
                onChange={(e) => patch({ labelWidthDots: Number(e.target.value) || 812 })}
                className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 font-mono text-sm text-[var(--wms-fg)]"
              />
            </label>
            <label className="block font-mono text-[0.65rem] uppercase text-[var(--wms-muted)]">
              Label height (dots)
              <input
                type="number"
                min={100}
                value={value.labelHeightDots}
                onChange={(e) => patch({ labelHeightDots: Number(e.target.value) || 594 })}
                className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 font-mono text-sm text-[var(--wms-fg)]"
              />
            </label>
          </div>
          <p className="font-mono text-[0.6rem] leading-relaxed text-[var(--wms-muted)]">
            Prefix and bit split are fixed for WMS encoding. Adjust printer endpoint and dot size
            to match your Zebra; commissioning POST sends raw ZPL to the configured host.
          </p>
        </div>
      ) : null}
    </div>
  );
}
