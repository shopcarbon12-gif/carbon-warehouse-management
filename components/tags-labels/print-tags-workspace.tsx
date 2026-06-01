"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Code2, Copy, Minus, Plus, Printer, Settings2, X } from "lucide-react";
import {
  buildOlaHangtagZpl,
  buildOlaHangtagZplBatch,
  type OlaLabelItem,
} from "@/lib/utils/zpl-ola-hangtag";
import { OlaLabelCanvas } from "./ola-label-canvas";

type Mode = "rfid" | "nonrfid";

type Match = {
  id: string;
  sku: string;
  ls_system_id: string;
  upc: string | null;
  description: string | null;
  size: string | null;
  color: string | null;
  price: string | null;
};

type Phase = "IDLE" | "ENCODING" | "PRINTING" | "SUCCESS" | "ERROR";
const STEPS: Phase[] = ["IDLE", "ENCODING", "PRINTING", "SUCCESS"];

type BinRow = { id: string; code: string };
type PnPrinter = { id: number; name: string };

const LABEL_W = 789;
const LABEL_H = 576;

function parsePrinterLine(line: string): { host: string; port: number; uri: string } {
  const m = line.trim().match(/^(.+):(\d+)\s*\/\s*(.+)$/);
  if (!m) return { host: "192.168.1.3", port: 80, uri: "PSTPRNT" };
  const port = Number.parseInt(m[2], 10);
  return { host: m[1].trim(), port: Number.isFinite(port) && port > 0 ? port : 80, uri: m[3].trim() || "PSTPRNT" };
}

export function PrintTagsWorkspace({
  mode,
  companyPrefix,
}: {
  mode: Mode;
  companyPrefix: number;
}) {
  const rfid = mode === "rfid";

  // search + selection
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [matches, setMatches] = useState<Match[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<Match | null>(null);

  // quantity / placement
  const [qty, setQty] = useState(1);
  const [addStock, setAddStock] = useState(false);
  const [bins, setBins] = useState<BinRow[]>([]);
  const [binId, setBinId] = useState("");

  // settings
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [printerLine, setPrinterLine] = useState("192.168.1.3:80 / PSTPRNT");
  const [pnPrinters, setPnPrinters] = useState<PnPrinter[]>([]);
  const [pnPrinterId, setPnPrinterId] = useState<number | "">("");

  // run state
  const [phase, setPhase] = useState<Phase>("IDLE");
  const [elapsedMs, setElapsedMs] = useState(0);
  const timerRef = useRef<number | null>(null);
  const startRef = useRef<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastJob, setLastJob] = useState<string[]>([]);
  const [nextSerial, setNextSerial] = useState(1);
  const [zplOpen, setZplOpen] = useState(false);
  const busy = phase === "ENCODING" || phase === "PRINTING";

  // ---- effects ----
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(search.trim()), 280);
    return () => window.clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (debounced.length < 2) {
      setMatches([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    void (async () => {
      try {
        const res = await fetch(`/api/rfid/catalog-search?q=${encodeURIComponent(debounced)}`);
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { matches?: Match[] };
        if (!cancelled) setMatches(data.matches ?? []);
      } finally {
        if (!cancelled) setSearching(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/locations/bins");
        if (res.ok) setBins((await res.json()) as BinRow[]);
      } catch {
        /* non-fatal */
      }
    })();
  }, []);

  // PrintNode printer list (non-RFID only)
  useEffect(() => {
    if (rfid) return;
    void (async () => {
      try {
        const res = await fetch("/api/printnode/printers");
        if (!res.ok) return;
        const data = (await res.json()) as { printers?: PnPrinter[] };
        const list = data.printers ?? [];
        setPnPrinters(list);
        if (list[0]) setPnPrinterId((prev) => (prev === "" ? list[0].id : prev));
      } catch {
        /* non-fatal */
      }
    })();
  }, [rfid]);

  // next serial for the selected SKU
  useEffect(() => {
    if (!selected) {
      setNextSerial(1);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/rfid/next-serial?customSkuId=${encodeURIComponent(selected.id)}`);
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { next_serial?: number };
        if (!cancelled && typeof data.next_serial === "number") setNextSerial(data.next_serial);
      } catch {
        /* non-fatal */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected]);

  // elapsed timer
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
    if (phase === "ERROR" || phase === "SUCCESS") return;
    startRef.current = Date.now();
    timerRef.current = window.setInterval(() => {
      if (startRef.current) setElapsedMs(Date.now() - startRef.current);
    }, 100);
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, [phase]);

  // ---- derived ----
  const olaItem: OlaLabelItem | null = useMemo(() => {
    if (!selected) return null;
    return {
      sku: selected.sku,
      size: selected.size,
      color: selected.color,
      price: selected.price,
      upc: selected.upc,
      description: selected.description,
      sysid: selected.ls_system_id,
    };
  }, [selected]);

  const batchZpl = useMemo(
    () => (olaItem ? buildOlaHangtagZplBatch(olaItem, nextSerial, qty, { includeRfid: rfid, companyPrefix }) : ""),
    [olaItem, nextSerial, qty, rfid, companyPrefix],
  );

  // ---- helpers ----
  const pick = (m: Match) => {
    setSelected(m);
    setSearch(m.sku);
    setMatches([]);
    setMessage(null);
    setError(null);
  };

  const bumpQty = (d: number) => setQty((q) => Math.max(1, Math.min(500, q + d)));

  const copyZpl = useCallback(async () => {
    if (!batchZpl) return setError("Select a product first.");
    try {
      await navigator.clipboard.writeText(batchZpl);
      setMessage(`Copied full ZPL — ${qty} label(s), ${batchZpl.length} chars.`);
    } catch {
      setMessage("Clipboard blocked — open Show ZPL to copy manually.");
    }
  }, [batchZpl, qty]);

  const stopTimer = useCallback(() => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = null;
    if (startRef.current) setElapsedMs(Date.now() - startRef.current);
  }, []);

  const onPrint = useCallback(async () => {
    setMessage(null);
    setError(null);
    setLastJob([]);
    if (!selected || !olaItem) return setError("Select a product from search.");
    if (addStock && !binId) return setError('Choose a bin when "Add to inventory" is on.');

    setPhase("ENCODING");
    setElapsedMs(0);
    try {
      if (rfid) {
        // 1) commission (DB encode + audit); we print the OLA label ourselves.
        const { host, port, uri } = parsePrinterLine(printerLine);
        const res = await fetch("/api/rfid/commission", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Carbon-Client-Print": "1" },
          body: JSON.stringify({
            customSkuId: selected.id,
            qty,
            binId: binId || null,
            addToInventory: addStock,
            companyPrefix,
            printerIp: host,
            printerPort: port,
            printerUri: uri,
            labelDimensions: { w: LABEL_W, h: LABEL_H },
          }),
        });
        const data = (await res.json()) as {
          error?: string;
          inserted?: { epc: string; serial_number: number }[];
          status_final?: string;
          printer_host?: string;
          printer_port?: number;
          printer_uri?: string;
        };
        if (!res.ok) {
          stopTimer();
          setPhase("ERROR");
          return setError(data.error ?? "Commission failed");
        }
        const inserted = data.inserted ?? [];
        // 2) build the OLA hang-tag ZPL for the exact serials we just minted.
        const zpl = inserted
          .map((r) => buildOlaHangtagZpl(olaItem, r.serial_number, { includeRfid: true, companyPrefix }))
          .join("\n");
        // 3) browser-direct print to the LAN printer (cloud WMS can't reach 192.168.x).
        setPhase("PRINTING");
        const printUrl = `http://${data.printer_host ?? host}:${data.printer_port ?? port}/${(data.printer_uri ?? uri).toLowerCase()}`;
        let printerOk = false;
        let printerErr: string | null = null;
        try {
          await fetch(printUrl, {
            method: "POST",
            headers: { "Content-Type": "text/plain; charset=utf-8" },
            body: zpl,
            mode: "no-cors",
            signal: AbortSignal.timeout(10_000),
          });
          printerOk = true;
        } catch (e) {
          printerErr = e instanceof Error ? e.message : "Printer fetch failed";
        }
        await new Promise((r) => window.setTimeout(r, 1200));
        stopTimer();
        setPhase("SUCCESS");
        setLastJob(inserted.map((r) => r.epc));
        const stock = data.status_final ?? (addStock ? "in-stock" : "commissioned");
        setMessage(
          printerOk
            ? `Created ${inserted.length} tag(s) — ${stock}. Sent to ${printUrl}. Audit: rfid_print.`
            : `Created ${inserted.length} tag(s) — ${stock}. Printer unreachable (${printUrl}): ${printerErr}. Items saved.`,
        );
      } else {
        // Non-RFID: PrintNode handles the print (cloud → local client → printer).
        setPhase("PRINTING");
        const res = await fetch("/api/printnode/print", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            item: olaItem,
            qty,
            printerId: pnPrinterId === "" ? undefined : pnPrinterId,
            startSerial: nextSerial,
          }),
        });
        const data = (await res.json()) as { error?: string; jobId?: number };
        if (!res.ok) {
          stopTimer();
          setPhase("ERROR");
          return setError(data.error ?? "PrintNode submit failed");
        }
        await new Promise((r) => window.setTimeout(r, 1000));
        stopTimer();
        setPhase("SUCCESS");
        setLastJob(Array.from({ length: qty }, (_, i) => `${selected.sku} · label ${i + 1}/${qty}`));
        setMessage(`Sent ${qty} label(s) to PrintNode (job #${data.jobId}).`);
      }
      window.setTimeout(() => setPhase("IDLE"), 4500);
    } catch {
      stopTimer();
      setPhase("ERROR");
      setError("Network error");
    }
  }, [selected, olaItem, addStock, binId, rfid, printerLine, companyPrefix, qty, pnPrinterId, nextSerial, stopTimer]);

  // ---- UI bits ----
  const cardCls = "rounded-2xl border border-[var(--wms-border)] bg-[var(--wms-surface)]/85 p-4 sm:p-5";
  const headCls = "flex items-center gap-2.5";
  const stepNo = (n: number) => (
    <span className="grid h-6 w-6 place-items-center rounded-md border border-[color-mix(in_srgb,var(--wms-accent)_40%,var(--wms-border))] bg-[color-mix(in_srgb,var(--wms-accent)_18%,var(--wms-surface-elevated))] font-mono text-xs font-bold text-[var(--wms-accent)]">
      {n}
    </span>
  );
  const h2Cls = "m-0 font-mono text-sm font-bold uppercase tracking-wider text-[var(--wms-muted)]";

  const activeIdx = phase === "ERROR" ? 0 : Math.max(0, STEPS.indexOf(phase));
  const stepLabel = (p: Phase) =>
    p === "ENCODING" ? (rfid ? "Encoding" : "Sending") : p === "IDLE" ? "Idle (ready)" : p[0] + p.slice(1).toLowerCase();
  const note =
    phase === "ENCODING"
      ? rfid
        ? "Commission API: DB encode → ZPL → printer…"
        : "Build ZPL → PrintNode job…"
      : phase === "PRINTING"
        ? rfid
          ? `Printer phase ${parsePrinterLine(printerLine).host}…`
          : "PrintNode → local client → label printer…"
        : phase === "SUCCESS"
          ? rfid
            ? "Job complete — rfid_print audit written."
            : "Job complete — sent to PrintNode."
          : phase === "ERROR"
            ? "Job aborted — see message below."
            : rfid
              ? "Ready — select a SKU and print tags."
              : "Ready — select a SKU and print labels.";

  return (
    <div className="flex flex-col gap-4 lg:grid lg:grid-cols-2 lg:gap-5">
      {/* LEFT column (find / qty / print) */}
      <div className="contents lg:flex lg:flex-col lg:gap-5">
        {/* 1 — find product */}
        <section className={`${cardCls} order-1`}>
          <div className={headCls}>
            {stepNo(1)}
            <h2 className={h2Cls}>Find product</h2>
          </div>
          <p className="mt-1.5 font-mono text-xs text-[var(--wms-muted)]">
            System ID · SKU · UPC / EAN · or matrix description — type 2+ characters.
          </p>
          <div className="relative mt-3">
            <input
              type="search"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                if (selected && e.target.value !== selected.sku) setSelected(null);
              }}
              placeholder="Search catalog…"
              autoComplete="off"
              className="w-full rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2.5 font-mono text-sm text-[var(--wms-fg)] placeholder:text-[var(--wms-muted)] focus:border-[var(--wms-accent)]/50 focus:outline-none focus:ring-1 focus:ring-[var(--wms-accent)]/30"
            />
            {searching ? (
              <p className="mt-2 font-mono text-[0.7rem] text-[var(--wms-muted)]">Searching…</p>
            ) : null}
            {matches.length > 0 ? (
              <ul className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] py-1 shadow-xl">
                {matches.map((m) => (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => pick(m)}
                      className="w-full px-3 py-2 text-left font-mono text-xs hover:bg-[color-mix(in_srgb,var(--wms-accent)_12%,var(--wms-surface-elevated))]"
                    >
                      <span className="font-semibold text-[var(--wms-accent)]">{m.sku}</span>
                      <span className="text-[var(--wms-muted)]">
                        {" "}
                        · {m.color ?? "—"} · sz {m.size ?? "—"} · ${Math.trunc(Number(m.price) || 0)}
                      </span>
                      <br />
                      <span className="text-[var(--wms-muted)]">
                        UPC {m.upc ?? "—"} · {m.description ?? "—"}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          {selected ? (
            <div className="mt-3 rounded-md border border-[var(--wms-accent)]/35 bg-[color-mix(in_srgb,var(--wms-accent)_9%,var(--wms-surface))] px-3 py-2.5 font-mono text-xs text-[var(--wms-fg)]">
              <span className="font-bold text-[var(--wms-accent)]">{selected.sku}</span>
              <span className="text-[var(--wms-muted)]"> · </span>
              {selected.description ?? "—"}
              <span className="mt-1 block text-[var(--wms-muted)]">
                {selected.color ?? "—"} · size {selected.size ?? "—"} · $
                {Math.trunc(Number(selected.price) || 0)} · UPC {selected.upc ?? "—"} · System ID{" "}
                {selected.ls_system_id}
              </span>
            </div>
          ) : null}
        </section>

        {/* 2 — quantity & placement */}
        <section className={`${cardCls} order-2`}>
          <div className={headCls}>
            {stepNo(2)}
            <h2 className={h2Cls}>Quantity &amp; placement</h2>
          </div>
          <div className="mt-3.5 grid grid-cols-2 gap-3">
            <div>
              <span className="mb-1.5 block font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)]">
                Quantity
              </span>
              <div className="flex h-12 items-stretch overflow-hidden rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]">
                <button type="button" onClick={() => bumpQty(-1)} className="grid w-11 place-items-center text-[var(--wms-fg)] hover:bg-[color-mix(in_srgb,var(--wms-accent)_14%,transparent)]" aria-label="Decrease">
                  <Minus className="h-4 w-4" />
                </button>
                <input
                  type="number"
                  min={1}
                  max={500}
                  value={qty}
                  onChange={(e) => setQty(Math.max(1, Math.min(500, Number(e.target.value) || 1)))}
                  className="w-full min-w-0 flex-1 border-0 bg-transparent text-center font-mono text-lg tabular-nums text-[var(--wms-fg)] outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                />
                <button type="button" onClick={() => bumpQty(1)} className="grid w-11 place-items-center text-[var(--wms-fg)] hover:bg-[color-mix(in_srgb,var(--wms-accent)_14%,transparent)]" aria-label="Increase">
                  <Plus className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div>
              <span className="mb-1.5 block font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)]">
                Add to inventory
              </span>
              <button
                type="button"
                onClick={() => setAddStock((v) => !v)}
                className="flex h-12 w-full items-center justify-center gap-3 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]"
              >
                <span className={`relative h-6 w-11 rounded-full transition ${addStock ? "bg-[var(--wms-accent)]" : "bg-[color-mix(in_srgb,var(--wms-muted)_40%,transparent)]"}`}>
                  <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${addStock ? "left-[1.4rem]" : "left-0.5"}`} />
                </span>
                <span className="font-mono text-sm text-[var(--wms-fg)]">{addStock ? "On" : "Off"}</span>
              </button>
            </div>
          </div>
          {addStock ? (
            <label className="mt-3 block">
              <span className="mb-1.5 block font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)]">
                Bin (required)
              </span>
              <select
                value={binId}
                onChange={(e) => setBinId(e.target.value)}
                className="w-full rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2.5 font-mono text-sm text-[var(--wms-fg)]"
              >
                <option value="">— Select bin —</option>
                {bins.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.code}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </section>

        {/* 3 — print */}
        <section className={`${cardCls} order-3`}>
          <div className={`${headCls} max-sm:hidden`}>
            {stepNo(3)}
            <h2 className={h2Cls}>{rfid ? "Encoding & print" : "Print"}</h2>
          </div>
          <div className="mt-0 flex gap-2.5 sm:mt-3.5">
            <button
              type="button"
              onClick={() => (batchZpl ? setZplOpen(true) : setError("Select a product first."))}
              className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg border border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-muted)_12%,var(--wms-surface-elevated))] py-2.5 font-mono text-xs font-medium text-[var(--wms-fg)] hover:border-[var(--wms-accent)]/50"
            >
              <Code2 className="h-4 w-4" /> Show ZPL
            </button>
            <button
              type="button"
              onClick={() => void copyZpl()}
              className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg border border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-muted)_12%,var(--wms-surface-elevated))] py-2.5 font-mono text-xs font-medium text-[var(--wms-fg)] hover:border-[var(--wms-accent)]/50"
            >
              <Copy className="h-4 w-4" /> Copy ZPL
            </button>
          </div>
          <button
            type="button"
            disabled={!selected || busy}
            onClick={() => void onPrint()}
            className="wms-btn-primary mt-3 inline-flex w-full font-mono disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Printer className="h-4 w-4" strokeWidth={2} />
            Print tag
          </button>
          {error ? <p className="mt-3 font-mono text-xs text-[var(--wms-status-danger-fg)]">{error}</p> : null}
          {message ? <p className="mt-3 font-mono text-xs font-medium text-[var(--wms-accent)]">{message}</p> : null}
        </section>

        {/* settings drawer */}
        <details className="order-6 overflow-hidden rounded-2xl border border-[var(--wms-border)] bg-[var(--wms-surface)]/85 max-sm:hidden" open={settingsOpen}>
          <summary
            onClick={(e) => {
              e.preventDefault();
              setSettingsOpen((v) => !v);
            }}
            className="flex cursor-pointer list-none items-center gap-2 px-4 py-3.5 font-mono text-xs font-bold uppercase tracking-wider text-[var(--wms-muted)]"
          >
            <Settings2 className="h-4 w-4" />
            {rfid ? "RFID / printer settings" : "Printer settings (PrintNode)"}
            <ChevronDown className={`ml-auto h-4 w-4 transition-transform ${settingsOpen ? "rotate-180" : ""}`} />
          </summary>
          <div className="space-y-3 border-t border-[var(--wms-border)] px-4 py-4">
            {rfid ? (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <label className="block font-mono text-[0.65rem] uppercase text-[var(--wms-muted)]">
                    Company prefix (20-bit)
                    <input readOnly value={companyPrefix} className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/60 px-2 py-2 font-mono text-sm text-[var(--wms-muted)]" />
                  </label>
                  <label className="block font-mono text-[0.65rem] uppercase text-[var(--wms-muted)]">
                    Bit split (item / serial)
                    <input readOnly value="40 / 36" className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/60 px-2 py-2 font-mono text-sm text-[var(--wms-muted)]" />
                  </label>
                </div>
                <label className="block font-mono text-[0.65rem] uppercase text-[var(--wms-muted)]">
                  Printer (host:port / URI)
                  <input value={printerLine} onChange={(e) => setPrinterLine(e.target.value)} className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 font-mono text-sm text-[var(--wms-fg)]" />
                </label>
                <p className="font-mono text-[0.6rem] leading-relaxed text-[var(--wms-muted)]">
                  RFID hang-tag (5 × 6.5 cm), Code 39 + chip encode (^RFW,E). Browser-direct print over the LAN; cloud WMS can&apos;t reach 192.168.x.
                </p>
              </>
            ) : (
              <>
                <label className="block font-mono text-[0.65rem] uppercase text-[var(--wms-muted)]">
                  PrintNode printer
                  <select
                    value={pnPrinterId}
                    onChange={(e) => setPnPrinterId(e.target.value ? Number(e.target.value) : "")}
                    className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 font-mono text-sm text-[var(--wms-fg)]"
                  >
                    {pnPrinters.length === 0 ? <option value="">(server default)</option> : null}
                    {pnPrinters.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="font-mono text-[0.6rem] leading-relaxed text-[var(--wms-muted)]">
                  Non-RFID tags print on 2 × 3 in stock via PrintNode (cloud → local client → label printer). Same artwork as RFID — no chip encode.
                </p>
              </>
            )}
          </div>
        </details>
      </div>

      {/* RIGHT column (status / preview) */}
      <div className="contents lg:flex lg:flex-col lg:gap-5">
        {/* status */}
        <section className={`${cardCls} order-5`}>
          <div className="flex items-center justify-between gap-3">
            <h2 className={h2Cls}>{rfid ? "RFID task status" : "Print status"}</h2>
            <span className={`font-mono text-base tabular-nums ${phase === "IDLE" ? "text-[var(--wms-muted)]" : "font-semibold text-[var(--wms-accent)]"}`}>
              {String(Math.floor(elapsedMs / 60000)).padStart(2, "0")}:{String(Math.floor(elapsedMs / 1000) % 60).padStart(2, "0")}
            </span>
          </div>
          <div className="mt-2.5 flex flex-wrap gap-2 max-sm:hidden">
            {STEPS.map((p, i) => {
              const done = phase !== "ERROR" && i < activeIdx;
              const current = phase !== "ERROR" && i === activeIdx;
              return (
                <div
                  key={p}
                  className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 font-mono text-[0.65rem] uppercase tracking-wide ${
                    done
                      ? "border-emerald-500/40 bg-emerald-500/10 font-medium text-emerald-200"
                      : current
                        ? "border-[var(--wms-accent)]/55 bg-[color-mix(in_srgb,var(--wms-accent)_18%,var(--wms-surface-elevated))] font-semibold text-[var(--wms-accent)]"
                        : "border-[var(--wms-border)] text-[var(--wms-muted)]"
                  }`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${done ? "bg-emerald-400" : current ? "animate-pulse bg-[var(--wms-accent)]" : "bg-[var(--wms-muted)]"}`} />
                  {stepLabel(p)}
                </div>
              );
            })}
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--wms-surface-elevated)]">
            <div
              className={`h-full transition-all duration-300 ${phase === "ERROR" ? "bg-red-500/70" : "bg-[var(--wms-accent)]"}`}
              style={{ width: phase === "ERROR" ? "100%" : ["0%", "33%", "66%", "100%"][activeIdx] }}
            />
          </div>
          <p className="mt-3 font-mono text-xs text-[var(--wms-muted)]">{note}</p>
          {lastJob.length > 0 ? (
            <div className="mt-3 max-h-40 overflow-auto border-t border-[var(--wms-border)]/70 pt-2">
              <p className="font-mono text-[0.6rem] uppercase tracking-wider text-[var(--wms-muted)]">
                {rfid ? "Last job — EPCs (hex)" : "Last job — labels sent"}
              </p>
              <ul className="mt-1 space-y-0.5 font-mono text-[0.65rem] text-[var(--wms-accent)]">
                {lastJob.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>

        {/* preview */}
        <section className={`${cardCls} order-4`}>
          <div className={headCls}>
            <h2 className={h2Cls}>Label preview</h2>
            <span className="font-mono text-[0.65rem] normal-case text-[var(--wms-muted)]">· rendered from live ZPL</span>
          </div>
          <div className="mt-3 grid place-items-center rounded-xl p-2">
            <OlaLabelCanvas item={olaItem} media={mode} serial={nextSerial} />
          </div>
        </section>
      </div>

      {/* Show ZPL modal */}
      {zplOpen ? (
        <>
          <button type="button" aria-label="Close" className="fixed inset-0 z-[80] bg-black/70 backdrop-blur-sm" onClick={() => setZplOpen(false)} />
          <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
            <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[var(--wms-border)] bg-[var(--wms-surface)] shadow-2xl">
              <div className="flex items-center justify-between border-b border-[var(--wms-border)] px-4 py-3">
                <h3 className="font-mono text-sm font-semibold text-[var(--wms-fg)]">
                  Raw ZPL <span className="font-normal text-[var(--wms-muted)]">· {qty} label(s) · {batchZpl.length} chars</span>
                </h3>
                <div className="flex gap-2">
                  <button type="button" onClick={() => void copyZpl()} className="inline-flex items-center gap-1 rounded border border-[var(--wms-border)] px-2 py-1 font-mono text-[0.7rem] text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)]">
                    <Copy className="h-3.5 w-3.5" /> Copy
                  </button>
                  <button type="button" onClick={() => setZplOpen(false)} className="rounded p-1.5 text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)] hover:text-[var(--wms-fg)]" aria-label="Close">
                    <X className="h-5 w-5" />
                  </button>
                </div>
              </div>
              <pre className="m-0 overflow-auto whitespace-pre px-4 py-3 font-mono text-xs leading-relaxed text-[var(--wms-fg)]">{batchZpl}</pre>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
