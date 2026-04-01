"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, Eye, Printer, ScrollText } from "lucide-react";
import { generateSGTIN96 } from "@/lib/epc";
import {
  buildRfidReftagZplBatch,
  type RfidReftagZplLabel,
} from "@/lib/utils/zpl-rfid-reftag";
import { LabelPreviewCanvas } from "./label-preview-canvas";
import {
  CommissioningSettingsPanel,
  DEFAULT_RFID_COMMISSION_SETTINGS,
  parsePrinterLine,
  type RfidCommissionSettings,
} from "./commissioning-settings-panel";
import {
  CommissioningStatusBar,
  type RfidTaskPhase,
} from "./commissioning-status-bar";
import { PrintLogsModal } from "./print-logs-modal";

type BinRow = { id: string; code: string };

type Match = {
  id: string;
  sku: string;
  ls_system_id: string;
  upc: string;
  description: string;
};

const PRINTING_SETTLE_MS = 1200;

export function CommissioningWorkspace() {
  const [settings, setSettings] = useState<RfidCommissionSettings>(
    DEFAULT_RFID_COMMISSION_SETTINGS,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [matches, setMatches] = useState<Match[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [selected, setSelected] = useState<Match | null>(null);

  const [qty, setQty] = useState(1);
  const [binId, setBinId] = useState("");
  const [bins, setBins] = useState<BinRow[]>([]);
  const [loadingBins, setLoadingBins] = useState(true);
  const [addToInventory, setAddToInventory] = useState(false);

  const [phase, setPhase] = useState<RfidTaskPhase>("IDLE");
  const [elapsedMs, setElapsedMs] = useState(0);
  const timerRef = useRef<number | null>(null);
  const startRef = useRef<number | null>(null);

  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastEpcs, setLastEpcs] = useState<string[]>([]);

  const [previewOpen, setPreviewOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);

  const [nextSerial, setNextSerial] = useState(1);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(search.trim()), 280);
    return () => window.clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (debouncedSearch.length < 2) {
      setMatches([]);
      return;
    }
    let cancelled = false;
    setSearchLoading(true);
    void (async () => {
      try {
        const res = await fetch(
          `/api/rfid/catalog-search?q=${encodeURIComponent(debouncedSearch)}`,
        );
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { matches?: Match[] };
        if (!cancelled) setMatches(data.matches ?? []);
      } finally {
        if (!cancelled) setSearchLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [debouncedSearch]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/locations/bins");
        if (res.ok) setBins((await res.json()) as BinRow[]);
      } finally {
        setLoadingBins(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!selected) {
      setNextSerial(1);
      return;
    }
    let cancelled = false;
    void (async () => {
      const res = await fetch(
        `/api/rfid/next-serial?customSkuId=${encodeURIComponent(selected.id)}`,
      );
      if (!res.ok || cancelled) return;
      const data = (await res.json()) as { next_serial?: number };
      if (!cancelled && typeof data.next_serial === "number") {
        setNextSerial(data.next_serial);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected]);

  useEffect(() => {
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }

    if (phase === "IDLE") {
      startRef.current = null;
      setElapsedMs(0);
      return;
    }

    if (phase === "ERROR" || phase === "SUCCESS") {
      return;
    }

    startRef.current = Date.now();
    timerRef.current = window.setInterval(() => {
      if (startRef.current) setElapsedMs(Date.now() - startRef.current);
    }, 100);

    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, [phase]);

  const previewEpc = useMemo(() => {
    if (!selected) return "0".repeat(24);
    const ls = Number(selected.ls_system_id);
    if (!Number.isFinite(ls)) return "0".repeat(24);
    try {
      return generateSGTIN96(settings.companyPrefix, ls, nextSerial);
    } catch {
      return "INVALID";
    }
  }, [selected, settings.companyPrefix, nextSerial]);

  const stopTimerFreeze = useCallback(() => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = null;
    if (startRef.current) setElapsedMs(Date.now() - startRef.current);
  }, []);

  const onPrint = useCallback(async () => {
    setMessage(null);
    setError(null);
    setLastEpcs([]);
    if (!selected) {
      setError("Select a product from search results.");
      return;
    }
    if (addToInventory && !binId) {
      setError("Choose a bin when “Add to inventory” is checked.");
      return;
    }

    const { host, port, uri } = parsePrinterLine(settings.printerLine);

    setPhase("ENCODING");
    setElapsedMs(0);

    try {
      const res = await fetch("/api/rfid/commission", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customSkuId: selected.id,
          qty,
          binId: binId || null,
          addToInventory,
          companyPrefix: settings.companyPrefix,
          printerIp: host,
          printerPort: port,
          printerUri: uri,
          labelDimensions: {
            w: settings.labelWidthDots,
            h: settings.labelHeightDots,
          },
        }),
      });
      const data = (await res.json()) as {
        error?: string;
        inserted?: { epc: string; serial_number: number }[];
        status_final?: string;
        printer_ok?: boolean;
        printer_error?: string | null;
        printer_url?: string;
      };
      if (!res.ok) {
        stopTimerFreeze();
        setPhase("ERROR");
        setError(data.error ?? "Commission failed");
        return;
      }

      setPhase("PRINTING");
      await new Promise((r) => window.setTimeout(r, PRINTING_SETTLE_MS));

      stopTimerFreeze();
      setPhase("SUCCESS");
      const n = data.inserted?.length ?? 0;
      const stock = data.status_final ?? "—";
      const printerLine =
        data.printer_ok === false
          ? ` Printer unreachable (${data.printer_url ?? "—"}): ${data.printer_error ?? "error"}. Items saved; audit logged.`
          : ` Sent ${n} job(s) to ${data.printer_url ?? "printer"}.`;
      setMessage(
        `Created ${n} item(s) — ${stock}.${printerLine} Audit: rfid_print.`,
      );
      setLastEpcs((data.inserted ?? []).map((r) => r.epc));

      window.setTimeout(() => {
        setPhase("IDLE");
      }, 4500);
    } catch {
      stopTimerFreeze();
      setPhase("ERROR");
      setError("Network error");
    }
  }, [
    selected,
    qty,
    binId,
    addToInventory,
    settings,
    stopTimerFreeze,
  ]);

  const pickMatch = (m: Match) => {
    setSelected(m);
    setSearch(m.sku);
    setMatches([]);
  };

  const copyZpl = useCallback(async () => {
    if (!selected) return;
    const ls = Number(selected.ls_system_id);
    if (!Number.isFinite(ls)) {
      setError("Invalid Lightspeed system ID for ZPL.");
      return;
    }
    setError(null);
    try {
      const rows: RfidReftagZplLabel[] = [];
      const dateStr = new Date().toISOString().slice(0, 10);
      for (let i = 0; i < qty; i += 1) {
        const sn = nextSerial + i;
        const epc = generateSGTIN96(settings.companyPrefix, ls, sn);
        rows.push({
          epc,
          sku: selected.sku,
          description: selected.description,
          systemId: selected.ls_system_id,
          upc: selected.upc,
          dateStr,
          pw: settings.labelWidthDots,
          ll: settings.labelHeightDots,
        });
      }
      const zpl = buildRfidReftagZplBatch(rows);
      await navigator.clipboard.writeText(zpl);
      setMessage(`Copied ZPL for ${qty} label(s) — paste to Zebra utilities or raw port 9100.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "ZPL copy failed");
    }
  }, [selected, qty, nextSerial, settings]);

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <CommissioningSettingsPanel
        open={settingsOpen}
        onToggle={() => setSettingsOpen((o) => !o)}
        value={settings}
        onChange={setSettings}
      />

      <CommissioningStatusBar
        phase={phase}
        elapsedMs={elapsedMs}
        printerEndpoint={settings.printerLine.trim() || "—"}
      />

      <div className="rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80 p-5">
        <h2 className="font-mono text-[0.7rem] font-semibold uppercase tracking-wider text-[var(--wms-muted)]">
          SKU search
        </h2>
        <p className="mt-1 font-mono text-[0.6rem] text-[var(--wms-muted)]">
          System ID, SKU, UPC, EAN, or matrix description — type at least 2 characters.
        </p>
        <div className="relative mt-3">
          <input
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              if (selected && e.target.value !== selected.sku) setSelected(null);
            }}
            placeholder="Search…"
            className="w-full rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2.5 font-mono text-sm text-[var(--wms-fg)] placeholder:text-[var(--wms-muted)] focus:border-teal-500/50 focus:outline-none focus:ring-1 focus:ring-teal-500/30"
          />
          {searchLoading ? (
            <p className="mt-2 font-mono text-[0.65rem] text-[var(--wms-muted)]">Searching…</p>
          ) : null}
          {matches.length > 0 ? (
            <ul className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] py-1 shadow-xl">
              {matches.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => pickMatch(m)}
                    className="w-full px-3 py-2 text-left font-mono text-xs hover:bg-[var(--wms-surface-elevated)]"
                  >
                    <span className="text-teal-400/90">{m.sku}</span>
                    <span className="text-[var(--wms-muted)]"> · </span>
                    <span className="text-[var(--wms-muted)]">UPC {m.upc}</span>
                    <br />
                    <span className="text-[var(--wms-muted)]">LS {m.ls_system_id}</span>
                    <span className="text-[var(--wms-muted)]"> — </span>
                    <span className="text-[var(--wms-fg)]">{m.description}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        {selected ? (
          <div className="mt-4 rounded-md border border-teal-500/25 bg-teal-950/20 px-3 py-2 font-mono text-[0.7rem] text-[var(--wms-fg)]">
            <span className="text-teal-500/90">{selected.sku}</span>
            <span className="text-[var(--wms-muted)]"> · </span>
            {selected.description}
            <span className="mt-1 block text-[var(--wms-muted)]">
              UPC {selected.upc} · System ID {selected.ls_system_id}
            </span>
          </div>
        ) : null}

        <label className="mt-4 block">
          <span className="font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)]">
            Quantity
          </span>
          <input
            type="number"
            min={1}
            max={500}
            value={qty}
            onChange={(e) => setQty(Number(e.target.value) || 1)}
            className="mt-1 w-full rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2.5 font-mono text-sm tabular-nums text-[var(--wms-fg)]"
          />
        </label>

        <label className="mt-4 flex cursor-pointer items-center gap-2 font-mono text-sm text-[var(--wms-fg)]">
          <input
            type="checkbox"
            checked={addToInventory}
            onChange={(e) => setAddToInventory(e.target.checked)}
            className="h-4 w-4 rounded border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] text-teal-600"
          />
          Add to inventory (in-stock in selected bin)
        </label>

        <label className="mt-4 block">
          <span className="font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)]">
            Bin {addToInventory ? "(required)" : "(optional)"}
          </span>
          <select
            value={binId}
            onChange={(e) => setBinId(e.target.value)}
            disabled={loadingBins}
            className="mt-1 w-full rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2.5 font-mono text-sm text-[var(--wms-fg)] disabled:opacity-50"
          >
            <option value="">— Select bin —</option>
            {bins.map((b) => (
              <option key={b.id} value={b.id}>
                {b.code}
              </option>
            ))}
          </select>
        </label>

        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={!selected}
            onClick={() => setPreviewOpen(true)}
            className="inline-flex flex-1 min-w-[8rem] items-center justify-center gap-2 rounded-lg border border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-muted)_12%,var(--wms-surface-elevated))] py-2.5 font-mono text-xs font-medium text-[var(--wms-fg)] shadow-sm hover:border-[var(--wms-accent)]/50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Eye className="h-4 w-4" strokeWidth={2} />
            Preview label
          </button>
          <button
            type="button"
            onClick={() => setLogsOpen(true)}
            className="inline-flex flex-1 min-w-[8rem] items-center justify-center gap-2 rounded-lg border border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-muted)_12%,var(--wms-surface-elevated))] py-2.5 font-mono text-xs font-medium text-[var(--wms-fg)] shadow-sm hover:border-[var(--wms-accent)]/50"
          >
            <ScrollText className="h-4 w-4" strokeWidth={2} />
            Open logs
          </button>
          <button
            type="button"
            disabled={!selected}
            onClick={() => void copyZpl()}
            className="inline-flex w-full min-w-[8rem] flex-[1_1_100%] items-center justify-center gap-2 rounded-lg border border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-muted)_12%,var(--wms-surface-elevated))] py-2.5 font-mono text-xs font-medium text-[var(--wms-fg)] shadow-sm hover:border-[var(--wms-accent)]/50 sm:flex-[1] sm:basis-auto"
          >
            <Copy className="h-4 w-4" strokeWidth={2} />
            Copy ZPL (RFID + layout)
          </button>
        </div>

        <button
          type="button"
          disabled={
            !selected || phase === "ENCODING" || phase === "PRINTING"
          }
          onClick={() => void onPrint()}
          className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-teal-600/50 bg-teal-950/40 py-3 font-mono text-sm font-medium text-teal-200 hover:bg-teal-900/30 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Printer className="h-4 w-4" strokeWidth={2} />
          Print / commission
        </button>

        {error ? (
          <p className="mt-3 font-mono text-xs text-red-400/90">{error}</p>
        ) : null}
        {message ? (
          <p className="mt-3 font-mono text-xs font-medium text-[var(--wms-accent)]">{message}</p>
        ) : null}
      </div>

      {lastEpcs.length > 0 ? (
        <div className="rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/60 p-4">
          <h3 className="font-mono text-[0.65rem] uppercase tracking-wider text-[var(--wms-muted)]">
            Last job — EPCs (hex)
          </h3>
          <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto font-mono text-[0.65rem] font-medium text-[var(--wms-accent)]">
            {lastEpcs.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {previewOpen && selected ? (
        <>
          <button
            type="button"
            aria-label="Close preview"
            className="fixed inset-0 z-[60] bg-black/70"
            onClick={() => setPreviewOpen(false)}
          />
          <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
            <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] p-5 shadow-2xl">
              <div className="mb-4 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-[var(--wms-fg)]">Label preview</h3>
                <button
                  type="button"
                  onClick={() => setPreviewOpen(false)}
                  className="font-mono text-xs text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
                >
                  Close
                </button>
              </div>
              <p className="mb-3 font-mono text-[0.6rem] text-[var(--wms-muted)]">
                Canvas at {settings.labelWidthDots} × {settings.labelHeightDots} dots (scaled to
                fit). Sample EPC uses next serial {nextSerial}.
              </p>
              <LabelPreviewCanvas
                widthDots={settings.labelWidthDots}
                heightDots={settings.labelHeightDots}
                sku={selected.sku}
                upc={selected.upc}
                description={selected.description}
                epc={previewEpc}
                systemId={selected.ls_system_id}
                companyPrefix={settings.companyPrefix}
                itemRefBits={settings.itemRefBits}
                serialBits={settings.serialBits}
              />
            </div>
          </div>
        </>
      ) : null}

      <PrintLogsModal open={logsOpen} onClose={() => setLogsOpen(false)} />
    </div>
  );
}
