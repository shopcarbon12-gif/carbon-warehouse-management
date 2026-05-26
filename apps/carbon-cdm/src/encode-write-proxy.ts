/**
 * Small TCP MITM proxy that lets the 2019 MonsoonReader binary write
 * C-prefix EPCs that its own argument parser segfaults on.
 *
 * Background — why this exists:
 *
 *   - MR1 (`/opt/legacy-rfid/MonsoonReader`, 2019 build) is the only
 *     Senitron binary that does end-to-end chip writes against the
 *     SA-2000 family from the command line. Live evidence today
 *     (2026-05-26) shows it doing real `TAG_ACCESS : cmd = WRITE`
 *     on .70 with F0A0B-prefix targets.
 *
 *   - MR1 segfaults parsing `--target_tag` values that don't start
 *     with a header byte its parser recognizes (specifically C1/C2,
 *     the Senitron legacy non-SGTIN pool — exact crash 2026-05-26
 *     on .70 with `target_tag=C1...`).
 *
 *   - MR2 (Feb 2020 build) doesn't crash on C-prefix but fails
 *     RFID_RadioOpen with `-9983 RADIO_NOT_PRESENT` on at least
 *     .30 and .34 in cold/warm/reset/reboot state. MR2's radio
 *     init is structurally incompatible with that chip path.
 *
 *   - No other Senitron binary in any archive does chip writes.
 *
 * Strategy:
 *
 *   MR1's parser crashes before it ever talks to the chip. Once
 *   it's running, its TCP stream to the WIZnet bridge is a TLV
 *   sequence that includes the target EPC bits as three 32-bit
 *   register writes (registers 0x05, 0x06, 0x07). If we route MR1
 *   through a local proxy that substitutes those three register
 *   values mid-flight, MR1 itself only ever sees a parser-safe
 *   F0A0B placeholder, but the bridge receives the real C-prefix
 *   SELECT mask. The chip then targets the actual C-prefix tag and
 *   MR1's WRITE_TAG access burns the new F0A0B EPC.
 *
 * Wire-protocol notes (from the pcap captured against .30 on
 * 2026-05-26):
 *
 *   - Every TLV record is 8 bytes: `01 00 RR 08 VV VV VV VV`
 *     - `01 00` = SET register command
 *     - `RR`    = register id (single byte)
 *     - `08`    = value length sentinel (= 4-byte value)
 *     - `VV..`  = 4 bytes of value, big-endian
 *   - Target EPC occupies three consecutive registers:
 *     - 0x05 → bits 0-31  of the 96-bit EPC
 *     - 0x06 → bits 32-63
 *     - 0x07 → bits 64-95
 *
 * The proxy maintains a sliding parser that finds these three
 * frames in the MR1→bridge byte stream and rewrites the 4 value
 * bytes of each. Bridge→MR1 traffic is forwarded untouched.
 *
 * Risk: MR1 may verify the EPC the chip returns post-Select. If it
 * does, the chip's "actual" EPC (C-prefix) won't match the
 * placeholder MR1 expected and MR1 may bail. Empirically the
 * successful 11:28 write log on .70 produced no EPC-verification
 * output, so we proceed with the simple unidirectional rewrite.
 * If verification proves to be a problem, the proxy can be extended
 * to rewrite the bridge→MR1 direction too — Gen2 EPC in tag-access
 * frames sits at a fixed offset in the chip's response.
 */

import { createServer, type Server, type Socket } from "node:net";
import { connect } from "node:net";
import { log } from "./log.js";

/**
 * 24-hex placeholder we hand MR1 as `--target_tag`. Must:
 *   - parse cleanly through MR1's parser (no segfault)
 *   - have a unique 12-byte wire signature that we can grep for in
 *     the byte stream (we don't actually grep for this — we parse
 *     the TLV records — but the constant is documented here so
 *     future readers can spot it in agent logs / pcaps)
 */
export const PLACEHOLDER_TARGET_EPC = "F0A0B3DEADBEEFCAFEBABE99";

function epcHexToBytes(hex24: string): Buffer {
  if (!/^[0-9A-Fa-f]{24}$/.test(hex24)) {
    throw new Error(`Invalid 24-hex EPC: ${hex24}`);
  }
  return Buffer.from(hex24, "hex");
}

export type ProxyHandle = {
  /** Localhost port MR1 should connect to via --serial_host/--serial_port. */
  port: number;
  /** Promise resolves when the proxy fully tears down. */
  closed: Promise<void>;
  /** Stats observed during the proxy's lifetime (for diagnostic logging). */
  stats: () => {
    bytesUpstream: number;
    bytesDownstream: number;
    framesRewritten: number;
    upstreamConnected: boolean;
  };
  /** Force-close the proxy and any in-flight connections. */
  shutdown: () => Promise<void>;
};

/**
 * Bring up a single-shot TCP proxy on a random localhost port that
 * rewrites the target EPC in any TLV register-set frame for registers
 * 0x05 / 0x06 / 0x07 to the real target's bytes. The proxy accepts
 * exactly ONE client connection (MR1) and exits when MR1 closes.
 */
export async function startEncodeWriteProxy(
  bridgeHost: string,
  bridgePort: number,
  realTargetEpc: string,
): Promise<ProxyHandle> {
  const realBytes = epcHexToBytes(realTargetEpc);
  const r05 = realBytes.subarray(0, 4);
  const r06 = realBytes.subarray(4, 8);
  const r07 = realBytes.subarray(8, 12);

  let bytesUpstream = 0;
  let bytesDownstream = 0;
  let framesRewritten = 0;
  let upstreamConnected = false;
  let pending = Buffer.alloc(0);

  const rewriteChunk = (chunk: Buffer): Buffer => {
    /**
     * The wire format puts each TLV record contiguously. Two TCP
     * packets MAY fragment a record across chunks, so we buffer any
     * trailing bytes that look like the start of a record-in-progress
     * and stitch them in with the next chunk.
     *
     * Detection rule: a 4-byte preamble `01 00 RR 08` followed by 4
     * value bytes. We look for RR ∈ {0x05, 0x06, 0x07} and rewrite
     * the 4 value bytes that follow.
     */
    const buf = Buffer.concat([pending, chunk]);
    const out = Buffer.alloc(buf.length);
    let oi = 0;
    let i = 0;
    while (i < buf.length) {
      // Need at least 8 bytes for a complete record check.
      if (
        i + 8 <= buf.length &&
        buf[i] === 0x01 &&
        buf[i + 1] === 0x00 &&
        buf[i + 3] === 0x08
      ) {
        const reg = buf[i + 2];
        if (reg === 0x05 || reg === 0x06 || reg === 0x07) {
          // Header (4 bytes) preserved, value (4 bytes) substituted.
          buf.copy(out, oi, i, i + 4);
          oi += 4;
          const replacement =
            reg === 0x05 ? r05 : reg === 0x06 ? r06 : r07;
          replacement.copy(out, oi);
          oi += 4;
          i += 8;
          framesRewritten++;
          continue;
        }
      }
      // If we have a partial header at the tail of the buffer, hold
      // it back for the next chunk so we don't miss a fragmented
      // record. A partial is up to 7 bytes that COULD be the start
      // of a `01 00 RR 08 ...` record.
      const remaining = buf.length - i;
      if (
        remaining < 8 &&
        buf[i] === 0x01 &&
        (remaining < 2 || buf[i + 1] === 0x00)
      ) {
        pending = buf.subarray(i);
        return out.subarray(0, oi);
      }
      out[oi++] = buf[i++]!;
    }
    pending = Buffer.alloc(0);
    return out.subarray(0, oi);
  };

  let server: Server | null = null;
  let downstream: Socket | null = null;
  let upstream: Socket | null = null;
  let closedResolve: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    closedResolve = resolve;
  });

  const shutdown = (): Promise<void> => {
    try {
      downstream?.destroy();
    } catch {
      /* ignore */
    }
    try {
      upstream?.destroy();
    } catch {
      /* ignore */
    }
    try {
      server?.close();
    } catch {
      /* ignore */
    }
    return closed;
  };

  server = createServer((sock) => {
    if (downstream) {
      // Reject any 2nd client. Single-shot.
      sock.destroy();
      return;
    }
    downstream = sock;
    upstream = connect(bridgePort, bridgeHost);
    upstream.setNoDelay(true);
    sock.setNoDelay(true);

    upstream.on("connect", () => {
      upstreamConnected = true;
    });
    upstream.on("data", (b) => {
      bytesDownstream += b.length;
      // bridge → MR1: forward as-is for now.
      sock.write(b);
    });
    upstream.on("error", (e) => {
      log.warn("encode-write-proxy: upstream error", { err: e.message });
      sock.destroy();
    });
    upstream.on("close", () => {
      sock.end();
    });

    sock.on("data", (b) => {
      bytesUpstream += b.length;
      const rewritten = rewriteChunk(b);
      upstream?.write(rewritten);
    });
    sock.on("error", (e) => {
      log.warn("encode-write-proxy: downstream error", { err: e.message });
      upstream?.destroy();
    });
    sock.on("close", () => {
      // Drain `pending` if anything remains — write it through.
      if (pending.length > 0 && upstream && !upstream.destroyed) {
        upstream.write(pending);
        pending = Buffer.alloc(0);
      }
      upstream?.end();
      try {
        server?.close();
      } catch {
        /* ignore */
      }
      closedResolve();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  if (typeof addr === "string" || addr === null) {
    throw new Error("encode-write-proxy: failed to bind localhost port");
  }
  const port = addr.port;

  log.info("encode-write-proxy: ready", {
    port,
    bridgeHost,
    bridgePort,
    realTargetEpc,
    placeholder: PLACEHOLDER_TARGET_EPC,
  });

  return {
    port,
    closed,
    stats: () => ({
      bytesUpstream,
      bytesDownstream,
      framesRewritten,
      upstreamConnected,
    }),
    shutdown,
  };
}
