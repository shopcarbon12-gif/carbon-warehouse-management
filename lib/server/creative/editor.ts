/**
 * CarbonWMS Creative — the Auto-Editor (spec §7.4). The brain's shot list + the music's beats →
 * an EDIT PLAN (JSON): which clip or still plays when, cut on the beat, the hero reveal on the
 * drop, transitions, kinetic type in CARBON fonts inside the Reels safe zone, SFX, music, end card,
 * grade + grain + loudness. `composeHyperFrames(plan)` writes it as a HyperFrames composition
 * (HTML → MP4); the render worker runs it. No extra AI cost for editing.
 */
import type { BrandBrain, Preset } from "./config";
import type { Shot } from "./director";

export type Transition = "hard_cut" | "match_cut" | "flash_frame" | "whip_pan" | "zoom_punch" | "mask_wipe" | "glitch" | "dissolve" | "fade" | "jump_cut" | "morph";
export type TextStyle = "slam" | "caption" | "price" | "callout" | "hook" | "date";

export type Segment = {
  id: string;
  shotIdx: number;
  start: number;
  dur: number;
  src: { kind: "video" | "image"; asset: string; mediaStart?: number; rate?: number; audio?: boolean };
  motion: "none" | "kenburns_in" | "kenburns_out" | "push";
  transitionIn: Transition;
  text: { text: string; style: TextStyle; at: number; dur: number } | null;
  sfx: { asset: string; at: number; volume: number }[];
  isEndCard: boolean;
};

export type EditPlan = {
  version: 1;
  width: number;
  height: number;
  fps: number;
  duration: number;
  bpm: number | null;
  music: { asset: string; mediaStart: number; volume: number; fadeOut: number } | null;
  voice: { asset: string; start: number; volume: number } | null;
  segments: Segment[];
  captions: { text: string; at: number; dur: number }[];
  endCard: { text: string; sub: string; logoAsset: string | null; start: number; dur: number };
  font: { headline: string; headlineAsset: string | null; body: string };
  colors: { ink: string; paper: string; accent: string };
  grade: Preset["grade"];
  grain: number;
  lufs: number;
  safe: { top: number; bottom: number; side: number };
  /** Chat edits like "bigger price text" (1 = default). */
  textScale?: number;
  /** asset key → where the render worker downloads it from (signed URL). */
  assets: Record<string, string>;
};

const ASPECTS: Record<string, [number, number]> = { "9:16": [1080, 1920], "4:5": [1080, 1350], "1:1": [1080, 1080], "16:9": [1920, 1080] };

const nearest = (t: number, beats: number[]) => (beats.length ? beats.reduce((p, c) => (Math.abs(c - t) < Math.abs(p - t) ? c : p), beats[0]) : t);

/**
 * Lay the shots on the music. Each cut boundary snaps to the nearest beat (never shorter than
 * 0.4 s); the first hero / product shot starts on the drop by choosing where the music starts.
 */
export function buildEditPlan(input: {
  shots: Shot[];
  media: Record<number, { kind: "video" | "image"; asset: string; duration?: number; audio?: boolean }>;
  aspect: string;
  brand: BrandBrain;
  preset: Preset;
  music: { asset: string; beats: number[]; bpm: number; drop: number | null; duration: number } | null;
  voice?: { asset: string; duration: number } | null;
  captions?: { text: string; at: number; dur: number }[];
  sfx?: Record<string, string>; // sfx name → asset key
  assets: Record<string, string>;
  logoAsset?: string | null;
  fontAsset?: string | null;
  draft?: boolean;
}): EditPlan {
  const [width, height] = ASPECTS[input.aspect] ?? ASPECTS["9:16"];
  const shots = input.shots.filter((s) => !s.is_end_card);
  const style = input.brand.editStyle;
  const endDur = style.endCard.seconds ?? 1.6;
  // The first shot whose overlay names the product / price is the hero reveal.
  const heroIdx = Math.max(0, shots.findIndex((s) => /product|price|\$|reveal|hero/i.test(`${s.text_overlay ?? ""} ${s.subject_action}`)));
  let musicStart = 0;
  let beats: number[] = [];
  if (input.music) {
    const heroAt = shots.slice(0, heroIdx).reduce((a, s) => a + s.duration_s, 0);
    if (input.music.drop != null && input.music.drop - heroAt > 0) musicStart = input.music.drop - heroAt;
    beats = input.music.beats.map((b) => b - musicStart).filter((b) => b >= 0);
  }
  const segments: Segment[] = [];
  let t = 0;
  for (const [i, s] of shots.entries()) {
    const m = input.media[s.idx];
    if (!m) continue;
    let end = t + s.duration_s;
    if (beats.length) {
      const snapped = nearest(end, beats);
      if (snapped - t >= 0.4) end = snapped;
    }
    const dur = Math.max(0.4, Math.round((end - t) * 1000) / 1000);
    const isVideo = m.kind === "video" && !s.is_static_frame;
    const txt = s.text_overlay?.trim();
    segments.push({
      id: `s${i}`,
      shotIdx: s.idx,
      start: Math.round(t * 1000) / 1000,
      dur,
      src: isVideo ? { kind: "video", asset: m.asset, mediaStart: 0, rate: m.duration && m.duration < dur ? Math.max(0.5, m.duration / dur) : 1, audio: Boolean(m.audio) } : { kind: "image", asset: m.asset },
      motion: isVideo ? "none" : i % 2 ? "kenburns_out" : "kenburns_in",
      transitionIn: (i === 0 ? "hard_cut" : (s.transition_in as Transition)) || "hard_cut",
      text: txt ? { text: txt, style: i === 0 ? "hook" : /\$\d/.test(txt) ? "price" : i === heroIdx ? "slam" : "caption", at: 0.08, dur: Math.max(0.6, dur - 0.15) } : null,
      sfx: (s.sfx ?? []).map((n) => input.sfx?.[n.toLowerCase()]).filter((a): a is string => Boolean(a)).slice(0, 2).map((asset) => ({ asset, at: 0, volume: 0.6 })),
      isEndCard: false,
    });
    t = end;
  }
  const endStart = Math.round(t * 1000) / 1000;
  const duration = Math.round((endStart + endDur) * 1000) / 1000;
  return {
    version: 1,
    width,
    height,
    fps: style.export?.fps ?? 30,
    duration,
    bpm: input.music?.bpm ?? null,
    music: input.music ? { asset: input.music.asset, mediaStart: Math.round(musicStart * 1000) / 1000, volume: input.voice ? 0.35 : 0.9, fadeOut: 0.8 } : null,
    voice: input.voice ? { asset: input.voice.asset, start: 0.2, volume: 1 } : null,
    segments,
    captions: input.captions ?? [],
    endCard: { text: style.endCard.text ?? "CARBON", sub: style.endCard.sub ?? "shopcarbon.com", logoAsset: input.logoAsset ?? null, start: endStart, dur: endDur },
    font: { headline: input.brand.fonts.headline, headlineAsset: input.fontAsset ?? null, body: input.brand.fonts.body },
    colors: { ink: input.brand.colors.ink, paper: input.brand.colors.paper, accent: input.brand.colors.accent },
    grade: input.preset.grade,
    grain: input.preset.grade.grain ?? style.grain ?? 0.1,
    lufs: style.export?.lufs ?? -14,
    // Reels UI: keep words out of the top 14% and bottom 20%.
    safe: { top: Math.round(height * 0.14), bottom: Math.round(height * 0.2), side: Math.round(width * 0.06) },
    assets: input.assets,
  };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const n3 = (x: number) => (Math.round(x * 1000) / 1000).toString();

/** Asset key → the file name inside the HyperFrames project (assets/…). */
export const assetFile = (key: string) => `assets/${key.replace(/[^a-zA-Z0-9._-]/g, "_")}`;

/**
 * The edit plan as one HyperFrames composition (index.html). Footage is timed on wrappers,
 * transitions and kinetic type are GSAP tweens on children (HyperFrames contract: no CSS filter on
 * footage — the grade, grain and loudness are the ffmpeg finishing pass).
 */
export function composeHyperFrames(plan: EditPlan): string {
  const W = plan.width, H = plan.height;
  const ts = plan.textScale ?? 1;
  const headline = plan.font.headlineAsset ? "CarbonHead" : "Oswald";
  const fontFace = plan.font.headlineAsset ? `@font-face { font-family: "CarbonHead"; src: url('${assetFile(plan.font.headlineAsset)}'); font-weight: 400 900; }` : "";
  let z = 1;
  const parts: string[] = [];
  const tl: string[] = [];
  for (const s of plan.segments) {
    const wid = `${s.id}-w`;
    const media =
      s.src.kind === "video"
        ? `<video id="${s.id}-v" src="${assetFile(s.src.asset)}" ${s.src.audio ? 'data-has-audio="true"' : "muted"} playsinline${s.src.mediaStart ? ` data-media-start="${n3(s.src.mediaStart)}"` : ""}${s.src.rate && s.src.rate !== 1 ? ` data-playback-rate="${n3(s.src.rate)}"` : ""} style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></video>`
        : `<img id="${s.id}-i" src="${assetFile(s.src.asset)}" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover" />`;
    parts.push(
      `<div id="${wid}" class="clip seg" data-start="${n3(s.start)}" data-duration="${n3(s.dur + (s.transitionIn === "dissolve" ? 0.3 : 0))}" data-track-index="1" style="z-index:${z++}"><div id="${s.id}-m" class="mover">${media}</div>${
        s.text ? `<div id="${s.id}-t" class="txt ${s.text.style}"><span id="${s.id}-tx">${esc(s.text.text)}</span></div>` : ""
      }</div>`,
    );
    const at = s.start;
    // motion on the still / footage wrapper
    if (s.motion === "kenburns_in") tl.push(`tl.fromTo("#${s.id}-m", { scale: 1 }, { scale: 1.07, duration: ${n3(s.dur)}, ease: "none" }, ${n3(at)});`);
    if (s.motion === "kenburns_out") tl.push(`tl.fromTo("#${s.id}-m", { scale: 1.08 }, { scale: 1, duration: ${n3(s.dur)}, ease: "none" }, ${n3(at)});`);
    // transition into this segment
    switch (s.transitionIn) {
      case "flash_frame":
        tl.push(`tl.fromTo("#flash", { opacity: 0.95 }, { opacity: 0, duration: 0.12, ease: "power2.out", immediateRender: false }, ${n3(at)});`);
        break;
      case "whip_pan":
        tl.push(`tl.fromTo("#${s.id}-m", { xPercent: 35 }, { xPercent: 0, duration: 0.22, ease: "power3.out" }, ${n3(at)});`);
        break;
      case "zoom_punch":
        tl.push(`tl.fromTo("#${s.id}-m", { scale: 1.22 }, { scale: 1, duration: 0.28, ease: "power3.out" }, ${n3(at)});`);
        break;
      case "mask_wipe":
        tl.push(`tl.fromTo("#${s.id}-m", { clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0% 0 0)", duration: 0.35, ease: "power2.inOut" }, ${n3(at)});`);
        break;
      case "glitch":
        tl.push(`tl.fromTo("#${s.id}-m", { x: -24 }, { x: 0, duration: 0.06, ease: "steps(3)" }, ${n3(at)}); tl.fromTo("#${s.id}-m", { x: 18 }, { x: 0, duration: 0.06, ease: "steps(2)" }, ${n3(at + 0.08)});`);
        break;
      case "dissolve":
      case "fade":
      case "morph":
        tl.push(`tl.fromTo("#${s.id}-m", { opacity: 0 }, { opacity: 1, duration: 0.3, ease: "none" }, ${n3(at)});`);
        break;
      default:
        break; // hard cut / match cut / jump cut
    }
    if (s.text) {
      const ta = at + s.text.at;
      if (s.text.style === "slam" || s.text.style === "hook" || s.text.style === "date")
        tl.push(`tl.fromTo("#${s.id}-tx", { scale: 1.45, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.18, ease: "power4.out" }, ${n3(ta)});`);
      else tl.push(`tl.fromTo("#${s.id}-tx", { yPercent: 60, opacity: 0 }, { yPercent: 0, opacity: 1, duration: 0.24, ease: "power3.out" }, ${n3(ta)});`);
    }
  }
  // End card
  const e = plan.endCard;
  parts.push(
    `<div id="end" class="clip" data-start="${n3(e.start)}" data-duration="${n3(e.dur)}" data-track-index="2" style="z-index:${z++};background:#000"><div id="end-in" class="endin">${
      e.logoAsset ? `<img id="end-logo" src="${assetFile(e.logoAsset)}" alt="CARBON" />` : `<div id="end-word">${esc(e.text)}</div>`
    }<div id="end-sub">${esc(e.sub)}</div></div></div>`,
  );
  tl.push(`tl.fromTo("#end-in", { opacity: 0, scale: 0.96 }, { opacity: 1, scale: 1, duration: 0.35, ease: "power3.out" }, ${n3(e.start + 0.05)});`);
  // Captions (UGC: burned-in, IG style)
  for (const [k, c] of plan.captions.entries()) {
    parts.push(`<div id="cap${k}" class="clip cap" data-start="${n3(c.at)}" data-duration="${n3(c.dur)}" data-track-index="3" style="z-index:900"><span id="cap${k}-t">${esc(c.text)}</span></div>`);
    tl.push(`tl.fromTo("#cap${k}-t", { scale: 0.92, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.12, ease: "power2.out" }, ${n3(c.at)});`);
  }
  // Audio: music, voice, SFX
  const audio: string[] = [];
  if (plan.music)
    audio.push(
      `<audio id="music" class="clip" src="${assetFile(plan.music.asset)}" data-start="0" data-duration="${n3(plan.duration)}" data-media-start="${n3(plan.music.mediaStart)}" data-volume="${plan.music.volume}" data-fade-out="${plan.music.fadeOut}" data-track-index="10"></audio>`,
    );
  if (plan.voice) audio.push(`<audio id="voice" class="clip" src="${assetFile(plan.voice.asset)}" data-start="${n3(plan.voice.start)}" data-volume="${plan.voice.volume}" data-track-index="11"></audio>`);
  let sfxN = 0;
  for (const s of plan.segments)
    for (const fx of s.sfx) audio.push(`<audio id="fx${sfxN++}" class="clip" src="${assetFile(fx.asset)}" data-start="${n3(s.start + fx.at)}" data-volume="${fx.volume}" data-track-index="12"></audio>`);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=${W}, height=${H}" />
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>
${fontFace}
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: #000; }
#root { position: relative; width: 100%; height: 100%; overflow: hidden; background: #000; font-family: "${headline}", "Oswald", sans-serif; }
.seg, #end, .cap { position: absolute; inset: 0; overflow: hidden; }
.mover { position: absolute; inset: 0; transform-origin: 50% 50%; }
.txt { position: absolute; left: ${plan.safe.side}px; right: ${plan.safe.side}px; display: flex; justify-content: center; text-align: center; color: #fff; text-transform: uppercase; letter-spacing: -0.01em; text-shadow: 0 2px 18px rgba(0,0,0,.55); }
.txt span { display: inline-block; transform-origin: 50% 60%; }
.txt.hook, .txt.slam, .txt.date { top: ${Math.round(H * 0.38)}px; font-weight: 700; font-size: ${Math.round(W * 0.115 * ts)}px; line-height: 0.95; }
.txt.caption { bottom: ${plan.safe.bottom + Math.round(H * 0.02)}px; font-weight: 700; font-size: ${Math.round(W * 0.062 * ts)}px; line-height: 1.05; }
.txt.price { bottom: ${plan.safe.bottom + Math.round(H * 0.02)}px; justify-content: flex-start; text-align: left; font-weight: 700; font-size: ${Math.round(W * 0.075 * ts)}px; }
.txt.price span { background: ${plan.colors.ink}; padding: 0.12em 0.32em; }
.txt.callout { top: ${Math.round(H * 0.55)}px; font-weight: 700; font-size: ${Math.round(W * 0.05 * ts)}px; }
.cap { display: flex; align-items: flex-end; justify-content: center; padding: 0 ${plan.safe.side}px ${plan.safe.bottom + Math.round(H * 0.06)}px; pointer-events: none; }
.cap span { display: inline-block; font-family: "Inter", sans-serif; font-weight: 900; font-size: ${Math.round(W * 0.058 * ts)}px; line-height: 1.1; color: #fff; text-align: center; text-shadow: 0 0 12px rgba(0,0,0,.8), 0 2px 2px rgba(0,0,0,.9); }
#end { display: flex; align-items: center; justify-content: center; }
.endin { display: flex; flex-direction: column; align-items: center; gap: ${Math.round(H * 0.025)}px; }
#end-logo { width: ${Math.round(W * 0.62)}px; height: auto; }
#end-word { color: #fff; font-weight: 700; font-size: ${Math.round(W * 0.19)}px; letter-spacing: 0.04em; }
#end-sub { color: rgba(255,255,255,.78); font-family: "Inter", sans-serif; font-weight: 700; font-size: ${Math.round(W * 0.04)}px; letter-spacing: 0.06em; }
#flash { position: absolute; inset: 0; background: #fff; opacity: 0; z-index: 950; pointer-events: none; }
</style>
</head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${n3(plan.duration)}" data-width="${W}" data-height="${H}">
${parts.join("\n")}
<div id="flash"></div>
${audio.join("\n")}
</div>
<script>
const tl = gsap.timeline({ paused: true });
${tl.join("\n")}
window.__timelines["main"] = tl;
tl.seek(0);
</script>
</body>
</html>`;
}

/**
 * The finishing pass (ffmpeg): CARBON grade from the preset, film grain, scale to the export size
 * (1080p, or 4K for finals when asked), smooth slow-mo by frame interpolation when a segment is
 * slowed, light sharpening, loudness normalised to −14 LUFS.
 */
export function finishingArgs(plan: EditPlan, input: string, output: string, opts: { upscale4k?: boolean; interpolate?: boolean; hasAudio?: boolean } = {}): string[] {
  const g = plan.grade;
  const scaleW = opts.upscale4k ? plan.width * 2 : plan.width;
  const scaleH = opts.upscale4k ? plan.height * 2 : plan.height;
  const vf = [
    `scale=${scaleW}:${scaleH}:flags=lanczos`,
    opts.interpolate ? `minterpolate=fps=${plan.fps}:mi_mode=mci:mc_mode=aobmc:vsbmc=1` : null,
    `eq=contrast=${g.contrast}:saturation=${g.saturation}:brightness=${g.brightness}`,
    g.warmth ? `colorbalance=rm=${(g.warmth / 2).toFixed(3)}:bm=${(-g.warmth / 2).toFixed(3)}` : null,
    "unsharp=5:5:0.35:5:5:0",
    plan.grain > 0 ? `noise=alls=${Math.round(plan.grain * 60)}:allf=t` : null,
    "format=yuv420p",
  ]
    .filter(Boolean)
    .join(",");
  const audio = opts.hasAudio === false ? ["-an"] : ["-af", `loudnorm=I=${plan.lufs}:TP=-1.5:LRA=11`, "-c:a", "aac", "-b:a", "192k"];
  return ["-y", "-i", input, "-vf", vf, ...audio, "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-r", String(plan.fps), "-movflags", "+faststart", output];
}
