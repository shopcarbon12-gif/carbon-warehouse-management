"use client";

import { useState } from "react";
import useSWR from "swr";
import {
  Antenna as AntennaIcon,
  Cpu,
  KeyRound,
  Pencil,
  Plus,
  Radio,
  Server,
  Trash2,
  Zap,
} from "lucide-react";
import type {
  HardwareConfigTree,
  HardwareReaderRow,
  HardwareAntennaRow,
} from "@/lib/server/hardware-config";
import type { CdmAgentRow } from "@/lib/server/cdm-agents";
import type { ZoneRow } from "@/lib/server/zones";
import { ZoneEditorModal } from "./zone-editor-modal";
import { CdmAgentEditorModal } from "./cdm-agent-editor-modal";
import { TokenRevealModal } from "./token-reveal-modal";
import { RecoverReadersButton } from "./recover-readers-button";
import { ReaderEditorModal } from "./reader-editor-modal";
import { AntennaEditorModal } from "./antenna-editor-modal";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? res.statusText);
  }
  return res.json();
};

export function HardwareConfigWorkspace() {
  // Live-ish dashboard: refetch on tab focus + poll agents/tree every 10s so
  // the heartbeat / status pill stays current without manual refresh. Zones
  // change rarely, longer interval is fine.
  const tree = useSWR<HardwareConfigTree>("/api/hardware-config", fetcher, {
    refreshInterval: 10_000,
    revalidateOnFocus: true,
  });
  const zones = useSWR<{ zones: ZoneRow[] }>("/api/zones", fetcher, {
    refreshInterval: 60_000,
    revalidateOnFocus: true,
  });
  const agents = useSWR<{ agents: CdmAgentRow[] }>("/api/cdm-agents", fetcher, {
    refreshInterval: 10_000,
    revalidateOnFocus: true,
  });

  // Modal state
  const [zoneModalOpen, setZoneModalOpen] = useState(false);
  const [zoneModalLocationId, setZoneModalLocationId] = useState<string | null>(null);
  const [agentModalOpen, setAgentModalOpen] = useState(false);
  const [revealToken, setRevealToken] = useState<{ name: string; token: string } | null>(
    null,
  );
  const [readerModalOpen, setReaderModalOpen] = useState(false);
  const [readerEditing, setReaderEditing] = useState<HardwareReaderRow | null>(null);
  const [readerDefaultZoneId, setReaderDefaultZoneId] = useState<string | null>(null);
  const [antennaModalOpen, setAntennaModalOpen] = useState(false);
  const [antennaParent, setAntennaParent] = useState<HardwareReaderRow | null>(null);
  const [antennaEditing, setAntennaEditing] = useState<HardwareAntennaRow | null>(null);

  const reload = async () => {
    await Promise.all([tree.mutate(), zones.mutate(), agents.mutate()]);
  };

  // ────────── delete handlers ──────────
  const removeZone = async (zoneId: string, name: string) => {
    if (!window.confirm(`Delete zone "${name}"? Any devices in it must be reassigned first.`)) return;
    await callDelete(`/api/zones/${zoneId}`, reload);
  };
  const removeAgent = async (agentId: string, name: string) => {
    if (!window.confirm(`Delete CDM agent "${name}"? Devices assigned to it will be unlinked.`)) return;
    await callDelete(`/api/cdm-agents/${agentId}`, reload);
  };
  const removeReader = async (id: string, name: string) => {
    if (!window.confirm(`Delete reader "${name}"? All antennas under it are deleted too.`)) return;
    await callDelete(`/api/hardware-config/readers/${id}`, reload);
  };
  const removeAntenna = async (id: string, name: string) => {
    if (!window.confirm(`Delete "${name}"?`)) return;
    await callDelete(`/api/hardware-config/antennas/${id}`, reload);
  };

  const rotateAgentToken = async (agentId: string, name: string) => {
    if (!window.confirm(`Rotate the API token for "${name}"? The current token will stop working immediately.`)) return;
    try {
      const res = await fetch(
        `/api/cdm-agents/${encodeURIComponent(agentId)}/regenerate-token`,
        { method: "POST" },
      );
      const j = (await res.json()) as { error?: string; token?: string };
      if (!res.ok || !j.token) throw new Error(j.error ?? "Rotation failed");
      setRevealToken({ name, token: j.token });
      await reload();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Rotation failed");
    }
  };

  if (tree.error || zones.error || agents.error) {
    const err = tree.error ?? zones.error ?? agents.error;
    return (
      <p className="font-mono text-xs text-red-400/90">
        {err instanceof Error ? err.message : "Failed to load hardware config"}
      </p>
    );
  }

  if (!tree.data && !zones.data && !agents.data) {
    return <p className="font-mono text-xs text-[var(--wms-muted)]">Loading...</p>;
  }

  return (
    <div className="space-y-8">
      <CdmAgentsSection
        agents={agents.data?.agents ?? []}
        onCreate={() => setAgentModalOpen(true)}
        onDelete={removeAgent}
        onRotateToken={rotateAgentToken}
      />

      <HardwareTreeSection
        tree={tree.data}
        onAddZone={(locationId) => {
          setZoneModalLocationId(locationId);
          setZoneModalOpen(true);
        }}
        onDeleteZone={removeZone}
        onAddReader={(zoneId) => {
          setReaderEditing(null);
          setReaderDefaultZoneId(zoneId);
          setReaderModalOpen(true);
        }}
        onEditReader={(reader) => {
          setReaderEditing(reader);
          setReaderDefaultZoneId(null);
          setReaderModalOpen(true);
        }}
        onDeleteReader={removeReader}
        onAddAntenna={(reader) => {
          setAntennaParent(reader);
          setAntennaEditing(null);
          setAntennaModalOpen(true);
        }}
        onEditAntenna={(reader, antenna) => {
          setAntennaParent(reader);
          setAntennaEditing(antenna);
          setAntennaModalOpen(true);
        }}
        onDeleteAntenna={removeAntenna}
      />

      <ZoneEditorModal
        open={zoneModalOpen}
        locationId={zoneModalLocationId}
        onClose={() => setZoneModalOpen(false)}
        onSaved={async () => {
          setZoneModalOpen(false);
          await reload();
        }}
      />

      <CdmAgentEditorModal
        open={agentModalOpen}
        onClose={() => setAgentModalOpen(false)}
        onCreated={async (token, name) => {
          setAgentModalOpen(false);
          setRevealToken({ name, token });
          await reload();
        }}
      />

      <TokenRevealModal
        open={!!revealToken}
        agentName={revealToken?.name ?? ""}
        token={revealToken?.token ?? ""}
        onClose={() => setRevealToken(null)}
      />

      <ReaderEditorModal
        open={readerModalOpen}
        editing={readerEditing}
        defaultZoneId={readerDefaultZoneId}
        onClose={() => setReaderModalOpen(false)}
        onSaved={async () => {
          setReaderModalOpen(false);
          await reload();
        }}
      />

      <AntennaEditorModal
        open={antennaModalOpen}
        parent={antennaParent}
        editing={antennaEditing}
        onClose={() => setAntennaModalOpen(false)}
        onSaved={async () => {
          setAntennaModalOpen(false);
          await reload();
        }}
      />
    </div>
  );
}

async function callDelete(url: string, onSuccess: () => Promise<void>) {
  try {
    const res = await fetch(url, { method: "DELETE" });
    const j = (await res.json()) as { error?: string };
    if (!res.ok) throw new Error(j.error ?? "Delete failed");
    await onSuccess();
  } catch (e) {
    window.alert(e instanceof Error ? e.message : "Delete failed");
  }
}

// ──────────────────────────────────────────────────────────────────────────
// CDM Agents section
// ──────────────────────────────────────────────────────────────────────────

function CdmAgentsSection({
  agents,
  onCreate,
  onDelete,
  onRotateToken,
}: {
  agents: CdmAgentRow[];
  onCreate: () => void;
  onDelete: (id: string, name: string) => void;
  onRotateToken: (id: string, name: string) => void;
}) {
  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-[var(--wms-muted)]">
          <Server className="h-3.5 w-3.5" /> Carbon CDM agents
        </h2>
        <button
          type="button"
          onClick={onCreate}
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--wms-accent)]/50 bg-[var(--wms-accent)] px-3 py-1.5 font-mono text-[0.65rem] font-semibold uppercase tracking-wide text-[var(--wms-accent-fg)] hover:opacity-90"
        >
          <Plus className="h-3 w-3" />
          Add agent
        </button>
      </div>

      {agents.length === 0 ? (
        <p className="rounded-md border border-dashed border-[var(--wms-border)] p-3 text-center font-mono text-xs text-[var(--wms-muted)]">
          No agents yet.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-[var(--wms-border)]">
          <table className="w-full min-w-[820px] border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] font-mono uppercase tracking-wide">
                <th className="px-3 py-2 text-[0.6rem]">Name</th>
                <th className="px-3 py-2 text-[0.6rem]">Location</th>
                <th className="px-3 py-2 text-[0.6rem]">Status</th>
                <th className="px-3 py-2 text-[0.6rem]">Version</th>
                <th className="px-3 py-2 text-[0.6rem]">Last heartbeat</th>
                <th className="px-3 py-2 text-[0.6rem]">Devices</th>
                <th className="px-3 py-2 text-right text-[0.6rem]">Actions</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr
                  key={a.id}
                  className="border-b border-[var(--wms-border)]/60 last:border-b-0"
                >
                  <td className="px-3 py-2 font-mono text-[var(--wms-fg)]">{a.name}</td>
                  <td className="px-3 py-2 text-[var(--wms-muted)]">
                    {a.location_code} - {a.location_name}
                  </td>
                  <td className="px-3 py-2">
                    <StatusPill status={a.status} />
                  </td>
                  <td className="px-3 py-2 font-mono text-[var(--wms-muted)]">
                    {a.agent_version ?? "-"}
                  </td>
                  <td className="px-3 py-2 font-mono text-[var(--wms-muted)]">
                    {a.last_heartbeat_at ? new Date(a.last_heartbeat_at).toLocaleString() : "never"}
                  </td>
                  <td className="px-3 py-2 font-mono text-[var(--wms-muted)]">
                    {a.device_count}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <RecoverReadersButton agentId={a.id} agentName={a.name} />
                    <button
                      type="button"
                      onClick={() => onRotateToken(a.id, a.name)}
                      title="Rotate API token"
                      className="mr-2 inline-flex items-center gap-1 rounded border border-[var(--wms-border)] px-2 py-1 font-mono text-[0.6rem] uppercase text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
                    >
                      <KeyRound className="h-3 w-3" /> Rotate
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(a.id, a.name)}
                      title="Delete agent"
                      className="inline-flex items-center gap-1 rounded border border-red-400/30 px-2 py-1 font-mono text-[0.6rem] uppercase text-red-400/80 hover:bg-red-400/10"
                    >
                      <Trash2 className="h-3 w-3" /> Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function StatusPill({ status }: { status: "online" | "offline" | "degraded" }) {
  const map: Record<typeof status, string> = {
    online: "bg-green-500/15 text-green-400 border-green-500/40",
    offline: "bg-zinc-500/15 text-zinc-400 border-zinc-500/40",
    degraded: "bg-yellow-500/15 text-yellow-400 border-yellow-500/40",
  };
  return (
    <span
      className={`inline-block rounded border px-1.5 py-0.5 font-mono text-[0.6rem] uppercase ${map[status]}`}
    >
      {status}
    </span>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Hardware tree section: Location → Zone → Reader → Antenna
// ──────────────────────────────────────────────────────────────────────────

type TreeProps = {
  tree: HardwareConfigTree | undefined;
  onAddZone: (locationId: string) => void;
  onDeleteZone: (id: string, name: string) => void;
  onAddReader: (zoneId: string) => void;
  onEditReader: (reader: HardwareReaderRow) => void;
  onDeleteReader: (id: string, name: string) => void;
  onAddAntenna: (reader: HardwareReaderRow) => void;
  onEditAntenna: (reader: HardwareReaderRow, antenna: HardwareAntennaRow) => void;
  onDeleteAntenna: (id: string, name: string) => void;
};

function HardwareTreeSection(props: TreeProps) {
  const { tree, onAddZone } = props;
  if (!tree || tree.locations.length === 0) {
    return (
      <section>
        <h2 className="mb-2 flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-[var(--wms-muted)]">
          <Cpu className="h-3.5 w-3.5" /> Hardware hierarchy
        </h2>
        <p className="rounded-md border border-dashed border-[var(--wms-border)] p-3 text-center font-mono text-xs text-[var(--wms-muted)]">
          No locations configured.
        </p>
      </section>
    );
  }

  return (
    <section>
      <h2 className="mb-2 flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-[var(--wms-muted)]">
        <Cpu className="h-3.5 w-3.5" /> Hardware hierarchy
      </h2>

      <div className="space-y-4">
        {tree.locations.map((loc) => (
          <div
            key={loc.id}
            className="rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/40 p-4"
          >
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="font-mono text-sm text-[var(--wms-fg)]">
                <span className="text-[var(--wms-muted)]">[{loc.code}]</span> {loc.name}
              </div>
              <button
                type="button"
                onClick={() => onAddZone(loc.id)}
                className="inline-flex items-center gap-1 rounded border border-[var(--wms-border)] px-2 py-1 font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
              >
                <Plus className="h-3 w-3" /> Add zone
              </button>
            </div>

            {loc.zones.length === 0 && loc.unzonedReaders.length === 0 ? (
              <p className="font-mono text-xs text-[var(--wms-muted)]">
                No zones yet. Add one to start placing readers.
              </p>
            ) : (
              <div className="space-y-3">
                {loc.zones.map((z) => (
                  <ZoneBlock key={z.id} zone={z} {...props} />
                ))}

                {loc.unzonedReaders.length > 0 ? (
                  <div className="rounded border border-yellow-500/30 bg-yellow-500/5 p-3">
                    <p className="mb-2 font-mono text-[0.65rem] uppercase tracking-wide text-yellow-400/80">
                      Unzoned readers (assign a zone)
                    </p>
                    <div className="ml-3 space-y-2">
                      {loc.unzonedReaders.map((r) => (
                        <ReaderCard key={r.id} reader={r} {...props} />
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function ZoneBlock({
  zone,
  onDeleteZone,
  onAddReader,
  ...rest
}: { zone: HardwareConfigTree["locations"][number]["zones"][number] } & TreeProps) {
  return (
    <div className="rounded border border-[var(--wms-border)]/60 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="font-mono text-sm font-semibold text-[var(--wms-fg)]">
            {zone.name}
          </span>
          {zone.description ? (
            <span className="ml-2 font-mono text-[0.65rem] text-[var(--wms-muted)]">
              ({zone.description})
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onAddReader(zone.id)}
            className="inline-flex items-center gap-1 rounded border border-[var(--wms-accent)]/50 bg-[var(--wms-accent)]/15 px-2 py-1 font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-accent)] hover:bg-[var(--wms-accent)]/25"
          >
            <Plus className="h-3 w-3" /> Reader
          </button>
          <button
            type="button"
            onClick={() => onDeleteZone(zone.id, zone.name)}
            className="inline-flex items-center gap-1 rounded border border-red-400/30 px-2 py-1 font-mono text-[0.6rem] uppercase text-red-400/80 hover:bg-red-400/10"
          >
            <Trash2 className="h-3 w-3" /> Zone
          </button>
        </div>
      </div>
      {zone.readers.length === 0 ? (
        <p className="ml-3 font-mono text-[0.7rem] text-[var(--wms-muted)]">
          No readers in this zone yet.
        </p>
      ) : (
        <div className="ml-3 space-y-2">
          {zone.readers.map((r) => (
            <ReaderCard key={r.id} reader={r} onDeleteZone={onDeleteZone} onAddReader={onAddReader} {...rest} />
          ))}
        </div>
      )}
    </div>
  );
}

function ReaderCard({
  reader,
  onEditReader,
  onDeleteReader,
  onAddAntenna,
  onEditAntenna,
  onDeleteAntenna,
}: {
  reader: HardwareReaderRow;
} & TreeProps) {
  return (
    <div className="rounded border border-[var(--wms-border)]/40 bg-[var(--wms-surface)]/30 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <Radio className="h-3.5 w-3.5 text-[var(--wms-accent)]" />
        <span className="font-mono text-xs text-[var(--wms-fg)]">{reader.name}</span>
        {reader.network_address ? (
          <span className="rounded bg-[var(--wms-surface-elevated)] px-1.5 py-0.5 font-mono text-[0.6rem] text-[var(--wms-muted)]">
            {reader.network_address}
          </span>
        ) : null}
        {reader.cdm_agent_name ? (
          <span className="font-mono text-[0.6rem] text-[var(--wms-muted)]">
            agent: {reader.cdm_agent_name}
          </span>
        ) : (
          <span className="font-mono text-[0.6rem] text-yellow-400/70">unmanaged</span>
        )}
        <StatusPill status={reader.status_online ? "online" : "offline"} />

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => onAddAntenna(reader)}
            title="Add antenna"
            className="inline-flex items-center gap-0.5 rounded border border-[var(--wms-accent)]/50 px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wide text-[var(--wms-accent)] hover:bg-[var(--wms-accent)]/15"
          >
            <Plus className="h-2.5 w-2.5" /> Ant
          </button>
          <button
            type="button"
            onClick={() => onEditReader(reader)}
            title="Edit reader"
            className="rounded border border-[var(--wms-border)] p-1 text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
          >
            <Pencil className="h-2.5 w-2.5" />
          </button>
          <button
            type="button"
            onClick={() => onDeleteReader(reader.id, reader.name)}
            title="Delete reader"
            className="rounded border border-red-400/30 p-1 text-red-400/80 hover:bg-red-400/10"
          >
            <Trash2 className="h-2.5 w-2.5" />
          </button>
        </div>
      </div>
      {reader.antennas.length > 0 ? (
        <div className="ml-5 mt-2 space-y-1">
          {reader.antennas.map((a) => (
            <AntennaLine
              key={a.id}
              reader={reader}
              antenna={a}
              onEditAntenna={onEditAntenna}
              onDeleteAntenna={onDeleteAntenna}
            />
          ))}
        </div>
      ) : (
        <p className="ml-5 mt-1 font-mono text-[0.6rem] text-[var(--wms-muted)]">
          No antennas
        </p>
      )}
    </div>
  );
}

function AntennaLine({
  reader,
  antenna,
  onEditAntenna,
  onDeleteAntenna,
}: {
  reader: HardwareReaderRow;
  antenna: HardwareAntennaRow;
  onEditAntenna: (reader: HardwareReaderRow, antenna: HardwareAntennaRow) => void;
  onDeleteAntenna: (id: string, name: string) => void;
}) {
  const cfg = antenna.config as {
    antenna_number?: number;
    transmit_power_dbm?: number;
    enabled?: boolean;
  };
  const num = cfg.antenna_number ?? "?";
  const power = cfg.transmit_power_dbm ?? null;
  const isOff = cfg.enabled === false;
  return (
    <div className="flex flex-wrap items-center gap-2 text-[0.65rem]">
      <AntennaIcon className="h-3 w-3 text-[var(--wms-muted)]" />
      <span className="font-mono text-[var(--wms-fg)]">
        #{num} {antenna.name}
      </span>
      {power !== null ? (
        <span className="rounded bg-[var(--wms-surface-elevated)] px-1.5 py-0.5 font-mono text-[var(--wms-muted)]">
          {power} dBm
        </span>
      ) : null}
      {isOff ? (
        <span className="rounded border border-zinc-500/40 bg-zinc-500/15 px-1.5 py-0.5 font-mono text-[0.55rem] uppercase text-zinc-400">
          disabled
        </span>
      ) : null}
      <StatusPill status={antenna.status_online ? "online" : "offline"} />
      <AntennaTestButton antennaId={antenna.id} antennaName={antenna.name} />
      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          onClick={() => onEditAntenna(reader, antenna)}
          title="Edit antenna (incl. power)"
          className="rounded border border-[var(--wms-border)] p-1 text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
        >
          <Pencil className="h-2.5 w-2.5" />
        </button>
        <button
          type="button"
          onClick={() => onDeleteAntenna(antenna.id, antenna.name)}
          title="Delete antenna"
          className="rounded border border-red-400/30 p-1 text-red-400/80 hover:bg-red-400/10"
        >
          <Trash2 className="h-2.5 w-2.5" />
        </button>
      </div>
    </div>
  );
}

/**
 * One-shot connection test for an antenna. Click → POSTs to the WMS to
 * queue a test → shows "Testing…" with a spinner for up to ~90 s while
 * the agent picks up the flag and runs a 30-sec listen window. Triggers
 * a tree mutate when the test completes so the new status pill renders.
 *
 * Caveat: the agent listens to the parent reader's WHOLE binary stream;
 * it can't currently distinguish per-antenna in the protocol. So if the
 * reader has 2 antennas wired and only one is plugged in, both will pass
 * the test. Tooltip notes this.
 */
function AntennaTestButton({
  antennaId,
  antennaName,
}: {
  antennaId: string;
  antennaName: string;
}) {
  const [busy, setBusy] = useState(false);
  const click = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/hardware-config/antennas/${antennaId}/test`, {
        method: "POST",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        alert(`Test queue failed: ${data.error ?? res.statusText}`);
        setBusy(false);
        return;
      }
      // Hold the spinner for up to 90 s while the agent runs the test.
      // The status pill will be re-rendered by SWR's auto-refetch on focus
      // / interval. We just keep the button locked so the operator doesn't
      // double-trigger. After the window we release regardless.
      await new Promise((r) => setTimeout(r, 90_000));
    } catch (e) {
      alert(`Test failed: ${e instanceof Error ? e.message : "unknown"}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={() => void click()}
      disabled={busy}
      title={`Run a 30 s connection test for ${antennaName}. Listens for ANY tag on the parent reader.`}
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wider ${
        busy
          ? "cursor-not-allowed border-amber-400/40 bg-amber-400/10 text-amber-300"
          : "border-red-400/40 bg-red-400/10 text-red-300 hover:bg-red-400/20"
      }`}
    >
      <Zap className="h-2.5 w-2.5" />
      {busy ? "Testing…" : "Test"}
    </button>
  );
}
