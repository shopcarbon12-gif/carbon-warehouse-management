"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { X } from "lucide-react";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? res.statusText);
  }
  return res.json();
};

type LocOpt = { id: string; code: string; name: string };

type Props = {
  open: boolean;
  onClose: () => void;
  /** Called with the freshly-issued bearer token (visible ONCE) and the agent name. */
  onCreated: (token: string, name: string) => void;
};

export function CdmAgentEditorModal({ open, onClose, onCreated }: Props) {
  const { data: locData } = useSWR<LocOpt[]>("/api/locations", fetcher, {
    revalidateOnFocus: false,
  });
  const locations = locData ?? [];

  const [locationId, setLocationId] = useState("");
  const [name, setName] = useState("");
  const [hostname, setHostname] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLocationId(locations[0]?.id ?? "");
    setName("");
    setHostname("");
    setErr(null);
  }, [open, locations]);

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
    const trimmed = name.trim().toLowerCase();
    if (!trimmed) {
      setErr("Agent name is required");
      return;
    }
    if (!/^[a-z0-9-]+$/.test(trimmed)) {
      setErr("Use lowercase letters, numbers, and hyphens only");
      return;
    }
    if (!locationId) {
      setErr("Location is required");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/cdm-agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          locationId,
          name: trimmed,
          hostname: hostname.trim() || null,
        }),
      });
      const j = (await res.json()) as { error?: string; token?: string };
      if (!res.ok) throw new Error(j.error ?? "Save failed");
      if (!j.token) throw new Error("Agent created but no token returned");
      onCreated(j.token, trimmed);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)] p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-mono text-sm font-semibold text-[var(--wms-fg)]">
            Add Carbon CDM agent
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mb-3 font-mono text-[0.65rem] text-[var(--wms-muted)]">
          One agent per warehouse / store host. After creation, the API token is shown
          ONCE — copy it into the agent's <code>.env</code> file. It cannot be
          retrieved later.
        </p>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block font-mono text-[0.65rem] uppercase tracking-wider text-[var(--wms-muted)]">
              Location
            </label>
            <select
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
              className="w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1.5 font-mono text-xs text-[var(--wms-fg)] focus:border-[var(--wms-accent)] focus:outline-none"
            >
              <option value="">-- select --</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  [{l.code}] {l.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block font-mono text-[0.65rem] uppercase tracking-wider text-[var(--wms-muted)]">
              Agent name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. orlando-cdm"
              maxLength={64}
              className="w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1.5 font-mono text-xs text-[var(--wms-fg)] focus:border-[var(--wms-accent)] focus:outline-none"
            />
            <p className="mt-1 font-mono text-[0.6rem] text-[var(--wms-muted)]">
              Lowercase letters, numbers, hyphens. Used as a hostname-friendly identifier.
            </p>
          </div>
          <div>
            <label className="mb-1 block font-mono text-[0.65rem] uppercase tracking-wider text-[var(--wms-muted)]">
              Hostname / IP (optional)
            </label>
            <input
              type="text"
              value={hostname}
              onChange={(e) => setHostname(e.target.value)}
              placeholder="carbon-cdm.local or 192.168.1.x"
              maxLength={256}
              className="w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1.5 font-mono text-xs text-[var(--wms-fg)] focus:border-[var(--wms-accent)] focus:outline-none"
            />
          </div>
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
            {busy ? "Creating..." : "Create + reveal token"}
          </button>
        </div>
      </div>
    </div>
  );
}
