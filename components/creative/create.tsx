"use client";

/**
 * Creative → Create (spec §7): five taps from start to final.
 *   1 What are we promoting? · 2 What do you want? · 3 Who's wearing it? · 4 Pick 1 of 3 concepts ·
 *   5 Approve the draft → final → captions + post. A chat box handles every change after that.
 */
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, useSyncExternalStore } from "react";
import useSWR from "swr";
import { api, btn, btnDanger, btnPrimary, card, chip, CreativeShell, ErrorLine, fetcher, head, input, JobLine, KIND_LABEL, Media, money, muted, statusLabel, type Job } from "./ui";

type Product = { id: string; title: string; image: string | null; price: number; stock: number; type: string; gender: string; isNew: boolean; sold30: number | null; twin: { status: string; confirmedAt: string | null } | null };
type Products = { products: Product[]; suggestions: { newDrops: string[]; bestSellers: string[]; slowMovers: string[] }; twinCost: number };
type Model = { id: string; name: string; gender: string; refs: string[]; look: string | null; personality: string | null; pinned: boolean; active: boolean; isRealPerson: boolean; consent: boolean };

const KINDS = [
  { k: "static", t: "Static", d: "Photo ads + carousel, 4:5 and 9:16", ex: "Hero still · price tag · shop now" },
  { k: "video", t: "Video", d: "Every shot becomes a real video of your model, then cut on the beat with effects", ex: "Walk-in → freeze → slam" },
  { k: "ugc", t: "UGC", d: "Looks like a real person filmed it on their phone — talks about or shows the piece", ex: "Unboxing · off the hanger · mirror try-on" },
  { k: "campaign", t: "Full Campaign", d: "Hero video + cut-downs + UGC + photo ads + carousel + stories", ex: "One click = the whole drop" },
] as const;

const ASPECT: Record<string, string> = { "9:16": "aspect-[9/16]", "4:5": "aspect-[4/5]", "1:1": "aspect-square" };
const TWIN_STATUS: Record<string, string> = { building: "checking the product…", new: "checking the product…", ready: "check these", no_images: "no photos in Shopify", failed: "couldn't read the product" };
const price = (n: number) => `$${Number(n).toFixed(2).replace(/\.00$/, "")}`;
const fileName = (title: string | null | undefined, size: string | null, ext: string) => encodeURIComponent(`CARBON-${(title || "creative").replace(/\W+/g, "-").replace(/^-|-$/g, "")}${size ? `-${size.replace(":", "x")}` : ""}.${ext}`);

export function CreativeCreate() {
  const sp = useSearchParams();
  const project = sp.get("project");
  return <CreativeShell>{project ? <ProjectView id={project} /> : <NewProject />}</CreativeShell>;
}

/* ------------------------------------------------------------------ steps 1–3 */

function NewProject() {
  const sp = useSearchParams();
  const router = useRouter();
  const { data: pd, error: pe } = useSWR<Products>("/api/creative/products", fetcher);
  const { data: sd } = useSWR<{ models: Model[]; brand?: { presets?: { key: string; name: string }[] } }>("/api/creative/settings", fetcher);
  const [picked, setPicked] = useState<string[]>(() => (sp.get("products") ?? "").split(",").filter(Boolean));
  const [kind, setKind] = useState<string>(sp.get("kind") ?? "");
  const [cast, setCast] = useState<string[] | "auto">("auto");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "new" | "best" | "slow">("all");
  const [more, setMore] = useState(false);
  const [preset, setPreset] = useState<string>(sp.get("preset") ?? "");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const step = !picked.length ? 1 : !kind ? 2 : 3;

  const list = useMemo(() => {
    const all = pd?.products ?? [];
    const ids = filter === "new" ? pd?.suggestions.newDrops : filter === "best" ? pd?.suggestions.bestSellers : filter === "slow" ? pd?.suggestions.slowMovers : null;
    const byFilter = ids ? ids.map((id) => all.find((p) => p.id === id)).filter((p): p is Product => Boolean(p)) : all;
    const s = q.trim().toLowerCase();
    return s ? byFilter.filter((p) => p.title.toLowerCase().includes(s) || p.type.includes(s)) : byFilter;
  }, [pd, q, filter]);

  const toggle = (id: string) => setPicked((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : xs.length >= 6 ? xs : [...xs, id]));
  async function start() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ projectId: string }>("/api/creative/projects", {
        method: "POST",
        json: { kind, products: picked, cast, preset: preset || null, inspirationAdId: sp.get("inspiration") || null, ideaId: sp.get("idea") || null, recipe: sp.get("recipe") || null, title: title || undefined },
      });
      router.push(`/creative/create?project=${r.projectId}`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }
  const models = (sd?.models ?? []).filter((m) => m.active && m.refs.length >= 2 && (!m.isRealPerson || m.consent));
  const pickedProducts = picked.map((id) => pd?.products.find((p) => p.id === id)).filter(Boolean) as Product[];

  return (
    <>
      <div className="mb-4 flex items-center gap-2 text-xs uppercase tracking-widest">
        {["Product", "Type", "Who"].map((s, i) => (
          <span key={s} className={`${i + 1 === step ? "text-white" : i + 1 < step ? "text-white/60" : "text-white/25"}`}>{i + 1}. {s}{i < 2 ? <span className="mx-2 text-white/20">/</span> : null}</span>
        ))}
      </div>
      {sp.get("inspiration") ? <p className="mb-3 border-l-2 border-white/40 pl-3 text-sm">Remaking a Radar ad: the same shots, in the same order, with your product and your model — never its brand, text or people.</p> : null}
      <ErrorLine error={err ?? (pe as Error | undefined)?.message} />

      {/* 1 — products */}
      <section className={step === 1 ? "" : "mb-4"}>
        <h2 className={`${head} text-2xl md:text-3xl`}>What are we promoting?</h2>
        {step > 1 ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {pickedProducts.map((p) => (
              <span key={p.id} className="inline-flex items-center gap-2 border border-white/15 bg-white/5 py-1 pl-1 pr-2 text-sm">
                <Media url={p.image} className="h-9 w-9" />
                {p.title}
                <button aria-label={`Remove ${p.title}`} className="min-h-9 min-w-9 text-white/60" onClick={() => toggle(p.id)}>×</button>
              </span>
            ))}
          </div>
        ) : null}
        {step === 1 || picked.length ? (
          <div className={step === 1 ? "mt-3" : "mt-2"}>
            <div className="flex flex-wrap gap-2">
              {([["all", "All in stock"], ["new", "New drops"], ["best", "Best sellers"], ["slow", "Overstock to move"]] as const).map(([k, l]) => (
                <button key={k} className={chip(filter === k)} onClick={() => setFilter(k)}>{l}</button>
              ))}
            </div>
            <input className={`${input} mt-2`} placeholder="Search products" value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="mt-2 grid max-h-[60dvh] grid-cols-3 gap-1.5 overflow-y-auto md:grid-cols-6">
              {list.slice(0, 120).map((p) => {
                const on = picked.includes(p.id);
                return (
                  <button key={p.id} onClick={() => toggle(p.id)} className={`relative border text-left ${on ? "border-white" : "border-white/10"}`}>
                    <Media url={p.image} className="aspect-[4/5] w-full" />
                    {on ? <span className="absolute right-1 top-1 bg-white px-1.5 text-xs font-bold text-black">✓</span> : null}
                    {p.twin?.confirmedAt ? <span className="absolute left-1 top-1 bg-black/70 px-1 text-[10px]">twin ✓</span> : null}
                    <div className="p-1.5">
                      <p className="line-clamp-2 text-xs font-semibold">{p.title}</p>
                      <p className={`text-[11px] ${muted}`}>{price(p.price)} · {p.stock} in stock{p.sold30 ? ` · ${p.sold30} sold` : ""}</p>
                    </div>
                  </button>
                );
              })}
              {!pd ? <p className={`col-span-full text-sm ${muted}`}>Loading the catalog…</p> : null}
            </div>
            {pd && list.length > 120 ? <p className={`mt-1 text-xs ${muted}`}>Showing 120 of {list.length} — search to find the rest.</p> : null}
            {pd ? <p className={`mt-1 text-xs ${muted}`}>The first time a product is used the app builds its Product Twin (cut-outs + facts, ≈ {money(pd.twinCost)} once, kept forever).</p> : null}
          </div>
        ) : null}
      </section>

      {/* 2 — kind */}
      {step >= 2 ? (
        <section className="mt-6">
          <h2 className={`${head} text-2xl md:text-3xl`}>What do you want?</h2>
          <div className="mt-3 grid gap-2 md:grid-cols-4">
            {KINDS.map((x) => (
              <button key={x.k} onClick={() => setKind(x.k)} className={`flex min-h-28 flex-col justify-between border p-3 text-left ${kind === x.k ? "border-white bg-white text-black" : "border-white/15 bg-[#0d0d0d] hover:border-white/50"}`}>
                <span className={`${head} text-xl`}>{x.t}</span>
                <span className={`text-xs ${kind === x.k ? "text-black/70" : muted}`}>{x.d}</span>
                <span className={`mt-2 text-[11px] italic ${kind === x.k ? "text-black/60" : "text-white/35"}`}>{x.ex}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {/* 3 — cast */}
      {step >= 3 ? (
        <section className="mt-6">
          <h2 className={`${head} text-2xl md:text-3xl`}>Who&rsquo;s wearing it?</h2>
          {kind === "animated" ? (
            <p className={`mt-2 text-sm ${muted}`}>Animated ads use the product cut-outs — no model needed.</p>
          ) : (
            <>
              <div className="mt-3 flex flex-wrap gap-2">
                <button className={chip(cast === "auto")} onClick={() => setCast("auto")}>Auto-cast (recommended)</button>
                <button className={chip(cast !== "auto")} onClick={() => setCast([])}>Pick models</button>
                <Link className={chip(false)} href="/creative/settings?tab=models" target="_blank">+ New model</Link>
              </div>
              {cast !== "auto" && !models.length ? (
                <p className="mt-2 text-sm text-amber-200">No model is ready yet — add one in <Link className="underline" href="/creative/settings?tab=models" target="_blank">Settings › Models</Link> (it needs at least 2 photos).</p>
              ) : cast !== "auto" ? (
                <div className="mt-2 grid grid-cols-4 gap-1.5 md:grid-cols-8">
                  {models.map((m) => {
                    const on = cast.includes(m.id);
                    return (
                      <button key={m.id} onClick={() => setCast((c) => (c === "auto" ? [m.id] : on ? c.filter((x) => x !== m.id) : c.length >= 4 ? c : [...c, m.id]))} className={`border ${on ? "border-white" : "border-white/10"}`}>
                        <Media url={m.refs[0]} className="aspect-square w-full" />
                        <p className="truncate px-1 py-1 text-xs">{m.name}</p>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className={`mt-2 text-xs ${muted}`}>Auto-cast fits the concept, and keeps variety: nobody in more than 2 of the last 10 ads unless pinned.</p>
              )}
            </>
          )}
          <button className={`mt-4 text-sm ${muted} underline`} onClick={() => setMore((m) => !m)}>⋯ More</button>
          {more ? (
            <div className={`${card} mt-2 grid gap-2 md:grid-cols-2`}>
              <label className="text-sm">Look<select className={`${input} mt-1`} value={preset} onChange={(e) => setPreset(e.target.value)}><option value="">Auto (brand default)</option>{(sd?.brand?.presets ?? []).map((x) => <option key={x.key} value={x.key}>{x.name}</option>)}</select>{kind === "ugc" ? <span className={`mt-1 block text-xs ${muted}`}>UGC ignores the Look — it always looks like a real phone video.</span> : null}</label>
              <label className="text-sm">Name (optional)<input className={`${input} mt-1`} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={kind === "campaign" ? "e.g. Winter drop" : ""} /></label>
            </div>
          ) : null}
          <div className="mt-5">
            <button className={`${btnPrimary} min-h-12 w-full text-base md:w-auto md:px-10`} disabled={busy || (cast !== "auto" && !cast.length && kind !== "animated")} onClick={start}>
              {busy ? "Starting…" : sp.get("inspiration") && kind !== "static" ? "Make my version of this ad" : "Show me 3 concepts"}
            </button>
            <p className={`mt-2 text-xs ${muted}`}>
              {kind === "static" ? "Concepts are text + cheap sketches. The photo ads are drawn after you pick one." : kind === "ugc" ? "Concepts are text only. Nothing is filmed until you tap Make the video." : "Concepts are text + cheap sketches. The real video is only made when you tap Make the video."}
            </p>
          </div>
        </section>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ project */

type Concept = {
  title: string; idea: string; hook: { first_1_5s: string; text: string | null; why: string }; recipe_key: string; edit_recipe: string;
  storyboard: { frame: number; framing?: string; shot: string; text: string | null; thumbUrl: string | null }[]; look?: { location: string; light: string; palette: string }; music: { mood: string; bpm: number }; length_s: number; format: string; inspired_by: string[];
};
type Shot = { idx: number; subject_action: string; camera_move: string; lens: string; lighting: string; location: string; duration_s: number; garment_must_show: string; text_overlay: string | null; is_end_card: boolean };
type View = {
  project: { id: string; title: string; kind: string; status: string; step_note: string | null; concepts: Concept[] | null; concept_idx: number | null; shot_list: { shots: Shot[] } | null; captions: { options?: string[]; hashtags?: string[] } | null; sizes: string[]; role: string | null; campaign_id: string | null; preset: string; feedback: string | null };
  stills: { id: string; shotIdx: number; url: string; note: string; critic: { overall: number } | null }[];
  clips: { id: string; shotIdx: number; url: string; engine: string; note: string }[];
  renders: { id: string; size: string | null; draft: boolean; url: string; poster: string | null; kind: "video" | "image"; shotIdx: number | null; createdAt: string }[];
  rendersRunning: number;
  attempts: { rejected: number; failed: number };
  jobs: Job[];
  spend: number;
  chat: { role: string; text: string; created_at: string }[];
  cast: { id: string; name: string; refs: string[] }[];
  twins: ({ productId: string; title: string; status: string; confirmed: boolean; error: string | null; facts: Record<string, unknown> | null; cutouts: { angle: string; url: string }[]; details: { kind: string; url: string }[] } | null)[];
  finalEstimate: number | null;
  testClipEstimate: number | null;
  missingShots: number[];
  posts?: { id: string; created_at: string }[];
  scriptText: string | null;
  scriptVersions: string[];
  music: { track: string | null; libraryCount: number };
  notice: string | null;
};

/** Batches finish while you're away: a desktop alert + sound says when (Settings › Alerts, owner 2026-11-15). */
/**
 * "What they say" (owner, 2026-11-15): see the words, change them by hand, or tap Rewrite for another version that
 * reads the product, every shot and the person. Earlier versions can be brought back.
 */
function ScriptBox({ text, versions, final, busy, act }: { text: string; versions: string[]; final: boolean; busy: string | null; act: (json: Record<string, unknown>, label: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? text;
  const changed = draft != null && draft.trim() !== text.trim();
  const words = value.trim() ? value.trim().split(/\s+/).length : 0;
  return (
    <section className={`${card} mb-6`}>
      <h2 className={`${head} mb-1 text-xl`}>What they say</h2>
      <p className={`mb-2 text-xs ${muted}`}>
        Change anything by hand, or tap Rewrite for a new version written from the product, every shot and the person. {final ? "Then tap Film it again to film the new words." : "Make the video films exactly these words."}
      </p>
      <textarea className={`${input} min-h-28 py-2`} value={value} onChange={(e) => setDraft(e.target.value)} />
      <p className={`mt-1 text-xs ${muted}`}>{words} words · about {Math.max(1, Math.round(words / 2.6))} seconds</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button className={btnPrimary} disabled={!!busy || !changed} onClick={() => act({ action: "script_save", text: value }, "script").then((ok) => ok && setDraft(null))}>
          {busy === "script" ? "…" : "Save my words"}
        </button>
        <button className={btn} disabled={!!busy} onClick={() => act({ action: "script_rewrite" }, "rewrite").then((ok) => ok && setDraft(null))}>
          {busy === "rewrite" ? "Writing another version…" : "Rewrite — another version"}
        </button>
        {changed ? <button className={btn} onClick={() => setDraft(null)}>Undo my changes</button> : null}
      </div>
      {versions.length > 1 ? (
        <details className="mt-3">
          <summary className={`cursor-pointer text-sm ${muted}`}>Earlier versions ({versions.length - 1})</summary>
          <div className="mt-2 space-y-2">
            {[...versions].reverse().filter((v) => v.trim() !== text.trim()).map((v, i) => (
              <div key={i} className="flex items-start gap-2 border-t border-white/5 pt-2">
                <p className="flex-1 text-sm">{v}</p>
                <button className={btn} disabled={!!busy} onClick={() => act({ action: "script_save", text: v }, "script")}>Use this</button>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}

function DesktopAlertsHint() {
  const show = useSyncExternalStore(
    () => () => undefined,
    () => {
      try {
        return typeof Notification !== "undefined" && Notification.permission !== "granted";
      } catch {
        return false;
      }
    },
    () => false,
  );
  if (!show) return null;
  return (
    <p className="mb-3 border-l-2 border-sky-300 bg-sky-300/10 px-3 py-2 text-sm text-sky-100">
      Pictures are made in the half-price batch and arrive later. <Link className="underline" href="/settings/alerts">Turn on desktop alerts</Link> on this computer to get a notification with a sound when they&rsquo;re ready.
    </p>
  );
}

function ProjectView({ id }: { id: string }) {
  const router = useRouter();
  const { data, error, mutate } = useSWR<View>(`/api/creative/projects/${id}`, fetcher, {
    refreshInterval: (d) => (d && (d.jobs.some((j) => ["queued", "running", "waiting"].includes(j.status)) || d.rendersRunning > 0) ? 4000 : 0),
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [say, setSay] = useState("");
  const [caption, setCaption] = useState<string | null>(null);
  const [posted, setPosted] = useState<string | null>(null);
  /** Returns true when it worked (the "What they say" box keeps the owner's text when a save fails). */
  const act = async (json: Record<string, unknown>, label: string): Promise<boolean> => {
    setBusy(label);
    setErr(null);
    try {
      const r = await api<{ note?: string; reply?: string }>(`/api/creative/projects/${id}`, { method: "POST", json });
      if (json.action === "post") setPosted(r.note ?? "Added to Social → Calendar.");
      if (json.action === "delete") {
        router.push("/creative/library");
        return true;
      }
      await mutate();
      return true;
    } catch (e) {
      setErr((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  };
  if (error) return <ErrorLine error={(error as Error).message} />;
  if (!data) return <p className={muted}>Loading…</p>;
  const p = data.project;
  const live = data.jobs.filter((j) => ["queued", "running", "waiting"].includes(j.status));
  // Only the NEWEST job can be "the one that stopped" — an old failure from an earlier step is history, not a button.
  const failedJob = !live.length && data.jobs[0] && ["failed", "paused"].includes(data.jobs[0].status) ? data.jobs[0] : null;
  const concept = p.concept_idx != null ? p.concepts?.[p.concept_idx] : null;
  const finals = data.renders.filter((r) => !r.draft);
  const drafts = data.renders.filter((r) => r.draft);
  const isMotion = p.kind === "video" || p.kind === "ugc";
  // Video / UGC have no preview: before Make the video only an earlier FINAL exists — shown as "Previous take".
  const showRenders = p.status === "final" ? (finals.length ? finals : data.renders) : isMotion ? [] : drafts.length ? drafts : data.renders;
  const previous = isMotion && p.status !== "final" ? finals.find((r) => r.kind === "video") ?? null : null;
  const latestBySize = new Map<string, View["renders"][number]>();
  const slides: View["renders"] = [];
  // showRenders comes newest-first from the API: the first one per size is the latest (owner, 2026-11-15: the page
  // kept showing the OLDEST final — the list was reversed twice).
  for (const r of showRenders) {
    if (r.kind === "video" && !latestBySize.has(r.size ?? "")) latestBySize.set(r.size ?? "", r);
    if (r.kind === "image") slides.push(r);
  }
  const slideMap = new Map<string, View["renders"][number]>();
  for (const s of slides) if (!slideMap.has(`${s.size}-${s.shotIdx}`)) slideMap.set(`${s.size}-${s.shotIdx}`, s);
  const testRunning = live.some((j) => j.kind === "project_test_clip");
  const regenerating = p.status === "brief" || live.some((j) => j.kind === "project_concepts");
  const captions = p.captions?.options ?? [];
  const hashtags = p.captions?.hashtags ?? [];
  const cap = caption ?? captions[0] ?? "";

  return (
    <>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className={`text-xs uppercase tracking-widest ${muted}`}>{KIND_LABEL[p.kind]}{p.role ? ` · ${p.role}` : ""} · {statusLabel(p.kind, p.status)} · spent {money(data.spend)}</p>
          <h1 className={`${head} text-3xl md:text-4xl`}>{p.title || concept?.title || "New creative"}</h1>
        </div>
        <div className="flex gap-2">
          <Link href="/creative/create" className={btn}>New</Link>
          <button className={btnDanger} disabled={!!busy} onClick={() => confirm("Delete this creative?") && void act({ action: "delete" }, "delete")}>Delete</button>
        </div>
      </div>
      {data.notice ? <p className="mb-3 border-l-2 border-amber-300 bg-amber-300/10 px-3 py-2 text-sm text-amber-100">{data.notice}</p> : null}
      <DesktopAlertsHint />
      <ErrorLine error={err} />
      {p.step_note ? <p className="mb-3 border-l-2 border-amber-300 px-3 py-2 text-sm text-amber-100">{p.step_note}</p> : null}
      {live.length ? <div className={`${card} mb-4`}>{live.map((j) => <JobLine key={j.id} job={j} />)}</div> : null}
      {failedJob ? (
        <div className={`${card} mb-4 border-red-500/30`}>
          <JobLine job={failedJob} />
          <button className={`${btn} mt-2`} disabled={!!busy} onClick={() => act({ action: "retry" }, "retry")}>Try again</button>
        </div>
      ) : null}

      {/* Product twins */}
      {data.twins.some((t) => t && !t.confirmed) ? (
        <section className="mb-6">
          <h2 className={`${head} mb-2 text-xl`}>Check the product</h2>
          {data.twins.map((t) =>
            t ? (
              <TwinCard
                key={t.productId}
                twin={t}
                onConfirm={async () => {
                  setErr(null);
                  try {
                    await api("/api/creative/products", { method: "POST", json: { productId: t.productId, action: "confirm" } });
                    await mutate();
                  } catch (e) {
                    setErr((e as Error).message);
                  }
                }}
                onUploaded={() => mutate()}
              />
            ) : null,
          )}
        </section>
      ) : null}

      {/* Concepts */}
      {p.concepts?.length && (p.status === "concepts" || p.status === "brief") ? (
        <section className={`mb-6 ${regenerating ? "opacity-50" : ""}`}>
          <h2 className={`${head} mb-2 text-2xl`}>{regenerating ? "New concepts on the way…" : "Pick 1 of 3"}</h2>
          <div className="grid gap-3 md:grid-cols-3">
            {p.concepts.map((c, i) => (
              <div key={i} className={`${card} flex flex-col gap-2`}>
                {c.storyboard.some((f) => f.thumbUrl) ? <div className="grid grid-cols-4 gap-1">{c.storyboard.slice(0, 4).map((f, j) => <Media key={j} url={f.thumbUrl} className="aspect-[9/16] w-full" alt={f.shot} />)}</div> : null}
                <h3 className={`${head} text-xl`}>{c.title}</h3>
                <p className="text-sm">{c.idea}</p>
                <p className="text-sm"><span className="font-bold">Hook (0–1.5 s):</span> {c.hook.first_1_5s}{c.hook.text ? <span className="ml-1 bg-white px-1 text-black">{c.hook.text}</span> : null}</p>
                <p className={`text-xs ${muted}`}>Why it stops the scroll: {c.hook.why}</p>
                {c.look?.location && <p className={`text-xs ${muted}`}>Look: {c.look.location} · {c.look.light} · {c.look.palette}</p>}
                <p className={`text-xs ${muted}`}>{c.edit_recipe}</p>
                <p className={`text-xs ${muted}`}>{c.music.mood} · {c.music.bpm} BPM · {c.length_s ? `${c.length_s}s` : "slides"} · {c.format}</p>
                <ol className={`list-decimal pl-4 text-xs ${muted}`}>{c.storyboard.map((f, j) => <li key={j}>{f.shot}{f.text ? ` — “${f.text}”` : ""}</li>)}</ol>
                <button className={`${btnPrimary} mt-auto`} disabled={!!busy || regenerating || data.twins.some((t) => t && !t.confirmed && t.cutouts.length)} onClick={() => act({ action: "pick", concept: i }, "pick")}>
                  {busy === "pick" ? "…" : "This one"}
                </button>
              </div>
            ))}
          </div>
          {data.twins.some((t) => t && !t.confirmed && t.cutouts.length) ? <p className="mt-2 text-sm text-amber-200">Confirm the product cut-outs ✓ above first.</p> : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <button className={btn} disabled={!!busy} onClick={() => act({ action: "concepts", modifier: "crazier" }, "c")}>Crazier</button>
            <button className={btn} disabled={!!busy} onClick={() => act({ action: "concepts", modifier: "luxury" }, "c")}>More luxury</button>
            <button className={btn} disabled={!!busy} onClick={() => act({ action: "concepts", modifier: "new" }, "c")}>New ideas</button>
            <Link className={btn} href="/creative/radar">Start a new one from a Radar ad</Link>
          </div>
        </section>
      ) : null}

      {/* Draft / final */}
      {latestBySize.size || slideMap.size || previous || (p.status === "draft" && isMotion) ? (
        <section className="mb-6">
          <h2 className={`${head} mb-2 text-2xl`}>{p.status === "final" ? "Final" : isMotion && !latestBySize.size ? "Shots ready — make the video" : "Draft"}</h2>
          <div className="flex flex-wrap gap-3">
            {[...latestBySize.values(), ...(previous ? [previous] : [])].map((r) => (
              <div key={r.id} className="w-full max-w-[360px]">
                <video src={r.url} poster={r.poster ?? undefined} controls playsInline className={`w-full bg-black ${ASPECT[r.size ?? "9:16"] ?? "aspect-[9/16]"}`} />
                <p className={`mt-1 text-xs ${muted}`}>
                  {r === previous ? "Previous take" : `${r.size} · ${r.draft ? "preview (free)" : "final"}`} · <a className="underline" href={`${r.url}&download=${fileName(p.title || concept?.title, r.size, "mp4")}`}>Download</a>
                </p>
              </div>
            ))}
          </div>
          {slideMap.size ? (
            <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4">
              {[...slideMap.values()].map((r) => (
                <a key={r.id} href={r.url} target="_blank" rel="noreferrer" className="block">
                  <Media url={r.url} className={`w-full ${ASPECT[r.size ?? "4:5"] ?? "aspect-[4/5]"}`} />
                  <p className={`text-xs ${muted}`}>{r.size}</p>
                </a>
              ))}
            </div>
          ) : null}
          {p.status === "final" && p.kind === "ugc" ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button className={btn} disabled={!!busy} onClick={() => confirm("Film this UGC again? The same pictures and words, a new take (the video costs again).") && act({ action: "refilm" }, "refilm")}>
                {busy === "refilm" ? "…" : "Film it again"}
              </button>
              <p className={`text-xs ${muted}`}>A new take with the same pictures and words — e.g. for a more natural voice.</p>
            </div>
          ) : null}
          {p.status === "draft" && data.missingShots.length ? (
            <div className="mt-4 border-l-2 border-amber-300 bg-amber-300/10 px-3 py-2 text-sm text-amber-100">
              Shot{data.missingShots.length > 1 ? "s" : ""} {data.missingShots.join(", ")} {data.missingShots.length > 1 ? "are" : "is"} missing — the video would jump there.
              <button className={`${btn} ml-3`} disabled={!!busy} onClick={() => act({ action: "redraw_missing" }, "redraw")}>{busy === "redraw" ? "…" : "Redraw missing shots"}</button>
            </div>
          ) : null}
          {p.status === "draft" ? (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button className={`${btnPrimary} min-h-12 px-8 text-base`} disabled={!!busy || testRunning} onClick={() => act({ action: "approve" }, "approve")}>
                {busy === "approve" ? "…" : isMotion ? `Make the video${data.finalEstimate ? ` ≈ ${money(data.finalEstimate)}` : ""}` : "Approve"}
              </button>
              {isMotion && data.testClipEstimate && !data.clips.length ? (
                <button className={`${btn} min-h-12`} disabled={!!busy || testRunning} onClick={() => act({ action: "test_clip" }, "test")}>
                  {busy === "test" ? "…" : testRunning ? "Test clip on the way…" : `Test one clip first ≈ ${money(data.testClipEstimate)}`}
                </button>
              ) : null}
              <button className={chip(p.feedback === "down")} disabled={!!busy || p.feedback === "down"} onClick={() => void act({ action: "feedback", verdict: "down" }, "fb")}>{p.feedback === "down" ? "👎 Noted" : "👎 Not for me"}</button>
              <p className={`w-full text-xs ${muted}`}>
                {!isMotion
                  ? "Approve marks it final."
                  : data.testClipEstimate
                    ? "Make the video turns every shot into a real moving clip (Kling), checks each one, then cuts them together with music, text and effects. The test makes only the first shot so you can see it move first — it is kept, not paid twice."
                    : p.kind === "ugc"
                      ? `Make the video films it as ONE continuous phone take on Kling 4.0 — the shots above are its keyframes, ${data.cast[0]?.name ?? "the creator"} says every line in one consistent voice — then adds music and the CARBON ending.`
                      : "Make the video turns every shot into a real moving clip (Kling), checks each one, then cuts them together with music, text and effects."}
              </p>
            </div>
          ) : null}
          {data.music.libraryCount === 0 && (p.kind === "video" || p.kind === "ugc" || p.kind === "animated") ? (
            <p className="mt-2 text-xs text-amber-200">No music in the library yet — {p.kind === "ugc" ? "no background music under the voice" : "videos come out silent"}. <Link className="underline" href="/creative/settings?tab=music">Add tracks</Link>.</p>
          ) : data.music.track ? (
            <p className={`mt-2 text-xs ${muted}`}>Music: {data.music.track}</p>
          ) : null}
        </section>
      ) : null}

      {/* What they say (UGC) */}
      {p.kind === "ugc" && data.scriptText != null && p.shot_list && !["approved", "clips"].includes(p.status) ? (
        <ScriptBox key={data.scriptText} text={data.scriptText} versions={data.scriptVersions} final={p.status === "final"} busy={busy} act={act} />
      ) : null}

      {/* Stills (critic-passed only) */}
      {data.stills.length ? (
        <section className="mb-6">
          <h2 className={`${head} mb-2 text-xl`}>Shots <span className={`text-sm ${muted}`}>passed the quality check{data.attempts.rejected ? ` · ${data.attempts.rejected} rejected tries hidden` : ""}</span></h2>
          <div className="flex gap-2 overflow-x-auto pb-2">
            {(p.shot_list?.shots ?? []).filter((s) => !s.is_end_card).map((s) => {
              const st = [...data.stills].reverse().find((x) => x.shotIdx === s.idx);
              const clip = [...data.clips].reverse().find((x) => x.shotIdx === s.idx);
              return (
                <div key={s.idx} className="w-36 shrink-0 md:w-44">
                  {clip ? <Media url={clip.url} video className="aspect-[9/16] w-full" /> : <Media url={st?.url} className="aspect-[2/3] w-full" />}
                  <p className="mt-1 line-clamp-2 text-xs">{s.idx + 1}. {s.subject_action}</p>
                  <p className={`text-[11px] ${muted}`}>{s.camera_move.replace(/_/g, " ")} · {s.lens} · {s.duration_s}s</p>
                  {st?.critic ? <p className="text-[11px] text-emerald-300">{st.critic.overall}/10</p> : null}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {/* Captions + post */}
      {p.status === "final" ? (
        <section className={`${card} mb-6`}>
          <h2 className={`${head} mb-2 text-xl`}>Post</h2>
          <div className="flex flex-wrap gap-2">{captions.map((c, i) => <button key={i} className={chip(cap === c)} onClick={() => setCaption(c)}>Caption {i + 1}</button>)}</div>
          <textarea className={`${input} mt-2 min-h-28 py-2`} value={cap} onChange={(e) => setCaption(e.target.value)} />
          <p className={`mt-1 text-xs ${muted}`}>{hashtags.map((h) => `#${h}`).join(" ")}</p>
          {!posted && data.posts?.length ? <p className="mt-2 text-sm text-emerald-200">Already in Social → Calendar ({data.posts.length}×). <Link className="underline" href="/marketing/calendar">Open Calendar</Link></p> : null}
          {posted ? (
            <p className="mt-2 text-sm text-emerald-200">{posted} <Link className="underline" href="/marketing/calendar">Open Calendar</Link></p>
          ) : (
            <button className={`${btnPrimary} mt-3`} disabled={!!busy || !cap.trim()} onClick={() => act({ action: "post", caption: cap, hashtags, useBestTime: true }, "post")}>
              {busy === "post" ? "…" : data.posts?.length ? "Post again at the best time" : "Post at the best time"}
            </button>
          )}
          <p className={`mt-1 text-xs ${muted}`}>Goes to Social → Calendar as a draft for your approval there (Instagram + Facebook).</p>
        </section>
      ) : null}

      {/* Chat */}
      {p.shot_list || p.kind === "animated" ? (
        <section className={`${card} mb-6`}>
          <h2 className={`${head} mb-2 text-xl`}>Change it</h2>
          <div className="max-h-64 space-y-1 overflow-y-auto">
            {data.chat.map((m, i) => (
              <p key={i} className={`text-sm ${m.role === "owner" ? "text-white" : "text-white/60"}`}>{m.role === "owner" ? "You: " : "→ "}{m.text}</p>
            ))}
          </div>
          <form
            className="mt-2 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!say.trim()) return;
              const t = say;
              setSay("");
              void act({ action: "chat", text: t }, "chat");
            }}
          >
            <input className={input} value={say} onChange={(e) => setSay(e.target.value)} placeholder="faster cuts · swap the model · more luxury · bigger price text" enterKeyHint="send" />
            <button className={btnPrimary} disabled={!!busy || !say.trim()}>{busy === "chat" ? "…" : "Send"}</button>
          </form>
        </section>
      ) : null}

      {concept ? (
        <details className={`${card} mb-6`}>
          <summary className="cursor-pointer text-sm">The concept and shot list</summary>
          <p className="mt-2 text-sm">{concept.idea}</p>
          <ol className="mt-2 space-y-1 text-xs">{(p.shot_list?.shots ?? []).map((s) => <li key={s.idx}>{s.idx + 1}. {s.subject_action} — {s.camera_move.replace(/_/g, " ")}, {s.lens}, {s.lighting}, {s.location}, {s.duration_s}s. Must show: {s.garment_must_show}{s.text_overlay ? ` · text “${s.text_overlay}”` : ""}</li>)}</ol>
        </details>
      ) : null}
    </>
  );
}

function TwinCard({ twin, onConfirm, onUploaded }: { twin: NonNullable<View["twins"][number]>; onConfirm: () => void; onUploaded: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  async function upload(angle: string, f: File) {
    const fd = new FormData();
    fd.set("kind", "twin");
    fd.set("productId", twin.productId);
    fd.set("angle", angle);
    fd.set("file", f);
    try {
      await api("/api/creative/upload", { method: "POST", body: fd });
      onUploaded();
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  return (
    <div className={`${card} mb-2`}>
      <p className="font-semibold">{twin.title} <span className={`text-xs ${muted}`}>{TWIN_STATUS[twin.status] ?? twin.status}</span></p>
      {twin.error ? <p className="text-sm text-amber-200">{twin.error}</p> : null}
      <ErrorLine error={err} />
      <div className="mt-2 flex gap-2 overflow-x-auto">
        {twin.cutouts.map((c) => (
          <div key={c.angle} className="w-28 shrink-0">
            <Media url={c.url} fit="contain" className="aspect-[2/3] w-full !bg-white" />
            <label className={`mt-1 block cursor-pointer text-center text-[11px] ${muted} underline`}>
              {c.angle} · replace
              <input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.currentTarget.value = ""; if (f) void upload(c.angle, f); }} />
            </label>
          </div>
        ))}
        {twin.details.slice(0, 4).map((d, i) => (
          <div key={i} className="w-20 shrink-0"><Media url={d.url} className="aspect-square w-full" /><p className={`text-[10px] ${muted}`}>{d.kind}</p></div>
        ))}
        {!twin.cutouts.length ? (
          <label className={`${btn} cursor-pointer`}>
            Upload a flat-lay / hanger photo
            <input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.currentTarget.value = ""; if (f) void upload("front", f); }} />
          </label>
        ) : null}
      </div>
      {twin.facts ? <p className={`mt-2 text-xs ${muted}`}>Facts the copy may use: {[twin.facts.fabric, twin.facts.fit, ...((twin.facts.seenInPhotos as string[]) ?? []).slice(0, 4)].filter(Boolean).join(" · ") || "—"}</p> : null}
      {twin.cutouts.length && twin.status === "ready" ? <button className={`${btnPrimary} mt-2`} onClick={onConfirm}>✓ Looks right</button> : null}
      <p className={`mt-1 text-xs ${muted}`}>The Shopify model never appears in any ad — only these garment cut-outs.</p>
    </div>
  );
}
