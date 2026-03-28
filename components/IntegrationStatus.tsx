import { shopifyConfigured } from "@/lib/integrations/shopify";
import { lightspeedConfigured } from "@/lib/integrations/lightspeed";
import { senitronConfigured, senitronBaseUrl } from "@/lib/integrations/senitron";

function Dot({ on }: { on: boolean }) {
  return (
    <span
      className={`inline-block size-2 rounded-full ${on ? "bg-[var(--accent)]" : "bg-[var(--muted)]/50"}`}
      title={on ? "Configured" : "Not configured"}
    />
  );
}

export function IntegrationStatus() {
  const rows = [
    { name: "Shopify", ok: shopifyConfigured(), hint: "Admin API + inventory" },
    { name: "Lightspeed POS", ok: lightspeedConfigured(), hint: "Retail catalog / sales" },
    {
      name: "Senitron RFID",
      ok: senitronConfigured(),
      hint: senitronBaseUrl(),
    },
  ];
  return (
    <ul className="grid gap-3 sm:grid-cols-3">
      {rows.map((r) => (
        <li
          key={r.name}
          className="flex flex-col gap-1 rounded-lg border border-[var(--surface-border)] bg-[var(--surface)] p-4"
        >
          <div className="flex items-center gap-2">
            <Dot on={r.ok} />
            <span className="font-semibold text-[var(--foreground)]">{r.name}</span>
          </div>
          <p className="font-mono text-[11px] leading-snug text-[var(--muted)]">{r.hint}</p>
        </li>
      ))}
    </ul>
  );
}
