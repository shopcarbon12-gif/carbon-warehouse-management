/**
 * PrintNode integration — used by the NON-RFID Print Tags path.
 *
 * Non-RFID hang-tags print through PrintNode (cloud → local PrintNode client →
 * the label printer) rather than the LAN browser-direct path used for RFID
 * commissioning. The account API key + default printer live in env.
 *
 * Auth is HTTP Basic with the API key as the username and an empty password.
 */

const PRINTNODE_BASE = "https://api.printnode.com";

export function printNodeApiKey(): string {
  return process.env.PRINTNODE_API_KEY?.trim() ?? "";
}

function envPrinterId(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/** Default NON-RFID printer id (the 2x3 label printer). */
export function printNodeDefaultPrinterId(): number | null {
  return envPrinterId("PRINTNODE_PRINTER_ID");
}

/**
 * RFID printer id (the Zebra hang-tag printer). Must be added to PrintNode so the
 * cloud WMS can reach it over HTTPS — a browser can't POST to the LAN printer.
 * NO fallback to the non-RFID printer: that printer can't encode the RFID chip,
 * so an unconfigured RFID printer should fail loudly rather than misprint.
 */
export function printNodeRfidPrinterId(): number | null {
  return envPrinterId("PRINTNODE_RFID_PRINTER_ID");
}

function authHeader(key: string): string {
  // Basic <base64(apiKey + ":")>
  return `Basic ${Buffer.from(`${key}:`).toString("base64")}`;
}

export type PrintNodePrinter = { id: number; name: string; state?: string };

/** List the account's printers (so the UI can offer a selector). */
export async function listPrintNodePrinters(): Promise<PrintNodePrinter[]> {
  const key = printNodeApiKey();
  if (!key) throw new Error("PRINTNODE_API_KEY not set");
  const res = await fetch(`${PRINTNODE_BASE}/printers`, {
    headers: { Authorization: authHeader(key) },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`PrintNode /printers ${res.status}`);
  }
  const rows = (await res.json()) as Array<{ id: number; name: string; state?: string }>;
  return rows.map((r) => ({ id: r.id, name: r.name, state: r.state }));
}

export type PrintNodeJob = {
  printerId: number;
  /** Raw ZPL to print. */
  zpl: string;
  title?: string;
  /** Number of copies of the whole job. Defaults to 1. */
  qty?: number;
  source?: string;
};

/** Submit a raw-ZPL print job. Returns the PrintNode print-job id. */
export async function submitPrintNodeJob(job: PrintNodeJob): Promise<number> {
  const key = printNodeApiKey();
  if (!key) throw new Error("PRINTNODE_API_KEY not set");
  const body = {
    printerId: job.printerId,
    title: job.title ?? "Carbon WMS — print tag",
    contentType: "raw_base64",
    content: Buffer.from(job.zpl, "utf8").toString("base64"),
    source: job.source ?? "Carbon WMS",
    ...(job.qty && job.qty > 1 ? { qty: job.qty } : {}),
  };
  const res = await fetch(`${PRINTNODE_BASE}/printjobs`, {
    method: "POST",
    headers: { Authorization: authHeader(key), "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PrintNode /printjobs ${res.status}: ${text.slice(0, 200)}`);
  }
  // PrintNode returns the new print-job id as a bare number.
  return (await res.json()) as number;
}
