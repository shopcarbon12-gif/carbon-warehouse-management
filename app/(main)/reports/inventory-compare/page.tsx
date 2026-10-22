import { redirect } from "next/navigation";

/**
 * POS compare read Lightspeed's expected on-hand, and Lightspeed is retired, so
 * this report is hidden from the WMS. The workspace component
 * (components/reports/inventory-compare-workspace.tsx) and its API routes stay
 * in the repo untouched; only the page is gated off.
 */
export default function InventoryComparePage() {
  redirect("/dashboard");
}
