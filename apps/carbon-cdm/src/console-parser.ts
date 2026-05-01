/**
 * Parses `new_monsoonreader --console` text output into discrete tag-read
 * records. This is the 2024-vintage Mojix binary that Senitron switched to
 * in their own deployments — it streams continuously (no alive-but-stuck
 * stalls) and verifies CRC at the binary, so we don't have to filter
 * phantom tags ourselves.
 *
 * Wire format (each line one read; UTF-8 stdout):
 *   RSSI -68.40 PC 3400 EPC F0A0B30E4F9B8C90000026B3 CRC 4CD0 (calculated 4CD0, OK)
 *   RSSI -71.10 PC 3400 EPC F0A0B30E4F9BB730000014A2 CRC 9F12 (calculated A2D1, WRONG!)
 *
 * Verified live 2026-05-01 against reader 192.168.1.76 — sample at
 * /tmp/new-mr-console.log on the CarbonCDM VM showed:
 *   • 47,582 lines in ~30 s of capture (~1,586 reads/sec sustained).
 *   • Two line shapes only (OK / WRONG!) — no init, header, status, or
 *     error lines.
 *   • Every EPC was exactly 24 hex chars; no all-zero filler EPCs.
 *   • RSSI in 0.1 dBm precision, range -87.10 to -43.80 in the sample.
 *   • CRC-mismatch rate ~1.8 % — these are the phantom reads the OLD
 *     binary would have passed through unfiltered.
 *
 * This binary doesn't emit antenna numbers per read (its CLI selects ONE
 * antenna at spawn via `-a N`), so the caller stamps the antenna from the
 * spawn args. That's fine for our deployment — every reader has one
 * antenna; the only multi-antenna reader (.16) is owned by SenitronCDM.
 */

const LINE_RE =
  /^RSSI (-?\d+(?:\.\d+)?) PC ([0-9A-Fa-f]+) EPC ([0-9A-Fa-f]+) CRC ([0-9A-Fa-f]+) \(calculated ([0-9A-Fa-f]+), (OK|WRONG!)\)$/;

export type ConsoleParsedRead = {
  /** EPC hex, uppercase, no whitespace. */
  epcHex: string;
  /** Reader-reported RSSI in dBm — float with 0.1 precision (e.g. -68.4). */
  rssiDbm: number;
  /** Protocol Control word, hex, uppercase (typically "3400" for SGTIN-96). */
  pc: string;
  /** True iff the binary reported the CRC matched. */
  crcOk: boolean;
};

export type ConsoleParseResult = {
  /** CRC-OK reads parsed in this chunk. WRONG! reads are dropped (counted in
   *  `badCrcCount`) — the whole point of switching to this binary is to lose
   *  the phantom-tag reads the old binary passed through. */
  records: ConsoleParsedRead[];
  /** Lines whose CRC was reported WRONG! and were therefore dropped. */
  badCrcCount: number;
  /** Lines that didn't match the expected shape — for metrics, should be 0
   *  in steady state. */
  malformedCount: number;
};

export type ConsoleParserState = {
  /** Last partial line, buffered across chunk boundaries. */
  buf: string;
};

export function newConsoleParserState(): ConsoleParserState {
  return { buf: "" };
}

/**
 * Try to parse a single line. Returns `null` for malformed lines.
 * Exported for unit tests; the supervisor uses `parseConsoleChunk`.
 */
export function parseConsoleLine(line: string): ConsoleParsedRead | null {
  const m = LINE_RE.exec(line.trim());
  if (!m) return null;
  const rssi = Number.parseFloat(m[1]!);
  if (!Number.isFinite(rssi)) return null;
  return {
    rssiDbm: rssi,
    pc: m[2]!.toUpperCase(),
    epcHex: m[3]!.toUpperCase(),
    crcOk: m[6] === "OK",
  };
}

/**
 * Consume a chunk of stdout text from `new_monsoonreader --console`.
 * Stateful (buffers a trailing partial line until the next chunk arrives).
 */
export function parseConsoleChunk(
  input: string,
  state: ConsoleParserState,
): ConsoleParseResult {
  const combined = state.buf + input;
  const lines = combined.split("\n");
  // Last entry is either the trailing partial line OR an empty string when
  // input ended on a newline. Either way, buffer it for next chunk.
  state.buf = lines.pop() ?? "";

  const records: ConsoleParsedRead[] = [];
  let badCrcCount = 0;
  let malformedCount = 0;

  for (const raw of lines) {
    if (raw.length === 0) continue; // blank between cycles, ignore
    const parsed = parseConsoleLine(raw);
    if (parsed === null) {
      malformedCount += 1;
      continue;
    }
    if (!parsed.crcOk) {
      badCrcCount += 1;
      continue;
    }
    records.push(parsed);
  }

  return { records, badCrcCount, malformedCount };
}
