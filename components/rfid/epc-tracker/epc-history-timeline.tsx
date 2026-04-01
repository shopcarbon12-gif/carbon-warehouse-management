"use client";

export type HistoryRow = {
  id: string;
  action: string;
  entity: string;
  metadata: unknown;
  created_at: string;
};

const ACTION_STYLES: Record<
  string,
  { border: string; bg: string; dot: string; label: string }
> = {
  rfid_print: {
    border: "border-blue-500/40",
    bg: "bg-blue-500/10",
    dot: "bg-blue-400",
    label: "text-blue-200/90",
  },
  rfid_receive: {
    border: "border-emerald-500/40",
    bg: "bg-emerald-500/10",
    dot: "bg-emerald-400",
    label: "text-emerald-200/90",
  },
  rfid_cycle_count: {
    border: "border-[var(--wms-muted)]/40",
    bg: "bg-[var(--wms-muted)]/10",
    dot: "bg-[var(--wms-muted)]",
    label: "text-[var(--wms-fg)]/90",
  },
  rfid_transfer: {
    border: "border-orange-500/45",
    bg: "bg-orange-500/10",
    dot: "bg-orange-400",
    label: "text-orange-200/90",
  },
  rfid_alarm: {
    border: "border-red-500/45",
    bg: "bg-red-500/10",
    dot: "bg-red-400",
    label: "text-red-200/90",
  },
  rfid_exception: {
    border: "border-red-500/45",
    bg: "bg-red-500/10",
    dot: "bg-red-400",
    label: "text-red-200/90",
  },
  exception_state: {
    border: "border-red-500/45",
    bg: "bg-red-500/10",
    dot: "bg-red-400",
    label: "text-red-200/90",
  },
};

const DEFAULT_STYLE = {
  border: "border-[var(--wms-border)]",
  bg: "bg-[var(--wms-surface-elevated)]/60",
  dot: "bg-[var(--wms-muted)]",
  label: "text-[var(--wms-fg)]",
};

type Props = {
  rows: HistoryRow[];
  loading?: boolean;
};

export function EpcHistoryTimeline({ rows, loading }: Props) {
  if (loading) {
    return (
      <p className="py-8 text-center font-mono text-xs text-[var(--wms-muted)]">Loading history…</p>
    );
  }

  if (rows.length === 0) {
    return (
      <p className="py-8 text-center font-mono text-xs text-[var(--wms-muted)]">
        No audit_log events reference this EPC yet.
      </p>
    );
  }

  return (
    <div className="relative pl-6">
      <div
        className="absolute bottom-4 left-[11px] top-4 w-px bg-[var(--wms-surface-elevated)]"
        aria-hidden
      />
      <ul className="space-y-4">
        {rows.map((r) => {
          const st =
            ACTION_STYLES[r.action] ??
            (r.action.includes("exception") || r.action.includes("alarm")
              ? ACTION_STYLES.rfid_exception
              : DEFAULT_STYLE);
          return (
            <li key={r.id} className="relative">
              <span
                className={`absolute left-[-17px] top-3 h-2.5 w-2.5 rounded-full ${st.dot}`}
              />
              <div
                className={`rounded-lg border ${st.border} ${st.bg} px-3 py-2.5 font-mono text-[0.65rem]`}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className={`font-semibold uppercase tracking-wide ${st.label}`}>
                    {r.action}
                  </span>
                  <time className="text-[var(--wms-muted)]" dateTime={r.created_at}>
                    {new Date(r.created_at).toLocaleString()}
                  </time>
                </div>
                <div className="mt-1 text-[var(--wms-muted)]">entity · {r.entity}</div>
                <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all text-[0.6rem] text-[var(--wms-muted)]">
                  {(() => {
                    const raw = JSON.stringify(r.metadata ?? {}, null, 2);
                    return raw.length > 900 ? `${raw.slice(0, 900)}…` : raw;
                  })()}
                </pre>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
