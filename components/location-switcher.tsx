"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

type Loc = { id: string; code: string; name: string };

export function LocationSwitcher({
  activeLocationId,
}: {
  activeLocationId: string;
}) {
  const router = useRouter();
  const [locations, setLocations] = useState<Loc[]>([]);

  const load = useCallback(async () => {
    const res = await fetch("/api/locations");
    if (!res.ok) return;
    const data = (await res.json()) as Loc[];
    setLocations(data);
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => {
      void load();
    }, 0);
    return () => clearTimeout(t);
  }, [load]);

  const activeLabel = useMemo(() => {
    const hit = locations.find((l) => l.id === activeLocationId);
    if (!hit) return "";
    return `${hit.code} · ${hit.name}`;
  }, [locations, activeLocationId]);

  async function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const locationId = e.target.value;
    if (!locationId || locationId === activeLocationId) return;
    const res = await fetch("/api/session/location", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locationId }),
    });
    if (res.ok) router.refresh();
  }

  return (
    <label className="mx-4 mb-2 mt-2 block">
      <span className="sr-only">Active location</span>
      <select
        title={activeLabel || undefined}
        className="w-full min-w-0 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-2.5 font-mono text-sm leading-snug text-[var(--wms-fg)] focus:border-[var(--wms-accent)]/60 focus:outline-none focus:ring-1 focus:ring-[var(--wms-accent)]/40 md:text-base"
        value={activeLocationId}
        onChange={onChange}
      >
        {locations.length === 0 ? (
          <option value={activeLocationId}>Loading…</option>
        ) : (
          locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.code} · {l.name}
            </option>
          ))
        )}
      </select>
    </label>
  );
}
