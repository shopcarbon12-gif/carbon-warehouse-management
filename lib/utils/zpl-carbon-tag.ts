/**
 * Carbon RFID price-tag ZPL builder.
 *
 * Direct port of `carbon-gen/lib/rfid.ts` so a tag printed from
 * Carbon WMS commission renders identical to one generated through
 * the Carbon Studio (https://app.shopcarbon.com/studio/rfid-price-tag).
 * Pre-1.2.48 the WMS shipped a different layout (single-row name,
 * UPC barcode at the bottom, no size/price column) — that's the file
 * the user pulled into a viewer and rejected as "not how my label
 * layout looks".
 *
 * Fields filled at print time:
 *   • TALLA/SIZE column: per-tag size + a horizontal sizes range row
 *   • UPC text (human readable, no barcode of UPC — barcode is of SKU)
 *   • Description split into two vertical lines (carbon-gen layout
 *     puts the matrix description in two rotated columns)
 *   • Color
 *   • Code 128 barcode in VERTICAL orientation (^BCB) of the custom SKU
 *   • SKU text
 *   • Retail price
 *   • Sizes-available column (e.g. "XS, S, M, L")
 *
 * EPC encoding uses ^RB + ^RFW,E (decimal triplet) — the bit-pack
 * scheme the printer applies must match carbon-gen exactly so any
 * downstream reader/auditor that decodes by carbon-gen rules sees
 * the same SGTIN-96 layout.
 */

// 6.5 × 5 cm physical label stock at 12 dpmm (300 DPI):
//   65 mm × 12 = 780 dots wide
//   50 mm × 12 = 600 dots tall
// Pre-1.2.50 carbon-gen used 812 × 594 which assumed a slightly bigger
// label — the rightmost ^GB tear-off line at x=783 + bottom row at
// y=552 fit fine in the carbon-gen-sized stock but pushed past the
// edge on the warehouse 65×50 mm rolls.
export const LABEL_WIDTH_DOTS = 780;
export const LABEL_HEIGHT_DOTS = 600;
export const PRINTER_DPI = 300;

export type CarbonTagSettings = {
  companyPrefix: number;
  companyPrefixBits: number;
  itemNumberBits: number;
  serialBits: number;
  printerIp: string;
  printerPort: number;
  labelWidthDots: number;
  labelHeightDots: number;
  labelShiftX: number;
  labelShiftY: number;
};

export const DEFAULT_CARBON_TAG_SETTINGS: CarbonTagSettings = {
  // Carbon Jeans tenant prefix — hex F0A0B = decimal 985611. Matches
  // tenant_epc_config.prefix_hex and the value envCompanyPrefix()
  // returns server-side. The prior 1044991 (hex FF1FF) was a placeholder
  // that, if it ever leaked into a printed tag, would have stamped the
  // wrong prefix and made every commissioned EPC fail the formula filter.
  companyPrefix: 985611,
  companyPrefixBits: 20,
  itemNumberBits: 40,
  serialBits: 36,
  printerIp: "192.168.1.3",
  // Browser print flow uses Zebra web print endpoint (/pstprnt) on HTTP port 80.
  printerPort: 80,
  labelWidthDots: LABEL_WIDTH_DOTS,
  labelHeightDots: LABEL_HEIGHT_DOTS,
  // Print-alignment nudge (2026-05-28): shift the whole printed image on the
  // physical label so it sits centered once the operator rotates the tag 90°.
  // labelShiftX → ^LS (NEGATIVE = right), labelShiftY → ^LT (POSITIVE = down).
  // These move the format on the media (no field clipping). First-pass values;
  // tune from a test print — if a direction is backwards, flip the sign.
  labelShiftX: -24, // right
  labelShiftY: 48, // down
};

export type CarbonTagInput = {
  itemName: string;
  color: string;
  size: string;
  upc: string;
  customSku: string;
  retailPrice: string;
  /** Comma-separated sizes-available column on the right. e.g. "XS, S, M, L". Optional. */
  sizesAvailable?: string;
};

const COMMON_SIZES = new Set([
  "XS", "S", "M", "L", "XL", "XXL", "XXXL",
  "2XL", "3XL", "4XL", "5XL",
  "OS", "ONESIZE",
]);

// Natural garment-size order for the sizes-run column. The SQL feeding this
// column uses `ORDER BY size`, which sorts ALPHABETICALLY (L, M, S, XL, XS,
// XXL, XXXL) — wrong for humans. This table ranks the common alpha sizes so
// the strip prints XS S M L XL XXL XXXL. Aliases (2XL≡XXL, etc.) share a rank.
const ALPHA_SIZE_RANK: Record<string, number> = {
  XXS: 0,
  XS: 1,
  S: 2,
  M: 3,
  L: 4,
  XL: 5,
  XXL: 6, "2XL": 6,
  XXXL: 7, "3XL": 7,
  XXXXL: 8, "4XL": 8,
  XXXXXL: 9, "5XL": 9,
  OS: 100, ONESIZE: 100,
};

const MULTI_WORD_COLORS = new Set([
  "OFF WHITE",
  "DARK BLUE",
  "LIGHT BLUE",
  "DARK GREY",
  "LIGHT GREY",
  "DARK GRAY",
  "LIGHT GRAY",
  "ARMY GREEN",
  "ROYAL BLUE",
  "NAVY BLUE",
  "HOT PINK",
  "BABY PINK",
  "BABY BLUE",
]);

export function sanitizeZpl(value: unknown): string {
  return String(value ?? "")
    .replace(/[\x00-\x1F\x7F]/g, "")
    .replace(/[\^~]/g, "-")
    .trim();
}

export function epcBitTotal(s: CarbonTagSettings): number {
  return s.companyPrefixBits + s.itemNumberBits + s.serialBits;
}

function mask(bits: number): bigint {
  return (BigInt(1) << BigInt(bits)) - BigInt(1);
}

function fnv1a64(input: string): bigint {
  let hash = BigInt("0xcbf29ce484222325");
  const prime = BigInt("0x100000001b3");
  const max64 = BigInt("0xffffffffffffffff");
  const bytes = new TextEncoder().encode(String(input));
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & max64;
  }
  return hash;
}

export function deriveItemNumber(systemId: string, bits = 40): bigint {
  const normalized = String(systemId || "").trim();
  if (!normalized) {
    throw new Error("Lightspeed System ID is required.");
  }
  if (/^\d+$/.test(normalized)) {
    return BigInt(normalized) & mask(bits);
  }
  return fnv1a64(normalized) & mask(bits);
}

function toPaddedHex(value: bigint, totalBits = 96): string {
  const hexChars = Math.ceil(totalBits / 4);
  return value.toString(16).toUpperCase().padStart(hexChars, "0");
}

export function buildEpc(opts: {
  companyPrefix: number;
  companyPrefixBits?: number;
  itemNumber: bigint;
  itemNumberBits?: number;
  serialNumber: number;
  serialBits?: number;
}): { epcHex: string; epcDecimal: string } {
  const cpBits = opts.companyPrefixBits ?? 20;
  const itemBits = opts.itemNumberBits ?? 40;
  const serialBits = opts.serialBits ?? 36;
  const cp = BigInt(opts.companyPrefix);
  const item = BigInt(opts.itemNumber);
  const serial = BigInt(opts.serialNumber);
  if (cp > mask(cpBits)) throw new Error(`Company prefix exceeds ${cpBits} bits.`);
  if (item > mask(itemBits)) throw new Error(`Item number exceeds ${itemBits} bits.`);
  if (serial > mask(serialBits)) throw new Error(`Serial exceeds ${serialBits} bits.`);
  const epcValue =
    (cp << BigInt(itemBits + serialBits)) |
    (item << BigInt(serialBits)) |
    serial;
  return {
    epcHex: toPaddedHex(epcValue, 96),
    epcDecimal: epcValue.toString(10),
  };
}

/**
 * ERB-faithful description word-wrap, ported from the operator's external
 * label-editor template. Splits the description on whitespace, removes every
 * word that also appears in color (attr3) or size (attr4), then greedily packs
 * words into up to two lines — each line takes words until the running length
 * exceeds 15 chars; the overflowing word starts the next line. Mirrors the
 * Ruby `number_of_lines.times { ... }` block. One safe deviation from the ERB:
 * a single word longer than 15 chars is emitted alone rather than dropped
 * (the ERB would have rendered an empty line).
 */
function wrapDescriptionErb(
  description: string,
  color: string,
  size: string,
): readonly [string, string] {
  const remove = new Set(
    [sanitizeZpl(color), sanitizeZpl(size)]
      .join(" ")
      .toUpperCase()
      .split(/\s+/)
      .filter(Boolean),
  );
  let words = sanitizeZpl(description)
    .toUpperCase()
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !remove.has(w));
  const charsPerLine = 15;
  const out: string[] = [];
  for (let n = 0; n < 2; n += 1) {
    let line = "";
    let temp = "";
    for (const r of words) {
      temp += `${r} `;
      if (temp.length > charsPerLine) break;
      line = temp;
    }
    let consumed = line.trim() ? line.trim().split(/\s+/).length : 0;
    if (consumed === 0 && words.length > 0) {
      line = words[0];
      consumed = 1;
    }
    out.push(line.trim());
    words = words.slice(consumed);
    if (words.length === 0) break;
  }
  return [out[0] ?? "", out[1] ?? ""] as const;
}

export function inferSizeFromDescription(description: string): string {
  const tokens = sanitizeZpl(description).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "";
  const tail = tokens[tokens.length - 1].toUpperCase();
  if (COMMON_SIZES.has(tail)) return tail;
  if (/^\d{1,3}(\.\d+)?$/.test(tail)) return tail;
  return "";
}

export function inferColorFromDescription(description: string, inferredSize: string): string {
  const tokens = sanitizeZpl(description).split(/\s+/).filter(Boolean);
  if (tokens.length < 1) return "";
  const upper = tokens.map((t) => t.toUpperCase());
  const inferredSizeUpper = String(inferredSize || "").toUpperCase();
  const lastIdx = upper.length - 1;
  const last = upper[lastIdx];
  const secondLast = upper[lastIdx - 1] || "";
  if (inferredSizeUpper && last === inferredSizeUpper) {
    if (secondLast && upper.length >= 3) {
      const thirdLast = upper[lastIdx - 2] || "";
      const pair = `${thirdLast} ${secondLast}`.trim();
      if (MULTI_WORD_COLORS.has(pair)) {
        return tokens[lastIdx - 2] && tokens[lastIdx - 1]
          ? `${tokens[lastIdx - 2]} ${tokens[lastIdx - 1]}`
          : tokens[lastIdx - 1] || "";
      }
    }
    return tokens[lastIdx - 1] || "";
  }
  if (secondLast) {
    const pair = `${secondLast} ${last}`.trim();
    if (MULTI_WORD_COLORS.has(pair)) {
      return `${tokens[lastIdx - 1]} ${tokens[lastIdx]}`;
    }
  }
  return tokens[lastIdx] || "";
}

function normalizeSizesColumn(value: string): string {
  const tokens = sanitizeZpl(value)
    .toUpperCase()
    .split(/[,/| ]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    unique.push(token);
  }
  // Operator preference (May 2026): no commas in the size-run strip —
  // just space-separated tokens for cleaner visual scanning.
  if (unique.length === 0) return "XS S M L";

  // Sort into natural size order (XS S M L XL XXL XXXL …) rather than the
  // alphabetical order the SQL DISTINCT…ORDER BY produced. Numeric sizes
  // (e.g. jeans 28/30/32) sort ascending; recognised alpha sizes use the
  // rank table; anything unrecognised keeps its incoming order, last.
  const rankKey = (s: string): [number, number] => {
    if (/^\d+(\.\d+)?$/.test(s)) return [0, Number.parseFloat(s)];
    const r = ALPHA_SIZE_RANK[s];
    if (r !== undefined) return [1, r];
    return [2, unique.indexOf(s)];
  };
  unique.sort((a, b) => {
    const ka = rankKey(a);
    const kb = rankKey(b);
    return ka[0] - kb[0] || ka[1] - kb[1];
  });
  return unique.join(" ");
}

/**
 * Build a single Carbon price-tag ZPL. The output layout matches the
 * external label-editor ERB template (vertical columns, ^GB graphic boxes,
 * ^FT/^AKB rotated text, ^BCB vertical Code 128 of the SKU, ^RFW,E
 * decimal-triplet EPC encoding).
 */
export function generateCarbonTagZpl(opts: {
  input: CarbonTagInput;
  settings: CarbonTagSettings;
  epcWrite: { companyPrefix: number; itemNumber: number; serialNumber: number };
}): string {
  const { input, settings, epcWrite } = opts;
  const safeColor = sanitizeZpl(input.color).toUpperCase();
  const inferredSize = inferSizeFromDescription(input.itemName);
  const safeSize = (sanitizeZpl(input.size) || inferredSize || "").toUpperCase();
  const safeColorResolved = (
    safeColor || inferColorFromDescription(input.itemName, safeSize)
  ).toUpperCase();
  const safeUpc = sanitizeZpl(input.upc).toUpperCase();
  const safeSku = sanitizeZpl(input.customSku).toUpperCase();
  // ERB renders `$<%=@retail_price.to_i %>` — integer dollars, truncated.
  const safePrice = String(Math.trunc(Number.parseFloat(sanitizeZpl(input.retailPrice)) || 0));
  const safeSizes = normalizeSizesColumn(input.sizesAvailable ?? "");
  const [line1, line2] = wrapDescriptionErb(input.itemName, safeColorResolved, safeSize);
  const epcLength = epcBitTotal(settings);
  // 2026-05-28 — WMS commission/reprint label re-aligned to MATCH the
  // operator's external label-editor ERB template 1:1: the ERB's exact
  // ^GB box/divider coordinates, ^FT field positions, plain Arial (no bold
  // font B), integer price (`.to_i`-equivalent truncation), and the ERB's
  // 15-char/2-line description wrap (wrapDescriptionErb above).
  //   • Barcode REVERTED to Code 128 (^BCB,110) at ^BY2,2 per operator
  //     request, encoding the RAW SKU/ALU — the prior trailing-letter
  //     strip ("subset C width hack") is intentionally GONE so the bars
  //     mirror the ERB's `<%=@alu%>`. If a SKU that ends in letters
  //     overflows the right border again, revisit the encode here.
  //   • The ERB `@item_attr12` slot (^FT765) is mapped to the sizes-run
  //     column (safeSizes). Change that token if attr12 should hold a
  //     different field.
  // The static `TALLA/SIZE` label is hardcoded. ^PW/^LL/^LH/^LS/^LT remain
  // (the ERB omits them — the external editor injects size/offset; the WMS
  // must supply them itself for raw-port printing). ^CI28 kept for UTF-8.

  return `^XA
^CI28
^PW${settings.labelWidthDots}
^LL${settings.labelHeightDots}
^MD20
^LH0,0
^LS${settings.labelShiftX}
^LT${settings.labelShiftY}
^CWK,E:ARIAL.TTF
^FT73,490^AKB,38,^FDTALLA/SIZE^FS
^FT194,522^AKB,134^FB515,1,0,C^FD${safeSize}^FS
^FT253,590^AKB,36^FB600,1,0,C^FD${safeUpc}^FS
^FT313,552^AKB,36^FB550,1,0,C^FD${line1}^FS
^FT373,552^AKB,36^FB550,1,0,C^FD${line2}^FS
^FT432,552^AKB,36^FB550,1,0,C^FD${safeColorResolved}^FS
^FO455,${safeSku.length === 13 ? "95" : "125"}^BY2,2^BCB,110,N,N,N^FD${safeSku}^FS
^FT600,552^AKB,32^FB550,1,0,C^FD${safeSku}^FS
^FT687,552^AKB,60^FB550,1,0,C^FD$${safePrice}^FS
^FT765,552^AKB,44^FB550,1,0,C^FD${safeSizes}^FS
^FO34,79^GB410,427,2^FS
^FO83,77^GB0,423,3^FS
^FO325,80^GB0,425,3^FS
^FO387,80^GB0,425,3^FS
^FO612,79^GB107,426,3^FS
^FO783,57^GB0,477,3^FS
^FO266,80^GB0,425,3^FS
^FO207,80^GB0,425,3^FS
^RB${epcLength},${settings.companyPrefixBits},${settings.itemNumberBits},${settings.serialBits}^FS
^RFW,E^FD${epcWrite.companyPrefix},${epcWrite.itemNumber},${epcWrite.serialNumber}^FS
^PQ1,0,1,Y
^XZ`;
}

/** Concatenate per-label ZPL into one batch the printer streams sequentially. */
export function generateCarbonTagBatch(zpls: string[]): string {
  return zpls.join("\n");
}
