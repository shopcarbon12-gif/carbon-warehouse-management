import { redirect } from "next/navigation";

/**
 * Lightspeed sync is retired (the WMS is the catalog source of truth), so this
 * screen is hidden from the WMS. The workspace component
 * (components/inventory/sync/sync-dashboard.tsx) and every sync API stay in the
 * repo untouched; only the page is gated off.
 */
export default function InventorySyncPage() {
  redirect("/dashboard");
}
