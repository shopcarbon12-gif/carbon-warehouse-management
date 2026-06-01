"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Code2, Copy, Minus, Plus, Printer, Settings2, X } from "lucide-react";
import { buildOlaHangtagZplBatch, type OlaLabelItem } from "@/lib/utils/zpl-ola-hangtag";
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

export function PrintTagsWorkspace({ mode, companyPrefix }: { mode: Mode; companyPrefix: number }) {
  const rfid = mode === "rfid";

  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [matches, setMatches] = useState<Match[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<Match | null>(null);

  const [qty, setQty] = useState(1);
  const [addStock, setAddStock] = useState(false);
  const [bins, setBins] = useState<BinRow[]>([]);
  const [binId, setBinId] = useState("");

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pnPrinters, setPnPrinters] = useState<PnPrinter[]>([]);
  const [pnPrinterId, setPnPrinterId] = useState<number | "">("");

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

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(search.trim()), 260);
    return () => window.clearTimeout(t);
  }, [search]);

  // search + auto-select when exactly one match (no extra click)
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
        const list = data.matches ?? [];
        if (cancelled) return;
        if (list.length === 1 && (!selected || selected.id !== list[0]!.id)) {
          pick(list[0]!); // single hit → select automatically
        } else {
          setMatches(list);
        }
      } finally {
        if (!cancelled) setSearching(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  useEffect(() => {
    if (rfid) return;
    void (async () => {
      try {
        const res = await fetch("/api/printnode/printers");
        if (!res.ok) return;
        const data = (await res.json()) as { printers?: PnPrinter[] };
        const list = data.printers ?? [];
        setPnPrinters(list);
        if (list[0]) setPnPrinterId((prev) => (prev === "" ? list[0]!.id : prev));
      } catch {
        /* non-fatal */
      }
    })();
  }, [rfid]);

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

  function pick(m: Match) {
    setSelected(m);
    setSearch(m.sku);
    setMatches([]);
    setMessage(null);
    setError(null);
  }

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

    setPhase("ENCODING");
    setElapsedMs(0);
    try {
      if (rfid) {
        // 1) commission (DB encode + audit). Bin is optional: null = inherit the
        //    bin where this UPC already lives, else stays unassigned.
        const res = await fetch("/api/rfid/commission", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Carbon-Client-Print": "1" },
          body: JSON.stringify({
            customSkuId: selected.id,
            qty,
            binId: binId || null,
            addToInventory: addStock,
            companyPrefix,
          }),
        });
        const data = (await res.json()) as {
          error?: string;
          inserted?: { epc: string; serial_number: number }[];
          status_final?: string;
          zpl?: string;
        };
        if (!res.ok) {
          stopTimer();
          setPhase("ERROR");
          return setError(data.error ?? "Commission failed");
        }
        const inserted = data.inserted ?? [];
        // 2) print the label the commission API built (canonical zpl-carbon-tag,
        //    calibrated on the printer), via PrintNode — the cloud WMS can't
        //    reach the LAN printer from HTTPS.
        setPhase("PRINTING");
        const pres = await fetch("/api/printnode/print", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            zpl: data.zpl,
            item: olaItem,
            qty: inserted.length || qty,
            includeRfid: true,
            serials: inserted.map((r) => r.serial_number),
            companyPrefix,
            printerKind: "rfid",
          }),
        });
        const pdata = (await pres.json()) as { error?: string; jobId?: number };
        stopTimer();
        setPhase("SUCCESS");
        setLastJob(inserted.map((r) => r.epc));
        const stock = data.status_final ?? (addStock ? "in-stock" : "commissioned");
        setMessage(
          pres.ok
            ? `Created ${inserted.length} tag(s) — ${stock}. Sent to PrintNode (job #${pdata.jobId}). Audit: rfid_print.`
            : `Created ${inserted.length} tag(s) — ${stock}, but PRINT failed: ${pdata.error}. Items saved.`,
        );
      } else {
        setPhase("PRINTING");
        const res = await fetch("/api/printnode/print", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            item: olaItem,
            qty,
            includeRfid: false,
            startSerial: nextSerial,
            printerId: pnPrinterId === "" ? undefined : pnPrinterId,
            printerKind: "nonrfid",
          }),
        });
        const data = (await res.json()) as { error?: string; jobId?: number };
        if (!res.ok) {
          stopTimer();
          setPhase("ERROR");
          return setError(data.error ?? "PrintNode submit failed");
        }
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
  }, [selected, olaItem, addStock, binId, rfid, companyPrefix, qty, pnPrinterId, nextSerial, stopTimer]);

  // ---- house-style UI ----
  const cardCls = "rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80 p-4";
  const headCls = "flex items-center gap-2";
  const h2Cls = "m-0 font-mono text-[0.7rem] font-semibold uppercase tracking-wider text-[var(--wms-muted)]";
  const stepNo = (n: number) => (
    <span className="grid h-5 w-5 place-items-center rounded border border-[color-mix(in_srgb,var(--wms-accent)_40%,var(--wms-border))] bg-[color-mix(in_srgb,var(--wms-accent)_16%,var(--wms-surface-elevated))] font-mono text-[0.6rem] font-bold text-[var(--wms-accent)]">
      {n}
    </span>
  );

  const activeIdx = phase === "ERROR" ? 0 : Math.max(0, STEPS.indexOf(phase));
  const stepLabel = (p: Phase) =>
    p === "ENCODING" ? (rfid ? "Encoding" : "Sending") : p === "IDLE" ? "Idle (ready)" : p[0] + p.slice(1).toLowerCase();
  const note =
    phase === "ENCODING"
      ? rfid
        ? "Commission API: DB encode → audit…"
        : "Building ZPL…"
      : phase === "PRINTING"
        ? "PrintNode → local client → printer…"
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
    <div className="flex flex-col gap-4 lg:grid lg:grid-cols-2 lg:gap-4">
      {/* LEFT column (find / qty / print) */}
      <div className="contents lg:flex lg:flex-col lg:gap-4">
        {/* 1 — find product */}
        <section className={`${cardCls} order-1`}>
          <div className={headCls}>
            {stepNo(1)}
            <h2 className={h2Cls}>Find product</h2>
          </div>
          <p className="mt-1.5 font-mono text-[0.65rem] text-[var(--wms-muted)]">
            System ID · SKU · UPC / EAN · or matrix description — type 2+ characters.
          </p>
          <div className="relative mt-2.5">
            <input
              type="search"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                if (selected && e.target.value !== selected.sku) setSelected(null);
              }}
              placeholder="Search catalog…"
              autoComplete="off"
              className="w-full rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-sm text-[var(--wms-fg)] placeholder:text-[var(--wms-muted)] focus:border-[var(--wms-accent)]/50 focus:outline-none focus:ring-1 focus:ring-[var(--wms-accent)]/30"
            />
            {searching ? (
              <p className="mt-1.5 font-mono text-[0.65rem] text-[var(--wms-muted)]">Searching…</p>
            ) : null}
            {matches.length > 0 ? (
              <ul className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] py-1 shadow-xl">
                {matches.map((m) => (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => pick(m)}
                      className="w-full px-3 py-1.5 text-left font-mono text-xs hover:bg-[color-mix(in_srgb,var(--wms-accent)_12%,var(--wms-surface-elevated))]"
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
            <div className="mt-2.5 rounded-md border border-[var(--wms-accent)]/35 bg-[color-mix(in_srgb,var(--wms-accent)_9%,var(--wms-surface))] px-3 py-2 font-mono text-xs text-[var(--wms-fg)]">
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

        {/* 2 — quantity (+ placement, RFID only) */}
        <section className={`${cardCls} order-2`}>
          <div className={headCls}>
            {stepNo(2)}
            <h2 className={h2Cls}>{rfid ? "Quantity & placement" : "Quantity"}</h2>
          </div>
          <div className={`mt-3 grid gap-3 ${rfid ? "grid-cols-2" : "grid-cols-1"}`}>
            <div>
              <span className="mb-1.5 block font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-muted)]">
                Quantity
              </span>
              <div className="flex h-10 items-stretch overflow-hidden rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]">
                <button type="button" onClick={() => bumpQty(-1)} className="grid w-10 place-items-center text-[var(--wms-fg)] hover:bg-[color-mix(in_srgb,var(--wms-accent)_14%,transparent)]" aria-label="Decrease">
                  <Minus className="h-4 w-4" />
                </button>
                <input
                  type="number"
                  min={1}
                  max={500}
                  value={qty}
                  onChange={(e) => setQty(Math.max(1, Math.min(500, Number(e.target.value) || 1)))}
                  className="w-full min-w-0 flex-1 border-0 bg-transparent text-center font-mono text-base tabular-nums text-[var(--wms-fg)] outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                />
                <button type="button" onClick={() => bumpQty(1)} className="grid w-10 place-items-center text-[var(--wms-fg)] hover:bg-[color-mix(in_srgb,var(--wms-accent)_14%,transparent)]" aria-label="Increase">
                  <Plus className="h-4 w-4" />
                </button>
              </div>
            </div>
            {rfid ? (
              <div>
                <span className="mb-1.5 block font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-muted)]">
                  Add to inventory
                </span>
                <button
                  type="button"
                  onClick={() => setAddStock((v) => !v)}
                  className="flex h-10 w-full items-center justify-center gap-2.5 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]"
                >
                  <span className={`relative h-5 w-9 rounded-full transition ${addStock ? "bg-[var(--wms-accent)]" : "bg-[color-mix(in_srgb,var(--wms-muted)_40%,transparent)]"}`}>
                    <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${addStock ? "left-[1.15rem]" : "left-0.5"}`} />
                  </span>
                  <span className="font-mono text-xs text-[var(--wms-fg)]">{addStock ? "On" : "Off"}</span>
                </button>
              </div>
            ) : null}
          </div>
          {rfid && addStock ? (
            <label className="mt-3 block">
              <span className="mb-1.5 block font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-muted)]">
                Bin (optional)
              </span>
              <select
                value={binId}
                onChange={(e) => setBinId(e.target.value)}
                className="w-full rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2 font-mono text-sm text-[var(--wms-fg)]"
              >
                <option value="">— Auto (where its UPC lives) —</option>
                {bins.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.code}
                  </option>
                ))}
              </select>
              <span className="mt-1 block font-mono text-[0.55rem] text-[var(--wms-muted)]">
                Leave on Auto: the tag joins the bin its UPC already occupies, or stays unassigned.
              </span>
            </label>
          ) : null}
        </section>

        {/* 3 — print */}
        <section className={`${cardCls} order-3`}>
          <div className={headCls}>
            {stepNo(3)}
            <h2 className={h2Cls}>{rfid ? "Encode & print" : "Print"}</h2>
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => (batchZpl ? setZplOpen(true) : setError("Select a product first."))}
              className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg border border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-muted)_12%,var(--wms-surface-elevated))] py-2 font-mono text-xs font-medium text-[var(--wms-fg)] hover:border-[var(--wms-accent)]/50"
            >
              <Code2 className="h-4 w-4" /> Show ZPL
            </button>
            <button
              type="button"
              onClick={() => void copyZpl()}
              className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg border border-[var(--wms-border)] bg-[color-mix(in_srgb,var(--wms-muted)_12%,var(--wms-surface-elevated))] py-2 font-mono text-xs font-medium text-[var(--wms-fg)] hover:border-[var(--wms-accent)]/50"
            >
              <Copy className="h-4 w-4" /> Copy ZPL
            </button>
          </div>
          <button
            type="button"
            disabled={!selected || busy}
            onClick={() => void onPrint()}
            className="wms-btn-primary mt-2.5 inline-flex w-full font-mono disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Printer className="h-4 w-4" strokeWidth={2} />
            Print tag
          </button>
          {error ? <p className="mt-2.5 font-mono text-xs text-[var(--wms-status-danger-fg)]">{error}</p> : null}
          {message ? <p className="mt-2.5 font-mono text-xs font-medium text-[var(--wms-accent)]">{message}</p> : null}
        </section>

        {/* settings drawer */}
        <details className="order-6 overflow-hidden rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/80" open={settingsOpen}>
          <summary
            onClick={(e) => {
              e.preventDefault();
              setSettingsOpen((v) => !v);
            }}
            className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 font-mono text-[0.7rem] font-semibold uppercase tracking-wider text-[var(--wms-muted)]"
          >
            <Settings2 className="h-4 w-4" />
            {rfid ? "RFID / printer settings" : "Printer settings (PrintNode)"}
            <ChevronDown className={`ml-auto h-4 w-4 transition-transform ${settingsOpen ? "rotate-180" : ""}`} />
          </summary>
          <div className="space-y-3 border-t border-[var(--wms-border)] px-4 py-4">
            {rfid ? (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <label className="block font-mono text-[0.6rem] uppercase text-[var(--wms-muted)]">
                    Company prefix (20-bit)
                    <input readOnly value={companyPrefix} className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/60 px-2 py-1.5 font-mono text-sm text-[var(--wms-muted)]" />
                  </label>
                  <label className="block font-mono text-[0.6rem] uppercase text-[var(--wms-muted)]">
                    Bit split (item / serial)
                    <input readOnly value="40 / 36" className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/60 px-2 py-1.5 font-mono text-sm text-[var(--wms-muted)]" />
                  </label>
                </div>
                <p className="font-mono text-[0.6rem] leading-relaxed text-[var(--wms-muted)]">
                  RFID hang-tag (5 × 6.5 cm) with Code 39 + chip encode (^RFW). Prints via PrintNode
                  to the Zebra (must be added to PrintNode as the RFID printer).
                </p>
              </>
            ) : (
              <>
                <label className="block font-mono text-[0.6rem] uppercase text-[var(--wms-muted)]">
                  PrintNode printer
                  <select
                    value={pnPrinterId}
                    onChange={(e) => setPnPrinterId(e.target.value ? Number(e.target.value) : "")}
                    className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1.5 font-mono text-sm text-[var(--wms-fg)]"
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
                  Non-RFID tags print on 2 × 3 in stock via PrintNode. Same artwork as RFID — no chip
                  encode, no inventory placement.
                </p>
              </>
            )}
          </div>
        </details>
      </div>

      {/* RIGHT column (status / preview) */}
      <div className="contents lg:flex lg:flex-col lg:gap-4">
        {/* status */}
        <section className={`${cardCls} order-5`}>
          <div className="flex items-center justify-between gap-3">
            <h2 className={h2Cls}>{rfid ? "RFID task status" : "Print status"}</h2>
            <span className={`font-mono text-sm tabular-nums ${phase === "IDLE" ? "text-[var(--wms-muted)]" : "font-semibold text-[var(--wms-accent)]"}`}>
              {String(Math.floor(elapsedMs / 60000)).padStart(2, "0")}:{String(Math.floor(elapsedMs / 1000) % 60).padStart(2, "0")}
            </span>
          </div>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {STEPS.map((p, i) => {
              const done = phase !== "ERROR" && i < activeIdx;
              const current = phase !== "ERROR" && i === activeIdx;
              return (
                <div
                  key={p}
                  className={`flex items-center gap-1.5 rounded border px-2 py-1 font-mono text-[0.6rem] uppercase tracking-wide ${
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
          <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-[var(--wms-surface-elevated)]">
            <div
              className={`h-full transition-all duration-300 ${phase === "ERROR" ? "bg-red-500/70" : "bg-[var(--wms-accent)]"}`}
              style={{ width: phase === "ERROR" ? "100%" : ["0%", "33%", "66%", "100%"][activeIdx] }}
            />
          </div>
          <p className="mt-2.5 font-mono text-[0.65rem] text-[var(--wms-muted)]">{note}</p>
          {lastJob.length > 0 ? (
            <div className="mt-2.5 max-h-36 overflow-auto border-t border-[var(--wms-border)]/70 pt-2">
              <p className="font-mono text-[0.55rem] uppercase tracking-wider text-[var(--wms-muted)]">
                {rfid ? "Last job — EPCs (hex)" : "Last job — labels sent"}
              </p>
              <ul className="mt-1 space-y-0.5 font-mono text-[0.6rem] text-[var(--wms-accent)]">
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
            <span className="font-mono text-[0.6rem] normal-case text-[var(--wms-muted)]">· rendered from live ZPL</span>
          </div>
          <div className="mt-3 grid place-items-center">
            <OlaLabelCanvas item={olaItem} media={mode} serial={nextSerial} />
          </div>
        </section>
      </div>

      {/* Show ZPL modal */}
      {zplOpen ? (
        <>
          <button type="button" aria-label="Close" className="fixed inset-0 z-[80] bg-black/70 backdrop-blur-sm" onClick={() => setZplOpen(false)} />
          <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
            <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] shadow-2xl">
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
