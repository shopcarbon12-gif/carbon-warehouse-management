#!/usr/bin/env node
// Run on the VM. Captures unique EPCs from .22 with RSSI/antenna at a given power.
// Args: --power N --out /tmp/captured-X.json --silenceMs 30000 --maxMs 600000

import net from "node:net";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";

const argv = Object.fromEntries(
  process.argv.slice(2).reduce((acc, v, i, arr) => {
    if (v.startsWith("--")) acc.push([v.slice(2), arr[i + 1]]);
    return acc;
  }, []),
);
const POWER = Number(argv.power ?? 300);
const OUT = String(argv.out ?? "/tmp/captured.json");
const SILENCE_MS = Number(argv.silenceMs ?? 30_000);
const MAX_MS = Number(argv.maxMs ?? 600_000);
const READER_HOST = String(argv.host ?? "192.168.1.22");
const READER_PORT = Number(argv.serialPort ?? 10002);
const STREAM_PORT = Number(argv.streamPort ?? 39200);
const CONTROL_PORT = Number(argv.controlPort ?? 39201);
const BIN = "/opt/legacy-rfid/MonsoonReader";

const FILE_HEADER = Buffer.from([0xbe, 0x06, 0x18, 0x00, 0x00]);
const RECORD_SIZE = 50;

function parseStream(input, state) {
  let cursor = 0;
  const records = [];
  if (!state.headerSeen) {
    if (input.length < FILE_HEADER.length)
      return { records, remaining: input };
    if (input.subarray(0, 5).equals(FILE_HEADER)) cursor = 5;
    state.headerSeen = true;
  }
  while (cursor + RECORD_SIZE <= input.length) {
    if (input[cursor] !== 0x31 || input[cursor + 1] !== 0x00) {
      cursor++;
      continue;
    }
    const epcLen = input[cursor + 3];
    if (epcLen < 8 || epcLen > 24) {
      cursor++;
      continue;
    }
    const start = cursor;
    const rssiByte = input[start + 2];
    const rssiDbm = rssiByte === 0 ? 0 : -rssiByte;
    const antenna = input[start + 9];
    const epc = input
      .subarray(start + 26, start + 26 + epcLen)
      .toString("hex")
      .toUpperCase();
    if (!/^0+$/.test(epc)) records.push({ epc, antenna, rssiDbm });
    cursor += RECORD_SIZE;
  }
  return { records, remaining: input.subarray(cursor) };
}

function spawnReader() {
  const args = [
    "--num", "1",
    "--stream", String(STREAM_PORT),
    "--control", String(CONTROL_PORT),
    "--read_time_ms", "1000",
    "--power", String(POWER),
    "--serial_host", READER_HOST,
    "--serial_port", String(READER_PORT),
    "--fastid",
    "--infinite",
  ];
  const child = spawn(BIN, args, {
    cwd: "/opt/legacy-rfid/runtime",
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.resume();
  child.stderr?.resume();
  return child;
}

const seen = new Map(); // epc -> { epc, bestRssi, bestAntenna, totalReads, firstSeenMs, lastSeenMs }
let lastNewEpcAt = Date.now();
const startedAt = Date.now();

let child = null;
let sock = null;
let parserState = { headerSeen: false };
let buffer = Buffer.alloc(0);
let stopping = false;

function consume(chunk) {
  buffer = Buffer.concat([buffer, chunk]);
  if (buffer.length > 1024 * 1024)
    buffer = buffer.subarray(buffer.length - 65536);
  const r = parseStream(buffer, parserState);
  buffer = r.remaining;
  const now = Date.now();
  for (const rec of r.records) {
    let s = seen.get(rec.epc);
    if (!s) {
      s = {
        epc: rec.epc,
        bestRssi: rec.rssiDbm,
        bestAntenna: rec.antenna,
        totalReads: 0,
        firstSeenMs: now,
        lastSeenMs: now,
      };
      seen.set(rec.epc, s);
      lastNewEpcAt = now;
      console.log(
        `[${seen.size.toString().padStart(4, " ")}] ${rec.epc}  rssi=${rec.rssiDbm}dBm  ant=${rec.antenna}`,
      );
    } else {
      // Track the strongest (least-negative) RSSI seen for this EPC
      if (rec.rssiDbm > s.bestRssi) {
        s.bestRssi = rec.rssiDbm;
        s.bestAntenna = rec.antenna;
      }
    }
    s.totalReads += 1;
    s.lastSeenMs = now;
  }
}

function connectStream() {
  parserState = { headerSeen: false };
  buffer = Buffer.alloc(0);
  sock = net.createConnection(STREAM_PORT, "127.0.0.1");
  sock.on("connect", () => console.log("[stream connected]"));
  sock.on("data", consume);
  sock.on("error", (e) => console.log("[stream error]", e.message));
  sock.on("close", () => {
    sock = null;
  });
}

function killStuckChild() {
  if (child && !child.killed) {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
}

function lifecycle() {
  if (child) {
    child.on("exit", (code, signal) => {
      console.log(`[child exit] code=${code} signal=${signal}`);
      child = null;
      if (sock) {
        try {
          sock.destroy();
        } catch {}
      }
      if (!stopping) setTimeout(() => spawnLoop(), 1500);
    });
  }
}

function spawnLoop() {
  if (stopping) return;
  child = spawnReader();
  console.log(`[spawn] pid=${child.pid} power=${POWER}`);
  lifecycle();
  setTimeout(() => connectStream(), 2500);
}

const sat = setInterval(() => {
  const now = Date.now();
  const sinceNew = now - lastNewEpcAt;
  const elapsed = now - startedAt;
  if (sinceNew >= SILENCE_MS && seen.size > 0) {
    console.log(
      `[saturated] ${seen.size} unique EPCs after ${elapsed}ms; ${sinceNew}ms since last new`,
    );
    finish();
  } else if (elapsed >= MAX_MS) {
    console.log(
      `[max-time hit] ${seen.size} unique EPCs after ${elapsed}ms`,
    );
    finish();
  }
}, 1000);

async function finish() {
  if (stopping) return;
  stopping = true;
  clearInterval(sat);
  if (sock) {
    try {
      sock.destroy();
    } catch {}
  }
  killStuckChild();
  await new Promise((r) => setTimeout(r, 500));
  const records = Array.from(seen.values()).sort((a, b) => b.bestRssi - a.bestRssi);
  const out = {
    capturedAt: new Date().toISOString(),
    power: POWER,
    host: READER_HOST,
    serialPort: READER_PORT,
    elapsedMs: Date.now() - startedAt,
    silenceMs: Date.now() - lastNewEpcAt,
    totalUnique: records.length,
    records,
  };
  await fs.writeFile(OUT, JSON.stringify(out, null, 2));
  console.log(`[wrote] ${OUT} (${records.length} unique EPCs)`);
  process.exit(0);
}

spawnLoop();
