import { redirect } from "next/navigation";

/**
 * The integrations overview only listed old connection records (Senitron's
 * March 2026 import, the retired Lightspeed row) and had no controls, so it is
 * hidden from the WMS (owner 2026-10-22). The rows stay in
 * integration_connections and /api/integrations is untouched; Integrations ›
 * Shopify keeps its own page.
 */
export default function IntegrationsPage() {
  redirect("/dashboard");
}
