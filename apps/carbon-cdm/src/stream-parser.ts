/**
 * Parses MonsoonReader's --stream binary output into discrete tag-read records.
 * Format reverse-engineered from a live capture — see project notes:
 *
 *   Each record is 48 bytes:
 *     [00..01]  marker  0x31 0x00  (also seen 0x31 0xae for some non-tag events)
 *     [02..03]  flags / type
 *     [04..07]  unknown 4 bytes (maybe sequence)
 *     [08..09]  2 bytes
 *     [10..13]  4 bytes (ts seconds, big-endian uint)
 *     [14..17]  4 bytes
 *     [18..21]  4 bytes (sub-second / sequence)
 *     [22..25]  4 bytes
 *     [26..37]  EPC (12 bytes = 96 bits)
 *     [38..47]  trailer / extras
 *
 * The stream starts with a small framing header before the first record;
 * we re-sync to the first 0x31-byte and parse 48-byte aligned records from
 * there. If a record's first byte isn't 0x31 we re-sync forward by one byte.
 */

export const RECORD_SIZE = 48;
const RECORD_MARKER = 0x31;
const TAG_READ_TYPE = 0x00;
const EPC_OFFSET = 26;
const EPC_LENGTH = 12;
const TS_SEC_OFFSET = 10;
const SUB_SEC_OFFSET = 18;

export type ParsedTagRead = {
  epcHex: string;
  /** Ms since epoch derived from the on-wire timestamp. May drift from real
   *  time — receive-time is recorded separately by the runner. */
  monsoonTsMs: number | null;
};

export type ParseResult = {
  records: ParsedTagRead[];
  /** Bytes that didn't form a complete record yet — caller buffers for next chunk. */
  remaining: Buffer;
  /** Bytes we threw away (garbage / framing prefixes / desync). For metrics. */
  skipped: number;
};

/** Pure parser: stateless, given a buffer returns the parsed records and
 *  a tail buffer the caller should keep for the next chunk. */
export function parseStream(input: Buffer): ParseResult {
  let cursor = 0;
  let skipped = 0;

  // Skip leading bytes until we find a candidate marker.
  while (cursor < input.length && input[cursor] !== RECORD_MARKER) {
    cursor++;
    skipped++;
  }

  const records: ParsedTagRead[] = [];

  while (cursor + RECORD_SIZE <= input.length) {
    const start = cursor;
    if (input[start] !== RECORD_MARKER) {
      // Re-sync: drop one byte and search forward.
      cursor++;
      skipped++;
      continue;
    }

    const recordType = input[start + 1];

    if (recordType === TAG_READ_TYPE) {
      const epc = input.subarray(start + EPC_OFFSET, start + EPC_OFFSET + EPC_LENGTH);
      const epcHex = epc.toString("hex");
      // EPC of all zeros = filler/heartbeat; ignore.
      if (epcHex !== "000000000000000000000000") {
        const tsSec = input.readUInt32BE(start + TS_SEC_OFFSET);
        const subSec = input.readUInt32BE(start + SUB_SEC_OFFSET);
        // If tsSec looks unset/invalid, don't fabricate a date.
        const monsoonTsMs =
          tsSec > 0 && tsSec < 4_000_000_000
            ? tsSec * 1000 + Math.floor(subSec % 1000)
            : null;
        records.push({ epcHex, monsoonTsMs });
      }
    }
    // Other record types (0xae etc.) — just consume and skip.
    cursor += RECORD_SIZE;
  }

  return { records, remaining: input.subarray(cursor), skipped };
}
