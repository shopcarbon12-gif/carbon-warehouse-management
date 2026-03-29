"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

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
        className="w-full rounded-md border border-slate-700 bg-zinc-900 px-3 py-2 font-mono text-sm text-slate-200 focus:border-teal-500/60 focus:outline-none focus:ring-1 focus:ring-teal-500/40"
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
