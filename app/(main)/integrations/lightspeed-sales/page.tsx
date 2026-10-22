import { redirect } from "next/navigation";

/**
 * Lightspeed sales feed is retired and hidden from the WMS. The workspace
 * component (components/infrastructure/lightspeed-sales-workspace.tsx) and its
 * API routes stay in the repo untouched; only the page is gated off.
 */
export default function LightspeedSalesPage() {
  redirect("/dashboard");
}
