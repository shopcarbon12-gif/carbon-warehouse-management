"use client";

import useSWR from "swr";
import { useState } from "react";

type HandheldClientInfo = {
  serialNumber?: string;
  wifiMac?: string;
  bluetoothMac?: string;
  radioVersion?: string;
  androidRelease?: string;
  appVersion?: string;
  model?: string;
  manufacturer?: string;
};

type DeviceRow = {
  id: string;
  name: string;
  device_type: string;
  android_id: string | null;
  network_address?: string | null;
  is_authorized: boolean;
  location_code: string;
  config?: Record<string, unknown>;
};

function readClientInfo(config: Record<string, unknown> | undefined): HandheldClientInfo | null {
  const raw = config?.handheld_client_info;
  if (!raw || typeof raw !== "object") return null;
  return raw as HandheldClientInfo;
}

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to load devices");
  const j = (await res.json()) as { devices: DeviceRow[] };
  return j.devices;
};

export function HandheldBindingsWorkspace() {
  const { data, error, mutate } = useSWR("/api/infrastructure/devices", fetcher);
  const [busy, setBusy] = useState<string | null>(null);

  const authorize = async (id: string) => {
    setBusy(id);
    try {
      const res = await fetch(`/api/infrastructure/devices/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isAuthorized: true }),
      });
      if (!res.ok) throw new Error("Authorize failed");
      await mutate();
    } finally {
      setBusy(null);
    }
  };

  if (error) return <p className="font-mono text-xs text-red-500/90">{String(error.message)}</p>;
  if (!data) return <p className="font-mono text-xs text-[var(--wms-muted)]">Loading…</p>;

  const pending = data.filter(
    (d) => d.device_type === "handheld_reader" && !d.is_authorized && Boolean(d.android_id?.trim()),
  );

  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--wms-border)] dark:border-[var(--wms-border)]">
      <table className="w-full min-w-[960px] text-left text-sm">
        <thead>
          <tr className="border-b border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] font-mono text-[0.6rem] uppercase text-[var(--wms-muted)]">
            <th className="px-3 py-2">Location</th>
            <th className="px-3 py-2">Name</th>
            <th className="px-3 py-2">Android ID</th>
            <th className="px-3 py-2">Network / MAC</th>
            <th className="px-3 py-2">Serial</th>
            <th className="px-3 py-2">OS / radio</th>
            <th className="px-3 py-2">Authorized</th>
            <th className="px-3 py-2 text-right"> </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--wms-border)]/80">
          {pending.length === 0 ? (
            <tr>
              <td colSpan={8} className="px-3 py-6 text-center text-[var(--wms-muted)]">
                No pending handheld registrations. Open the mobile app once (device ping) after login.
              </td>
            </tr>
          ) : (
            pending.map((d) => (
              <tr key={d.id} className="text-[var(--wms-fg)]">
                <td className="px-3 py-2 font-mono text-xs">{d.location_code}</td>
                <td className="px-3 py-2">{d.name}</td>
                <td className="px-3 py-2 font-mono text-xs">{d.android_id ?? "—"}</td>
                <td className="max-w-[140px] truncate px-3 py-2 font-mono text-xs" title={d.network_address ?? ""}>
                  {d.network_address ?? "—"}
                </td>
                <td className="max-w-[120px] truncate px-3 py-2 font-mono text-xs" title={readClientInfo(d.config)?.serialNumber ?? ""}>
                  {readClientInfo(d.config)?.serialNumber ?? "—"}
                </td>
                <td className="max-w-[180px] truncate px-3 py-2 font-mono text-[0.65rem] leading-tight text-[var(--wms-muted)]" title="">
                  {(() => {
                    const c = readClientInfo(d.config);
                    if (!c) return "—";
                    const parts = [c.androidRelease && `A${c.androidRelease}`, c.radioVersion].filter(Boolean);
                    return parts.length ? parts.join(" · ") : "—";
                  })()}
                </td>
                <td className="px-3 py-2">{d.is_authorized ? "Yes" : "No"}</td>
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    disabled={busy === d.id || !d.android_id}
                    onClick={() => void authorize(d.id)}
                    className="rounded-lg bg-blue-600 px-3 py-1.5 font-mono text-xs text-white disabled:opacity-50"
                  >
                    Authorize
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
