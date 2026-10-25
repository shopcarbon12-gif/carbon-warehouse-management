/** Shared types, fetcher, Eastern-time helpers and class tokens for CarbonMarketing screens. */
import type { MarketingPost } from "@/lib/server/marketing/store";

export type { MarketingPost };

export const ET = "America/New_York";

export const fetcher = async <T,>(u: string): Promise<T> => {
  const r = await fetch(u, { cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error || `HTTP ${r.status}`);
  return j as T;
};

export async function send<T = unknown>(url: string, method: "PATCH" | "POST", body?: unknown): Promise<T> {
  const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

/** "YYYY-MM-DD" of an instant, in Eastern time. */
export function etDay(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ET, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

/** Value for <input type="datetime-local"> showing an instant in Eastern time. */
export function etLocalInput(iso: string | null): string {
  if (!iso) return "";
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: ET, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(iso))
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** Eastern wall-clock "YYYY-MM-DDTHH:mm" → ISO instant with the right EDT/EST offset. */
export function etLocalToIso(local: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return null;
  for (const off of ["-04:00", "-05:00"]) {
    const iso = `${local}:00${off}`;
    if (etLocalInput(iso) === local) return new Date(iso).toISOString();
  }
  return null;
}

export function etWhen(iso: string | null): string {
  if (!iso) return "No time set";
  return new Date(iso).toLocaleString("en-US", { timeZone: ET, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export const STATUS_LABEL: Record<string, string> = {
  draft: "Waiting for approval",
  changes_requested: "Changes requested",
  approved: "Approved",
  publishing: "Publishing",
  published: "Published",
  partly_published: "Partly published",
  failed: "Failed",
  cancelled: "Cancelled",
};
export const STATUS_TONE: Record<string, string> = {
  draft: "bg-[var(--wms-surface-elevated)] text-[var(--wms-muted)] border-[var(--wms-border)]",
  changes_requested: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40",
  approved: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40",
  publishing: "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/40",
  published: "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/40",
  partly_published: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40",
  failed: "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/40",
  cancelled: "bg-[var(--wms-surface-elevated)] text-[var(--wms-muted)] border-[var(--wms-border)] line-through",
};
export const FORMAT_LABEL: Record<string, string> = { image: "Single image", carousel: "Carousel", reel: "Reel", story: "Story" };

export const card = "min-w-0 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] p-3";
export const btn =
  "rounded-md border px-2.5 py-1 font-mono text-[0.72rem] uppercase tracking-wide disabled:opacity-50 max-md:min-h-11 max-md:px-3";
export const field =
  "rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1 font-mono text-xs text-[var(--wms-fg)] max-md:min-h-11 max-md:text-base";
export const label = "font-mono text-[0.66rem] font-semibold uppercase tracking-wide text-[var(--wms-muted)]";
