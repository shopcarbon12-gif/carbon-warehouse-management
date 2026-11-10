"use client";

/**
 * Creative → Settings (profile icon): the Brand Brain wizard (spec §3), models (§7.1), music + SFX,
 * locations, spend caps, Radar sources, and the engines table behind "⋯ More" (§12).
 */
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import useSWR from "swr";
import { api, btn, btnDanger, btnPrimary, card, chip, CreativeShell, ErrorLine, fetcher, head, input, Media, money, muted } from "./ui";

type Preset = { key: string; name: string; look: string; grade: { contrast: number; saturation: number; brightness: number; warmth: number; grain: number }; pacing: string; samples: string[]; sampleUrls: (string | null)[] };
type Model = { id: string; name: string; gender: string; refs: string[]; look: string | null; personality: string | null; voice: string | null; lanes: string[]; pinned: boolean; active: boolean; isRealPerson: boolean; consent: boolean; height: string | null; size: string | null };
type S = {
  settings: { caps: Record<"openai" | "fal", { daily: number; monthly: number }>; routing: Record<string, string[]>; sources: Record<string, { enabled: boolean }>; categoryOptions: { bags: boolean; hats: boolean; belts: boolean }; retentionDays: number; metaCountries: string[] };
  defaults: { routes: Record<string, { label: string; why: string; engines: string[] }>; engines: Record<string, { label: string; perSecond: { silent: number; audio: number } }>; sources: Record<string, { enabled: boolean; note: string }> };
  keys: Record<string, boolean>;
  brand: {
    presets: Preset[]; defaultPreset: string; voice: { description: string; samples: { text: string; verdict: "up" | "down" | null }[] }; dos: string[]; donts: string[];
    fonts: { headline: string; body: string; headlineFile?: string | null }; colors: Record<string, string>; editStyle: Record<string, unknown>; wizardDone: boolean; logoUrls: Record<string, string>;
  };
  models: Model[];
  voices: string[];
  audio: { id: string; kind: string; name: string; bpm: number | null; duration_s: number | null; moods: string[]; license: string; url: string; beats: { drop: number | null } | null }[];
  recipes: { key: string; name: string; idea: string; status: string; media_types: string[]; score: number | null }[];
  locations: { id: string; name: string; description: string; url: string | null; source: string }[];
  costs: { candidates: number; sheet: number };
};

const TABS = ["brand", "models", "music", "locations", "caps", "radar", "more"] as const;

export function CreativeSettings() {
  const sp = useSearchParams();
  const router = useRouter();
  const tab = (TABS as readonly string[]).includes(sp.get("tab") ?? "") ? (sp.get("tab") as (typeof TABS)[number]) : "brand";
  const { data, error, mutate } = useSWR<S>("/api/creative/settings", fetcher);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  async function run<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
    setBusy(label);
    setErr(null);
    try {
      const r = await fn();
      await mutate();
      return r;
    } catch (e) {
      setErr((e as Error).message);
      return null;
    } finally {
      setBusy(null);
    }
  }
  const put = (json: Record<string, unknown>) => run("save", () => api("/api/creative/settings", { method: "PUT", json }));
  const act = <T,>(json: Record<string, unknown>, label = String(json.action)) => run(label, () => api<T>("/api/creative/settings", { method: "POST", json }));
  const upload = (fd: FormData, label = "upload") => run(label, () => api("/api/creative/upload", { method: "POST", body: fd }));

  return (
    <CreativeShell>
      <h1 className={`${head} mb-3 text-4xl`}>Settings</h1>
      <div className="mb-4 flex gap-1 overflow-x-auto">
        {TABS.map((t) => <button key={t} className={chip(tab === t)} onClick={() => router.replace(`/creative/settings?tab=${t}`)}>{t === "more" ? "⋯ More" : t === "brand" ? "Brand Brain" : t}</button>)}
      </div>
      <ErrorLine error={err ?? (error as Error | undefined)?.message} />
      {!data ? <p className={muted}>Loading…</p> : tab === "brand" ? <BrandTab d={data} put={put} act={act} upload={upload} busy={busy} /> : tab === "models" ? <ModelsTab d={data} act={act} upload={upload} busy={busy} /> : tab === "music" ? <MusicTab d={data} act={act} upload={upload} busy={busy} /> : tab === "locations" ? <LocationsTab d={data} act={act} upload={upload} busy={busy} /> : tab === "caps" ? <CapsTab d={data} put={put} /> : tab === "radar" ? <RadarTab d={data} put={put} /> : <MoreTab d={data} put={put} act={act} busy={busy} />}
    </CreativeShell>
  );
}

type Fn = (json: Record<string, unknown>) => Promise<unknown>;
type Act = <T>(json: Record<string, unknown>, label?: string) => Promise<T | null>;
type Up = (fd: FormData, label?: string) => Promise<unknown>;

function BrandTab({ d, put, act, upload, busy }: { d: S; put: Fn; act: Act; upload: Up; busy: string | null }) {
  const b = d.brand;
  const [step, setStep] = useState(0);
  const [samples, setSamples] = useState(b.voice.samples);
  const [desc, setDesc] = useState(b.voice.description);
  const [dos, setDos] = useState(b.dos.join("\n"));
  const [donts, setDonts] = useState(b.donts.join("\n"));
  const [presets, setPresets] = useState(b.presets);
  const steps = ["Logo + fonts", "Looks", "Voice", "Do / Don't", "Edit style", "Done"];
  const file = (kind: string, extra: Record<string, string>) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const fd = new FormData();
    fd.set("kind", kind);
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    fd.set("file", f);
    void upload(fd, kind);
  };
  return (
    <div>
      <p className={`mb-3 text-sm ${muted}`}>{b.wizardDone ? "Set up ✓ — change anything below." : "One-time setup, about 10 minutes. Everything you make uses it automatically."}</p>
      <div className="mb-3 flex flex-wrap gap-1">{steps.map((s, i) => <button key={s} className={chip(step === i)} onClick={() => setStep(i)}>{i + 1}. {s}</button>)}</div>
      {step === 0 ? (
        <div className={`${card} grid gap-3 md:grid-cols-2`}>
          <div>
            <p className="mb-1 text-sm font-semibold">Logo</p>
            <div className="flex gap-2">
              <div className="flex h-16 w-40 items-center justify-center bg-black p-2"><Media url={b.logoUrls.white} className="max-h-full w-full object-contain" /></div>
              <div className="flex h-16 w-40 items-center justify-center bg-white p-2"><Media url={b.logoUrls.black} className="max-h-full w-full object-contain bg-white" /></div>
            </div>
            <div className="mt-2 flex gap-2">
              <label className={`${btn} cursor-pointer`}>Upload light logo<input type="file" accept="image/png,image/svg+xml" className="hidden" onChange={file("logo", { which: "white" })} /></label>
              <label className={`${btn} cursor-pointer`}>Upload dark logo<input type="file" accept="image/png,image/svg+xml" className="hidden" onChange={file("logo", { which: "black" })} /></label>
            </div>
          </div>
          <div>
            <p className="mb-1 text-sm font-semibold">Fonts</p>
            <p className="text-sm">Headline: <b>{b.fonts.headline}</b> {b.fonts.headlineFile ? "✓ file" : <span className="text-amber-200">(no file yet — Oswald stands in)</span>}</p>
            <p className="text-sm">Body: <b>{b.fonts.body}</b></p>
            <div className="mt-2 flex gap-2">
              <label className={`${btn} cursor-pointer`}>Headline font file<input type="file" accept=".woff2,.woff,.ttf,.otf" className="hidden" onChange={file("font", { which: "headline" })} /></label>
              <label className={`${btn} cursor-pointer`}>Body font file<input type="file" accept=".woff2,.woff,.ttf,.otf" className="hidden" onChange={file("font", { which: "body" })} /></label>
            </div>
          </div>
          <div className="md:col-span-2">
            <p className="mb-1 text-sm font-semibold">Colours</p>
            <div className="flex flex-wrap gap-2">
              {Object.entries(b.colors).map(([k, v]) => (
                <label key={k} className="flex items-center gap-2 text-sm">
                  <input type="color" className="h-10 w-12 bg-transparent" defaultValue={v} onBlur={(e) => void put({ brand: { colors: { ...b.colors, [k]: e.target.value } } })} /> {k}
                </label>
              ))}
            </div>
          </div>
        </div>
      ) : step === 1 ? (
        <div className="grid gap-3 md:grid-cols-2">
          {presets.map((p, i) => (
            <div key={p.key} className={card}>
              <div className="flex items-center justify-between">
                <h3 className={`${head} text-xl`}>{p.name}</h3>
                <button className={chip(b.defaultPreset === p.key)} onClick={() => void put({ brand: { defaultPreset: p.key } })}>{b.defaultPreset === p.key ? "Default" : "Make default"}</button>
              </div>
              <div className="my-2 grid grid-cols-2 gap-1">{[0, 1].map((j) => <Media key={j} url={p.sampleUrls?.[j]} className="aspect-[2/3] w-full" />)}</div>
              <textarea className={`${input} min-h-20 py-2`} value={p.look} onChange={(e) => setPresets((ps) => ps.map((x, k) => (k === i ? { ...x, look: e.target.value } : x)))} />
              <div className="mt-2 grid grid-cols-5 gap-1 text-[11px]">
                {(["contrast", "saturation", "brightness", "warmth", "grain"] as const).map((g) => (
                  <label key={g}>{g}<input className={`${input} !min-h-9 px-1`} inputMode="decimal" value={String(p.grade[g])} onChange={(e) => setPresets((ps) => ps.map((x, k) => (k === i ? { ...x, grade: { ...x.grade, [g]: Number(e.target.value) || 0 } } : x)))} /></label>
                ))}
              </div>
              <div className="mt-2 flex gap-2">
                <button className={btn} onClick={() => void put({ brand: { presets: presets.map(({ sampleUrls: _s, ...x }) => (void _s, x)) } })}>Save</button>
                <button className={btn} disabled={!!busy} onClick={() => void act({ action: "preset_samples", preset: p.key }, `s-${p.key}`)}>{busy === `s-${p.key}` ? "Drawing…" : "Sample frames (≈ $0.14)"}</button>
              </div>
            </div>
          ))}
        </div>
      ) : step === 2 ? (
        <div className={card}>
          <label className="text-sm">How CARBON sounds<input className={`${input} mt-1`} value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
          <div className="mt-3 flex items-center justify-between">
            <p className="text-sm font-semibold">Rate captions 👍 / 👎 so the app learns the tone</p>
            <button className={btn} disabled={!!busy} onClick={async () => { const r = await act<{ samples: S["brand"]["voice"]["samples"] }>({ action: "voice_samples" }); if (r) setSamples(r.samples); }}>{busy === "voice_samples" ? "Writing…" : samples.length ? "10 new captions" : "Write 10 captions (≈ 1¢)"}</button>
          </div>
          <div className="mt-2 space-y-1">
            {samples.map((s, i) => (
              <div key={i} className="flex items-start gap-2 border-t border-white/5 py-1.5 text-sm">
                <p className="flex-1">{s.text}</p>
                {(["up", "down"] as const).map((v) => <button key={v} className={chip(s.verdict === v)} onClick={() => setSamples((xs) => xs.map((x, k) => (k === i ? { ...x, verdict: v } : x)))}>{v === "up" ? "👍" : "👎"}</button>)}
              </div>
            ))}
          </div>
          <button className={`${btnPrimary} mt-3`} onClick={() => void put({ brand: { voice: { description: desc, samples } } })}>Save voice</button>
        </div>
      ) : step === 3 ? (
        <div className={`${card} grid gap-3 md:grid-cols-2`}>
          <label className="text-sm">Do (one per line)<textarea className={`${input} mt-1 min-h-40 py-2`} value={dos} onChange={(e) => setDos(e.target.value)} /></label>
          <label className="text-sm">Don&rsquo;t (one per line)<textarea className={`${input} mt-1 min-h-40 py-2`} value={donts} onChange={(e) => setDonts(e.target.value)} /></label>
          <button className={btnPrimary} onClick={() => void put({ brand: { dos: dos.split("\n").map((x) => x.trim()).filter(Boolean), donts: donts.split("\n").map((x) => x.trim()).filter(Boolean) } })}>Save</button>
        </div>
      ) : step === 4 ? (
        <div className={card}>
          <p className={`mb-2 text-sm ${muted}`}>Your edit taste, taken from your three finished Reels ({String(b.editStyle.source ?? "")}). These are the defaults for every edit.</p>
          <pre className="overflow-x-auto whitespace-pre-wrap bg-black p-3 text-xs">{JSON.stringify(b.editStyle, null, 2)}</pre>
        </div>
      ) : (
        <div className={card}>
          <p className="text-sm">Logo, fonts, looks, voice and do/don&rsquo;t are saved. Locations and music live in their own tabs.</p>
          <button className={`${btnPrimary} mt-3`} onClick={() => void put({ brand: { wizardDone: true } })}>{b.wizardDone ? "Done ✓" : "Finish setup"}</button>
        </div>
      )}
    </div>
  );
}

function ModelsTab({ d, act, upload, busy }: { d: S; act: Act; upload: Up; busy: string | null }) {
  const [gender, setGender] = useState<"female" | "male">("female");
  const [desc, setDesc] = useState("");
  const [cands, setCands] = useState<{ id: string; url: string }[]>([]);
  const [pick, setPick] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [real, setReal] = useState({ name: "", consent: false, notCelebrity: false });
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2 md:grid-cols-6">
        {d.models.map((m) => (
          <div key={m.id} className={`border ${m.active ? "border-white/10" : "border-white/5 opacity-50"} bg-[#0d0d0d]`}>
            <Media url={m.refs[0]} className="aspect-square w-full" />
            <div className="p-1.5 text-xs">
              <p className="font-semibold">{m.name} {m.isRealPerson ? <span className="text-amber-200">real</span> : null}</p>
              <p className={muted}>{m.look ?? "—"}{m.height ? ` · ${m.height}` : ""}</p>
              <p className={muted}>{m.personality ?? ""}</p>
              <div className="mt-1 flex flex-wrap gap-1">
                <button className={chip(m.pinned)} onClick={() => void act({ action: "model_meta", modelId: m.id, pinned: !m.pinned })}>{m.pinned ? "Pinned" : "Pin"}</button>
                <button className={chip(!m.active)} onClick={() => void act({ action: "model_meta", modelId: m.id, active: !m.active })}>{m.active ? "Hide" : "Show"}</button>
              </div>
              <select className={`${input} mt-1 !min-h-9 text-xs`} value={m.voice ?? ""} onChange={(e) => void act({ action: "model_meta", modelId: m.id, voice: e.target.value })}>
                <option value="">Voice…</option>
                {d.voices.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </div>
          </div>
        ))}
      </div>
      <button className={btn} disabled={!!busy} onClick={() => void act({ action: "describe_models" })}>{busy === "describe_models" ? "Looking…" : "Fill in look / personality for the models (≈ 1¢ each)"}</button>

      <div className={card}>
        <h3 className={`${head} mb-2 text-xl`}>Add a model</h3>
        <div className="flex flex-wrap gap-2">
          <button className={chip(gender === "female")} onClick={() => setGender("female")}>Woman</button>
          <button className={chip(gender === "male")} onClick={() => setGender("male")}>Man</button>
        </div>
        <input className={`${input} mt-2`} placeholder="Describe the look (or leave empty for a random new face)" value={desc} onChange={(e) => setDesc(e.target.value)} />
        <button className={`${btn} mt-2`} disabled={!!busy} onClick={async () => { const r = await act<{ candidates: { id: string; url: string }[] }>({ action: "model_candidates", gender, description: desc || undefined }); if (r) setCands(r.candidates); }}>
          {busy === "model_candidates" ? "Casting…" : `Show 4 candidates (≈ ${money(d.costs.candidates)})`}
        </button>
        {cands.length ? (
          <>
            <div className="mt-2 grid grid-cols-4 gap-1">{cands.map((c) => <button key={c.id} className={`border ${pick === c.id ? "border-white" : "border-transparent"}`} onClick={() => setPick(c.id)}><Media url={c.url} className="aspect-square w-full" /></button>)}</div>
            <div className="mt-2 flex gap-2">
              <input className={input} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
              <button className={btnPrimary} disabled={!pick || !name || !!busy} onClick={async () => { const r = await act({ action: "create_model", name, gender, candidatePath: pick }, "create"); if (r) { setCands([]); setPick(null); setName(""); } }}>
                {busy === "create" ? "Making the sheet…" : `Make the 4-view sheet (≈ ${money(d.costs.sheet)})`}
              </button>
            </div>
          </>
        ) : null}
        <p className={`mt-1 text-xs ${muted}`}>Celebrity or public-figure lookalikes are blocked.</p>
      </div>

      <div className={card}>
        <h3 className={`${head} mb-2 text-xl`}>Upload a real person</h3>
        <input className={input} placeholder="Name" value={real.name} onChange={(e) => setReal({ ...real, name: e.target.value })} />
        <label className="mt-2 flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="h-5 w-5" checked={real.consent} onChange={(e) => setReal({ ...real, consent: e.target.checked })} /> This person agreed to their face being used in CARBON ads</label>
        <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="h-5 w-5" checked={real.notCelebrity} onChange={(e) => setReal({ ...real, notCelebrity: e.target.checked })} /> They are not a celebrity or public figure</label>
        <label className={`${btn} mt-2 cursor-pointer ${!(real.consent && real.notCelebrity && real.name) ? "pointer-events-none opacity-40" : ""}`}>
          {busy === "model" ? "Making the sheet…" : `Choose a clear face photo (≈ ${money(d.costs.sheet)})`}
          <input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (!f) return; const fd = new FormData(); fd.set("kind", "model"); fd.set("name", real.name); fd.set("gender", gender); fd.set("consent", String(real.consent)); fd.set("notCelebrity", String(real.notCelebrity)); fd.set("file", f); void upload(fd, "model"); }} />
        </label>
      </div>
    </div>
  );
}

function MusicTab({ d, act, upload, busy }: { d: S; act: Act; upload: Up; busy: string | null }) {
  const [moods, setMoods] = useState("deep house");
  const [license, setLicense] = useState("owner");
  const send = (kind: "music" | "sfx") => (e: React.ChangeEvent<HTMLInputElement>) => {
    for (const f of Array.from(e.target.files ?? [])) {
      const fd = new FormData();
      fd.set("kind", kind);
      fd.set("moods", moods);
      fd.set("license", license);
      fd.set("file", f);
      void upload(fd, kind);
    }
  };
  return (
    <div className="space-y-3">
      <div className={card}>
        <p className={`mb-2 text-sm ${muted}`}>Royalty-free or your own licensed tracks only — never trending commercial songs in ads. Each track is tempo-tagged automatically so cuts land on the beat.</p>
        <div className="grid gap-2 md:grid-cols-2">
          <label className="text-sm">Moods for the next upload (comma)<input className={`${input} mt-1`} value={moods} onChange={(e) => setMoods(e.target.value)} /></label>
          <label className="text-sm">License<input className={`${input} mt-1`} value={license} onChange={(e) => setLicense(e.target.value)} /></label>
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <label className={`${btnPrimary} cursor-pointer`}>{busy === "music" ? "Uploading…" : "Add music (files or a folder's files)"}<input type="file" accept="audio/*" multiple className="hidden" onChange={send("music")} /></label>
          <label className={`${btn} cursor-pointer`}>{busy === "sfx" ? "Uploading…" : "Add SFX (name them whoosh, rustle, shutter, bass…)"}<input type="file" accept="audio/*" multiple className="hidden" onChange={send("sfx")} /></label>
        </div>
      </div>
      {d.audio.map((a) => (
        <div key={a.id} className={`${card} flex flex-wrap items-center gap-2 text-sm`}>
          <span className="w-12 text-xs uppercase">{a.kind}</span>
          <span className="flex-1 font-semibold">{a.name}</span>
          <span className={`text-xs ${muted}`}>{a.bpm ? `${a.bpm} BPM` : "—"} · {a.duration_s ? `${Math.round(a.duration_s)}s` : "—"}{a.beats?.drop != null ? ` · drop at ${a.beats.drop.toFixed(1)}s` : ""} · {a.license}</span>
          <input className={`${input} !min-h-9 w-48`} defaultValue={a.moods.join(", ")} onBlur={(e) => void act({ action: "audio_tags", id: a.id, moods: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} />
          <audio src={a.url} controls preload="none" className="h-9 max-w-full" />
          <button className={btnDanger} onClick={() => void act({ action: "audio_delete", id: a.id })}>Remove</button>
        </div>
      ))}
      {!d.audio.length ? <p className={`text-sm ${muted}`}>— No tracks yet. Videos render silent until you add some.</p> : null}
    </div>
  );
}

function LocationsTab({ d, act, upload, busy }: { d: S; act: Act; upload: Up; busy: string | null }) {
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  return (
    <div className="space-y-3">
      <div className={card}>
        <input className={input} placeholder="Name (e.g. Night garage, Orlando parking lot)" value={name} onChange={(e) => setName(e.target.value)} />
        <input className={`${input} mt-2`} placeholder="What it looks like" value={desc} onChange={(e) => setDesc(e.target.value)} />
        <div className="mt-2 flex flex-wrap gap-2">
          <button className={btn} disabled={!name || !!busy} onClick={() => void act({ action: "location_text", name, description: desc })}>Save as words (free)</button>
          <button className={btn} disabled={!name || !!busy} onClick={() => void act({ action: "location_ai", name, description: desc })}>{busy === "location_ai" ? "Drawing…" : "Draw a reusable plate (≈ $0.25)"}</button>
          <label className={`${btn} cursor-pointer ${!name ? "pointer-events-none opacity-40" : ""}`}>Upload a real photo<input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (!f) return; const fd = new FormData(); fd.set("kind", "location"); fd.set("name", name); fd.set("description", desc); fd.set("file", f); void upload(fd, "location"); }} /></label>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {d.locations.map((l) => (
          <div key={l.id} className="border border-white/10 bg-[#0d0d0d]">
            <Media url={l.url} className="aspect-video w-full" />
            <div className="p-2 text-xs"><p className="font-semibold">{l.name}</p><p className={muted}>{l.description}</p><button className="mt-1 text-red-300 underline" onClick={() => void act({ action: "location_delete", id: l.id })}>Remove</button></div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CapsTab({ d, put }: { d: S; put: Fn }) {
  const [caps, setCaps] = useState(d.settings.caps);
  return (
    <div className={`${card} space-y-3`}>
      <p className={`text-sm ${muted}`}>Jobs pause when a cap is reached. Nothing that costs money runs unless you tap a button.</p>
      {(["openai", "fal"] as const).map((p) => (
        <div key={p} className="grid grid-cols-[8rem_1fr_1fr] items-center gap-2 text-sm">
          <span>{p === "fal" ? "fal.ai (video)" : "OpenAI"}{d.keys[p] ? "" : " — no key"}</span>
          {(["daily", "monthly"] as const).map((k) => (
            <label key={k} className="text-xs">{k} $<input className={input} inputMode="decimal" value={String(caps[p][k])} onChange={(e) => setCaps({ ...caps, [p]: { ...caps[p], [k]: Number(e.target.value.replace(/[^\d.]/g, "")) || 0 } })} /></label>
          ))}
        </div>
      ))}
      <button className={btnPrimary} onClick={() => void put({ caps })}>Save caps</button>
    </div>
  );
}

function RadarTab({ d, put }: { d: S; put: Fn }) {
  const s = d.settings;
  const enabled = (k: string) => s.sources[k]?.enabled ?? d.defaults.sources[k]?.enabled ?? false;
  return (
    <div className="space-y-3">
      <div className={card}>
        <h3 className={`${head} mb-2 text-lg`}>Sources</h3>
        {Object.entries(d.defaults.sources).map(([k, v]) => (
          <label key={k} className="flex min-h-11 items-center gap-2 border-t border-white/5 text-sm">
            <input type="checkbox" className="h-5 w-5" checked={enabled(k)} onChange={(e) => void put({ sources: { ...s.sources, [k]: { enabled: e.target.checked } } })} />
            <span className="flex-1">{k}</span><span className={`text-xs ${muted}`}>{v.note}</span>
          </label>
        ))}
        <p className={`mt-2 text-xs ${muted}`}>Keys: Meta {d.keys.meta ? "✓" : "—"} · Snap {d.keys.snap ? "✓" : "—"} · Apify fallback {d.keys.apify ? "✓" : "— (off)"}</p>
      </div>
      <div className={card}>
        <h3 className={`${head} mb-2 text-lg`}>Categories</h3>
        <p className={`mb-2 text-xs ${muted}`}>Clothing and shoes only. Jewelry, watches, eyewear, beauty, fragrance and the rest are always blocked. Optional:</p>
        {(["bags", "hats", "belts"] as const).map((k) => (
          <label key={k} className="mr-4 inline-flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="h-5 w-5" checked={s.categoryOptions[k]} onChange={(e) => void put({ categoryOptions: { ...s.categoryOptions, [k]: e.target.checked } })} /> {k}</label>
        ))}
      </div>
      <div className={`${card} grid gap-2 md:grid-cols-2`}>
        <label className="text-sm">Keep media of inactive ads (days)<input className={`${input} mt-1`} inputMode="numeric" pattern="[0-9]*" defaultValue={s.retentionDays} onBlur={(e) => void put({ retentionDays: Number(e.target.value) || 180 })} /></label>
        <label className="text-sm">Meta API countries (EU)<input className={`${input} mt-1`} defaultValue={s.metaCountries.join(",")} onBlur={(e) => void put({ metaCountries: e.target.value.split(",").map((x) => x.trim().toUpperCase()).filter((x) => x.length === 2) })} /></label>
      </div>
    </div>
  );
}

function MoreTab({ d, put, act, busy }: { d: S; put: Fn; act: Act; busy: string | null }) {
  const [newer, setNewer] = useState<{ id: string; title: string }[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      <div className={card}>
        <h3 className={`${head} mb-2 text-lg`}>Engines (you never have to pick)</h3>
        {Object.entries(d.defaults.routes).map(([job, r]) => {
          const cur = d.settings.routing[job] ?? r.engines;
          return (
            <div key={job} className="border-t border-white/5 py-2 text-sm">
              <p className="font-semibold">{r.label}</p>
              <p className={`text-xs ${muted}`}>{r.why}</p>
              <select className={`${input} mt-1`} value={cur[0]} onChange={(e) => void put({ routing: { ...d.settings.routing, [job]: [e.target.value, ...r.engines.filter((x) => x !== e.target.value)] } })}>
                {Object.entries(d.defaults.engines).map(([id, e]) => <option key={id} value={id}>{e.label} — ${e.perSecond.silent}/s ({e.perSecond.audio}/s with sound)</option>)}
              </select>
              <p className={`mt-1 text-xs ${muted}`}>Then, if it fails twice: {cur.slice(1).map((x) => d.defaults.engines[x]?.label ?? x).join(" → ")}</p>
            </div>
          );
        })}
        <button className={`${btn} mt-2`} disabled={!!busy} onClick={async () => { const r = await act<{ newer: { id: string; title: string }[]; note: string | null }>({ action: "catalog_check" }); if (r) { setNewer(r.newer); setNote(r.note); } }}>Check fal.ai for newer models</button>
        {note ? <p className={`mt-1 text-xs ${muted}`}>{note}</p> : null}
        {newer ? <ul className="mt-1 text-xs">{newer.length ? newer.slice(0, 20).map((m) => <li key={m.id}>New: {m.title} ({m.id})</li>) : <li className={muted}>Nothing newer found.</li>}</ul> : null}
      </div>
      <div className={card}>
        <h3 className={`${head} mb-2 text-lg`}>Edit recipes</h3>
        {d.recipes.map((r) => (
          <div key={r.key} className="flex flex-wrap items-center gap-2 border-t border-white/5 py-2 text-sm">
            <span className="flex-1"><b>{r.name}</b> <span className={`text-xs ${muted}`}>{r.idea} · {r.media_types.join("/")}{r.score != null ? ` · Radar score ${r.score}` : ""}</span></span>
            {r.status === "proposed" ? <span className="text-xs text-amber-200">proposed from Radar</span> : null}
            <button className={chip(r.status === "active")} onClick={() => void act({ action: "recipe_status", key: r.key, status: r.status === "active" ? "retired" : "active" })}>{r.status === "active" ? "On" : r.status === "proposed" ? "Approve" : "Off"}</button>
          </div>
        ))}
      </div>
    </div>
  );
}
