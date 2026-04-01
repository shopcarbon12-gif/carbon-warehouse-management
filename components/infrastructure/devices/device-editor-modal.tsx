"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { X } from "lucide-react";
import type { DeviceGridRow } from "@/lib/server/infrastructure-devices";
import { DEVICE_TYPES, type DeviceType } from "@/lib/constants/device-registry";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? res.statusText);
  }
  return res.json();
};

type LocOpt = { id: string; code: string; name: string };
type BinOpt = { id: string; code: string };

type Props = {
  open: boolean;
  editing: DeviceGridRow | null;
  onClose: () => void;
  onSaved: () => void;
};

function isPrinter(t: DeviceType): boolean {
  return t === "printer";
}

function needsBinBinding(t: DeviceType): boolean {
  return t !== "printer";
}

export function DeviceEditorModal({ open, editing, onClose, onSaved }: Props) {
  const { data: locData } = useSWR<LocOpt[]>("/api/locations", fetcher, {
    revalidateOnFocus: false,
  });
  const locations = locData ?? [];

  const [deviceType, setDeviceType] = useState<DeviceType>("printer");
  const [name, setName] = useState("");
  const [locationId, setLocationId] = useState("");
  const [binId, setBinId] = useState("");
  const [networkAddress, setNetworkAddress] = useState("");
  const [printerPort, setPrinterPort] = useState("80");
  const [printerUri, setPrinterUri] = useState("PSTPRNT");
  const [statusOnline, setStatusOnline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const binsUrl =
    locationId && /^[0-9a-f-]{36}$/i.test(locationId)
      ? `/api/locations/bins?locationId=${encodeURIComponent(locationId)}`
      : null;
  const { data: binRows } = useSWR<BinOpt[]>(binsUrl, fetcher, { revalidateOnFocus: false });
  const bins = useMemo(() => binRows ?? [], [binRows]);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setDeviceType(editing.device_type);
      setName(editing.name);
      setLocationId(editing.location_id);
      setBinId(editing.bin_id ?? "");
      setNetworkAddress(editing.network_address ?? "");
      const c = editing.config;
      setPrinterPort(String(typeof c.port === "number" ? c.port : 80));
      setPrinterUri(typeof c.uri === "string" ? c.uri : "PSTPRNT");
      setStatusOnline(editing.status_online);
    } else {
      setDeviceType("printer");
      setName("");
      setLocationId(locations[0]?.id ?? "");
      setBinId("");
      setNetworkAddress("");
      setPrinterPort("80");
      setPrinterUri("PSTPRNT");
      setStatusOnline(false);
    }
    setErr(null);
  }, [open, editing, locations]);

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

  const save = async () => {
    const nm = name.trim();
    if (!nm) {
      setErr("Device name is required");
      return;
    }
    if (!locationId) {
      setErr("Assigned location is required");
      return;
    }
    const net = networkAddress.trim();
    if (!net) {
      setErr(isPrinter(deviceType) ? "IP address / host is required" : "MAC or reader ID is required");
      return;
    }

    setBusy(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = {
        locationId,
        deviceType,
        name: nm,
        networkAddress: net,
        statusOnline,
      };
      if (editing) body.id = editing.id;
      if (needsBinBinding(deviceType)) {
        body.binId = binId.trim() ? binId.trim() : null;
      } else {
        body.binId = null;
      }
      if (isPrinter(deviceType)) {
        const p = Number.parseInt(printerPort, 10);
        body.printerPort = Number.isFinite(p) ? p : 80;
        body.printerUri = printerUri.trim() || "PSTPRNT";
      }

      const res = await fetch("/api/infrastructure/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? "Save failed");
      onSaved();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <>
      <button
        type="button"
        aria-label="Close"
        className="fixed inset-0 z-[85] bg-black/70"
        onClick={() => !busy && onClose()}
      />
      <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
        <div className="max-h-[min(92vh,640px)] w-full max-w-lg overflow-y-auto rounded-xl border border-[var(--wms-border)] bg-[var(--wms-surface)] shadow-2xl">
          <div className="flex items-center justify-between border-b border-[var(--wms-border)] px-4 py-3">
            <h2 className="text-sm font-semibold text-[var(--wms-fg)]">
              {editing ? "Edit device" : "Register device"}
            </h2>
            <button
              type="button"
              onClick={() => !busy && onClose()}
              className="rounded p-2 text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="space-y-3 p-4">
            <label className="block font-mono text-[0.65rem] uppercase text-[var(--wms-muted)]">
              Device type
              <select
                value={deviceType}
                disabled={Boolean(editing)}
                onChange={(e) => setDeviceType(e.target.value as DeviceType)}
                className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 font-mono text-sm text-[var(--wms-fg)] disabled:opacity-60"
              >
                {DEVICE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </label>

            <label className="block font-mono text-[0.65rem] uppercase text-[var(--wms-muted)]">
              Device name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 font-mono text-sm text-[var(--wms-fg)]"
              />
            </label>

            <label className="block font-mono text-[0.65rem] uppercase text-[var(--wms-muted)]">
              Assigned location
              <select
                value={locationId}
                onChange={(e) => {
                  setLocationId(e.target.value);
                  setBinId("");
                }}
                className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 font-mono text-sm text-[var(--wms-fg)]"
              >
                <option value="">Select location…</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.code} — {l.name}
                  </option>
                ))}
              </select>
            </label>

            {isPrinter(deviceType) ? (
              <>
                <label className="block font-mono text-[0.65rem] uppercase text-[var(--wms-muted)]">
                  IP address / host
                  <input
                    value={networkAddress}
                    onChange={(e) => setNetworkAddress(e.target.value)}
                    placeholder="192.168.1.3"
                    className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 font-mono text-sm text-[var(--wms-fg)]"
                  />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block font-mono text-[0.65rem] uppercase text-[var(--wms-muted)]">
                    Port
                    <input
                      type="number"
                      min={1}
                      max={65535}
                      value={printerPort}
                      onChange={(e) => setPrinterPort(e.target.value)}
                      className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 font-mono text-sm text-[var(--wms-fg)]"
                    />
                  </label>
                  <label className="block font-mono text-[0.65rem] uppercase text-[var(--wms-muted)]">
                    URI
                    <input
                      value={printerUri}
                      onChange={(e) => setPrinterUri(e.target.value)}
                      placeholder="PSTPRNT"
                      className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 font-mono text-sm text-[var(--wms-fg)]"
                    />
                  </label>
                </div>
              </>
            ) : (
              <>
                <label className="block font-mono text-[0.65rem] uppercase text-[var(--wms-muted)]">
                  MAC / reader ID
                  <input
                    value={networkAddress}
                    onChange={(e) => setNetworkAddress(e.target.value)}
                    placeholder="00:1A:2B:3C:4D:5E"
                    className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 font-mono text-sm text-[var(--wms-fg)]"
                  />
                </label>
                <label className="block font-mono text-[0.65rem] uppercase text-[var(--wms-muted)]">
                  Bin (optional — pin scans to a bin)
                  <select
                    value={binId}
                    onChange={(e) => setBinId(e.target.value)}
                    disabled={!locationId}
                    className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 font-mono text-sm text-[var(--wms-fg)] disabled:opacity-50"
                  >
                    <option value="">Entire location (no bin)</option>
                    {bins.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.code}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}

            <label className="block font-mono text-[0.65rem] uppercase text-[var(--wms-muted)]">
              Status (mock)
              <select
                value={statusOnline ? "online" : "offline"}
                onChange={(e) => setStatusOnline(e.target.value === "online")}
                className="mt-1 w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-2 font-mono text-sm text-[var(--wms-fg)]"
              >
                <option value="online">Online</option>
                <option value="offline">Offline</option>
              </select>
            </label>

            {err ? <p className="font-mono text-xs text-red-400/90">{err}</p> : null}

            <button
              type="button"
              disabled={busy}
              onClick={() => void save()}
              className="w-full rounded-lg border border-[var(--wms-accent)]/50 bg-[var(--wms-accent)] py-2.5 font-mono text-xs font-semibold text-[var(--wms-accent-fg)] shadow-sm hover:opacity-90 disabled:opacity-50"
            >
              Save device
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
