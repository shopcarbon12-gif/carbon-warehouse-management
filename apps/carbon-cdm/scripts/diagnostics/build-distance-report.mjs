#!/usr/bin/env node
// Build the distance HTML report from a captured EPC snapshot.
//
// Usage:
//   node build-distance-report.mjs \
//     --in /tmp/captured-max.json \
//     --out /home/max_distance.html \
//     --title "TEST3 (192.168.1.22) — Max Power (32 dBm)" \
//     --token cdm_xxx
//
// Local decode replicates lib/server/epc-decode.ts (Carbon Jeans tenant_epc_config:
//   prefix F0A0B, 20-bit prefix + 40-bit asset (=ls_system_id) + 36-bit serial).
// Catalog enrichment is fetched via /api/cdm-agents/lookup-by-epc (Bearer token).
// If the endpoint isn't deployed yet, catalog cells fall back to "—".

import fs from "node:fs/promises";

const argv = Object.fromEntries(
  process.argv.slice(2).reduce((acc, v, i, arr) => {
    if (v.startsWith("--")) acc.push([v.slice(2), arr[i + 1]]);
    return acc;
  }, []),
);
const IN = String(argv.in);
const OUT = String(argv.out);
const TITLE = String(argv.title ?? "Distance Report");
const TOKEN = argv.token ? String(argv.token) : null;
const WMS = String(argv.wms ?? "https://wms.shopcarbon.com");

// Carbon Jeans tenant_epc_config (matches lib/server/epc-decode.ts contract).
const CFG = {
  prefixHex: "F0A0B",
  prefixBits: 20,
  assetBits: 40,
  serialBits: 36,
  assetPaddingDigits: 14,
};

const HEX_RE = /^[0-9A-F]+$/;
const ONE = BigInt(1);

function decodeEpc(epcHexInput) {
  const epcHex = (epcHexInput ?? "").trim().toUpperCase();
  if (epcHex.length !== 24)
    return { valid: false, reason: "bad_length", prefixHex: "", systemId: null, serial: null };
  if (!HEX_RE.test(epcHex))
    return { valid: false, reason: "bad_hex", prefixHex: "", systemId: null, serial: null };
  const total = CFG.prefixBits + CFG.assetBits + CFG.serialBits;
  if (total !== 96)
    return { valid: false, reason: "bad_config", prefixHex: "", systemId: null, serial: null };

  const bits96 = BigInt("0x" + epcHex);
  const prefixShift = CFG.assetBits + CFG.serialBits;
  const prefixMask = (ONE << BigInt(CFG.prefixBits)) - ONE;
  const prefixVal = (bits96 >> BigInt(prefixShift)) & prefixMask;

  const expectedPrefixVal = BigInt("0x" + CFG.prefixHex);
  if (prefixVal !== expectedPrefixVal) {
    const prefixHexRead = prefixVal
      .toString(16)
      .toUpperCase()
      .padStart(Math.ceil(CFG.prefixBits / 4), "0");
    return { valid: false, reason: "wrong_prefix", prefixHex: prefixHexRead, systemId: null, serial: null };
  }

  const assetMask = (ONE << BigInt(CFG.assetBits)) - ONE;
  const assetVal = (bits96 >> BigInt(CFG.serialBits)) & assetMask;
  const serialMask = (ONE << BigInt(CFG.serialBits)) - ONE;
  const serialVal = bits96 & serialMask;

  return {
    valid: true,
    prefixHex: CFG.prefixHex.toUpperCase(),
    systemId: assetVal,
    serial: serialVal,
  };
}

function hexToBinary(hex) {
  return hex
    .split("")
    .map((c) => parseInt(c, 16).toString(2).padStart(4, "0"))
    .join("");
}

// Best-effort categorisation of how strong the read was. The reader streams
// dBm; closer reads are less negative. Buckets are heuristic — actual physical
// distance varies with antenna gain and environment.
function distanceBucket(rssi) {
  if (rssi >= -55) return { label: "very close", order: 0, color: "#0f9c4f" };
  if (rssi >= -65) return { label: "close", order: 1, color: "#3fb35d" };
  if (rssi >= -75) return { label: "near", order: 2, color: "#bcbf2c" };
  if (rssi >= -85) return { label: "mid", order: 3, color: "#dd9b2c" };
  if (rssi >= -95) return { label: "far", order: 4, color: "#d57021" };
  return { label: "very far / fringe", order: 5, color: "#b53d3d" };
}

async function fetchCatalog(epcs) {
  if (!TOKEN) return null;
  if (epcs.length === 0) return new Map();
  // Endpoint may not be deployed yet — guard with a tight timeout.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(`${WMS}/api/cdm-agents/lookup-by-epc`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ epcs }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      console.warn(`[catalog] HTTP ${res.status}; skipping`);
      return null;
    }
    const data = await res.json();
    const map = new Map();
    for (const r of data.rows ?? []) map.set(r.epcHex, r);
    return map;
  } catch (e) {
    console.warn(`[catalog] fetch failed: ${e.message}; skipping`);
    return null;
  }
}

function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function main() {
  const raw = JSON.parse(await fs.readFile(IN, "utf8"));
  const records = raw.records;

  const epcs = records.map((r) => r.epc).filter((e) => /^[0-9A-F]{24}$/.test(e));
  // Lookup in chunks of 200 (endpoint cap is 500 but stay conservative).
  let catalogMap = new Map();
  let catalogStatus = "skipped";
  if (TOKEN) {
    catalogStatus = "ok";
    for (let i = 0; i < epcs.length; i += 200) {
      const chunk = epcs.slice(i, i + 200);
      const m = await fetchCatalog(chunk);
      if (m === null) {
        catalogStatus = "endpoint-unavailable";
        catalogMap = new Map();
        break;
      }
      for (const [k, v] of m) catalogMap.set(k, v);
    }
  }

  // Sort by RSSI desc (closer first), then by total reads desc.
  records.sort((a, b) => {
    if (b.bestRssi !== a.bestRssi) return b.bestRssi - a.bestRssi;
    return (b.totalReads ?? 0) - (a.totalReads ?? 0);
  });

  const rows = records.map((rec, idx) => {
    const dec = decodeEpc(rec.epc);
    const cat = catalogMap.get(rec.epc);
    const bucket = distanceBucket(rec.bestRssi);
    const binary = hexToBinary(rec.epc);
    const epcUrn = dec.valid
      ? `urn:epc:tag:carbon-96:${CFG.prefixHex}.${dec.systemId.toString()}.${dec.serial.toString()}`
      : "—";
    // Display the raw decimal system_id — NO padStart. Catalog lookup uses
    // exactly this string (BigInt.toString) and zero-padding both confuses
    // the eye AND would never match the BIGINT-typed ls_system_id column.
    const sysIdStr = dec.valid ? dec.systemId.toString() : "—";
    const matched = !!cat && (cat.sku || cat.productName);
    return {
      idx: idx + 1,
      binary,
      epc: rec.epc,
      epcFormula: "MonsoonReader stream → 50-byte record bytes[26..26+epc_length] (project's stream-parser.ts)",
      epcUrn,
      sysIdFormula: "decodeEpc() per lib/server/epc-decode.ts: prefixHex F0A0B, 20-bit prefix | 40-bit asset (=ls_system_id) | 36-bit serial",
      systemId: sysIdStr,
      serial: dec.valid ? dec.serial.toString() : "—",
      validReason: dec.valid ? "valid" : (dec.reason ?? "invalid"),
      sku: matched && cat.sku ? cat.sku : "—",
      productName: matched && cat.productName ? cat.productName : "—",
      color: matched && cat.color ? cat.color : "—",
      size: matched && cat.size ? cat.size : "—",
      rssi: rec.bestRssi,
      antenna: rec.bestAntenna,
      reads: rec.totalReads,
      bucket,
    };
  });

  const matchedCount = rows.filter((r) => r.sku !== "—").length;
  const decodedCount = rows.filter((r) => r.validReason === "valid").length;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escHtml(TITLE)}</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    color: #1f2933;
    background: #f6f8fa;
    line-height: 1.45;
    font-size: 14px;
  }
  header {
    padding: 28px 32px 20px;
    background: #ffffff;
    border-bottom: 1px solid #d6dde4;
  }
  header h1 {
    margin: 0 0 4px; font-size: 22px; font-weight: 600; color: #102a43;
  }
  header .meta {
    color: #486581;
    font-size: 13px;
    margin-top: 8px;
  }
  header .meta span { display: inline-block; margin-right: 22px; }
  header .meta strong { color: #1f2933; font-weight: 600; }
  main { padding: 24px 32px 60px; }
  .summary {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
    gap: 12px;
    margin-bottom: 22px;
  }
  .stat {
    background: #ffffff;
    border: 1px solid #d6dde4;
    border-radius: 8px;
    padding: 12px 16px;
  }
  .stat .label { font-size: 11px; color: #627d98; text-transform: uppercase; letter-spacing: 0.6px; }
  .stat .value { font-size: 22px; font-weight: 600; color: #102a43; margin-top: 2px; }
  .legend {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 16px;
    font-size: 12px;
    color: #486581;
  }
  .legend .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: #ffffff;
    border: 1px solid #d6dde4;
    border-radius: 999px;
    padding: 3px 10px;
  }
  .legend .pill::before {
    content: "";
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--c, #888);
  }
  table {
    width: 100%;
    border-collapse: collapse;
    background: #ffffff;
    border: 1px solid #d6dde4;
    border-radius: 8px;
    overflow: hidden;
    font-size: 13px;
  }
  thead th {
    background: #eef2f6;
    color: #243b53;
    font-weight: 600;
    text-align: left;
    padding: 10px 12px;
    border-bottom: 1px solid #d6dde4;
    font-size: 12px;
    letter-spacing: 0.3px;
    white-space: nowrap;
  }
  tbody td {
    padding: 8px 12px;
    border-bottom: 1px solid #ecf0f3;
    vertical-align: top;
  }
  tbody tr:hover { background: #f7fafc; }
  td.mono, th.mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12px; }
  td.bin { word-break: break-all; max-width: 260px; color: #486581; font-size: 11px; }
  td.epc { color: #102a43; font-weight: 600; }
  td.formula { color: #627d98; font-size: 11px; max-width: 240px; }
  td.dash { color: #9aa5b1; font-style: italic; }
  td.rssi { white-space: nowrap; font-weight: 600; }
  .bucket {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 999px;
    color: #ffffff;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.3px;
  }
  td.idx { color: #9aa5b1; font-variant-numeric: tabular-nums; text-align: right; padding-right: 6px; }
  footer { margin: 24px 32px 60px; color: #627d98; font-size: 12px; }
  .banner-warn {
    background: #fff8e1; border: 1px solid #f0c674;
    color: #6c5a00; padding: 10px 14px; border-radius: 6px;
    margin: 0 0 16px; font-size: 13px;
  }
</style>
</head>
<body>
<header>
  <h1>${escHtml(TITLE)}</h1>
  <div class="meta">
    <span><strong>Captured:</strong> ${escHtml(raw.capturedAt)}</span>
    <span><strong>Reader:</strong> ${escHtml(raw.host)}:${escHtml(String(raw.serialPort))}</span>
    <span><strong>Power:</strong> ${escHtml(String(raw.power / 10))} dBm (raw ${escHtml(String(raw.power))})</span>
    <span><strong>Capture window:</strong> ${escHtml(String(Math.round(raw.elapsedMs / 1000)))} s</span>
    <span><strong>Saturation:</strong> ${escHtml(String(Math.round(raw.silenceMs / 1000)))} s of silence</span>
  </div>
</header>
<main>
  ${catalogStatus === "endpoint-unavailable" ? `<div class="banner-warn">Catalog enrichment endpoint not yet deployed; SKU / description columns left as <code>—</code>. Re-run this report after the next WMS deploy to populate them.</div>` : ""}
  <div class="summary">
    <div class="stat"><div class="label">Unique EPCs</div><div class="value">${rows.length}</div></div>
    <div class="stat"><div class="label">Decoded (F0A0B)</div><div class="value">${decodedCount}</div></div>
    <div class="stat"><div class="label">Catalog matched</div><div class="value">${matchedCount}</div></div>
    <div class="stat"><div class="label">Strongest RSSI</div><div class="value">${rows.length ? rows[0].rssi + " dBm" : "—"}</div></div>
    <div class="stat"><div class="label">Weakest RSSI</div><div class="value">${rows.length ? rows[rows.length - 1].rssi + " dBm" : "—"}</div></div>
  </div>
  <div class="legend">
    <span class="pill" style="--c:#0f9c4f">very close (≥ −55 dBm)</span>
    <span class="pill" style="--c:#3fb35d">close (≥ −65)</span>
    <span class="pill" style="--c:#bcbf2c">near (≥ −75)</span>
    <span class="pill" style="--c:#dd9b2c">mid (≥ −85)</span>
    <span class="pill" style="--c:#d57021">far (≥ −95)</span>
    <span class="pill" style="--c:#b53d3d">fringe (&lt; −95)</span>
  </div>
  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>Distance</th>
        <th>RSSI</th>
        <th>Reads</th>
        <th>Ant</th>
        <th>Binary (96 bits)</th>
        <th>EPC (hex)</th>
        <th>Binary→EPC formula</th>
        <th>System ID</th>
        <th>EPC→SystemID formula</th>
        <th>Custom SKU</th>
        <th>Item description (name · color · size)</th>
      </tr>
    </thead>
    <tbody>
      ${rows
        .map(
          (r) => `
      <tr>
        <td class="idx mono">${r.idx}</td>
        <td><span class="bucket" style="background:${r.bucket.color}">${escHtml(r.bucket.label)}</span></td>
        <td class="rssi mono">${r.rssi} dBm</td>
        <td class="mono">${r.reads}</td>
        <td class="mono">${r.antenna}</td>
        <td class="bin mono">${r.binary}</td>
        <td class="epc mono">${r.epc}</td>
        <td class="formula">${escHtml(r.epcFormula)}</td>
        <td class="mono ${r.systemId === "—" ? "dash" : ""}">${escHtml(r.systemId)}</td>
        <td class="formula">${escHtml(r.sysIdFormula)}</td>
        <td class="mono ${r.sku === "—" ? "dash" : ""}">${escHtml(r.sku)}</td>
        <td class="${r.productName === "—" ? "dash" : ""}">${
            r.productName === "—" ? "—" : escHtml(`${r.productName} · ${r.color} · ${r.size}`)
          }</td>
      </tr>`,
        )
        .join("")}
    </tbody>
  </table>
</main>
<footer>
  Carbon CDM agent diagnostic — sorted by best (least-negative) RSSI per unique EPC, closest first.
  Distance bucket is heuristic: actual range depends on antenna gain, polarization, and environment.
  Binary→EPC: parsed from MonsoonReader's <code>--stream</code> 50-byte records (marker 0x31 0x00, EPC at byte 26).
  EPC→SystemID: project's <code>decodeEpc()</code> at <code>lib/server/epc-decode.ts</code> using <code>tenant_epc_config</code> (prefix F0A0B / 20+40+36 bits).
</footer>
</body>
</html>`;

  await fs.writeFile(OUT, html);
  console.log(
    `wrote ${OUT}: ${rows.length} rows (${decodedCount} decoded, ${matchedCount} catalog-matched, ${catalogStatus})`,
  );
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
