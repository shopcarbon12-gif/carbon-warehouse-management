"use client";

import useSWR from "swr";
import { Radar } from "lucide-react";

type DiscoveryRow = {
  id: string;
  cdm_agent_id: string;
  cdm_agent_name: string;
  mac_address: string;
  current_ip: string;
  port: number;
  dhcp_enabled: boolean | null;
  first_seen_at: string;
  last_seen_at: string;
  age_seconds: number | null;
};

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

function fmtAge(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

/**
 * WIZnet bridges seen on the LAN by the CDM agent that aren't yet bound
 * to a `devices` row. Refreshes every 60s. Adoption (turn discovery →
 * device + lock the static IP) is a follow-up; for now the panel is
 * read-only — visibility lets the operator see the MACs and confirm
 * each is the reader they expect before manually adding it.
 */
export function WiznetDiscoveriesPanel() {
  const { data, error } = useSWR<{ discoveries: DiscoveryRow[] }>(
    "/api/cdm-agents/wiznet-discoveries",
    fetcher,
    { refreshInterval: 60_000, revalidateOnFocus: true },
  );

  const rows = data?.discoveries ?? [];

  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-[var(--wms-muted)]">
          <Radar className="h-3.5 w-3.5" /> Discovered WIZnet bridges
        </h2>
        <span className="font-mono text-[0.6rem] text-[var(--wms-muted)]">
          {rows.length === 0 ? "no unbound bridges" : `${rows.length} pending`}
        </span>
      </div>

      {error ? (
        <p className="rounded-md border border-red-400/30 p-3 text-center font-mono text-xs text-red-400/80">
          Failed to load discoveries.
        </p>
      ) : rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-[var(--wms-border)] p-3 text-center font-mono text-xs text-[var(--wms-muted)]">
          The agent isn&apos;t seeing any unbound WIZnet bridges on the LAN. All discovered
          bridges are matched to devices by MAC address.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-[var(--wms-border)]">
          <table className="w-full min-w-[760px] border-collapse text-left text-xs max-md:min-w-[560px]">
            <thead>
              <tr className="border-b border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] font-mono uppercase tracking-wide">
                <th className="px-3 py-2 text-[0.6rem] max-md:sticky max-md:left-0 max-md:z-[1] max-md:bg-[var(--wms-surface-elevated)] max-md:text-xs max-md:shadow-[inset_-1px_0_0_var(--wms-border)]">MAC</th>
                <th className="px-3 py-2 text-[0.6rem] max-md:text-xs">Current IP</th>
                <th className="px-3 py-2 text-[0.6rem] max-md:hidden">Port</th>
                <th className="px-3 py-2 text-[0.6rem] max-md:text-xs">DHCP</th>
                <th className="px-3 py-2 text-[0.6rem] max-md:text-xs">Agent</th>
                <th className="px-3 py-2 text-[0.6rem] max-md:text-xs">Last seen</th>
                <th className="px-3 py-2 text-[0.6rem] max-md:hidden">First seen</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr
                  key={d.id}
                  className="border-b border-[var(--wms-border)]/60 last:border-b-0"
                >
                  <td className="px-3 py-2 font-mono text-[var(--wms-fg)] max-md:sticky max-md:left-0 max-md:z-[1] max-md:bg-[var(--wms-surface-elevated)] max-md:shadow-[inset_-1px_0_0_var(--wms-border)]">
                    {d.mac_address.toUpperCase()}
                  </td>
                  <td className="px-3 py-2 font-mono text-[var(--wms-fg)]">{d.current_ip}</td>
                  <td className="px-3 py-2 font-mono text-[var(--wms-muted)] max-md:hidden">{d.port}</td>
                  <td className="px-3 py-2 font-mono text-[var(--wms-muted)]">
                    {d.dhcp_enabled === null ? "?" : d.dhcp_enabled ? "yes" : "no"}
                  </td>
                  <td className="px-3 py-2 text-[var(--wms-muted)]">{d.cdm_agent_name}</td>
                  <td className="px-3 py-2 font-mono text-[var(--wms-muted)]">
                    {fmtAge(d.age_seconds)}
                  </td>
                  <td className="px-3 py-2 font-mono text-[var(--wms-muted)] max-md:hidden">
                    {new Date(d.first_seen_at).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 font-mono text-[0.6rem] text-[var(--wms-muted)]">
        Bridges seen on the LAN that aren&apos;t bound to a reader yet. Add a reader with the matching
        MAC address to bind it and stop it from showing here.
      </p>
    </section>
  );
}
