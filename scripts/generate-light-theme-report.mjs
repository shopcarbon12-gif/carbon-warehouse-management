#!/usr/bin/env node
/**
 * Builds docs/light-theme-evidence/light-theme-report.html with embedded PNGs (data URLs)
 * so images are visible when opening the file from any location.
 *
 *   node scripts/generate-light-theme-report.mjs
 */
import fs from "node:fs";
import path from "node:path";

const root = path.join(process.cwd(), "docs", "light-theme-evidence");
const beforeDir = path.join(root, "before");
const afterDir = path.join(root, "after");
const outFile = path.join(root, "light-theme-report.html");

function pngs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".png"))
    .sort();
}

function toDataUrl(filePath) {
  const b = fs.readFileSync(filePath);
  return `data:image/png;base64,${b.toString("base64")}`;
}

const beforeFiles = pngs(beforeDir);
const afterFiles = pngs(afterDir);
const names = [...new Set([...beforeFiles, ...afterFiles])].sort();

const globalChanges = `
<ul>
  <li>Light mode CSS variables aligned to approved design review: page background <code>#f3f3f4</code>, surfaces <code>#ffffff</code> / <code>#eeeeee</code>, text <code>#1a1d1f</code>, muted <code>#5c6366</code>, accent <code>#0b9597</code>, secondary label tone <code>#587e7e</code>, borders softened to match outline tokens.</li>
  <li>Added <code>--wms-accent-fg</code> for primary buttons; root font scale <code>wms-text-lg</code> uses <code>line-height: 1.55</code> and slightly roomier main padding so larger type does not crowd chrome.</li>
  <li>Introduced <code>.wms-page-header</code> (gradient band + card edge on light) so route titles read as headers, not plain body copy.</li>
  <li>Replaced hardcoded <code>slate-*</code> / <code>zinc-*</code> utility colors in app/components with <code>var(--wms-*)</code> so the same markup works in dark and light.</li>
  <li>Fonts unchanged: <strong>Outfit</strong> + <strong>JetBrains Mono</strong> (no switch to Inter/Manrope in the product).</li>
</ul>
`;

let body = "";
for (const file of names) {
  const bp = path.join(beforeDir, file);
  const ap = path.join(afterDir, file);
  const route = file.replace(/\.png$/, "").replace(/__/g, "/");
  const bSrc = fs.existsSync(bp) ? toDataUrl(bp) : "";
  const aSrc = fs.existsSync(ap) ? toDataUrl(ap) : "";

  body += `
  <section>
    <h2>/${route}</h2>
    <div class="pair">
      <div class="shot">
        <h3>Before</h3>
        ${bSrc ? `<img src="${bSrc}" alt="Before ${route}" />` : `<p class="missing">No before capture</p>`}
      </div>
      <div class="shot">
        <h3>After</h3>
        ${aSrc ? `<img src="${aSrc}" alt="After ${route}" />` : `<p class="missing">No after capture</p>`}
      </div>
    </div>
    <p class="route-note">Same route with light theme + large type preset in localStorage for capture.</p>
  </section>`;
}

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Carbon WMS — Light theme evidence (before / after)</title>
  <style>
    :root { --bg: #f1f5f9; --card: #fff; --border: #e2e8f0; --text: #0f172a; --muted: #64748b; }
    * { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; margin: 0; padding: 1.5rem; background: var(--bg); color: var(--text); line-height: 1.5; }
    h1 { font-size: 1.5rem; margin: 0 0 0.5rem; }
    .lede { color: var(--muted); max-width: 80ch; margin-bottom: 1rem; }
    .lede.warn { background: #fffbeb; border: 1px solid #fcd34d; padding: 0.75rem 1rem; border-radius: 8px; color: #78350f; max-width: 90ch; }
    section { margin-bottom: 3rem; }
    h2 { font-size: 1.05rem; border-bottom: 2px solid var(--border); padding-bottom: 0.35rem; margin: 0 0 1rem; font-family: ui-monospace, monospace; }
    .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 0.5rem; }
    @media (max-width: 1100px) { .pair { grid-template-columns: 1fr; } }
    .shot { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 0.75rem; }
    .shot h3 { margin: 0 0 0.5rem; font-size: 0.9rem; color: var(--muted); }
    .shot img { width: 100%; height: auto; display: block; border-radius: 4px; border: 1px solid var(--border); }
    .missing { color: #b91c1c; font-size: 0.875rem; margin: 0; padding: 2rem; text-align: center; background: #fef2f2; border-radius: 4px; }
    .route-note { font-size: 0.8rem; color: var(--muted); margin: 0.5rem 0 0; }
    .global { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 1rem 1.25rem; margin-bottom: 2rem; }
    .global ul { margin: 0.5rem 0 0; }
    .global li { margin-bottom: 0.35rem; }
    code { font-size: 0.85em; background: #f1f5f9; padding: 0.1em 0.35em; border-radius: 3px; }
  </style>
</head>
<body>
  <h1>Carbon WMS web — light theme pass</h1>
  <p class="lede">Before / after full-page captures with <strong>light</strong> color mode and <strong>large</strong> font scale. Images are embedded (data URLs) so they render without separate files. Web only; APK not modified.</p>
  <p class="lede warn"><strong>Capture note:</strong> The first &ldquo;before&rdquo; pass ran while the app on port 3040 was busy and login env vars were not picked up, so many &ldquo;before&rdquo; panes show the sign-in screen. The &ldquo;after&rdquo; pass used <code>next start</code> on port <code>3050</code> with valid <code>WMS_SCREENSHOT_*</code> / <code>SEED_ADMIN_PASSWORD</code> from <code>.env.local</code> and shows authenticated views. Re-run <code>node scripts/capture-theme-evidence.mjs before</code> from the previous commit if you need a matched logged-in baseline.</p>
  <div class="global">
    <strong>What changed (summary)</strong>
    ${globalChanges}
  </div>
  ${body}
</body>
</html>
`;

fs.writeFileSync(outFile, html, "utf8");
console.log("Wrote", outFile, "sections:", names.length);
console.log("Note: embedded report can be large (several MB).");
