/**
 * CarbonWMS Email — the CARBON template pack's hero pictures (owner, 2026-11-10: "10 production
 * email templates … big display type over photos must be baked into a single image").
 *
 * Each layout is a small web page (600 px wide) built from the owner's spec and the target looks
 * in the pack. The editor shows the page live; the server draws it once in headless Chromium at 2×
 * (lib/server/email/text-pics.ts) and the email sends a 1200 px JPG, so Gmail and Outlook show the
 * real type. Headlines fit the width by themselves (the page measures and sizes them).
 *
 * Pure (no server or browser APIs).
 */

export type HeroLayout =
  | "night-shift"
  | "silhouette"
  | "editorial"
  | "monument"
  | "coordinates"
  | "brutal-grid"
  | "red-alert"
  | "teaser"
  | "cut-paste"
  | "quiet";

export type HeroFields = {
  layout: HeroLayout;
  /** Up to 3 photos (null = a grey stand-in until one is picked). */
  photos: (string | null)[];
  headline: string;
  label: string;
  subline: string;
  note: string;
  accent: string;
  /** The CARBON grade: contrast +15, saturation −30, film grain. */
  grade: boolean;
};

export const INK = "#0A0A0A";
export const BONE = "#F2EFE8";
export const STEEL = "#3A3A38";
export const ORANGE = "#FF4D00";
export const LIME = "#C6FF00";
export const RED = "#E10600";

export const PACK_BASE = "https://wms.shopcarbon.com/email/pack";

type LayoutDef = {
  name: string;
  height: number;
  photos: number;
  /** Which text fields the layout uses (the panel shows only these). */
  fields: { headline: string; label?: string; subline?: string; note?: string };
  defaults: Omit<HeroFields, "layout" | "photos" | "grade">;
  bg: string;
};

export const HERO_LAYOUTS: Record<HeroLayout, LayoutDef> = {
  "night-shift": {
    name: "Night Shift: 3-photo collage, two-word headline",
    height: 760,
    photos: 3,
    bg: INK,
    fields: { headline: "Headline (first word light, the rest in the accent)", label: "Top label" },
    defaults: { headline: "NIGHT SHIFT", label: "FW26 — LOOKBOOK / VOL. 01", subline: "", note: "", accent: ORANGE },
  },
  silhouette: {
    name: "Silhouette: one black-and-white photo, one giant word",
    height: 720,
    photos: 1,
    bg: INK,
    fields: { headline: "Giant word", label: "Top label" },
    defaults: { headline: "CARBON", label: "SILHOUETTE — FW26", subline: "", note: "", accent: ORANGE },
  },
  editorial: {
    name: "The Edit: word behind the model, a note box",
    height: 640,
    photos: 1,
    bg: INK,
    fields: { headline: "Giant word (behind the photo)", label: "Top label", note: "Note box (3 short lines)" },
    defaults: { headline: "UNFILTERED", label: "THE EDIT — ISSUE 07", subline: "", note: "Worn in Orlando.\nBuilt for the\nlong night.", accent: ORANGE },
  },
  monument: {
    name: "Monument: one phrase stacked 5 times, product on top",
    height: 700,
    photos: 1,
    bg: INK,
    fields: { headline: "Phrase", subline: "Spec line (parts split with //)" },
    defaults: { headline: "RAW DENIM", label: "", subline: "DROP 014 // 14 OZ SELVEDGE // MADE TO FADE", note: "", accent: BONE },
  },
  coordinates: {
    name: "Coordinates: GPS bar, photo, city name, red tag",
    height: 620,
    photos: 1,
    bg: INK,
    fields: { headline: "City / place", label: "Coordinates", subline: "Tag" },
    defaults: { headline: "ORLANDO", label: "28.5384° N, 81.3789° W", subline: "SHOWROOM — NOW OPEN", note: "", accent: RED },
  },
  "brutal-grid": {
    name: "Brutal Grid: 3 stacked words on a grid, framed product",
    height: 520,
    photos: 1,
    bg: INK,
    fields: { headline: "Three words (e.g. 40% OFF GRID)" },
    defaults: { headline: "40% OFF GRID", label: "", subline: "", note: "", accent: LIME },
  },
  "red-alert": {
    name: "Red Alert: headline on red, photo, date bar",
    height: 600,
    photos: 1,
    bg: RED,
    fields: { headline: "Headline", subline: "Date bar" },
    defaults: { headline: "DROP ALERT", label: "", subline: "FRIDAY • 12:00 PM ET • SHOPCARBON.COM", note: "", accent: RED },
  },
  teaser: {
    name: "Teaser: blurred photo, orange tint, one giant word",
    height: 820,
    photos: 1,
    bg: ORANGE,
    fields: { headline: "Giant word", label: "Top-left (REC …)", subline: "Bottom-left line" },
    defaults: { headline: "SOON", label: "REC 00:00:14", subline: "SOMETHING IS LOADING.", note: "", accent: ORANGE },
  },
  "cut-paste": {
    name: "Cut & Paste: zine collage, paper card, hazard tape",
    height: 760,
    photos: 2,
    bg: INK,
    fields: { headline: "Bottom headline (first word solid, rest outlined)", note: "Card words (2 words)", label: "Card number" },
    defaults: { headline: "CUT & PASTE", label: "NO. 03", subline: "", note: "STREET ISSUE", accent: ORANGE },
  },
  quiet: {
    name: "Quiet: one product on bone, calm headline",
    height: 700,
    photos: 1,
    bg: BONE,
    fields: { headline: "Headline" },
    defaults: { headline: "THE ESSENTIALS", label: "", subline: "", note: "", accent: INK },
  },
};

export const HERO_LAYOUT_IDS = Object.keys(HERO_LAYOUTS) as HeroLayout[];

const esc = (s: string) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
const safeColor = (c: string, fb: string) => (/^#[0-9a-f]{6}$/i.test(c) ? c : fb);

const FONTS =
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Anton&family=Archivo+Black&family=Bebas+Neue&family=Space+Grotesk:wght@500;700&display=block">';

/** A photo spot: the photo (graded) or a grey stand-in. */
function photo(url: string | null | undefined, style: string, opts: { grade: boolean; bw?: boolean; blur?: number; label?: string } = { grade: true }): string {
  const filters = [opts.bw ? "grayscale(1) contrast(1.25)" : opts.grade ? "contrast(1.15) saturate(0.7)" : "", opts.blur ? `blur(${opts.blur}px)` : ""].filter(Boolean).join(" ");
  if (!url)
    return `<div class="ph" style="${style};background:radial-gradient(ellipse at 50% 35%,#8a8a86,#3a3a38 75%);"><span class="phl">${esc(opts.label ?? "PHOTO")}</span></div>`;
  return `<div class="ph" style="${style};"><img src="${esc(url)}" alt="" style="width:100%;height:100%;object-fit:cover;object-position:50% 25%;${filters ? `filter:${filters};` : ""}${opts.blur ? "transform:scale(1.08);" : ""}">${opts.grade ? '<div class="grain"></div>' : ""}</div>`;
}

/** A headline that fits `w` px (the page sizes it); `cls` adds solid / outline styling. */
const fit = (text: string, w: number, style: string, max = 400) => `<div class="fit" data-w="${w}" data-max="${max}" style="${style}">${esc(text)}</div>`;

function body(f: HeroFields): string {
  const L = HERO_LAYOUTS[f.layout];
  const p = f.photos;
  const a = safeColor(f.accent, L.defaults.accent);
  const g = f.grade;
  const words = (f.headline || L.defaults.headline).trim().split(/\s+/);
  const lab = (s: string, style: string) => (s ? `<div style="position:absolute;${style};font:500 11px/1 'Space Grotesk',Arial,sans-serif;letter-spacing:2px;">${esc(s)}</div>` : "");
  switch (f.layout) {
    case "night-shift":
      return `
${lab(f.label, `left:30px;top:40px;color:${BONE};font-size:19px;letter-spacing:.5px`)}
${photo(p[0], "left:38px;top:120px;width:310px;height:470px;transform:rotate(2deg)", { grade: g, label: "LOOK 01 full body" })}
${photo(p[1], "left:332px;top:94px;width:262px;height:300px;transform:rotate(-4deg)", { grade: g, label: "LOOK 02" })}
${photo(p[2], "left:350px;top:402px;width:230px;height:205px;transform:rotate(2deg)", { grade: g, label: "DETAIL" })}
<div style="position:absolute;left:442px;top:42px;width:112px;height:112px;border:3px solid ${BONE};border-radius:50%;"></div>
<div style="position:absolute;left:463px;top:88px;width:84px;height:5px;background:${a};transform:rotate(-42deg);"></div>
${fit(words[0] ?? "", 280, `position:absolute;left:30px;top:572px;color:${BONE};font-family:Anton,Impact,sans-serif;line-height:.86;`, 170)}
${fit(words.slice(1).join(" "), 270, `position:absolute;left:252px;top:636px;color:${a};font-family:Anton,Impact,sans-serif;line-height:.86;`, 170)}`;
    case "silhouette":
      return `
${photo(p[0], "left:10px;top:10px;width:580px;height:700px", { grade: g, bw: true, label: "B/W LOOK, industrial" })}
<div style="position:absolute;left:10px;top:360px;width:580px;height:350px;background:linear-gradient(180deg,rgba(10,10,10,0),${INK} 85%);"></div>
${lab(f.label, `left:30px;top:30px;color:${BONE};font-size:17px;letter-spacing:1px`)}
<img src="${PACK_BASE}/sparkle-${a === LIME ? "lime" : a === RED ? "red" : a === BONE ? "bone" : "orange"}.png" alt="" style="position:absolute;right:28px;top:22px;width:34px;height:34px;">
${fit(f.headline || "CARBON", 560, `position:absolute;left:20px;bottom:38px;color:${BONE};font-family:Anton,Impact,sans-serif;line-height:.86;`)}`;
    case "editorial": {
      const note = (f.note || "").split(/\n/).slice(0, 4);
      return `
${lab(f.label, `left:30px;top:30px;color:${BONE};font-size:17px;letter-spacing:1px`)}
${fit(f.headline || "UNFILTERED", 560, `position:absolute;left:20px;top:300px;color:${BONE};font-family:Anton,Impact,sans-serif;line-height:.86;`)}
${photo(p[0], "left:185px;top:70px;width:230px;height:540px;z-index:2;box-shadow:0 0 0 1px rgba(0,0,0,.3)", { grade: g, label: "MODEL (cut-out or full body)" })}
${note.length ? `<div style="position:absolute;right:26px;top:36px;width:150px;background:${STEEL};padding:12px 14px;z-index:3;font:500 14px/1.35 'Space Grotesk',Arial,sans-serif;color:${BONE};">${note.map(esc).join("<br>")}</div>` : ""}`;
    }
    case "monument": {
      const t = f.headline || "RAW DENIM";
      const row = (i: number) =>
        fit(t, 560, `position:absolute;left:20px;top:${22 + i * 118}px;font-family:Anton,Impact,sans-serif;line-height:.86;${i === 0 || i === 4 ? `color:${BONE};` : `color:${INK};-webkit-text-stroke:2px ${BONE};`}`);
      return `
${[0, 1, 2, 3, 4].map(row).join("")}
${photo(p[0], "left:195px;top:105px;width:210px;height:430px;z-index:2", { grade: g, label: "PRODUCT / model" })}
<div style="position:absolute;left:20px;right:20px;bottom:22px;text-align:center;font:700 15px/1 'Space Grotesk',Arial,sans-serif;letter-spacing:1px;color:${BONE};">// ${esc((f.subline || "").split("//").map((x) => x.trim()).filter(Boolean).join("  //  "))} //</div>`;
    }
    case "coordinates":
      return `
<div style="position:absolute;left:0;top:0;width:600px;height:72px;background:${INK};"></div>
${lab(f.label, `left:30px;top:27px;color:${BONE};font-size:19px;font-weight:700;letter-spacing:.5px`)}
<img src="${PACK_BASE}/barcode-bone.png" alt="" style="position:absolute;right:28px;top:16px;width:160px;height:41px;">
${photo(p[0], "left:0;top:72px;width:600px;height:548px", { grade: g, label: "SHOWROOM interior / storefront at night" })}
<div style="position:absolute;left:0;top:330px;width:600px;height:290px;background:linear-gradient(180deg,rgba(10,10,10,0),rgba(10,10,10,.85));"></div>
${fit(f.headline || "ORLANDO", 560, `position:absolute;left:20px;bottom:74px;color:${BONE};font-family:Anton,Impact,sans-serif;line-height:.86;`)}
${f.subline ? `<div style="position:absolute;left:20px;bottom:30px;background:${a};color:${BONE};font:700 16px/1 'Space Grotesk',Arial,sans-serif;letter-spacing:1px;padding:9px 12px;">${esc(f.subline)}</div>` : ""}`;
    case "brutal-grid": {
      const [w1 = "40%", w2 = "OFF", ...rest] = words;
      const w3 = rest.join(" ") || "GRID";
      return `
<div style="position:absolute;inset:0;background-image:linear-gradient(#1d1d1d 1px,transparent 1px),linear-gradient(90deg,#1d1d1d 1px,transparent 1px);background-size:40px 40px;"></div>
${fit(w1, 270, `position:absolute;left:24px;top:60px;color:${a};font-family:'Archivo Black',Arial,sans-serif;line-height:1;`, 150)}
${fit(w2, 270, `position:absolute;left:24px;top:205px;color:${BONE};font-family:'Archivo Black',Arial,sans-serif;line-height:1;`, 150)}
${fit(w3, 270, `position:absolute;left:24px;top:345px;color:transparent;-webkit-text-stroke:3px ${a};font-family:'Archivo Black',Arial,sans-serif;line-height:1;`, 150)}
${photo(p[0], `left:318px;top:62px;width:250px;height:380px;border:4px solid ${a};box-sizing:border-box`, { grade: g, label: "PRODUCT on model" })}
<img src="${PACK_BASE}/sparkle-lime.png" alt="" style="position:absolute;left:548px;top:42px;width:40px;height:40px;">`;
    }
    case "red-alert":
      return `
${fit(f.headline || "DROP ALERT", 540, `position:absolute;left:30px;top:28px;color:${INK};font-family:Anton,Impact,sans-serif;line-height:.86;`, 200)}
${photo(p[0], "left:40px;top:150px;width:520px;height:384px", { grade: g, label: "PRODUCT / the drop" })}
${f.subline ? `<div style="position:absolute;left:40px;top:534px;width:520px;height:46px;background:${INK};color:${BONE};font:700 19px/46px 'Space Grotesk',Arial,sans-serif;letter-spacing:.5px;padding:0 16px;box-sizing:border-box;white-space:nowrap;overflow:hidden;">${esc(f.subline)}</div>` : ""}`;
    case "teaser": {
      const br = (pos: string) => `<div style="position:absolute;${pos};width:40px;height:40px;"></div>`;
      const corner = (x: "left" | "right", y: "top" | "bottom") =>
        br(`${x}:24px;${y}:24px;border-${y}:4px solid ${INK};border-${x}:4px solid ${INK}`);
      return `
${photo(p[0], "left:0;top:0;width:600px;height:820px", { grade: g, blur: 14, label: "anything: it is blurred" })}
<div style="position:absolute;inset:0;background:${a};opacity:.47;"></div>
${corner("left", "top")}${corner("right", "top")}${corner("left", "bottom")}${corner("right", "bottom")}
${f.label ? `<div style="position:absolute;left:44px;top:46px;font:700 17px/1 'Space Grotesk',Arial,sans-serif;color:${INK};letter-spacing:1px;"><span style="display:inline-block;width:11px;height:11px;border-radius:50%;background:${RED};margin-right:8px;vertical-align:1px;"></span>${esc(f.label)}</div>` : ""}
${fit(f.headline || "SOON", 520, `position:absolute;left:40px;top:250px;color:${INK};font-family:Anton,Impact,sans-serif;line-height:.86;`)}
${f.subline ? `<div style="position:absolute;left:44px;bottom:48px;font:700 19px/1 'Space Grotesk',Arial,sans-serif;color:${INK};letter-spacing:.5px;">${esc(f.subline)}</div>` : ""}`;
    }
    case "cut-paste": {
      const [c1 = "STREET", ...c2] = (f.note || "STREET ISSUE").trim().split(/\s+/);
      const [h1 = "CUT", ...h2] = words;
      return `
${photo(p[0], "left:22px;top:66px;width:300px;height:390px;transform:rotate(-4deg)", { grade: g, label: "LOOK torn print" })}
<div style="position:absolute;left:300px;top:44px;width:290px;height:272px;background:${BONE};transform:rotate(3deg);overflow:hidden;">
  <div class="grain" style="opacity:.12;"></div>
  ${f.label ? `<div style="position:absolute;left:0;right:0;top:22px;text-align:center;font:700 19px/1 'Space Grotesk',Arial,sans-serif;color:${a};">${esc(f.label)}</div>` : ""}
  ${fit(c1, 190, `position:absolute;left:24px;top:62px;color:${INK};font-family:Anton,Impact,sans-serif;line-height:.9;`, 90)}
  ${fit(c2.join(" ") || "ISSUE", 150, `position:absolute;left:24px;top:142px;color:${BONE};-webkit-text-stroke:3px ${INK};font-family:Anton,Impact,sans-serif;line-height:.9;`, 90)}
</div>
${photo(p[1], "left:328px;top:302px;width:270px;height:235px;transform:rotate(3deg)", { grade: g, label: "DETAIL hands / pockets" })}
<div style="position:absolute;left:-40px;top:552px;width:680px;height:30px;background:url('${PACK_BASE}/hazard-orange.png') 0 0/600px 30px repeat-x;transform:rotate(5deg);"></div>
${fit(h1, 160, `position:absolute;left:24px;top:640px;color:${BONE};font-family:Anton,Impact,sans-serif;line-height:.86;`, 120)}
${fit(h2.join(" ") || "& PASTE", 330, `position:absolute;left:234px;top:640px;color:${INK};-webkit-text-stroke:3px ${BONE};font-family:Anton,Impact,sans-serif;line-height:.86;`, 120)}`;
    }
    case "quiet":
      return `
${photo(p[0], "left:120px;top:36px;width:360px;height:470px", { grade: false, label: "PRODUCT on a plinth, soft light" })}
${fit(f.headline || "THE ESSENTIALS", 540, `position:absolute;left:30px;top:540px;color:${INK};font-family:'Bebas Neue',Impact,sans-serif;line-height:.9;`, 130)}`;
  }
}

/** The page the server draws (and the editor shows): #pic, 600 px wide, its own height. */
export function heroPage(f: HeroFields): string {
  const L = HERO_LAYOUTS[f.layout] ?? HERO_LAYOUTS["night-shift"];
  // Size every headline to its width once the web fonts are really there (fonts.ready can resolve
  // before the font stylesheet has even arrived), and again whenever a font finishes loading.
  const fitJs = `(function(){var done=false;function go(){document.querySelectorAll('.fit').forEach(function(e){var w=+e.dataset.w,m=+e.dataset.max||400;e.style.fontSize='100px';var r=e.scrollWidth||1;e.style.fontSize=Math.min(m,Math.floor(100*w/r*10)/10)+'px';});}function finish(){go();if(!done){done=true;window.__heroReady=true;}}window.__heroReady=false;function fams(){var f=['Anton','Archivo Black','Bebas Neue','Space Grotesk'];return Promise.all(f.map(function(x){return document.fonts.load('100px "'+x+'"').catch(function(){});}));}window.addEventListener('load',function(){fams().then(function(){return document.fonts.ready;}).then(finish);});if(document.fonts){document.fonts.addEventListener('loadingdone',go);}setTimeout(finish,6000);})();`;
  return `<!doctype html><html><head><meta charset="utf-8">${FONTS}<style>
html,body{margin:0;padding:0;background:${L.bg};}
#pic{position:relative;width:600px;height:${L.height}px;overflow:hidden;background:${L.bg};-webkit-font-smoothing:antialiased;}
#pic *{box-sizing:border-box;}
.ph{position:absolute;overflow:hidden;background:#3a3a38;}
.phl{position:absolute;left:8px;bottom:8px;background:${BONE};color:${INK};font:700 10px/1 'Space Grotesk',Arial,sans-serif;padding:4px 6px;letter-spacing:.5px;}
.grain{position:absolute;inset:0;background:url('${PACK_BASE}/grain.png') 0 0/150px 150px;opacity:.15;mix-blend-mode:overlay;pointer-events:none;}
.fit{display:inline-block;white-space:nowrap;text-transform:uppercase;font-size:100px;}
</style></head><body><div id="pic">${body({ ...L.defaults, ...f, accent: f.accent || L.defaults.accent })}</div><script>${fitJs}</script></body></html>`;
}

export function heroDefaults(layout: HeroLayout): HeroFields {
  const L = HERO_LAYOUTS[layout];
  return { layout, photos: Array.from({ length: L.photos }, () => null), grade: true, ...L.defaults };
}

/** Words for people with pictures off (alt text). */
export function heroAlt(f: HeroFields): string {
  return [f.headline, f.subline].filter(Boolean).join(" — ").slice(0, 200) || "CARBON";
}
