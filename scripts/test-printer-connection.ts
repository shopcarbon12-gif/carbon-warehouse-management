/**
 * Smoke-test raw HTTP POST to the Zebra (same URL shape as RFID commissioning).
 *
 *   npx tsx scripts/test-printer-connection.ts
 *
 * Env: PRINTER_HOST, PRINTER_PORT, PRINTER_URI (optional; defaults match commissioning UI).
 */
import { buildPrinterRawUrl } from "../lib/server/rfid-commission";

const PRINTER_HOST = process.env.PRINTER_HOST ?? "192.168.1.3";
const PRINTER_PORT = Number.parseInt(process.env.PRINTER_PORT ?? "80", 10) || 80;
const PRINTER_URI = process.env.PRINTER_URI ?? "PSTPRNT";

async function testPrinterConnection() {
  const targetUrl = buildPrinterRawUrl(PRINTER_HOST, PRINTER_PORT, PRINTER_URI);
  console.log(`🔌 Attempting to connect to WMS Printer at: ${targetUrl}...`);

  // ~HI returns model/firmware text without feeding a label.
  const payload = "~HI\n";

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const startTime = Date.now();
    const response = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        Accept: "text/plain, */*",
      },
      body: payload,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const ping = Date.now() - startTime;

    const bodyText = await response.text().catch(() => "");

    if (response.ok) {
      console.log(`✅ SUCCESS: Printer reached in ${ping}ms (HTTP ${response.status})`);
      if (bodyText.trim()) {
        console.log("Response body:", bodyText.trim().slice(0, 500));
      }
      console.log(
        "Routing from the Node.js server to the LAN is functioning perfectly.",
      );
    } else {
      console.error(
        `❌ ERROR: Connected, but received HTTP ${response.status} - ${response.statusText}`,
      );
      if (bodyText.trim()) {
        console.error("Body:", bodyText.trim().slice(0, 500));
      }
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") {
      console.error(`❌ TIMEOUT: Could not reach ${PRINTER_HOST} within 5 seconds.`);
      console.error(
        "Check your Docker network settings or ensure the Node server is on the same LAN as the printer.",
      );
    } else if (error instanceof Error) {
      console.error(`❌ NETWORK ERROR: ${error.message}`);
    } else {
      console.error("❌ UNKNOWN ERROR:", error);
    }
  }
}

void testPrinterConnection();
