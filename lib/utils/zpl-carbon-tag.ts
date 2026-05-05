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

export const LABEL_WIDTH_DOTS = 812;
export const LABEL_HEIGHT_DOTS = 594;
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
  companyPrefix: 1044991,
  companyPrefixBits: 20,
  itemNumberBits: 40,
  serialBits: 36,
  printerIp: "192.168.1.3",
  // Browser print flow uses Zebra web print endpoint (/pstprnt) on HTTP port 80.
  printerPort: 80,
  labelWidthDots: LABEL_WIDTH_DOTS,
  labelHeightDots: LABEL_HEIGHT_DOTS,
  labelShiftX: 0,
  labelShiftY: 0,
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

function splitVerticalColumns(
  description: string,
  color: string,
  size: string,
): readonly [string, string] {
  const words = sanitizeZpl(description).toUpperCase().split(/\s+/).filter(Boolean);
  const excluded = [sanitizeZpl(color), sanitizeZpl(size)]
    .join(" ")
    .toUpperCase()
    .split(/\s+/)
    .filter(Boolean);
  const filteredWords = words.filter((word) => !excluded.includes(word));
  if (filteredWords.length === 0) return ["ITEM", ""] as const;
  if (filteredWords.length === 1) return [sanitizeZpl(filteredWords[0]), ""] as const;
  if (filteredWords.length === 2) {
    return [sanitizeZpl(filteredWords[0]), sanitizeZpl(filteredWords[1])] as const;
  }
  const half = Math.ceil(filteredWords.length / 2);
  const line1 = sanitizeZpl(filteredWords.slice(0, half).join(" "));
  const line2 = sanitizeZpl(filteredWords.slice(half).join(" "));
  return [line1, line2] as const;
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

function formatDisplayPrice(value: string): string {
  const raw = sanitizeZpl(value);
  const num = Number.parseFloat(raw);
  if (Number.isFinite(num)) {
    if (Number.isInteger(num)) return String(num);
    return num.toFixed(2).replace(/\.00$/, "");
  }
  return raw || "0";
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
  if (unique.length === 0) return "XS, S, M, L";
  return unique.join(", ");
}

/**
 * Build a single Carbon price-tag ZPL. The output layout matches the
 * carbon-gen Studio renderer (vertical columns, ^GB graphic boxes,
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
  const safePrice = formatDisplayPrice(input.retailPrice);
  const safeSizes = normalizeSizesColumn(input.sizesAvailable ?? "");
  const [line1, line2] = splitVerticalColumns(input.itemName, safeColorResolved, safeSize);
  const barcodeY = safeSku.length === 13 ? 95 : 125;
  const epcLength = epcBitTotal(settings);

  return `^XA
^CI28
^PON
^FWN
^MNY
^PW${settings.labelWidthDots}
^LL${settings.labelHeightDots}
^MD20
^LH0,0
^LS${settings.labelShiftX}
^LT${settings.labelShiftY}
^CWK,E:ARIAL.TTF

^FO34,79^GB410,427,2^FS
^FO83,77^GB0,423,3^FS
^FO207,80^GB0,425,3^FS
^FO266,80^GB0,425,3^FS
^FO325,80^GB0,425,3^FS
^FO387,80^GB0,425,3^FS
^FO612,79^GB107,426,3^FS
^FO783,57^GB0,477,3^FS

^FT73,490^AKB,38,^FDTALLA/SIZE^FS
^FT194,522^AKB,134^FB515,1,0,C^FD${safeSize}^FS
^FT253,590^AKB,36^FB600,1,0,C^FD${safeUpc}^FS
^FT313,552^AKB,36^FB550,1,0,C^FD${line1}^FS
^FT373,552^AKB,36^FB550,1,0,C^FD${line2}^FS
^FT432,552^AKB,36^FB550,1,0,C^FD${safeColorResolved}^FS

^FO455,${barcodeY}^BY2,2^BCB,110,N,N,N^FD${safeSku}^FS
^FT600,552^AKB,32^FB550,1,0,C^FD${safeSku}^FS
^FT687,552^AKB,60^FB550,1,0,C^FD$${safePrice}^FS
^FT765,552^AKB,38^FB550,1,0,C^FD${safeSizes}^FS

^RB${epcLength},${settings.companyPrefixBits},${settings.itemNumberBits},${settings.serialBits}^FS
^RFW,E^FD${epcWrite.companyPrefix},${epcWrite.itemNumber},${epcWrite.serialNumber}^FS

^PQ1,0,1,Y
^XZ`;
}

/** Concatenate per-label ZPL into one batch the printer streams sequentially. */
export function generateCarbonTagBatch(zpls: string[]): string {
  return zpls.join("\n");
}
