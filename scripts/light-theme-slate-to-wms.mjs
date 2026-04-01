/**
 * One-off codemod: replace hardcoded slate/zinc Tailwind classes with WMS CSS variables
 * so light theme (data-theme="light", no .dark) matches approved palette.
 * Run: node scripts/light-theme-slate-to-wms.mjs
 */
import fs from "node:fs";
import path from "node:path";

const roots = ["app", "components"];

/** Longer patterns first */
const pairs = [
  ["border-slate-800/60", "border-[var(--wms-border)]/60"],
  ["border-slate-800/40", "border-[var(--wms-border)]/40"],
  ["hover:bg-zinc-900/50", "hover:bg-[var(--wms-surface-elevated)]/70"],
  ["hover:bg-zinc-900/60", "hover:bg-[var(--wms-surface-elevated)]/80"],
  ["bg-zinc-900/40", "bg-[var(--wms-surface-elevated)]/50"],
  ["bg-zinc-900/50", "bg-[var(--wms-surface-elevated)]/60"],
  ["divide-slate-800", "divide-[var(--wms-border)]"],
  ["divide-slate-700", "divide-[var(--wms-border)]"],
  ["ring-slate-800", "ring-[var(--wms-border)]"],
  ["ring-slate-700", "ring-[var(--wms-border)]"],
  ["border-slate-800", "border-[var(--wms-border)]"],
  ["border-slate-700", "border-[var(--wms-border)]"],
  ["border-slate-600", "border-[var(--wms-border)]"],
  ["bg-zinc-950", "bg-[var(--wms-surface)]"],
  ["bg-zinc-900", "bg-[var(--wms-surface-elevated)]"],
  ["bg-slate-950", "bg-[var(--wms-surface)]"],
  ["bg-slate-900", "bg-[var(--wms-surface-elevated)]"],
  ["bg-slate-800/60", "bg-[var(--wms-surface-elevated)]/80"],
  ["bg-slate-800", "bg-[var(--wms-surface-elevated)]"],
  ["hover:bg-slate-800/60", "hover:bg-[var(--wms-surface-elevated)]/80"],
  ["hover:bg-slate-800", "hover:bg-[var(--wms-surface-elevated)]"],
  ["hover:bg-zinc-800", "hover:bg-[var(--wms-surface-elevated)]"],
  ["text-slate-600", "text-[var(--wms-muted)]"],
  ["text-slate-500", "text-[var(--wms-muted)]"],
  ["text-slate-400", "text-[var(--wms-muted)]"],
  ["text-slate-300", "text-[var(--wms-fg)]"],
  ["text-slate-200", "text-[var(--wms-fg)]"],
  ["text-slate-100", "text-[var(--wms-fg)]"],
  ["placeholder-slate-500", "placeholder-[var(--wms-muted)]"],
];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

let changed = 0;
for (const root of roots) {
  const base = path.join(process.cwd(), root);
  for (const file of walk(base)) {
    let s = fs.readFileSync(file, "utf8");
    const orig = s;
    for (const [a, b] of pairs) {
      s = s.split(a).join(b);
    }
    if (s !== orig) {
      fs.writeFileSync(file, s, "utf8");
      changed++;
      console.log("updated", path.relative(process.cwd(), file));
    }
  }
}
console.log("files changed:", changed);
