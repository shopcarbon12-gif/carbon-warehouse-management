"use client";

/** Creative → Home (spec §2.1): Create, Give me ideas (text only, on demand), spend, what's working. */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import useSWR from "swr";
import { api, btn, btnPrimary, card, CreativeShell, ErrorLine, fetcher, head, JobLine, KIND_LABEL, Media, money, muted, STATUS_LABEL, type Job } from "./ui";

type Spend = Record<"openai" | "fal", { today: number; month: number; daily: number; monthly: number }> & { total: { today: number; month: number } };
type Idea = { id: string; idea: string; reason: string; prefill: { products?: string[]; kind?: string; recipe?: string | null; preset?: string } };
type Overview = {
  spend: Spend;
  keys: { openai: boolean; fal: boolean; meta: boolean };
  brand: { wizardDone: boolean };
  working: string[];
  radar: { kept: number; review: number; season: { label: string } };
  jobs: Job[];
  projects: { id: string; title: string; kind: string; status: string; step_note: string | null; cover: string | null; video: string | null; spend: number; role: string | null }[];
  ideas: Idea[];
};

export function ideaHref(i: Idea) {
  const q = new URLSearchParams();
  if (i.prefill.products?.length) q.set("products", i.prefill.products.join(","));
  if (i.prefill.kind) q.set("kind", i.prefill.kind);
  if (i.prefill.recipe) q.set("recipe", i.prefill.recipe);
  if (i.prefill.preset) q.set("preset", i.prefill.preset);
  q.set("idea", i.id);
  return `/creative/create?${q}`;
}

function Bar({ label, used, cap }: { label: string; used: number; cap: number }) {
  const pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
  return (
    <div>
      <div className="flex justify-between text-xs">
        <span className={muted}>{label}</span>
        <span>{money(used)} <span className={muted}>/ {money(cap)}</span></span>
      </div>
      <div className="mt-1 h-1.5 bg-white/10"><div className={`h-full ${pct > 85 ? "bg-red-400" : "bg-white"}`} style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

export function CreativeHome() {
  const router = useRouter();
  const { data, error, mutate } = useSWR<Overview>("/api/creative", fetcher, { refreshInterval: (d) => (d?.jobs?.some((j) => ["queued", "running", "waiting"].includes(j.status)) ? 5000 : 0) });
  const [ideas, setIdeas] = useState<Idea[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const shown = ideas ?? data?.ideas ?? [];

  async function giveIdeas() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ ideas: Idea[]; cost: number }>("/api/creative/ideas", { method: "POST" });
      setIdeas(r.ideas);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function skip(id: string) {
    setIdeas((xs) => (xs ?? data?.ideas ?? []).filter((x) => x.id !== id));
    await api("/api/creative/ideas", { method: "PATCH", json: { id, status: "skipped" } }).catch(() => {});
    void mutate();
  }
  const live = (data?.jobs ?? []).filter((j) => ["queued", "running", "waiting", "failed", "paused"].includes(j.status)).slice(0, 6);

  return (
    <CreativeShell>
      <section className="grid gap-3 md:grid-cols-[1.4fr_1fr]">
        <div className="flex flex-col justify-between border border-white/10 bg-[radial-gradient(120%_80%_at_0%_0%,#1d1d1d,#050505)] p-5 md:p-8">
          <div>
            <p className={`text-xs uppercase tracking-[0.3em] ${muted}`}>Your creative team</p>
            <h1 className={`${head} mt-2 text-5xl leading-[0.9] md:text-7xl`}>Make the<br />next ad.</h1>
            <p className={`mt-3 max-w-md text-sm ${muted}`}>You do three things: approve, ask for a change in plain words, post. Everything else has a smart default.</p>
          </div>
          <div className="mt-6 flex flex-wrap gap-2">
            <Link href="/creative/create" className={`${btnPrimary} min-h-12 px-7 text-base`}>Create something</Link>
            <button className={`${btn} min-h-12`} disabled={busy} onClick={giveIdeas}>{busy ? "Thinking…" : "Give me ideas"}</button>
          </div>
          {!data?.brand.wizardDone && data ? (
            <p className="mt-4 text-xs text-amber-200">Brand Brain not set up yet — the defaults are used until you <Link className="underline" href="/creative/settings?tab=brand">run the 10-minute setup</Link>.</p>
          ) : null}
        </div>
        <div className={`${card} flex flex-col gap-3`}>
          <h2 className={`${head} text-lg`}>Spend this month</h2>
          <p className={`${head} text-4xl`}>{money(data?.spend.total.month)}</p>
          {data ? (
            <>
              <Bar label="OpenAI (brain + pictures)" used={data.spend.openai.month} cap={data.spend.openai.monthly} />
              <Bar label="fal.ai (video)" used={data.spend.fal.month} cap={data.spend.fal.monthly} />
              <p className={`text-xs ${muted}`}>Today {money(data.spend.total.today)} · jobs pause at a cap · nothing runs unless you tap.</p>
              {!data.keys.fal ? <p className="text-xs text-amber-200">Video needs a fal.ai key (FAL_KEY) on the server.</p> : null}
            </>
          ) : null}
        </div>
      </section>

      <ErrorLine error={err ?? (error as Error | undefined)?.message} />

      {shown.length ? (
        <section className="mt-6">
          <h2 className={`${head} mb-2 text-xl`}>Ideas</h2>
          <div className="grid gap-2 md:grid-cols-2">
            {shown.map((i) => (
              <div key={i.id} className={`${card} flex flex-col gap-2`}>
                <p className="text-base font-semibold">{i.idea}</p>
                <p className={`text-sm ${muted}`}>{i.reason}</p>
                <div className="mt-auto flex gap-2">
                  <button className={btnPrimary} onClick={() => router.push(ideaHref(i))}>Make this</button>
                  <button className={btn} onClick={() => skip(i.id)}>Skip</button>
                </div>
              </div>
            ))}
          </div>
          <p className={`mt-2 text-xs ${muted}`}>Text only — one cheap AI call. Nothing is drawn or filmed until you tap Make this and approve the draft.</p>
        </section>
      ) : null}

      <section className="mt-6 grid gap-3 md:grid-cols-[1fr_1fr]">
        <div className={card}>
          <h2 className={`${head} mb-2 text-lg`}>What&rsquo;s working for CARBON</h2>
          {data?.working.length ? (
            <ul className="space-y-1.5 text-sm">{data.working.map((w) => <li key={w}>· {w}</li>)}</ul>
          ) : (
            <p className={`text-sm ${muted}`}>— Nothing posted from Creative yet. Results show here once posts have real numbers.</p>
          )}
        </div>
        <div className={card}>
          <h2 className={`${head} mb-2 text-lg`}>Radar</h2>
          <p className="text-sm">{data ? `${data.radar.kept} winning clothing & shoe ads · ${data.radar.review} to review` : "—"}</p>
          <p className={`text-xs ${muted}`}>Season now: {data?.radar.season.label ?? "—"}</p>
          <Link href="/creative/radar" className={`${btn} mt-3`}>Open Radar</Link>
        </div>
      </section>

      {live.length ? (
        <section className={`${card} mt-6`}>
          <h2 className={`${head} mb-1 text-lg`}>Working on</h2>
          {live.map((j) => <JobLine key={j.id} job={j} />)}
        </section>
      ) : null}

      <section className="mt-6">
        <div className="mb-2 flex items-end justify-between">
          <h2 className={`${head} text-xl`}>Recent</h2>
          <Link href="/creative/library" className={`text-sm ${muted} underline`}>Library</Link>
        </div>
        {data?.projects.length ? (
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {data.projects.slice(0, 8).map((p) => (
              <Link key={p.id} href={`/creative/create?project=${p.id}`} className="group block border border-white/10 bg-[#0d0d0d]">
                <Media url={p.cover} video={false} className="aspect-[4/5] w-full" />
                <div className="p-2">
                  <p className="truncate text-sm font-semibold">{p.title || KIND_LABEL[p.kind]}</p>
                  <p className={`text-xs ${p.status === "draft" ? "text-amber-200" : muted}`}>{KIND_LABEL[p.kind]} · {STATUS_LABEL[p.status] ?? p.status} · {money(p.spend)}</p>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <p className={`text-sm ${muted}`}>— Nothing made yet.</p>
        )}
      </section>
    </CreativeShell>
  );
}
