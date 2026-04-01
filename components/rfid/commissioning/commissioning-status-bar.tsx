"use client";

export type RfidTaskPhase = "IDLE" | "ENCODING" | "PRINTING" | "SUCCESS" | "ERROR";

const STEPS: { phase: RfidTaskPhase; label: string }[] = [
  { phase: "IDLE", label: "IDLE (READY)" },
  { phase: "ENCODING", label: "ENCODING" },
  { phase: "PRINTING", label: "PRINTING" },
  { phase: "SUCCESS", label: "SUCCESS" },
];

function phaseIndex(p: RfidTaskPhase): number {
  if (p === "ERROR") return 0;
  const i = STEPS.findIndex((s) => s.phase === p);
  return i < 0 ? 0 : i;
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

type Props = {
  phase: RfidTaskPhase;
  elapsedMs: number;
  printerEndpoint: string;
};

export function CommissioningStatusBar({ phase, elapsedMs, printerEndpoint }: Props) {
  const activeIdx = phaseIndex(phase);
  const isError = phase === "ERROR";

  return (
    <div className="rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface)]/90 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-mono text-[0.65rem] font-semibold uppercase tracking-wider text-[var(--wms-muted)]">
          RFID task status
        </h3>
        <div
          className={`font-mono text-sm tabular-nums ${
            phase === "IDLE" ? "text-[var(--wms-muted)]" : "text-teal-400/90"
          }`}
        >
          {formatElapsed(elapsedMs)}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {STEPS.map((step, i) => {
          const done = !isError && i < activeIdx;
          const current = !isError && i === activeIdx;
          const pending = i > activeIdx || isError;
          return (
            <div
              key={step.phase}
              className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 font-mono text-[0.65rem] uppercase tracking-wide ${
                done
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                  : current
                    ? "border-amber-500/50 bg-amber-500/10 text-amber-100"
                    : "border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/50 text-[var(--wms-muted)]"
              } ${pending && !current ? "opacity-70" : ""}`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  done ? "bg-emerald-400" : current ? "animate-pulse bg-amber-400" : "bg-[var(--wms-muted)]"
                }`}
              />
              {step.label}
            </div>
          );
        })}
        {isError ? (
          <div className="flex items-center gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-2.5 py-1.5 font-mono text-[0.65rem] uppercase tracking-wide text-red-200">
            Failed
          </div>
        ) : null}
      </div>

      <p className="mt-3 font-mono text-[0.6rem] text-[var(--wms-muted)]">
        {phase === "IDLE" && "Ready — select a SKU and run print / commission."}
        {phase === "ENCODING" && "Commission API: DB encode, ZPL batch, printer POST…"}
        {phase === "PRINTING" && `Printer phase ${printerEndpoint} (~1.2s settle)…`}
        {phase === "SUCCESS" && "Job complete — rfid_print audit written."}
        {phase === "ERROR" && "Job aborted — see message below."}
      </p>

      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--wms-surface-elevated)]">
        <div
          className={`h-full transition-all duration-300 ${
            isError ? "bg-red-500/70" : "bg-teal-500/80"
          }`}
          style={{
            width: isError
              ? "100%"
              : phase === "IDLE"
                ? "0%"
                : phase === "ENCODING"
                  ? "33%"
                  : phase === "PRINTING"
                    ? "66%"
                    : "100%",
          }}
        />
      </div>
    </div>
  );
}
