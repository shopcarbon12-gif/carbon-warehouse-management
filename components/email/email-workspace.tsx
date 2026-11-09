"use client";

import { useSearchParams } from "next/navigation";
import { EmailCampaigns } from "./campaigns";
import { EmailContacts } from "./contacts";
import { EmailDesigner } from "./designer";
import { EmailSettingsPanel } from "./settings";
import { EmailsList } from "./emails-list";

/**
 * Email Marketing: CarbonWMS's own email platform (owner, 2026-11-07; its own
 * menu section since 2026-11-09, built like Klaviyo). Emails (drag-and-drop
 * editor) · Campaigns · AI Designer · Audience · Settings. The open tab lives
 * in the URL (?tab=) so a refresh or a shared link opens the same place.
 */
const TABS = [
  { id: "emails", label: "Emails" },
  { id: "campaigns", label: "Campaigns" },
  { id: "designer", label: "AI Designer" },
  { id: "contacts", label: "Audience" },
  { id: "settings", label: "Settings" },
] as const;
type Tab = (typeof TABS)[number]["id"];

export function EmailWorkspace() {
  const params = useSearchParams();
  const raw = params.get("tab");
  const tab: Tab = TABS.some((x) => x.id === raw) ? (raw as Tab) : "emails";
  function open(t: Tab, extra: Record<string, string> = {}) {
    const u = new URL(window.location.href);
    u.searchParams.set("tab", t);
    for (const k of ["edit", "campaign"]) u.searchParams.delete(k);
    for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
    window.history.replaceState(null, "", u.toString());
  }
  return (
    <div className="flex min-w-0 flex-col gap-3 p-3 max-md:p-2">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-[var(--wms-fg)]">Email Marketing</h1>
          <p className="text-xs text-[var(--wms-muted)]">Build emails with drag and drop, send them through Amazon SES with a personal Shopify code per customer, and see what they sold.</p>
        </div>
      </header>
      <nav className="flex min-w-0 gap-1 overflow-x-auto border-b border-[var(--wms-border)]" aria-label="Email sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => open(t.id)}
            className={`-mb-px whitespace-nowrap border-b-2 px-3 py-1.5 font-mono text-[0.72rem] uppercase tracking-wide max-md:min-h-11 ${
              tab === t.id ? "border-[var(--wms-fg)] text-[var(--wms-fg)]" : "border-transparent text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>
      {tab === "emails" && <EmailsList onCampaign={(id) => open("campaigns", { campaign: id })} />}
      {tab === "campaigns" && <EmailCampaigns onOpenDesigner={() => open("emails")} />}
      {tab === "designer" && <EmailDesigner />}
      {tab === "contacts" && <EmailContacts />}
      {tab === "settings" && <EmailSettingsPanel />}
    </div>
  );
}
