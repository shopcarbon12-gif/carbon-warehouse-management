import { getDbEnvironmentHint } from "@/lib/server/db-environment-hint";

/** Server component: explains localhost Postgres vs production data. */
export function DevLocalDbBanner() {
  const hint = getDbEnvironmentHint();
  if (!hint) return null;
  return (
    <aside
      className="mb-4 rounded-lg border border-amber-700/50 bg-amber-950/35 px-3 py-2.5 text-amber-100/95 shadow-sm"
      role="status"
    >
      <p className="font-mono text-[0.7rem] font-semibold uppercase tracking-wide text-amber-400/95">
        {hint.title}
      </p>
      <p className="mt-1 font-mono text-[0.65rem] leading-relaxed text-amber-200/85">{hint.body}</p>
    </aside>
  );
}
