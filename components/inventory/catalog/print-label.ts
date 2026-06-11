/**
 * Print one RFID hang-tag label for a custom_sku to the LAN printer at
 * 192.168.1.3, creating its item with status='unknown'.
 *
 * Reuses the commission pipeline: the server allocates a fresh SGTIN-96 EPC,
 * inserts an items row (status 'unknown' — not live yet), and returns the ZPL.
 * Because the cloud WMS can't reach the LAN printer, we pass
 * X-Carbon-Client-Print and the browser POSTs the ZPL to the printer's HTTP
 * /pstprnt endpoint itself (browser is on the LAN; raw TCP 9100 isn't reachable
 * from a browser). Used by the catalog item popup + the matrix row print button.
 */

import { generateNonRfidTag203Batch } from "@/lib/utils/zpl-carbon-tag-203";
import type { CarbonTagInput } from "@/lib/utils/zpl-carbon-tag";

const PRINTER_HOST = "192.168.1.3";
/** 203-dpi Zebra for the no-chip tag — same target as /tags-labels/print/non-rfid. */
const NON_RFID_PRINTER_HOST = "192.168.1.220";

export async function printRfidLabel(
  customSkuId: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch("/api/rfid/commission", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Carbon-Client-Print": "1" },
      body: JSON.stringify({
        customSkuId,
        qty: 1,
        addToInventory: false,
        status: "unknown",
        printerIp: PRINTER_HOST,
        printerPort: 80,
        printerUri: "PSTPRNT",
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      zpl?: string;
      printer_host?: string;
      printer_port?: number;
      printer_uri?: string;
      inserted?: { epc: string }[];
    };
    if (!res.ok) return { ok: false, message: data.error ?? "Print failed" };
    if (!data.zpl) return { ok: false, message: "No ZPL returned from server." };

    const host = data.printer_host ?? PRINTER_HOST;
    const url = `http://${host}:${data.printer_port ?? 80}/${String(data.printer_uri ?? "PSTPRNT").toLowerCase()}`;
    const epc = data.inserted?.[0]?.epc ?? "";
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: data.zpl,
        // Warehouse printers don't return CORS headers; no-cors lets the POST
        // fire (opaque response). The printer prints regardless.
        mode: "no-cors",
        signal: AbortSignal.timeout(10_000),
      });
      return {
        ok: true,
        message: `Label sent to ${host} (status: unknown)${epc ? ` · EPC ${epc}` : ""}.`,
      };
    } catch {
      return {
        ok: false,
        message: `Item created (status unknown) but printer ${host} was unreachable.`,
      };
    }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Print failed" };
  }
}

/**
 * Print one NON-RFID (no-chip) hang-tag for a custom_sku to the 203-dpi printer
 * at 192.168.1.220 — byte-identical to the /tags-labels/print/non-rfid page:
 * same `sizesAvailable` source (/api/tags/sizes), same `generateNonRfidTag203Batch`
 * generator, same printer/URI. No DB write, no EPC — the label is built client-side
 * and POSTed straight to the printer's /pstprnt endpoint (browser is on the LAN).
 */
export async function printNonRfidLabel(item: {
  customSkuId: string;
  itemName: string;
  color: string | null;
  size: string | null;
  upc: string | null;
  sku: string;
  retailPrice: string | null;
}): Promise<{ ok: boolean; message: string }> {
  try {
    // Size-run column ("30 32 34") — same fetch the print workspace uses so the
    // printed tag matches the print page exactly.
    let sizesAvailable = "";
    try {
      const sres = await fetch(
        `/api/tags/sizes?customSkuId=${encodeURIComponent(item.customSkuId)}`,
      );
      const sj = (await sres.json().catch(() => ({}))) as { sizesAvailable?: string };
      sizesAvailable = String(sj.sizesAvailable ?? "");
    } catch {
      /* sizes column is optional */
    }

    const input: CarbonTagInput = {
      itemName: item.itemName ?? "",
      color: item.color ?? "",
      size: item.size ?? "",
      upc: item.upc ?? "",
      customSku: item.sku,
      retailPrice: item.retailPrice ?? "0",
      sizesAvailable,
    };
    const zpl = generateNonRfidTag203Batch(input, 1);

    const url = `http://${NON_RFID_PRINTER_HOST}:80/pstprnt`;
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: zpl,
        mode: "no-cors",
        signal: AbortSignal.timeout(10_000),
      });
      return { ok: true, message: `Non-RFID label sent to ${NON_RFID_PRINTER_HOST}.` };
    } catch {
      return { ok: false, message: `Printer ${NON_RFID_PRINTER_HOST} was unreachable.` };
    }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Print failed" };
  }
}
