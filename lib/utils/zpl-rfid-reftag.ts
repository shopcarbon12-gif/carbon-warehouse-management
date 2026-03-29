/**
 * Zebra ZPL for RFID REFTAG — matches Carbon WMS `generateSGTIN96` (12 hex bytes in ^RFW).
 * `includeDfr` true only for the first label in a batch to avoid printer buffer issues.
 */

export type RfidReftagZplLabel = {
  epc: string;
  sku?: string | null;
  description?: string | null;
  systemId: string | number;
  upc?: string | null;
  dateStr?: string;
  /** Label width dots (^PW). Default 812. */
  pw?: number;
  /** Label length dots (^LL). Default 594. */
  ll?: number;
};

export function sanitizeField(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(/[\^~]/g, "")
    .replace(/\n|\r/g, " ")
    .substring(0, 40);
}

export function buildRfidReftagZpl(
  data: RfidReftagZplLabel,
  includeDfr: boolean = true,
): string {
  const epc = String(data.epc).replace(/\s/g, "").toUpperCase();
  if (!/^[0-9A-F]{24}$/.test(epc)) {
    throw new Error("epc must be exactly 24 hexadecimal characters");
  }

  const dfrLine = includeDfr ? "^DFR:REFTAG.ZPL^FS\n" : "";
  const pw = data.pw ?? 812;
  const ll = data.ll ?? 594;
  const dateStr = data.dateStr ?? new Date().toISOString().slice(0, 10);

  return `^XA
${dfrLine}^PR1,1^FS
^PW${pw}
^LL${ll}
^PON
^LH0,0
^RS8,1,50,1,E^FS
^RFW,H,1,12,E^FD${epc}^FS
^FO50,50^A0N,50,50^FD${sanitizeField(data.sku)}^FS
^FO50,110^A0N,30,30^FD${sanitizeField(data.description)}^FS
^FO50,160^A0N,25,25^FDID: ${data.systemId}^FS
^FO50,250^BY3^BCN,150,Y,N,N^FD${data.upc}^FS
^FO550,500^A0N,20,20^FDCARBON WMS^FS
^FO50,500^A0N,20,20^FD${dateStr}^FS
^XZ`;
}

export function buildRfidReftagZplBatch(labels: RfidReftagZplLabel[]): string {
  return labels
    .map((label, index) => {
      const isFirstLabel = index === 0;
      return buildRfidReftagZpl(label, isFirstLabel);
    })
    .join("\n");
}
