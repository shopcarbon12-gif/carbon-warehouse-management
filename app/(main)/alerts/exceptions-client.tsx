"use client";

import { useCallback, useEffect, useState } from "react";

type Exc = {
  id: string;
  type: string;
  severity: string;
  state: string;
  detail: string;
  created_at: string;
};

export function ExceptionsClient() {
  const [rows, setRows] = useState<Exc[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const res = await fetch("/api/exceptions");
    if (!res.ok) return;
    setRows((await res.json()) as Exc[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => {
      void load();
    }, 0);
    return () => clearTimeout(t);
  }, [load]);

  async function setState(id: string, state: Exc["state"]) {
    const res = await fetch("/api/exceptions", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, state }),
    });
    if (res.ok) void load();
  }

  if (loading) {
    return <p className="mt-6 font-mono text-sm text-[var(--muted)]">Loading…</p>;
  }

  return (
    <div className="mt-6 overflow-x-auto rounded-lg border border-[var(--surface-border)]">
      <table className="w-full min-w-[560px] text-left text-sm">
        <thead>
          <tr className="border-b border-[var(--surface-border)] bg-[var(--surface)] font-mono text-xs uppercase text-[var(--muted)]">
            <th className="px-4 py-3">Type</th>
            <th className="px-4 py-3">Detail</th>
            <th className="px-4 py-3">State</th>
            <th className="px-4 py-3">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={4} className="px-4 py-8 text-center font-mono text-[var(--muted)]">
                No exceptions — run compare or seed data.
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr
                key={r.id}
                className="border-b border-[var(--surface-border)]/60 hover:bg-[var(--surface)]/40"
              >
                <td className="px-4 py-2 font-mono text-xs">{r.type}</td>
                <td className="max-w-md px-4 py-2 font-mono text-xs text-[var(--muted)]">
                  {r.detail}
                </td>
                <td className="px-4 py-2 font-mono text-xs">{r.state}</td>
                <td className="space-x-2 px-4 py-2 font-mono text-xs">
                  {r.state === "new" || r.state === "assigned" ? (
                    <>
                      <button
                        type="button"
                        className="text-[var(--accent)] hover:underline"
                        onClick={() => void setState(r.id, "resolved")}
                      >
                        Resolve
                      </button>
                      <button
                        type="button"
                        className="text-[var(--muted)] hover:underline"
                        onClick={() => void setState(r.id, "ignored")}
                      >
                        Ignore
                      </button>
                    </>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
