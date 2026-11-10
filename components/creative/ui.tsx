"use client";

/**
 * CarbonWMS Creative — shared UI. Always CARBON's own look (spec §2): black-heavy, bold condensed
 * type, high contrast — whatever the WMS theme is. Phone-first: 44 px taps, 16 px inputs.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

export const head = "font-[Oswald,'Arial_Narrow','Helvetica_Neue',sans-serif] font-bold uppercase tracking-[0.02em]";
export const btn =
  "inline-flex min-h-11 select-none items-center justify-center gap-2 rounded-none border border-white/15 bg-white/5 px-4 text-sm font-semibold text-white transition active:scale-[0.98] hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40";
export const btnPrimary =
  "inline-flex min-h-11 select-none items-center justify-center gap-2 rounded-none bg-white px-5 text-sm font-bold uppercase tracking-wide text-black transition active:scale-[0.98] hover:bg-white/85 disabled:cursor-not-allowed disabled:opacity-40";
export const btnDanger = "inline-flex min-h-11 items-center justify-center rounded-none border border-red-500/40 px-4 text-sm font-semibold text-red-300 hover:bg-red-500/10";
export const card = "border border-white/10 bg-[#111] p-4";
export const input = "min-h-11 w-full rounded-none border border-white/15 bg-black px-3 text-base text-white placeholder:text-white/35 focus:border-white/60 focus:outline-none md:text-sm";
export const chip = (on: boolean) =>
  `inline-flex min-h-9 items-center gap-1 whitespace-nowrap border px-3 text-xs font-semibold uppercase tracking-wide transition ${on ? "border-white bg-white text-black" : "border-white/20 text-white/75 hover:border-white/50"}`;
export const muted = "text-white/55";

export const money = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "—" : `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`);
export const dash = (v: unknown) => (v == null || v === "" ? "—" : String(v));

export async function api<T = unknown>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const r = await fetch(url, {
    ...init,
    headers: init?.json !== undefined ? { "Content-Type": "application/json", ...(init?.headers ?? {}) } : init?.headers,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- SWR picks the shape from useSWR<T>
export const fetcher = (url: string): Promise<any> => api(url);

const TABS = [
  { href: "/creative", label: "Home" },
  { href: "/creative/create", label: "Create" },
  { href: "/creative/radar", label: "Radar" },
  { href: "/creative/library", label: "Library" },
];

export function CreativeShell({ children, wide }: { children: ReactNode; wide?: boolean }) {
  const path = usePathname();
  return (
    <div className="min-h-[calc(100dvh-4rem)] w-full min-w-0 bg-[#050505] text-white selection:bg-white selection:text-black">
      <div className={`mx-auto flex w-full min-w-0 flex-col ${wide ? "max-w-[1500px]" : "max-w-6xl"}`}>
        <nav className="sticky top-0 z-20 flex items-center gap-1 border-b border-white/10 bg-[#050505]/95 px-3 backdrop-blur md:px-6">
          <span className={`${head} mr-3 hidden text-lg md:inline`}>CARBON <span className="text-white/40">Creative</span></span>
          <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
            {TABS.map((t) => {
              const on = t.href === "/creative" ? path === "/creative" : path?.startsWith(t.href);
              return (
                <Link key={t.href} href={t.href} className={`${head} flex min-h-12 items-center border-b-2 px-3 text-sm ${on ? "border-white text-white" : "border-transparent text-white/50 hover:text-white"}`}>
                  {t.label}
                </Link>
              );
            })}
          </div>
          <Link href="/creative/settings" aria-label="Settings" title="Settings (brand, models, caps)" className={`flex min-h-11 min-w-11 items-center justify-center border ${path?.startsWith("/creative/settings") ? "border-white" : "border-white/15"} text-white/80 hover:text-white`}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="8" r="4" /><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" /></svg>
          </Link>
        </nav>
        <div className="min-w-0 px-3 pb-24 pt-4 md:px-6">{children}</div>
      </div>
    </div>
  );
}

export function Title({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="mb-4">
      <h1 className={`${head} text-3xl leading-none md:text-5xl`}>{children}</h1>
      {sub ? <p className={`mt-2 text-sm ${muted}`}>{sub}</p> : null}
    </div>
  );
}

export function ErrorLine({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return <p className="my-2 border-l-2 border-red-500 bg-red-500/10 px-3 py-2 text-sm text-red-200">{error}</p>;
}

export type Job = { id: string; kind: string; status: string; progress: string | null; error: string | null; updated_at: string };

export function JobLine({ job }: { job: Job }) {
  const tone = job.status === "failed" ? "text-red-300" : job.status === "paused" ? "text-amber-300" : job.status === "done" ? "text-emerald-300" : "text-white";
  const live = ["queued", "running", "waiting"].includes(job.status);
  return (
    <div className="flex items-start gap-2 py-1.5 text-sm">
      <span className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${live ? "animate-pulse bg-white" : job.status === "done" ? "bg-emerald-400" : job.status === "failed" ? "bg-red-400" : "bg-amber-400"}`} />
      <div className="min-w-0">
        <span className={tone}>{job.error ?? job.progress ?? job.status}</span>
        <span className={`ml-2 text-xs ${muted}`}>{job.kind.replace(/_/g, " ")} · {job.status}</span>
      </div>
    </div>
  );
}

/** Poll while something is running (SWR refreshInterval helper). */
export function useLive(active: boolean, ms = 4000) {
  const [, setT] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setT((t) => t + 1), ms);
    return () => clearInterval(id);
  }, [active, ms]);
}

export function Media({ url, video, poster, className, alt = "" }: { url: string | null | undefined; video?: boolean; poster?: string | null; className?: string; alt?: string }) {
  if (!url) return <div className={`flex items-center justify-center bg-white/5 text-xs ${muted} ${className ?? ""}`}>—</div>;
  if (video)
    return (
      <video
        src={url}
        poster={poster ?? undefined}
        className={`bg-black object-cover ${className ?? ""}`}
        muted
        loop
        playsInline
        preload="metadata"
        onMouseEnter={(e) => void e.currentTarget.play().catch(() => {})}
        onMouseLeave={(e) => e.currentTarget.pause()}
        onClick={(e) => (e.currentTarget.paused ? void e.currentTarget.play().catch(() => {}) : e.currentTarget.pause())}
      />
    );
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt={alt} loading="lazy" className={`bg-black object-cover ${className ?? ""}`} />;
}

export const KIND_LABEL: Record<string, string> = { static: "Static", video: "Video", ugc: "UGC", animated: "Animated", campaign: "Full Campaign" };
export const STATUS_LABEL: Record<string, string> = {
  brief: "Getting ready",
  concepts: "Pick a concept",
  shots: "Shot list",
  stills: "Dressing models",
  draft: "Draft — approve?",
  approved: "Making the final",
  clips: "Video clips",
  final: "Final",
  failed: "Failed",
};
