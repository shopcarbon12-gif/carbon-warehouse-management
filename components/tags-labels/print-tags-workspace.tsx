"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildOlaHangtagZplBatch, type OlaLabelItem } from "@/lib/utils/zpl-ola-hangtag";
import { PrintLogsModal } from "@/components/rfid/commissioning/print-logs-modal";
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
const STEPS: { p: Phase; label: string }[] = [
  { p: "IDLE", label: "Idle (ready)" },
  { p: "ENCODING", label: "Encoding" },
  { p: "PRINTING", label: "Printing" },
  { p: "SUCCESS", label: "Success" },
];

type BinRow = { id: string; code: string };

function parsePrinterLine(line: string): { host: string; port: number; uri: string } {
  const m = line.trim().match(/^(.+):(\d+)\s*\/\s*(.+)$/);
  if (!m) return { host: "192.168.1.3", port: 80, uri: "PSTPRNT" };
  const port = Number.parseInt(m[2], 10);
  return { host: m[1].trim(), port: Number.isFinite(port) && port > 0 ? port : 80, uri: m[3].trim() || "PSTPRNT" };
}

const I = {
  theme: "M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19",
};

export function PrintTagsWorkspace({ mode, companyPrefix }: { mode: Mode; companyPrefix: number }) {
  const rfid = mode === "rfid";

  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [matches, setMatches] = useState<Match[]>([]);
  const [selected, setSelected] = useState<Match | null>(null);

  const [qty, setQty] = useState(1);
  const [addStock, setAddStock] = useState(false);
  const [bins, setBins] = useState<BinRow[]>([]);
  const [binId, setBinId] = useState("");

  const [printerLine, setPrinterLine] = useState(
    rfid ? "192.168.1.3:80 / PSTPRNT" : "192.168.1.220:80 / PSTPRNT",
  );

  const [phase, setPhase] = useState<Phase>("IDLE");
  const [elapsedMs, setElapsedMs] = useState(0);
  const timerRef = useRef<number | null>(null);
  const startRef = useRef<number | null>(null);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [lastJob, setLastJob] = useState<string[]>([]);
  const [nextSerial, setNextSerial] = useState(1);
  const [zplOpen, setZplOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const busy = phase === "ENCODING" || phase === "PRINTING";

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(search.trim()), 260);
    return () => window.clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (debounced.length < 2 || (selected && debounced === selected.sku)) {
      setMatches([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/rfid/catalog-search?q=${encodeURIComponent(debounced)}`);
        if (!res.ok || cancelled) return;
        const list = ((await res.json()) as { matches?: Match[] }).matches ?? [];
        if (cancelled) return;
        if (list.length === 1) pick(list[0]!);
        else setMatches(list);
      } catch {
        /* non-fatal */
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
  }

  const bumpQty = (d: number) => setQty((q) => Math.max(1, Math.min(500, q + d)));
  const stopTimer = useCallback(() => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = null;
    if (startRef.current) setElapsedMs(Date.now() - startRef.current);
  }, []);

  const copyZpl = useCallback(async () => {
    if (!batchZpl) return setMessage({ text: "Select a product first.", ok: false });
    try {
      await navigator.clipboard.writeText(batchZpl);
      setMessage({ text: `Copied full ZPL — ${qty} label(s), ${batchZpl.length} chars.`, ok: true });
    } catch {
      setMessage({ text: "Clipboard blocked — open Show ZPL to copy manually.", ok: false });
    }
  }, [batchZpl, qty]);

  const onPrint = useCallback(async () => {
    setMessage(null);
    setLastJob([]);
    if (!selected || !olaItem) return setMessage({ text: "Select a product from search.", ok: false });
    setPhase("ENCODING");
    setElapsedMs(0);
    try {
      if (rfid) {
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
          }),
        });
        const data = (await res.json()) as {
          error?: string;
          inserted?: { epc: string; serial_number: number }[];
          status_final?: string;
          zpl?: string;
          printer_host?: string;
          printer_port?: number;
          printer_uri?: string;
        };
        if (!res.ok) {
          stopTimer();
          setPhase("ERROR");
          return setMessage({ text: data.error ?? "Commission failed", ok: false });
        }
        const inserted = data.inserted ?? [];
        setPhase("PRINTING");
        const printUrl = `http://${data.printer_host ?? host}:${data.printer_port ?? port}/${(data.printer_uri ?? uri).toLowerCase()}`;
        let printerOk = false;
        let printerErr: string | null = null;
        if (data.zpl) {
          try {
            await fetch(printUrl, {
              method: "POST",
              headers: { "Content-Type": "text/plain; charset=utf-8" },
              body: data.zpl,
              mode: "no-cors",
              signal: AbortSignal.timeout(10_000),
            });
            printerOk = true;
          } catch (e) {
            printerErr = e instanceof Error ? e.message : "Printer fetch failed";
          }
        }
        await new Promise((r) => window.setTimeout(r, 1200));
        stopTimer();
        setPhase("SUCCESS");
        setLastJob(inserted.map((r) => r.epc));
        const stock = data.status_final ?? (addStock ? "in-stock" : "commissioned");
        setMessage({
          ok: printerOk,
          text: printerOk
            ? `Created ${inserted.length} tag(s) — ${stock}. Sent to ${printUrl}. Audit: rfid_print.`
            : `Created ${inserted.length} tag(s) — ${stock}. Printer unreachable (${printUrl}): ${printerErr}. Items saved.`,
        });
      } else {
        // Non-RFID: no DB encode — build the no-chip ZPL and print straight to
        // the network label printer (192.168.1.220), browser-direct.
        const { host, port, uri } = parsePrinterLine(printerLine);
        setPhase("PRINTING");
        const zpl = buildOlaHangtagZplBatch(olaItem, nextSerial, qty, { includeRfid: false, companyPrefix });
        const printUrl = `http://${host}:${port}/${uri.toLowerCase()}`;
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
        setLastJob(Array.from({ length: qty }, (_, i) => `${selected.sku} · label ${i + 1}/${qty}`));
        setMessage({
          ok: printerOk,
          text: printerOk
            ? `Sent ${qty} label(s) to ${printUrl}.`
            : `Printer unreachable (${printUrl}): ${printerErr}.`,
        });
      }
      window.setTimeout(() => setPhase("IDLE"), 4500);
    } catch {
      stopTimer();
      setPhase("ERROR");
      setMessage({ text: "Network error", ok: false });
    }
  }, [selected, olaItem, addStock, binId, rfid, printerLine, companyPrefix, qty, nextSerial, stopTimer]);

  const toggleTheme = () => {
    const el = document.documentElement;
    el.dataset.theme = el.dataset.theme === "light" ? "dark" : "light";
  };

  const activeIdx = phase === "ERROR" ? 0 : Math.max(0, STEPS.findIndex((s) => s.p === phase));
  const mmss = `${String(Math.floor(elapsedMs / 60000)).padStart(2, "0")}:${String(Math.floor(elapsedMs / 1000) % 60).padStart(2, "0")}`;
  const note =
    phase === "ENCODING"
      ? rfid ? "Commission API: DB encode → audit…" : "Building ZPL…"
      : phase === "PRINTING"
        ? `Printing to ${parsePrinterLine(printerLine).host}…`
        : phase === "SUCCESS"
          ? rfid ? "Job complete — rfid_print audit written." : "Job complete — sent to printer."
          : phase === "ERROR" ? "Job aborted — see message below."
            : rfid ? "Ready — select a SKU and run print & commission." : "Ready — select a SKU and print labels.";

  const pp = parsePrinterLine(printerLine);
  return (
    <div className={`shell ${rfid ? "tab-rfid" : "tab-nonrfid"}`}>
      <div className="topbar">
        <div className="brand">
          <span className="k">Carbon WMS · Tags &amp; Labels</span>
          <span className="t">{rfid ? "RFID commissioning console" : "Label printing console"}</span>
        </div>
        <div className="spacer" />
        <span className="pill">
          <span className="dot" /> {pp.host} · {pp.uri}
        </span>
        <button type="button" className="ghost-btn" onClick={toggleTheme}>
          <svg className="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" /><path d={I.theme} /></svg>
          Theme
        </button>
        <button type="button" className="ghost-btn" onClick={() => setLogsOpen(true)}>
          <svg className="icon" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M8 13h8M8 17h6" /></svg>
          Print logs
        </button>
      </div>

      <h1 className="page">Print tags</h1>
      <p className="page-sub">
        {rfid
          ? "Commission RFID hang-tags: find the product, set quantity and placement, preview the tag exactly as it prints, then encode & print in one pass. Every job is SGTIN-encoded and audit-logged (rfid_print)."
          : "Print non-RFID hang-tags: find the product, set quantity, preview the tag exactly as it prints, then print to the label printer (192.168.1.220). Same artwork as RFID tags — no chip encode."}
      </p>

      <div className="tabs" role="tablist">
        <Link href="/tags-labels/print/rfid" role="tab" className={`tab ${rfid ? "active" : ""}`}>
          <span className="tdot" />RFID tags
        </Link>
        <Link href="/tags-labels/print/non-rfid" role="tab" className={`tab ${!rfid ? "active" : ""}`}>
          <span className="tdot" />Non-RFID tags
        </Link>
      </div>

      <div className="grid">
        {/* LEFT */}
        <div>
          {/* 1 — find */}
          <section className="card m-find">
            <div className="card-h"><span className="step-no">1</span><h2>Find product</h2></div>
            <p className="hint">System ID · SKU · UPC / EAN · or matrix description — type 2+ characters.</p>
            <div className="search-wrap">
              <input
                className="input mono"
                type="search"
                placeholder="Search catalog…"
                autoComplete="off"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  if (selected && e.target.value !== selected.sku) setSelected(null);
                }}
              />
              {matches.length > 0 ? (
                <div className="results">
                  {matches.map((m) => (
                    <button key={m.id} type="button" className="result" onMouseDown={(e) => { e.preventDefault(); pick(m); }}>
                      <span className="sku">{m.sku}</span>
                      <span className="mut"> · {m.color ?? "—"} · sz {m.size ?? "—"} · ${Math.trunc(Number(m.price) || 0)}</span>
                      <br />
                      <span className="mut">UPC {m.upc ?? "—"} · {m.description ?? "—"}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            {selected ? (
              <div className="selected">
                <span className="sku">{selected.sku}</span> <span className="mut">·</span> {selected.description ?? "—"}
                <div className="row2">
                  {selected.color ?? "—"} · size {selected.size ?? "—"} · ${Math.trunc(Number(selected.price) || 0)} · UPC{" "}
                  {selected.upc ?? "—"} · System ID {selected.ls_system_id}
                </div>
              </div>
            ) : null}
          </section>

          {/* 2 — quantity */}
          <section className="card m-qty">
            <div className="card-h"><span className="step-no">2</span><h2>{rfid ? "Quantity & placement" : "Quantity"}</h2></div>
            <div className="two" style={{ marginTop: 14 }}>
              <div>
                <span style={{ display: "block", fontFamily: "'JetBrains Mono',monospace", fontSize: "13.5px", textTransform: "uppercase", letterSpacing: ".08em", color: "var(--wms-muted)", marginBottom: 7 }}>Quantity</span>
                <div className="stepper">
                  <button type="button" onClick={() => bumpQty(-1)}>−</button>
                  <input className="mono" type="number" min={1} max={500} value={qty} onChange={(e) => setQty(Math.max(1, Math.min(500, Number(e.target.value) || 1)))} />
                  <button type="button" onClick={() => bumpQty(1)}>+</button>
                </div>
              </div>
              {rfid ? (
                <div>
                  <span style={{ display: "block", fontFamily: "'JetBrains Mono',monospace", fontSize: "13.5px", textTransform: "uppercase", letterSpacing: ".08em", color: "var(--wms-muted)", marginBottom: 7 }}>Add to inventory</span>
                  <div className={`toggle ${addStock ? "on" : ""}`} onClick={() => setAddStock((v) => !v)}>
                    <span className="switch" />
                    <span className="lab">{addStock ? "On" : "Off"}</span>
                  </div>
                </div>
              ) : null}
            </div>
            {rfid && addStock ? (
              <label className="fld">
                <span>Bin (optional)</span>
                <select className="input" value={binId} onChange={(e) => setBinId(e.target.value)}>
                  <option value="">— Auto (where its UPC lives) —</option>
                  {bins.map((b) => (
                    <option key={b.id} value={b.id}>{b.code}</option>
                  ))}
                </select>
              </label>
            ) : null}
          </section>

          {/* 3 — print */}
          <section className="card m-print">
            <div className="card-h"><span className="step-no">3</span><h2>{rfid ? "Encoding & print" : "Print"}</h2></div>
            <p className="hint" style={{ marginTop: 8 }}>
              {rfid
                ? "SGTIN-encoded + audit-logged on print. Inspect or copy the raw Zebra ZPL before sending."
                : "Printed via PrintNode. Inspect or copy the raw ZPL before sending."}
            </p>
            <div className="actions">
              <button type="button" className="ghost-btn" onClick={() => (batchZpl ? setZplOpen(true) : setMessage({ text: "Select a product first.", ok: false }))}>
                <svg className="icon" viewBox="0 0 24 24"><path d="M16 18l6-6-6-6" /><path d="M8 6l-6 6 6 6" /></svg>
                Show ZPL
              </button>
              <button type="button" className="ghost-btn" onClick={() => void copyZpl()}>
                <svg className="icon" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>
                Copy ZPL
              </button>
            </div>
            <button type="button" className="primary" disabled={!selected || busy} onClick={() => void onPrint()}>
              <svg className="icon" viewBox="0 0 24 24" style={{ width: 17, height: 17 }}><path d="M6 9V2h12v7" /><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><rect x="6" y="14" width="12" height="8" /></svg>
              Print tag
            </button>
            {message ? <p className={`msg ${message.ok ? "ok" : "err"}`}>{message.text}</p> : null}
          </section>

          {/* settings drawer */}
          <details className="drawer">
            <summary>
              <svg className="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9z" /></svg>
              {rfid ? "RFID / printer settings" : "Printer settings (PrintNode)"}
            </summary>
            <div className="body">
              {rfid ? (
                <>
                  <div className="two">
                    <label className="fld" style={{ marginTop: 0 }}><span>Company prefix (20-bit)</span><input className="input ro" value={companyPrefix} readOnly /></label>
                    <div className="two" style={{ gap: 10 }}>
                      <label className="fld" style={{ marginTop: 0 }}><span>Bits — item</span><input className="input ro" value="40" readOnly /></label>
                      <label className="fld" style={{ marginTop: 0 }}><span>Bits — serial</span><input className="input ro" value="36" readOnly /></label>
                    </div>
                  </div>
                  <label className="fld"><span>Printer (host:port / URI)</span><input className="input" value={printerLine} onChange={(e) => setPrinterLine(e.target.value)} /></label>
                  <p className="locknote">RFID hang-tag (5 × 6.5 cm), Code 39 + chip encode (^RFW). Prints straight to the network Zebra over the LAN.</p>
                </>
              ) : (
                <>
                  <label className="fld"><span>Printer (host:port / URI)</span><input className="input" value={printerLine} onChange={(e) => setPrinterLine(e.target.value)} /></label>
                  <p className="locknote">Non-RFID label printer at 192.168.1.220 (network). Same hang-tag artwork as RFID — no chip encode.</p>
                </>
              )}
            </div>
          </details>
        </div>

        {/* RIGHT */}
        <div>
          <section className="card m-status">
            <div className="status-head">
              <div className="card-h" style={{ margin: 0 }}><h2>{rfid ? "RFID task status" : "Print status"}</h2></div>
              <span className={`timer ${phase !== "IDLE" ? "live" : ""}`}>{mmss}</span>
            </div>
            <div className="steps">
              {STEPS.map((s, i) => {
                const cls = phase === "ERROR" ? "" : i < activeIdx ? "done" : i === activeIdx ? "current" : "";
                const label = s.p === "ENCODING" && !rfid ? "Sending" : s.label;
                return (
                  <div key={s.p} className={`chip ${cls}`}><span className="b" />{label}</div>
                );
              })}
            </div>
            <div className="progress">
              <i style={{ width: phase === "ERROR" ? "100%" : ["0%", "33%", "66%", "100%"][activeIdx], background: phase === "ERROR" ? "#f87171" : undefined }} />
            </div>
            <p className="status-note">{note}</p>
            {lastJob.length > 0 ? (
              <div className="epc-list">
                <p style={{ margin: "0 0 4px", fontFamily: "'JetBrains Mono',monospace", fontSize: "11px", textTransform: "uppercase", letterSpacing: ".06em", color: "var(--wms-muted)" }}>
                  {rfid ? "Last job — EPCs (hex)" : "Last job — labels sent"}
                </p>
                <ul>{lastJob.map((e) => (<li key={e}>{e}</li>))}</ul>
              </div>
            ) : null}
          </section>

          <section className="card m-preview">
            <div className="card-h"><h2>Label preview <span style={{ color: "var(--wms-muted)", fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>· rendered from live ZPL</span></h2></div>
            <OlaLabelCanvas item={olaItem} media={mode} serial={nextSerial} />
          </section>
        </div>
      </div>

      {/* ZPL modal */}
      {zplOpen ? (
        <>
          <div className="overlay" onClick={() => setZplOpen(false)} />
          <div className="modal">
            <div className="box">
              <div className="mh">
                <h3>Raw ZPL <span className="mono" style={{ color: "var(--wms-muted)", fontWeight: 400, fontSize: 12 }}>· {qty} label(s) · {batchZpl.length} chars</span></h3>
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" className="ghost-btn" onClick={() => void copyZpl()}>
                    <svg className="icon" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>
                    Copy
                  </button>
                  <button type="button" className="ghost-btn" onClick={() => setZplOpen(false)}>Close</button>
                </div>
              </div>
              <div className="mb"><pre className="zpl-pre mono">{batchZpl}</pre></div>
            </div>
          </div>
        </>
      ) : null}

      <PrintLogsModal open={logsOpen} onClose={() => setLogsOpen(false)} />
    </div>
  );
}
