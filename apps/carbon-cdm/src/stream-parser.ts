/**
 * Parses MonsoonReader's `--stream PORT` binary output into discrete tag-read
 * records. Reverse-engineered from a live capture against a Carbon SA-2000
 * (file `/tmp/cdm-extract/cdm/MonsoonReader`, build 2016-10-05) on
 * 2026-05-01 — see project memory for capture notes.
 *
 * Wire format:
 *   - At the very start of a fresh stream connection, MonsoonReader sends a
 *     5-byte Boost-archive header `be 06 18 00 00`. Skip it once.
 *   - Then repeating 50-byte tag-read records:
 *       [00..01]  marker   0x31 0x00
 *       [02]      RSSI byte (magnitude in dBm; e.g. 0x64 = -100, 0x60 = -96)
 *       [03]      epc_length in bytes (typically 12 for SGTIN-96)
 *       [04..09]  six bytes of misc telemetry (phase / read-time / flags);
 *                 byte [09] is the antenna number (1..n)
 *       [10..17]  uint64 LE epoch-seconds timestamp
 *       [18..25]  uint64 LE microseconds within that second
 *       [26..(26+epc_length-1)]  EPC bytes
 *       [..49]    zero padding (record is fixed 50 bytes; up to 24-byte EPCs fit)
 *
 * If we lose sync (mid-stream noise, partial reconnect), scan forward one byte
 * at a time looking for the `0x31 0x00` marker followed by a sane epc_length
 * (we accept 8..24).
 */

export const RECORD_SIZE = 50;
const FILE_HEADER = Buffer.from([0xbe, 0x06, 0x18, 0x00, 0x00]);
const RECORD_MARKER_0 = 0x31;
const RECORD_MARKER_1 = 0x00;
const EPC_OFFSET = 26;
const EPC_LENGTH_OFFSET = 3;
const ANTENNA_OFFSET = 9;
const RSSI_OFFSET = 2;
const TS_SEC_OFFSET = 10;
const TS_USEC_OFFSET = 18;
const MIN_PLAUSIBLE_EPC_LEN = 8;
const MAX_PLAUSIBLE_EPC_LEN = 24;

export type ParsedTagRead = {
  epcHex: string;
  antennaNumber: number;
  /** Reader-reported RSSI in dBm (negative). May be 0 if unparseable. */
  rssiDbm: number;
  /** Ms since epoch from the on-wire timestamp; null if implausible. */
  monsoonTsMs: number | null;
};

export type ParseResult = {
  records: ParsedTagRead[];
  /** Bytes that didn't form a complete record yet — caller buffers for next chunk. */
  remaining: Buffer;
  /** Bytes thrown away while seeking the next valid marker. For metrics. */
  skipped: number;
  /** True if we consumed the 5-byte file header during this call. */
  consumedHeader: boolean;
};

export type ParserState = {
  /** True once we've consumed the leading 5-byte file header for the current
   *  connection. The supervisor resets this to `false` on each reconnect. */
  headerSeen: boolean;
};

export function newParserState(): ParserState {
  return { headerSeen: false };
}

function isPlausibleRecordStart(buf: Buffer, off: number): boolean {
  if (off + RECORD_SIZE > buf.length) return false;
  if (buf[off] !== RECORD_MARKER_0) return false;
  if (buf[off + 1] !== RECORD_MARKER_1) return false;
  const epcLen = buf[off + EPC_LENGTH_OFFSET]!;
  if (epcLen < MIN_PLAUSIBLE_EPC_LEN || epcLen > MAX_PLAUSIBLE_EPC_LEN) return false;
  return true;
}

export function parseStream(input: Buffer, state: ParserState): ParseResult {
  let cursor = 0;
  let skipped = 0;
  let consumedHeader = false;

  if (!state.headerSeen) {
    if (input.length < FILE_HEADER.length) {
      // Not enough bytes yet to even decide; keep them for next chunk.
      return { records: [], remaining: input, skipped: 0, consumedHeader: false };
    }
    if (input.subarray(0, FILE_HEADER.length).equals(FILE_HEADER)) {
      cursor = FILE_HEADER.length;
      consumedHeader = true;
    }
    // Either way, consider header phase done. Some captures have shown the
    // first connection bytes start straight at a record marker (no Boost
    // header), in which case we just fall through to record parsing.
    state.headerSeen = true;
  }

  const records: ParsedTagRead[] = [];

  while (cursor + RECORD_SIZE <= input.length) {
    if (!isPlausibleRecordStart(input, cursor)) {
      cursor++;
      skipped++;
      continue;
    }
    const start = cursor;
    const epcLen = input[start + EPC_LENGTH_OFFSET]!;
    const epc = input.subarray(start + EPC_OFFSET, start + EPC_OFFSET + epcLen);
    const epcHex = epc.toString("hex").toUpperCase();
    // All-zero EPCs are filler / no-tag-here cycle markers; drop them.
    if (!/^0+$/.test(epcHex)) {
      const antenna = input[start + ANTENNA_OFFSET]!;
      // RSSI byte is stored as the absolute value of dBm magnitude.
      const rssiByte = input[start + RSSI_OFFSET]!;
      const rssiDbm = rssiByte === 0 ? 0 : -rssiByte;
      const tsSec = Number(input.readBigUInt64LE(start + TS_SEC_OFFSET));
      const tsUsec = Number(input.readBigUInt64LE(start + TS_USEC_OFFSET));
      const monsoonTsMs =
        tsSec > 1_500_000_000 && tsSec < 4_000_000_000
          ? tsSec * 1000 + Math.floor(tsUsec / 1000)
          : null;
      records.push({ epcHex, antennaNumber: antenna, rssiDbm, monsoonTsMs });
    }
    cursor += RECORD_SIZE;
  }

  return {
    records,
    remaining: input.subarray(cursor),
    skipped,
    consumedHeader,
  };
}
