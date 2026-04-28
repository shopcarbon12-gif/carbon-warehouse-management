"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import type { CdmAgentRow } from "@/lib/server/cdm-agents";
import type { ZoneRow } from "@/lib/server/zones";
import type { HardwareReaderRow } from "@/lib/server/hardware-config";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? res.statusText);
  }
  return res.json();
};

type Props = {
  open: boolean;
  /** When set, the form is in EDIT mode. Otherwise CREATE mode. */
  editing: HardwareReaderRow | null;
  /** Pre-select this zone when opening the form (CREATE mode). */
  defaultZoneId: string | null;
  onClose: () => void;
  onSaved: () => void;
};

export function ReaderEditorModal({
  open,
  editing,
  defaultZoneId,
  onClose,
  onSaved,
}: Props) {
  const zonesSwr = useSWR<{ zones: ZoneRow[] }>("/api/zones", fetcher, {
    revalidateOnFocus: false,
  });
  const agentsSwr = useSWR<{ agents: CdmAgentRow[] }>("/api/cdm-agents", fetcher, {
    revalidateOnFocus: false,
  });
  const allZones = zonesSwr.data?.zones ?? [];
  const allAgents = agentsSwr.data?.agents ?? [];

  const [zoneId, setZoneId] = useState("");
  const [cdmAgentId, setCdmAgentId] = useState("");
  const [name, setName] = useState("");
  const [networkAddress, setNetworkAddress] = useState("");
  const [antennaCount, setAntennaCount] = useState("2");
  const [model, setModel] = useState("SA-2000");
  const [serialPort, setSerialPort] = useState("10002");
  const [streamPort, setStreamPort] = useState("");
  const [controlPort, setControlPort] = useState("");
  const [epcPrefix, setEpcPrefix] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const selectedZone = useMemo(
    () => allZones.find((z) => z.id === zoneId) ?? null,
    [allZones, zoneId],
  );
  const eligibleAgents = useMemo(
    () => allAgents.filter((a) => !selectedZone || a.location_id === selectedZone.location_id),
    [allAgents, selectedZone],
  );

  useEffect(() => {
    if (!open) return;
    if (editing) {
      const cfg = editing.config as {
        model?: string;
        monsoon_serial_port?: number;
        stream_port?: number;
        control_port?: number;
        antenna_count?: number;
        epc_prefix?: string;
      };
      setName(editing.name);
      setNetworkAddress(editing.network_address ?? "");
      setCdmAgentId(editing.cdm_agent_id ?? "");
      setAntennaCount(String(cfg.antenna_count ?? 2));
      setModel(cfg.model ?? "SA-2000");
      setSerialPort(String(cfg.monsoon_serial_port ?? 10002));
      setStreamPort(cfg.stream_port ? String(cfg.stream_port) : "");
      setControlPort(cfg.control_port ? String(cfg.control_port) : "");
      setEpcPrefix(cfg.epc_prefix ?? "");
      // zone_id isn't on HardwareReaderRow — leave to user to confirm
      setZoneId("");
    } else {
      setZoneId(defaultZoneId ?? "");
      setCdmAgentId("");
      setName("");
      setNetworkAddress("");
      setAntennaCount("2");
      setModel("SA-2000");
      setSerialPort("10002");
      setStreamPort("");
      setControlPort("");
      setEpcPrefix("");
    }
    setAdvanced(false);
    setErr(null);
  }, [open, editing, defaultZoneId]);

  // Default agent to first eligible when location changes
  useEffect(() => {
    if (!open || editing) return;
    if (!cdmAgentId && eligibleAgents.length === 1) {
      setCdmAgentId(eligibleAgents[0].id);
    }
  }, [open, editing, cdmAgentId, eligibleAgents]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  const save = async () => {
    if (!editing && !zoneId) {
      setErr("Zone is required");
      return;
    }
    if (!name.trim()) {
      setErr("Reader name is required");
      return;
    }
    if (!networkAddress.trim()) {
      setErr("Network address (IP) is required");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        networkAddress: networkAddress.trim(),
        antennaCount: Number(antennaCount),
        model: model.trim(),
        monsoonSerialPort: Number(serialPort),
        epcPrefix: epcPrefix.trim(),
      };
      if (zoneId) body.zoneId = zoneId;
      if (cdmAgentId) body.cdmAgentId = cdmAgentId;
      if (streamPort) body.streamPort = Number(streamPort);
      if (controlPort) body.controlPort = Number(controlPort);

      const url = editing
        ? `/api/hardware-config/readers/${encodeURIComponent(editing.id)}`
        : "/api/hardware-config/readers";
      const method = editing ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? "Save failed");
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)] p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-mono text-sm font-semibold text-[var(--wms-fg)]">
            {editing ? "Edit reader" : "Add reader"}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3">
          {!editing ? (
            <Field label="Zone">
              <select
                value={zoneId}
                onChange={(e) => setZoneId(e.target.value)}
                className={inputCls}
              >
                <option value="">-- select --</option>
                {allZones.map((z) => (
                  <option key={z.id} value={z.id}>
                    [{z.location_code}] {z.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}

          <Field label="Reader name">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Transfer Bin"
              maxLength={256}
              className={inputCls}
            />
          </Field>

          <Field label="Network address (IP or hostname)">
            <input
              type="text"
              value={networkAddress}
              onChange={(e) => setNetworkAddress(e.target.value)}
              placeholder="192.168.1.16"
              maxLength={256}
              className={inputCls}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Antenna count">
              <input
                type="number"
                min={1}
                max={32}
                value={antennaCount}
                onChange={(e) => setAntennaCount(e.target.value)}
                className={inputCls}
              />
            </Field>
            <Field label="Model">
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                maxLength={64}
                className={inputCls}
              />
            </Field>
          </div>

          <Field label="Carbon CDM agent">
            <select
              value={cdmAgentId}
              onChange={(e) => setCdmAgentId(e.target.value)}
              className={inputCls}
            >
              <option value="">-- unassigned --</option>
              {eligibleAgents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} (location {a.location_code})
                </option>
              ))}
            </select>
          </Field>

          <button
            type="button"
            onClick={() => setAdvanced((v) => !v)}
            className="inline-flex items-center gap-1 font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
          >
            {advanced ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            Advanced ports / EPC prefix
          </button>
          {advanced ? (
            <div className="grid grid-cols-2 gap-3 rounded border border-[var(--wms-border)]/60 p-3">
              <Field label="Reader TCP port">
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={serialPort}
                  onChange={(e) => setSerialPort(e.target.value)}
                  className={inputCls}
                />
              </Field>
              <Field label="EPC prefix">
                <input
                  type="text"
                  value={epcPrefix}
                  onChange={(e) => setEpcPrefix(e.target.value)}
                  placeholder="F0A0B"
                  maxLength={32}
                  className={inputCls}
                />
              </Field>
              <Field label="Stream port (auto if blank)">
                <input
                  type="number"
                  min={1024}
                  max={65535}
                  value={streamPort}
                  onChange={(e) => setStreamPort(e.target.value)}
                  placeholder="auto"
                  className={inputCls}
                />
              </Field>
              <Field label="Control port (auto if blank)">
                <input
                  type="number"
                  min={1024}
                  max={65535}
                  value={controlPort}
                  onChange={(e) => setControlPort(e.target.value)}
                  placeholder="auto"
                  className={inputCls}
                />
              </Field>
            </div>
          ) : null}

          {err ? (
            <p className="font-mono text-[0.7rem] text-red-400/90">{err}</p>
          ) : null}
        </div>

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded border border-[var(--wms-border)] px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-wide text-[var(--wms-muted)] hover:text-[var(--wms-fg)] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded border border-[var(--wms-accent)]/50 bg-[var(--wms-accent)] px-3 py-1.5 font-mono text-[0.65rem] font-semibold uppercase tracking-wide text-[var(--wms-accent-fg)] hover:opacity-90 disabled:opacity-60"
          >
            {busy ? "Saving..." : editing ? "Save changes" : "Add reader"}
          </button>
        </div>
      </div>
    </div>
  );
}

const inputCls =
  "w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1.5 font-mono text-xs text-[var(--wms-fg)] focus:border-[var(--wms-accent)] focus:outline-none";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block font-mono text-[0.65rem] uppercase tracking-wider text-[var(--wms-muted)]">
        {label}
      </label>
      {children}
    </div>
  );
}
