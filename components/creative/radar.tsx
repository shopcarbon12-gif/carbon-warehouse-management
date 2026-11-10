"use client";

/**
 * Creative → Radar (spec §4–5): winning clothing + shoe ads. Private research — other brands'
 * ads are inspiration for STRUCTURE only, never re-published.
 */
import Link from "next/link";
import { useMemo, useState } from "react";
import useSWR from "swr";
import { api, btn, btnPrimary, card, chip, CreativeShell, ErrorLine, fetcher, head, input, Media, muted } from "./ui";

type Card = {
  id: string; advertiser: string; headline: string; mediaType: string; thumb: string | null; video: string | null; w: number | null; h: number | null;
  platforms: string[]; sources: string[]; variations: number; daysRunning: number | null; isActive: boolean | null; winnerScore: number | null; patterns: string[];
  lane: string | null; hook: string | null; status: string; rejectReason: string | null; bookmarked: boolean; purged: boolean;
};
type Stats = { discovered: number; new: number; kept: number; review: number; rejected: number; tabs: Record<string, number>; rejectReasons: { reason: string; n: number }[]; categories: { cat: string; n: number }[]; brands: Record<string, number>; season: { key: string; label: string }; scoreExplained: string };

const PAT = (p: string) => p.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
const LANES = ["streetwear", "luxury", "evening_going_out", "denim", "basics_minimal", "athleisure", "workwear_utility", "y2k", "western"];
const PLATFORMS = ["facebook", "instagram", "tiktok", "youtube", "google", "snapchat", "pinterest", "manual"];
const SOURCES = ["meta_library", "meta_api", "tiktok_top", "tiktok_dsa", "google_atc", "snap", "pinterest", "manual"];
const SEASONS = ["bfcm", "holiday", "nye", "valentines", "spring_break", "summer", "back_to_school", "prom", "festival", "evergreen"];

type F = { tab: string; q: string; sort: string; category: string; media: string[]; patterns: string[]; lanes: string[]; genders: string[]; platforms: string[]; sources: string[]; seasons: string[]; daysMin: string; daysMax: string; hasOffer: boolean; aspect: string; status: string };
const EMPTY: F = { tab: "all", q: "", sort: "fresh", category: "", media: [], patterns: [], lanes: [], genders: [], platforms: [], sources: [], seasons: [], daysMin: "", daysMax: "", hasOffer: false, aspect: "", status: "kept" };

function qs(f: F) {
  const u = new URLSearchParams();
  if (f.tab !== "all") u.set("tab", f.tab);
  if (f.q) u.set("q", f.q);
  u.set("sort", f.sort);
  if (f.category) u.set("category", f.category);
  for (const [k, v] of [["media", f.media], ["patterns", f.patterns], ["lanes", f.lanes], ["genders", f.genders], ["platforms", f.platforms], ["sources", f.sources], ["seasons", f.seasons]] as const) if (v.length) u.set(k, v.join(","));
  if (f.daysMin) u.set("daysMin", f.daysMin);
  if (f.daysMax) u.set("daysMax", f.daysMax);
  if (f.hasOffer) u.set("hasOffer", "1");
  if (f.aspect) u.set("aspect", f.aspect);
  u.set("status", f.status);
  return u.toString();
}

export function CreativeRadar() {
  const [f, setF] = useState<F>(EMPTY);
  const [drawer, setDrawer] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [view, setView] = useState<"library" | "review" | "brands" | "sources">("library");
  const { data: stats, mutate: ms } = useSWR<Stats>("/api/creative/radar?view=stats", fetcher, { refreshInterval: 30000 });
  const { data: cols } = useSWR<{ collections: { pattern: string; active: number; total: number; thumbs: (string | null)[] }[] }>("/api/creative/radar?view=collections", fetcher);
  const key = `/api/creative/radar?${qs(view === "review" ? { ...f, status: "review" } : f)}`;
  const { data, error, mutate } = useSWR<{ ads: Card[]; total: number }>(view === "library" || view === "review" ? key : null, fetcher);
  const [err, setErr] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const set = (p: Partial<F>) => setF((x) => ({ ...x, ...p }));
  const tog = (k: "media" | "patterns" | "lanes" | "genders" | "platforms" | "sources" | "seasons", v: string) => setF((x) => ({ ...x, [k]: x[k].includes(v) ? x[k].filter((y) => y !== v) : [...x[k], v] }));
  const allPatterns = useMemo(() => (cols?.collections ?? []).map((c) => c.pattern), [cols]);

  async function post(json: Record<string, unknown>) {
    setErr(null);
    try {
      const r = await api<{ result?: string }>("/api/creative/radar", { method: "POST", json });
      await Promise.all([mutate(), ms()]);
      return r;
    } catch (e) {
      setErr((e as Error).message);
      return null;
    }
  }

  return (
    <CreativeShell wide>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className={`${head} text-4xl md:text-5xl`}>Radar</h1>
          <p className={`text-sm ${muted}`}>
            {stats ? `${stats.kept} kept · ${stats.review} to review · ${stats.rejected} rejected · ${stats.new} waiting for tagging — of ${stats.discovered} found` : "—"} · clothing & shoes only
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {(["library", "review", "brands", "sources"] as const).map((v) => (
            <button key={v} className={chip(view === v)} onClick={() => setView(v)}>{v === "review" ? `Review${stats?.review ? ` (${stats.review})` : ""}` : v === "brands" ? `Brands${stats?.brands?.pending ? ` (${stats.brands.pending} new)` : ""}` : v}</button>
          ))}
        </div>
      </div>
      <ErrorLine error={err ?? (error as Error | undefined)?.message} />

      {view === "brands" ? <Brands onErr={setErr} /> : view === "sources" ? <Sources onRefresh={() => post({ action: "refresh" })} onTag={() => post({ action: "tag_now" })} /> : (
        <>
          {view === "library" && cols?.collections.length ? (
            <div className="-mx-3 mb-4 flex gap-2 overflow-x-auto px-3 pb-1 md:-mx-6 md:px-6">
              {cols.collections.map((c) => (
                <button key={c.pattern} onClick={() => set({ patterns: [c.pattern] })} className="w-56 shrink-0 border border-white/10 bg-[#0d0d0d] text-left hover:border-white/40">
                  <div className="grid grid-cols-4 gap-px">{[0, 1, 2, 3].map((i) => <Media key={i} url={c.thumbs[i]} className="aspect-[3/4] w-full" />)}</div>
                  <div className="p-2">
                    <p className="text-sm font-semibold">{PAT(c.pattern)}</p>
                    <p className={`text-xs ${muted}`}>{c.active} active ads · See ads →</p>
                  </div>
                </button>
              ))}
            </div>
          ) : null}

          <div className="mb-3 flex flex-wrap items-center gap-2">
            {(["all", "static", "video", "ugc", "animated", "bookmarks"] as const).map((t) => (
              <button key={t} className={chip(f.tab === t)} onClick={() => set({ tab: t })}>{t === "ugc" ? "UGC" : t}{t !== "all" && t !== "bookmarks" && stats?.tabs?.[t] ? ` ${stats.tabs[t]}` : ""}</button>
            ))}
            {stats?.season && stats.season.key !== "evergreen" ? <button className={chip(f.seasons.includes(stats.season.key))} onClick={() => tog("seasons", stats.season.key)}>{stats.season.label}</button> : null}
            <select className={`${input} !min-h-9 w-auto`} value={f.category} onChange={(e) => set({ category: e.target.value })}>
              <option value="">All categories</option>
              {(stats?.categories ?? []).map((c) => <option key={c.cat} value={c.cat}>{c.cat} ({c.n})</option>)}
            </select>
            <input className={`${input} !min-h-9 w-full md:w-64`} placeholder="Search brand, hook, transcript, tags" value={f.q} onChange={(e) => set({ q: e.target.value })} />
            <button className={btn} onClick={() => setDrawer(true)}>Filters{Object.entries(f).filter(([k, v]) => !["tab", "q", "sort", "status", "category"].includes(k) && (Array.isArray(v) ? v.length : v)).length ? " •" : ""}</button>
            <select className={`${input} !min-h-9 w-auto`} value={f.sort} onChange={(e) => set({ sort: e.target.value })}>
              <option value="fresh">Fresh picks for you</option>
              <option value="recommended">Recommended</option>
              <option value="newest">Newest</option>
              <option value="longest">Longest running</option>
            </select>
            <span className={`text-xs ${muted}`} title={stats?.scoreExplained}>{data ? `${data.total} ads` : ""} · score = public activity, not sales ⓘ</span>
          </div>

          {view === "library" ? (
            <form className="mb-3 flex gap-2" onSubmit={async (e) => { e.preventDefault(); if (!url) return; const r = await post({ action: "import", url }); if (r) setUrl(""); }}>
              <input className={input} placeholder="Paste an ad link to import it (Instagram, TikTok, Facebook, a video file…)" value={url} onChange={(e) => setUrl(e.target.value)} />
              <button className={btn}>Import</button>
            </form>
          ) : null}

          {data && !data.ads.length ? (
            <div className={`${card} text-sm`}>
              {view === "review" ? "Nothing to review." : stats?.discovered ? "No ads match these filters." : "Radar is empty. Collection runs nightly at 3 AM — or "}
              {!stats?.discovered && view === "library" ? <button className="underline" onClick={() => post({ action: "refresh" })}>start it now</button> : null}
            </div>
          ) : null}
          <div className="columns-2 gap-2 md:columns-4 xl:columns-5">
            {(data?.ads ?? []).map((a) => (
              <div key={a.id} className="mb-2 break-inside-avoid border border-white/10 bg-[#0d0d0d]">
                <button className="block w-full text-left" onClick={() => setOpen(a.id)}>
                  <Media url={a.video ?? a.thumb} video={Boolean(a.video)} poster={a.thumb} className={`w-full ${a.w && a.h ? "" : "aspect-[4/5]"}`} />
                </button>
                <div className="p-2">
                  <div className="flex items-start justify-between gap-1">
                    <p className="truncate text-sm font-semibold">{a.advertiser}</p>
                    <button aria-label="Bookmark" className="min-h-9 min-w-9 text-lg" onClick={() => post({ action: "bookmark", adId: a.id, on: !a.bookmarked })}>{a.bookmarked ? "★" : "☆"}</button>
                  </div>
                  <p className={`text-xs ${muted}`}>{a.daysRunning != null ? `${a.daysRunning}d running` : "—"} · {a.variations} var · {a.platforms.join(", ") || "—"}{a.isActive ? " · active" : ""}</p>
                  <p className="mt-1 text-xs">{a.winnerScore != null ? <span className="bg-white px-1 font-bold text-black">{a.winnerScore}</span> : "—"} {a.patterns.slice(0, 2).map(PAT).join(" · ")}</p>
                  {view === "review" ? (
                    <div className="mt-2 flex gap-1">
                      <p className={`mb-1 text-[11px] ${muted}`}>{a.rejectReason}</p>
                      <button className={btn} onClick={() => post({ action: "review", adId: a.id, status: "kept" })}>Keep</button>
                      <button className={btn} onClick={() => post({ action: "review", adId: a.id, status: "rejected" })}>Reject</button>
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {drawer ? (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/70" onClick={() => setDrawer(false)}>
          <div className="h-full w-full max-w-md overflow-y-auto overscroll-contain border-l border-white/10 bg-[#0a0a0a] p-4 pb-[env(safe-area-inset-bottom)]" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between"><h2 className={`${head} text-2xl`}>Filters</h2><button className={btn} onClick={() => setDrawer(false)}>Done</button></div>
            {([
              ["Media type", "media", ["static", "carousel", "video", "ugc", "animated"]],
              ["Patterns", "patterns", allPatterns],
              ["Style lane", "lanes", LANES],
              ["Gender", "genders", ["men", "women", "unisex", "mixed"]],
              ["Platform", "platforms", PLATFORMS],
              ["Source", "sources", SOURCES],
              ["Season", "seasons", SEASONS],
            ] as const).map(([label, k, opts]) => (
              <div key={k} className="mb-3">
                <p className={`mb-1 text-xs uppercase tracking-widest ${muted}`}>{label}</p>
                <div className="flex flex-wrap gap-1">{opts.map((o) => <button key={o} className={chip(f[k].includes(o))} onClick={() => tog(k, o)}>{PAT(o)}</button>)}</div>
              </div>
            ))}
            <p className={`mb-1 text-xs uppercase tracking-widest ${muted}`}>Days running</p>
            <div className="mb-3 flex gap-2">
              <input className={input} inputMode="numeric" pattern="[0-9]*" placeholder="from" value={f.daysMin} onChange={(e) => set({ daysMin: e.target.value.replace(/\D/g, "") })} />
              <input className={input} inputMode="numeric" pattern="[0-9]*" placeholder="to" value={f.daysMax} onChange={(e) => set({ daysMax: e.target.value.replace(/\D/g, "") })} />
            </div>
            <p className={`mb-1 text-xs uppercase tracking-widest ${muted}`}>Aspect</p>
            <div className="mb-3 flex gap-1">{["", "vertical", "square", "horizontal"].map((a) => <button key={a} className={chip(f.aspect === a)} onClick={() => set({ aspect: a })}>{a || "any"}</button>)}</div>
            <label className="mb-3 flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="h-5 w-5" checked={f.hasOffer} onChange={(e) => set({ hasOffer: e.target.checked })} /> Has an offer</label>
            <button className={btn} onClick={() => setF({ ...EMPTY, tab: f.tab })}>Clear all</button>
          </div>
        </div>
      ) : null}

      {open ? <Detail id={open} onClose={() => setOpen(null)} onOpen={setOpen} /> : null}
    </CreativeShell>
  );
}

type DetailT = {
  ad: Card & {
    body: string; cta: string | null; landingUrl: string | null; countries: string[]; firstSeen: string | null; lastSeen: string | null; metrics: Record<string, unknown>;
    tags: { hook_text?: string; structure_summary?: string; media_type?: string; creative_pattern?: string[]; style_lane?: string; gender?: string; season_event?: string; offer?: string | null; price_shown?: string | null; palette?: string[]; typography_style?: string; video?: { shot_list: { t: number; shot: string }[]; cut_rate: number | null; transitions: string[]; music: boolean | null; voiceover: boolean | null; captions: boolean | null } | null } | null;
    category: { product_category?: string; confidence?: number; decision?: string } | null;
    media: { kind: string; url: string | null; poster: string | null; duration: number | null }[];
    variationsList: { id: string; source: string; platform: string | null; sourceUrl: string | null; headline: string; firstSeen: string | null; isActive: boolean | null; thumb: string | null }[];
    scoreBreakdown: Record<string, number>;
    scoreExplained: string;
  };
  similar: (Card & { similarity: number })[];
};

function Detail({ id, onClose, onOpen }: { id: string; onClose: () => void; onOpen: (id: string) => void }) {
  const { data, error } = useSWR<DetailT>(`/api/creative/radar/${id}`, fetcher);
  const a = data?.ad;
  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/80 md:items-center md:p-6" onClick={onClose}>
      <div className="h-full w-full overflow-y-auto overscroll-contain bg-[#0a0a0a] p-4 md:h-auto md:max-h-[90vh] md:max-w-5xl md:border md:border-white/10" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className={`${head} truncate text-2xl`}>{a?.advertiser ?? "…"}</h2>
          <button className={btn} onClick={onClose}>Close</button>
        </div>
        <ErrorLine error={(error as Error | undefined)?.message} />
        {a ? (
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
            <div>
              {a.media.map((m, i) => (m.kind === "video" ? <video key={i} src={m.url ?? undefined} poster={m.poster ?? undefined} controls playsInline className="mb-2 w-full bg-black" /> : <Media key={i} url={m.url} className="mb-2 w-full" />))}
              {a.purged ? <p className={`text-xs ${muted}`}>Media removed after 180 days inactive (details kept).</p> : null}
              {a.variationsList.length > 1 ? (
                <div className="mt-2">
                  <p className={`mb-1 text-xs uppercase tracking-widest ${muted}`}>{a.variationsList.length} variations</p>
                  <div className="flex gap-1 overflow-x-auto">{a.variationsList.map((v) => <Media key={v.id} url={v.thumb} className="h-24 w-20 shrink-0" />)}</div>
                </div>
              ) : null}
            </div>
            <div className="space-y-3 text-sm">
              <Link href={`/creative/create?inspiration=${a.id}`} className={`${btnPrimary} min-h-12 w-full text-base`}>Make a CARBON version →</Link>
              <p className={`text-xs ${muted}`}>Uses this ad&rsquo;s structure only — never its brand, logo, text, people or pictures.</p>
              <div className={card}>
                <p><span className="bg-white px-1 font-bold text-black">{a.winnerScore ?? "—"}</span> winner score <span className={`text-xs ${muted}`}>(public activity, not sales)</span></p>
                <p className={`mt-1 text-xs ${muted}`}>days {a.scoreBreakdown.days} · variations {a.scoreBreakdown.variations} · platforms {a.scoreBreakdown.platforms} · active {a.scoreBreakdown.active}</p>
                <p className={`mt-1 text-xs ${muted}`}>{a.daysRunning ?? "—"} days running · first seen {a.firstSeen?.slice(0, 10) ?? "—"} · {a.platforms.join(", ") || "—"} · {a.countries.join(", ") || "—"}</p>
              </div>
              {a.tags ? (
                <div className={card}>
                  <p><b>Hook:</b> {a.tags.hook_text || "—"}</p>
                  <p className="mt-1"><b>Structure:</b> {a.tags.structure_summary || "—"}</p>
                  <p className={`mt-1 text-xs ${muted}`}>{[a.tags.media_type, a.tags.style_lane, a.tags.gender, a.tags.season_event, ...(a.tags.creative_pattern ?? []).map(PAT)].filter(Boolean).join(" · ")}</p>
                  <p className={`mt-1 text-xs ${muted}`}>Offer: {a.tags.offer ?? "—"} · price shown: {a.tags.price_shown ?? "—"} · CTA: {a.cta ?? "—"} · type: {a.tags.typography_style ?? "—"}</p>
                  {a.tags.palette?.length ? <div className="mt-1 flex gap-1">{a.tags.palette.map((c) => <span key={c} className="h-4 w-6 border border-white/20" style={{ background: c }} />)}</div> : null}
                  {a.tags.video ? (
                    <div className="mt-2">
                      <p className={`text-xs ${muted}`}>cut rate {a.tags.video.cut_rate ?? "—"}/s · transitions {a.tags.video.transitions.join(", ") || "—"} · music {String(a.tags.video.music ?? "—")} · VO {String(a.tags.video.voiceover ?? "—")} · captions {String(a.tags.video.captions ?? "—")}</p>
                      <ol className="mt-1 text-xs">{a.tags.video.shot_list.map((s, i) => <li key={i}>{s.t}s — {s.shot}</li>)}</ol>
                    </div>
                  ) : null}
                </div>
              ) : <p className={muted}>Not tagged yet (next tagging batch).</p>}
              {a.headline || a.body ? <div className={card}><p className="font-semibold">{a.headline}</p><p className={`mt-1 whitespace-pre-wrap text-xs ${muted}`}>{a.body}</p></div> : null}
              <p className={`text-xs ${muted}`}>Category: {a.category?.product_category ?? "—"} ({a.category?.confidence != null ? `${Math.round(a.category.confidence * 100)}%` : "—"}) {a.category?.decision ?? ""}</p>
              <div className="flex flex-wrap gap-2">
                {a.variationsList.filter((v) => v.sourceUrl).slice(0, 2).map((v) => <a key={v.id} className={btn} href={v.sourceUrl!} target="_blank" rel="noreferrer">Open in source ({v.source})</a>)}
                {a.landingUrl ? <a className={btn} href={a.landingUrl} target="_blank" rel="noreferrer">Landing page</a> : null}
              </div>
            </div>
          </div>
        ) : !error ? <p className={muted}>Loading…</p> : null}
        {data?.similar.length ? (
          <div className="mt-6">
            <h3 className={`${head} mb-2 text-xl`}>Similar ads</h3>
            <div className="flex gap-2 overflow-x-auto">{data.similar.map((s) => <button key={s.id} className="w-32 shrink-0 text-left" onClick={() => onOpen(s.id)}><Media url={s.thumb} className="aspect-[4/5] w-full" /><p className="truncate text-xs">{s.advertiser}</p></button>)}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

type Brand = { id: string; name: string; lane: string | null; status: string; prior: string; meta_page_ids: string[]; handles: { google?: string }; found_by: string | null; last_refreshed_at: string | null; kept: number };

function Brands({ onErr }: { onErr: (e: string | null) => void }) {
  const { data, mutate } = useSWR<{ brands: Brand[] }>("/api/creative/radar?view=brands", fetcher);
  const [name, setName] = useState("");
  const post = async (json: Record<string, unknown>) => {
    onErr(null);
    try {
      await api("/api/creative/radar", { method: "POST", json });
      await mutate();
    } catch (e) {
      onErr((e as Error).message);
    }
  };
  const pending = (data?.brands ?? []).filter((b) => b.status === "pending");
  const rest = (data?.brands ?? []).filter((b) => b.status !== "pending");
  return (
    <div>
      <form className="mb-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void post({ action: "brand_add", name: name.trim() }).then(() => setName("")); }}>
        <input className={input} placeholder="Add a clothing or shoe brand" value={name} onChange={(e) => setName(e.target.value)} />
        <button className={btn}>Add</button>
      </form>
      {pending.length ? (
        <div className={`${card} mb-4`}>
          <h3 className={`${head} mb-2 text-lg`}>New advertisers found by keyword — approve?</h3>
          {pending.map((b) => (
            <div key={b.id} className="flex flex-wrap items-center gap-2 border-t border-white/5 py-2 text-sm">
              <span className="flex-1">{b.name} <span className={`text-xs ${muted}`}>{b.found_by}</span></span>
              <button className={btn} onClick={() => post({ action: "brand_status", brandId: b.id, status: "active" })}>Approve</button>
              <button className={btn} onClick={() => post({ action: "brand_status", brandId: b.id, status: "rejected" })}>Reject</button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="divide-y divide-white/5 border border-white/10">
        {rest.map((b) => <BrandRow key={b.id} b={b} post={post} />)}
      </div>
    </div>
  );
}

function BrandRow({ b, post }: { b: Brand; post: (j: Record<string, unknown>) => Promise<void> }) {
  const [edit, setEdit] = useState(false);
  const [pages, setPages] = useState(b.meta_page_ids.join(","));
  const [google, setGoogle] = useState(b.handles?.google ?? "");
  return (
    <div className="p-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`flex-1 ${b.status !== "active" ? "text-white/40 line-through" : ""}`}>{b.name} <span className={`text-xs ${muted}`}>{b.lane ?? ""} · {b.kept} kept · {b.last_refreshed_at ? `refreshed ${b.last_refreshed_at.slice(0, 10)}` : "never refreshed"}</span></span>
        <button className={btn} onClick={() => post({ action: "refresh", brandId: b.id })}>Refresh this brand</button>
        <button className={btn} onClick={() => setEdit((x) => !x)}>Ids</button>
        <button className={btn} onClick={() => post({ action: "brand_status", brandId: b.id, status: b.status === "active" ? "disabled" : "active" })}>{b.status === "active" ? "Off" : "On"}</button>
      </div>
      {edit ? (
        <div className="mt-2 grid gap-2 md:grid-cols-3">
          <input className={input} placeholder="Meta page ids (comma)" value={pages} onChange={(e) => setPages(e.target.value)} />
          <input className={input} placeholder="Google advertiser id (AR…)" value={google} onChange={(e) => setGoogle(e.target.value)} />
          <button className={btn} onClick={() => post({ action: "brand_ids", brandId: b.id, metaPageIds: pages.split(",").map((x) => x.trim()).filter(Boolean), google: google.trim() || null })}>Save</button>
        </div>
      ) : null}
    </div>
  );
}

type Runs = { runs: { id: string; source: string; status: string; counts: Record<string, number>; rejections: string[]; error: string | null; started_at: string; brand: string | null }[]; totals: { source: string; runs: number; discovered: number; new: number; merged: number; failed: number }[]; sources: Record<string, { enabled: boolean; note: string }> };

function Sources({ onRefresh, onTag }: { onRefresh: () => void; onTag: () => void }) {
  const { data } = useSWR<Runs>("/api/creative/radar?view=runs", fetcher, { refreshInterval: 15000 });
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-2">
        <button className={btnPrimary} onClick={onRefresh}>Collect now (all brands)</button>
        <button className={btn} onClick={onTag}>Tag new ads now (Batch, half price)</button>
        <Link href="/creative/settings?tab=radar" className={btn}>Sources on / off</Link>
      </div>
      <div className="mb-4 overflow-x-auto">
        <table className="w-full min-w-[520px] text-left text-sm">
          <thead className={`text-xs uppercase ${muted}`}><tr><th className="py-1">Source</th><th>Runs</th><th>Found</th><th>New</th><th>Merged</th><th>Failed</th></tr></thead>
          <tbody>
            {(data?.totals ?? []).map((t) => <tr key={t.source} className="border-t border-white/5"><td className="py-1">{t.source}</td><td>{t.runs}</td><td>{t.discovered}</td><td>{t.new}</td><td>{t.merged}</td><td className={t.failed ? "text-red-300" : ""}>{t.failed}</td></tr>)}
          </tbody>
        </table>
        {!data?.totals.length ? <p className={`text-sm ${muted}`}>No runs yet.</p> : null}
      </div>
      <div className="space-y-1">
        {(data?.runs ?? []).slice(0, 80).map((r) => (
          <details key={r.id} className="border border-white/10 p-2 text-sm">
            <summary className="cursor-pointer">
              <span className={r.status === "failed" ? "text-red-300" : r.status === "running" ? "text-white" : "text-white/80"}>{r.source}</span> · {r.brand ?? "keyword"} · {r.started_at.slice(0, 16).replace("T", " ")} · found {r.counts.discovered ?? 0}, new {r.counts.new ?? 0}, merged {r.counts.merged ?? 0}, known {r.counts.seen ?? 0}, pre-rejected {r.counts.preRejected ?? 0}
            </summary>
            {r.error ? <p className="mt-1 text-xs text-red-300">{r.error}</p> : null}
            <ul className={`mt-1 text-xs ${muted}`}>{(r.rejections ?? []).map((x, i) => <li key={i}>{x}</li>)}</ul>
          </details>
        ))}
      </div>
    </div>
  );
}
