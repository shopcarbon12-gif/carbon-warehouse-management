/**
 * CarbonWMS Creative — Animated ads (spec §7.5): render-engine templates driven by the Product
 * Twin and the presets — kinetic type, product spin, price drop, outfit grid flip, 3 ways,
 * countdown. HyperFrames HTML; no paid AI (the cut-outs already exist).
 */
import { assetFile } from "./editor";

export const ANIMATED_TEMPLATES = {
  kinetic_type: "Kinetic type — words slam on the beat, the piece lands",
  product_spin: "Product spin — front → back flip with the name and price",
  price_drop: "Price drop — the old price falls, the new one slams",
  outfit_grid: "Outfit grid flip — 4 pieces flip in, then the full fit",
  three_ways: "3 ways — three looks slide in, 01 / 02 / 03",
  countdown: "Countdown — the drop date ticks in",
} as const;
export type AnimatedTemplate = keyof typeof ANIMATED_TEMPLATES;

export type AnimatedData = {
  title: string;
  price: string | null;
  compareAt: string | null;
  words: string[]; // 2–5 short words
  images: string[]; // asset keys: cut-outs (transparent / white) or stills
  date: string | null; // countdown target text, e.g. "FRI 11.14"
  bg: string;
  ink: string;
  accent: string;
  headlineAsset: string | null;
  logoAsset: string | null;
  musicAsset: string | null;
  musicStart: number;
  width: number;
  height: number;
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function animatedHtml(t: AnimatedTemplate, d: AnimatedData): { html: string; duration: number } {
  const W = d.width, H = d.height;
  const img = (k: string, id: string, style: string) => `<img id="${id}" src="${assetFile(k)}" alt="" style="${style}" />`;
  const words = d.words.length ? d.words : [d.title];
  const el: string[] = [];
  const tl: string[] = [];
  let dur = 8;
  const big = Math.round(W * 0.16);
  switch (t) {
    case "kinetic_type": {
      dur = Math.max(6, words.length * 0.9 + 4);
      words.forEach((w, i) => {
        el.push(`<div id="w${i}" class="clip word" data-start="${(i * 0.9).toFixed(2)}" data-duration="0.9" data-track-index="1"><span id="w${i}s">${esc(w)}</span></div>`);
        tl.push(`tl.fromTo("#w${i}s", { scale: 1.6, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.16, ease: "power4.out" }, ${(i * 0.9).toFixed(2)});`);
      });
      const at = words.length * 0.9;
      el.push(`<div id="hero" class="clip full" data-start="${at.toFixed(2)}" data-duration="${(dur - at).toFixed(2)}" data-track-index="1">${img(d.images[0], "heroi", "position:absolute;left:10%;top:12%;width:80%;height:62%;object-fit:contain")}<div id="herot" class="label">${esc(d.title)}${d.price ? ` · ${esc(d.price)}` : ""}</div></div>`);
      tl.push(`tl.fromTo("#heroi", { y: 120, opacity: 0 }, { y: 0, opacity: 1, duration: 0.4, ease: "expo.out" }, ${at.toFixed(2)});`, `tl.fromTo("#herot", { opacity: 0 }, { opacity: 1, duration: 0.25 }, ${(at + 0.3).toFixed(2)});`);
      break;
    }
    case "product_spin": {
      dur = 7;
      el.push(`<div id="spin" class="clip full" data-start="0" data-duration="${dur}" data-track-index="1"><div id="card" style="position:absolute;left:12%;top:10%;width:76%;height:64%">${img(d.images[0], "front", "position:absolute;inset:0;width:100%;height:100%;object-fit:contain")}${d.images[1] ? img(d.images[1], "back", "position:absolute;inset:0;width:100%;height:100%;object-fit:contain;opacity:0") : ""}</div><div id="spint" class="label">${esc(d.title)}</div>${d.price ? `<div id="spinp" class="price">${esc(d.price)}</div>` : ""}</div>`);
      tl.push(`tl.fromTo("#card", { scale: 0.85, rotationY: -25 }, { scale: 1, rotationY: 0, duration: 1.2, ease: "power3.out" }, 0);`);
      if (d.images[1]) tl.push(`tl.fromTo("#card", { rotationY: 0 }, { rotationY: 180, duration: 1.1, ease: "power2.inOut", immediateRender: false }, 2.4);`, `tl.fromTo("#back", { opacity: 0 }, { opacity: 1, duration: 0.01, immediateRender: false }, 2.95);`, `tl.fromTo("#front", { opacity: 1 }, { opacity: 0, duration: 0.01, immediateRender: false }, 2.95);`, `tl.set("#back", { rotationY: 180 }, 0);`);
      tl.push(`tl.fromTo("#spint", { y: 40, opacity: 0 }, { y: 0, opacity: 1, duration: 0.35, ease: "power3.out" }, 0.6);`);
      if (d.price) tl.push(`tl.fromTo("#spinp", { scale: 1.5, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.2, ease: "power4.out" }, 4.2);`);
      break;
    }
    case "price_drop": {
      dur = 6.5;
      el.push(`<div id="pd" class="clip full" data-start="0" data-duration="${dur}" data-track-index="1">${img(d.images[0], "pdi", "position:absolute;left:8%;top:8%;width:84%;height:56%;object-fit:contain")}<div id="pdname" class="label" style="top:${Math.round(H * 0.66)}px">${esc(d.title)}</div>${d.compareAt ? `<div id="pdold" class="old">${esc(d.compareAt)}</div>` : ""}${d.price ? `<div id="pdnew" class="price" style="top:${Math.round(H * 0.74)}px">${esc(d.price)}</div>` : ""}</div>`);
      tl.push(`tl.fromTo("#pdi", { scale: 1.1, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.5, ease: "power3.out" }, 0);`, `tl.fromTo("#pdname", { opacity: 0 }, { opacity: 1, duration: 0.3 }, 0.6);`);
      if (d.compareAt) tl.push(`tl.fromTo("#pdold", { opacity: 0 }, { opacity: 1, duration: 0.2 }, 1.3);`, `tl.fromTo("#pdold", { y: 0, rotation: 0 }, { y: ${Math.round(H * 0.5)}, rotation: 18, duration: 0.6, ease: "power2.in", immediateRender: false }, 2.6);`);
      if (d.price) tl.push(`tl.fromTo("#pdnew", { scale: 1.8, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.2, ease: "power4.out" }, 3.1);`);
      break;
    }
    case "outfit_grid": {
      dur = 7.5;
      const imgs = d.images.slice(0, 4);
      el.push(`<div id="grid" class="clip full" data-start="0" data-duration="4.4" data-track-index="1">${imgs
        .map((k, i) => `<div id="g${i}" style="position:absolute;left:${i % 2 ? 51 : 3}%;top:${i < 2 ? 12 : 44}%;width:46%;height:30%;background:rgba(255,255,255,.06)">${img(k, `g${i}i`, "position:absolute;inset:4%;width:92%;height:92%;object-fit:contain")}</div>`)
        .join("")}</div>`);
      imgs.forEach((_, i) => tl.push(`tl.fromTo("#g${i}", { rotationX: 90, opacity: 0 }, { rotationX: 0, opacity: 1, duration: 0.35, ease: "back.out(1.6)" }, ${(0.2 + i * 0.45).toFixed(2)});`));
      el.push(`<div id="fit" class="clip full" data-start="4.4" data-duration="${(dur - 4.4).toFixed(2)}" data-track-index="1">${img(d.images[4] ?? d.images[0], "fiti", "position:absolute;inset:0;width:100%;height:100%;object-fit:cover")}<div id="fitt" class="label">${esc(d.title)}${d.price ? ` · ${esc(d.price)}` : ""}</div></div>`);
      tl.push(`tl.fromTo("#fiti", { scale: 1.12 }, { scale: 1, duration: 0.6, ease: "power3.out" }, 4.4);`, `tl.fromTo("#fitt", { opacity: 0 }, { opacity: 1, duration: 0.3 }, 4.8);`);
      break;
    }
    case "three_ways": {
      dur = 8;
      const imgs = d.images.slice(0, 3);
      imgs.forEach((k, i) => {
        el.push(`<div id="l${i}" class="clip full" data-start="${(i * 1.8).toFixed(2)}" data-duration="1.8" data-track-index="1">${img(k, `l${i}i`, "position:absolute;inset:0;width:100%;height:100%;object-fit:cover")}<div id="l${i}n" class="num">0${i + 1}</div></div>`);
        tl.push(`tl.fromTo("#l${i}i", { xPercent: 30 }, { xPercent: 0, duration: 0.3, ease: "power3.out" }, ${(i * 1.8).toFixed(2)});`, `tl.fromTo("#l${i}n", { scale: 1.6, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.18 }, ${(i * 1.8 + 0.1).toFixed(2)});`);
      });
      el.push(`<div id="split" class="clip full" data-start="5.4" data-duration="2.6" data-track-index="1">${imgs.map((k, i) => img(k, `s${i}`, `position:absolute;left:${(i * 100) / 3}%;top:0;width:${100 / 3}%;height:100%;object-fit:cover`)).join("")}<div id="splitt" class="label">${esc(d.title)}${d.price ? ` · ${esc(d.price)}` : ""}</div></div>`);
      imgs.forEach((_, i) => tl.push(`tl.fromTo("#s${i}", { yPercent: ${i % 2 ? -100 : 100} }, { yPercent: 0, duration: 0.35, ease: "power3.out" }, ${(5.4 + i * 0.08).toFixed(2)});`));
      tl.push(`tl.fromTo("#splitt", { opacity: 0 }, { opacity: 1, duration: 0.25 }, 5.9);`);
      break;
    }
    case "countdown": {
      dur = 6;
      el.push(`<div id="cd" class="clip full" data-start="0" data-duration="${dur}" data-track-index="1">${d.images[0] ? img(d.images[0], "cdi", "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.35") : ""}${[3, 2, 1].map((n) => `<div id="n${n}" class="word" style="opacity:0"><span>${n}</span></div>`).join("")}<div id="cdd" class="word" style="opacity:0"><span>${esc(d.date ?? "SOON")}</span></div><div id="cdt" class="label">${esc(d.title)}</div></div>`);
      [3, 2, 1].forEach((n, i) => tl.push(`tl.fromTo("#n${n}", { opacity: 1, scale: 1.4 }, { opacity: 0, scale: 0.9, duration: 0.9, ease: "power2.in" }, ${(0.3 + i).toFixed(2)});`));
      tl.push(`tl.fromTo("#cdd", { opacity: 0, scale: 1.6 }, { opacity: 1, scale: 1, duration: 0.2, ease: "power4.out" }, 3.4);`, `tl.fromTo("#cdt", { opacity: 0 }, { opacity: 1, duration: 0.3 }, 3.8);`);
      break;
    }
  }
  // End card
  el.push(`<div id="end" class="clip full" data-start="${dur.toFixed(2)}" data-duration="1.6" data-track-index="2" style="background:#000;display:flex;align-items:center;justify-content:center">${d.logoAsset ? `<img id="endl" src="${assetFile(d.logoAsset)}" alt="CARBON" style="width:62%" />` : `<div id="endl" class="word" style="position:static"><span>CARBON</span></div>`}</div>`);
  tl.push(`tl.fromTo("#endl", { opacity: 0 }, { opacity: 1, duration: 0.35 }, ${(dur + 0.05).toFixed(2)});`);
  const total = dur + 1.6;
  const family = d.headlineAsset ? "CarbonHead" : "Oswald";
  return {
    duration: total,
    html: `<!doctype html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=${W}, height=${H}" />
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>
${d.headlineAsset ? `@font-face { font-family: "CarbonHead"; src: url('${assetFile(d.headlineAsset)}'); font-weight: 400 900; }` : ""}
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: ${d.bg}; }
#root { position: relative; width: 100%; height: 100%; overflow: hidden; background: ${d.bg}; color: ${d.ink}; font-family: "${family}", "Oswald", sans-serif; perspective: 1400px; }
.full { position: absolute; inset: 0; }
.word { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; text-align: center; font-weight: 700; font-size: ${big}px; text-transform: uppercase; line-height: .95; padding: 0 6%; }
.word span { display: inline-block; }
.label { position: absolute; left: 6%; right: 6%; top: ${Math.round(H * 0.77)}px; text-align: center; font-weight: 700; font-size: ${Math.round(W * 0.06)}px; text-transform: uppercase; }
.price { position: absolute; left: 6%; right: 6%; top: ${Math.round(H * 0.68)}px; text-align: center; font-weight: 700; font-size: ${Math.round(W * 0.12)}px; color: ${d.accent}; }
.old { position: absolute; left: 6%; right: 6%; top: ${Math.round(H * 0.74)}px; text-align: center; font-weight: 700; font-size: ${Math.round(W * 0.09)}px; text-decoration: line-through; opacity: .6; }
.num { position: absolute; left: 6%; top: ${Math.round(H * 0.14)}px; font-weight: 700; font-size: ${Math.round(W * 0.2)}px; color: #fff; text-shadow: 0 4px 30px rgba(0,0,0,.5); }
</style></head><body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${total.toFixed(2)}" data-width="${W}" data-height="${H}">
${el.join("\n")}
${d.musicAsset ? `<audio id="music" class="clip" src="${assetFile(d.musicAsset)}" data-start="0" data-duration="${total.toFixed(2)}" data-media-start="${d.musicStart.toFixed(2)}" data-volume="0.9" data-fade-out="0.8" data-track-index="10"></audio>` : ""}
</div>
<script>
const tl = gsap.timeline({ paused: true });
${tl.join("\n")}
window.__timelines["main"] = tl;
tl.seek(0);
</script></body></html>`,
  };
}
