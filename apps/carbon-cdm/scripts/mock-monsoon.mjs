#!/usr/bin/env node
/**
 * Carbon CDM dev mock — drop-in replacement for the real MonsoonReader binary.
 * Accepts the same command-line flags but ignores most of them; the only one
 * that matters is `--stream <port>`, which it listens on. Emits realistic
 * 48-byte binary records resembling what we captured from the actual reader.
 *
 * Use it when CARBON_MONSOON_BINARY in the agent's .env points at this script
 * (chmod +x first). Lets the agent be tested end-to-end on any laptop without
 * the real Senitron-branded reader on the LAN.
 */

import net from "node:net";
import process from "node:process";

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

const streamPort = Number(flag("--stream", 30100));
const power = Number(flag("--power", 300)); // tens of dBm
const epcPrefix = process.env.MOCK_EPC_PREFIX ?? "f0a0b30e";
const tagPoolSize = Number(process.env.MOCK_TAG_POOL ?? 8);
const burstHz = Number(process.env.MOCK_BURST_HZ ?? 4);

console.error(
  `[mock-monsoon] starting; stream_port=${streamPort} power=${power} pool=${tagPoolSize}`,
);

// Pre-build a small pool of tag EPCs so reads look like the same items
// passing under the antenna repeatedly.
const tagPool = Array.from({ length: tagPoolSize }, (_, i) => {
  // 24-hex-char (12-byte) EPC, prefix + per-pool suffix.
  const suffix = `4f9c${(0xb000 + i).toString(16).padStart(4, "0")}0001${(
    0x8000 + i
  )
    .toString(16)
    .padStart(4, "0")}`;
  return (epcPrefix + suffix).padEnd(24, "0").slice(0, 24);
});

function makeRecord(epcHex, antennaNumber) {
  const buf = Buffer.alloc(48);
  buf[0] = 0x31; // marker
  buf[1] = 0x00; // tag-read type
  buf[2] = 0x60 | (antennaNumber & 0x07); // varies in real captures
  buf[3] = 0x0c;
  buf.writeUInt16BE(0x01b9, 4);
  buf.writeUInt16BE(0xff64, 6);
  buf[8] = 0x01;
  buf[9] = 0x01;
  buf.writeUInt32BE(Math.floor(Date.now() / 1000), 10);
  buf.writeUInt32BE(0, 14);
  buf.writeUInt32BE(Math.floor(Math.random() * 0x7fff_ffff), 18);
  buf.writeUInt32BE(0, 22);
  Buffer.from(epcHex, "hex").copy(buf, 26);
  // 38..47 already zero-filled.
  return buf;
}

const server = net.createServer((socket) => {
  console.error(`[mock-monsoon] client connected from ${socket.remoteAddress}`);

  // Realistic preamble — a few framing bytes before the first record.
  socket.write(Buffer.from([0xbe, 0x8a, 0x1b, 0x00]));

  const interval = setInterval(() => {
    // One "burst" = 1..3 reads as a few items pass under the antenna.
    const burst = 1 + Math.floor(Math.random() * 3);
    const chunks = [];
    for (let i = 0; i < burst; i++) {
      const epc = tagPool[Math.floor(Math.random() * tagPool.length)];
      const ant = 1 + Math.floor(Math.random() * 2); // antennas 1 or 2
      chunks.push(makeRecord(epc, ant));
    }
    try {
      socket.write(Buffer.concat(chunks));
    } catch {
      /* socket closed */
    }
  }, 1000 / burstHz);

  socket.on("close", () => {
    clearInterval(interval);
    console.error("[mock-monsoon] client disconnected");
  });
  socket.on("error", () => {
    clearInterval(interval);
  });
});

server.listen(streamPort, () => {
  console.error(`[mock-monsoon] listening on 0.0.0.0:${streamPort}`);
});

const shutdown = (sig) => {
  console.error(`[mock-monsoon] received ${sig}, exiting`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
