"use server";

import { getSession } from "@/lib/get-session";
import type { ParsedRow } from "@/lib/csv-customer-parse";
import { importRows, type ImportSummary } from "@/lib/csv-customer-import";

/**
 * Commit one batch of previously-previewed rows to pos_customers. The client
 * parses the file in the browser and sends rows in small batches (each its own
 * transaction) so a 10k-row import never hits the Server Action body limit and
 * never runs as one giant transaction. Re-running is safe — matched customers
 * are backfilled, not duplicated.
 */
export async function commitImport(
  rows: ParsedRow[],
  locationId: number | null,
): Promise<{ ok: boolean; summary?: ImportSummary; error?: string }> {
  const session = await getSession();
  if (!session?.sub) return { ok: false, error: "Not signed in." };
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, error: "Nothing to import." };
  }
  if (rows.length > 1000) {
    // Defensive: keep each request well under the Server Action body limit.
    return { ok: false, error: "Batch too large — import in chunks of ≤1000." };
  }
  try {
    const summary = await importRows(rows, {
      actedByUserId: session.sub,
      createdAtLocationId: locationId ?? null,
    });
    return { ok: true, summary };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Import failed." };
  }
}
