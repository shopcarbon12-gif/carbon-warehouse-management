"use client";

import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import {
  Antenna as AntennaIcon,
  Clock,
  Cpu,
  KeyRound,
  Pencil,
  Play,
  Square,
  Plus,
  Radio,
  RefreshCw,
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
import { WiznetDiscoveriesPanel } from "./wiznet-discoveries-panel";
import {
  ReaderScheduleModal,
  type ReaderScheduleType,
} from "./reader-schedule-modal";
import { ReaderEditorModal } from "./reader-editor-modal";
import { AntennaEditorModal } from "./antenna-editor-modal";
import { LiveScanWidget } from "./live-scan-widget";

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
  const [scheduleModalReader, setScheduleModalReader] = useState<HardwareReaderRow | null>(null);

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

  const pauseReader = async (id: string) => {
    try {
      const res = await fetch(
        `/api/hardware-config/readers/${encodeURIComponent(id)}/pause`,
        { method: "POST" },
      );
      const j = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? "Stop failed");
      await reload();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Stop failed");
    }
  };
  const resumeReader = async (id: string) => {
    try {
      const res = await fetch(
        `/api/hardware-config/readers/${encodeURIComponent(id)}/resume`,
        { method: "POST" },
      );
      const j = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? "Start failed");
      await reload();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Start failed");
    }
  };
  const hardResetReader = async (id: string, name: string) => {
    if (
      !window.confirm(
        `Hard Reset "${name}"?\n\n` +
          "The agent will tear down this reader's process and respawn it with " +
          "a fresh state (port rotation reset, sweep budget reset, fresh local " +
          "stream port). Any in-flight scan-session on this reader will end.\n\n" +
          "NOTE: this is the strongest SOFT reset. If the WIZnet bridge inside " +
          "the reader is firmware-wedged, only a physical power-cycle (or PoE " +
          "port reset on the switch) will recover it.",
      )
    )
      return;
    try {
      const res = await fetch(
        `/api/hardware-config/readers/${encodeURIComponent(id)}/hard-reset`,
        { method: "POST" },
      );
      const j = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? "Hard reset failed");
      await reload();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Hard reset failed");
    }
  };
  const pauseAllReaders = async () => {
    if (
      !window.confirm(
        "Stop every reader at this tenant?\n\n" +
          "The agent will SIGTERM each reader's binary, give it 10 s to issue " +
          "RFID_RadioAbortOperation to the chip, then run a belt-and-braces " +
          "abort cycle to GUARANTEE the radio is off — not just disconnected. " +
          "Use this when readers feel hot or when you actually need them off.",
      )
    )
      return;
    try {
      const res = await fetch(`/api/hardware-config/readers/pause-all`, { method: "POST" });
      const j = (await res.json()) as { error?: string; paused?: number };
      if (!res.ok) throw new Error(j.error ?? "Stop all failed");
      await reload();
      window.alert(`Stopped ${j.paused ?? 0} reader(s).`);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Stop all failed");
    }
  };
  const resumeAllReaders = async () => {
    try {
      const res = await fetch(`/api/hardware-config/readers/resume-all`, { method: "POST" });
      const j = (await res.json()) as { error?: string; resumed?: number };
      if (!res.ok) throw new Error(j.error ?? "Start all failed");
      await reload();
      window.alert(`Started ${j.resumed ?? 0} reader(s).`);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Start all failed");
    }
  };
  const hardResetAll = async () => {
    if (
      !window.confirm(
        "Hard reset every agent + reader at this tenant?\n\n" +
          "This signals every CDM agent to exit cleanly (systemd respawns within ~5 s), " +
          "kills every reader child, wipes supervisor slot state, and ends the live-scan " +
          "session so the counter resets to 0.\n\n" +
          "Use this when readers feel slow or stuck and a clean restart would clear it.",
      )
    )
      return;
    try {
      const res = await fetch(`/api/hardware-config/hard-reset`, { method: "POST" });
      const j = (await res.json()) as { error?: string; agents_signaled?: number };
      if (!res.ok) throw new Error(j.error ?? "Hard reset failed");
      await reload();
      window.alert(
        `Hard reset signaled to ${j.agents_signaled ?? 0} agent(s). ` +
          "They'll respawn within ~30 s. Click Live Scan to start a fresh session.",
      );
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Hard reset failed");
    }
  };
  const setMonsoonDriver = async (id: string, driver: "stream" | "console") => {
    try {
      const res = await fetch(
        `/api/hardware-config/readers/${encodeURIComponent(id)}/monsoon-driver`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ driver }),
        },
      );
      const j = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? "Driver flip failed");
      await reload();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Driver flip failed");
    }
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
      <LiveScanWidget />

      <CdmAgentsSection
        agents={agents.data?.agents ?? []}
        onCreate={() => setAgentModalOpen(true)}
        onDelete={removeAgent}
        onRotateToken={rotateAgentToken}
      />

      <WiznetDiscoveriesPanel />

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
        onPauseReader={pauseReader}
        onResumeReader={resumeReader}
        onHardResetReader={hardResetReader}
        onSetMonsoonDriver={setMonsoonDriver}
        onPauseAllReaders={pauseAllReaders}
        onResumeAllReaders={resumeAllReaders}
        onHardResetAll={hardResetAll}
        onOpenSchedule={(reader) => setScheduleModalReader(reader)}
      />

      {scheduleModalReader ? (
        <ReaderScheduleModal
          open
          readerId={scheduleModalReader.id}
          readerName={scheduleModalReader.name}
          initialSchedule={scheduleModalReader.scan_schedule as ReaderScheduleType | null}
          onClose={() => setScheduleModalReader(null)}
          onSaved={() => void reload()}
        />
      ) : null}

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

function StatusPill({
  status,
}: {
  status: "online" | "offline" | "degraded" | "reachable";
}) {
  // "reachable" = reader's WIZnet bridge was seen on the LAN within the
  // freshness window, but the chip isn't producing valid tag-read bytes.
  // Renders amber so operators can distinguish chassis-firmware faults
  // (yellow) from cable/network/bridge faults (gray "offline").
  const map: Record<typeof status, string> = {
    online: "bg-green-500/15 text-green-400 border-green-500/40",
    offline: "bg-zinc-500/15 text-zinc-400 border-zinc-500/40",
    degraded: "bg-yellow-500/15 text-yellow-400 border-yellow-500/40",
    reachable: "bg-amber-500/15 text-amber-400 border-amber-500/40",
  };
  // Tooltip on the amber state; aimed squarely at the operator who'll see
  // ".82 reachable" and want to know what to check.
  const title =
    status === "reachable"
      ? "Bridge on the LAN, but the chip is not producing valid tag reads. Check chassis power and firmware."
      : undefined;
  return (
    <span
      title={title}
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
  onPauseReader: (id: string) => void;
  onResumeReader: (id: string) => void;
  onHardResetReader: (id: string, name: string) => void;
  onSetMonsoonDriver: (id: string, driver: "stream" | "console") => void;
  onPauseAllReaders: () => void;
  onResumeAllReaders: () => void;
  onHardResetAll: () => void;
  onOpenSchedule: (reader: HardwareReaderRow) => void;
};

function HardwareTreeSection(props: TreeProps) {
  const { tree, onAddZone, onPauseAllReaders, onResumeAllReaders, onHardResetAll } = props;
  const heading = (
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <h2 className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-[var(--wms-muted)]">
        <Cpu className="h-3.5 w-3.5" /> Hardware hierarchy
      </h2>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onPauseAllReaders}
          title="Stop every reader at this tenant — radios go cold, not just agent-disconnected"
          className="inline-flex items-center gap-0.5 rounded border border-amber-400/50 px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wide text-amber-300 hover:bg-amber-400/15"
        >
          <Square className="h-2.5 w-2.5" /> Stop all
        </button>
        <button
          type="button"
          onClick={onResumeAllReaders}
          title="Start every stopped reader at this tenant"
          className="inline-flex items-center gap-0.5 rounded border border-emerald-400/50 px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wide text-emerald-300 hover:bg-emerald-400/15"
        >
          <Play className="h-2.5 w-2.5" /> Start all
        </button>
        <button
          type="button"
          onClick={onHardResetAll}
          title="Stop everything, restart all agents + readers, reset live-scan counter"
          className="inline-flex items-center gap-0.5 rounded border border-red-400/50 bg-red-500/5 px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wide text-red-300 hover:bg-red-400/20"
        >
          <RefreshCw className="h-2.5 w-2.5" /> Hard reset
        </button>
      </div>
    </div>
  );
  if (!tree || tree.locations.length === 0) {
    return (
      <section>
        {heading}
        <p className="rounded-md border border-dashed border-[var(--wms-border)] p-3 text-center font-mono text-xs text-[var(--wms-muted)]">
          No locations configured.
        </p>
      </section>
    );
  }

  return (
    <section>
      {heading}

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

function ReaderHealthBadge({ health }: { health: HardwareReaderRow["health"] }) {
  if (health.status === "ok") return null;
  const cfg =
    health.status === "needs_service"
      ? {
          cls: "border-fuchsia-400/60 bg-fuchsia-500/20 text-fuchsia-200",
          label: "needs service",
          tip:
            `Supervisor exhausted every software recovery (6+ failed cycles in ` +
            `10 min) — the chassis radio is wedged below software reach. The ` +
            `supervisor has stopped retrying on this reader to save CPU; it will ` +
            `auto-clear once the chip starts reading again. Physical action: ` +
            `swap the antenna cable, or PoE-cycle the chassis.`,
        }
      : health.status === "stuck"
      ? {
          cls: "border-red-400/50 bg-red-500/15 text-red-300",
          label: "stuck",
          tip:
            `Reader is on the network but producing zero reads — chassis ` +
            `firmware likely wedged. Try Hard Reset; if no recovery, physically ` +
            `power-cycle the reader.`,
        }
      : health.status === "slow"
        ? {
            cls: "border-amber-400/50 bg-amber-500/15 text-amber-300",
            label: "slow",
            tip:
              `Reading at ${health.reads_5m} reads in last 5 min vs location ` +
              `median ${health.peers_median_5m}. Check antenna orientation, ` +
              `cable, or swap the antenna with a known-good sibling reader.`,
          }
        : {
            cls: "border-zinc-400/40 bg-zinc-500/15 text-zinc-300",
            label: "offline",
            tip:
              `Reader's WIZnet bridge has been off the LAN for >3 min. Check ` +
              `network cable / PoE switch port.`,
          };
  return (
    <span
      title={cfg.tip}
      className={`rounded border px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wide ${cfg.cls}`}
    >
      {cfg.label}
    </span>
  );
}

function ReaderCard({
  reader,
  onEditReader,
  onDeleteReader,
  onAddAntenna,
  onEditAntenna,
  onDeleteAntenna,
  onPauseReader,
  onResumeReader,
  onHardResetReader,
  onSetMonsoonDriver,
  onOpenSchedule,
}: {
  reader: HardwareReaderRow;
  onPauseReader: (id: string) => void;
  onResumeReader: (id: string) => void;
  onHardResetReader: (id: string, name: string) => void;
  onSetMonsoonDriver: (id: string, driver: "stream" | "console") => void;
  onOpenSchedule: (reader: HardwareReaderRow) => void;
} & TreeProps) {
  const isManualPaused = !!reader.scan_paused_at;
  const hasSchedule = !!reader.scan_schedule;
  const driver: "stream" | "console" =
    (reader.config as { monsoon_driver?: string }).monsoon_driver === "stream"
      ? "stream"
      : "console";
  return (
    <div className="rounded border border-[var(--wms-border)]/40 bg-[var(--wms-surface)]/30 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <Radio className="h-3.5 w-3.5 text-[var(--wms-accent)]" />
        <span className="font-mono text-xs text-[var(--wms-fg)]">{reader.name}</span>
        <ReaderHealthBadge health={reader.health} />
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
        <StatusPill status={reader.bridge_state} />
        {isManualPaused ? (
          <span className="rounded border border-amber-400/40 bg-amber-500/15 px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wide text-amber-300">
            stopped
          </span>
        ) : null}
        {hasSchedule ? (
          <span
            title="Schedule configured"
            className="rounded border border-blue-400/40 bg-blue-500/10 px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wide text-blue-300"
          >
            sched
          </span>
        ) : null}

        <div className="ml-auto flex items-center gap-1">
          {isManualPaused ? (
            <button
              type="button"
              onClick={() => onResumeReader(reader.id)}
              title="Start scanning"
              className="inline-flex items-center gap-0.5 rounded border border-emerald-400/50 px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wide text-emerald-300 hover:bg-emerald-400/15"
            >
              <Play className="h-2.5 w-2.5" /> Start
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onPauseReader(reader.id)}
              title="Stop this reader — radio goes cold, agent issues forced abort"
              className="inline-flex items-center gap-0.5 rounded border border-amber-400/50 px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wide text-amber-300 hover:bg-amber-400/15"
            >
              <Square className="h-2.5 w-2.5" /> Stop
            </button>
          )}
          <button
            type="button"
            onClick={() =>
              onSetMonsoonDriver(reader.id, driver === "console" ? "stream" : "console")
            }
            title={`Driver: ${driver}. Click to switch to ${driver === "console" ? "stream" : "console"}.`}
            className={`inline-flex items-center gap-0.5 rounded border px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wide ${
              driver === "console"
                ? "border-emerald-400/50 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-400/20"
                : "border-zinc-400/50 bg-zinc-500/10 text-zinc-300 hover:bg-zinc-400/20"
            }`}
          >
            {driver}
          </button>
          <button
            type="button"
            onClick={() => onHardResetReader(reader.id, reader.name)}
            title={
              "Hard Reset this reader — agent tears down and respawns the " +
              "process with fresh state. Use when the reader is stuck or has " +
              "drifted slow. Any in-flight scan-session on this reader will end."
            }
            className="inline-flex items-center gap-0.5 rounded border border-red-400/40 bg-red-500/10 px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wide text-red-300 hover:bg-red-400/20"
          >
            <RefreshCw className="h-2.5 w-2.5" /> Reset
          </button>
          <button
            type="button"
            onClick={() => onOpenSchedule(reader)}
            title="Schedule auto-pause windows"
            className="inline-flex items-center gap-0.5 rounded border border-[var(--wms-border)] px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wide text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
          >
            <Clock className="h-2.5 w-2.5" /> Sched
          </button>
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
      {antenna.suggested_power_dbm !== null && antenna.suggested_power_dbm !== power ? (
        <button
          type="button"
          onClick={() => onEditAntenna(reader, antenna)}
          title={
            `Supervisor auto-sweep found this antenna reads at ${antenna.suggested_power_dbm} dBm ` +
            `but configured ${power ?? "?"} dBm produces no reads. Click to open the editor ` +
            `and apply the suggested power. Banner disappears once the antenna self-heals at ` +
            `configured.`
          }
          className="rounded border border-amber-400/60 bg-amber-500/15 px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wide text-amber-300 hover:bg-amber-500/25"
        >
          try {antenna.suggested_power_dbm} dBm
        </button>
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
 * Navigates to the dedicated /antenna_test page with this antenna pre-
 * selected as the default. The page's antenna picker stays unlocked so the
 * operator can still pick a different antenna once they're there. Replaces
 * the earlier inline "queue a 30s connection test" flow — the dedicated
 * page exposes the full operator-tunable test UI (power slider, sweep,
 * reference EPCs, calibration, etc.) which the inline button could not.
 */
function AntennaTestButton({
  antennaId,
  antennaName,
}: {
  antennaId: string;
  antennaName: string;
}) {
  return (
    <Link
      href={`/antenna_test?antennaId=${encodeURIComponent(antennaId)}`}
      title={`Open the Antenna Test page with ${antennaName} pre-selected.`}
      className="inline-flex items-center gap-1 rounded border border-red-400/40 bg-red-400/10 px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wider text-red-300 hover:bg-red-400/20"
    >
      <Zap className="h-2.5 w-2.5" />
      Test
    </Link>
  );
}
