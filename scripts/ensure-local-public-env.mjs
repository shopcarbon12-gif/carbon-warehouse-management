/**
 * Writes gitignored `.env.local` with public URL vars for `npm run dev` parity.
 * Safe to run repeatedly — overwrites only these two keys; keeps other lines.
 *
 *   npm run env:ensure-local
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const target = path.join(root, ".env.local");

const LOCAL = "http://localhost:3040";
const KEYS = new Set(["WMS_APP_PUBLIC_BASE_URL", "NEXT_PUBLIC_BASE_URL"]);

let text = "";
if (fs.existsSync(target)) {
  text = fs.readFileSync(target, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
}

const rest = [];
for (const line of text.split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) {
    rest.push(line);
    continue;
  }
  const i = line.indexOf("=");
  if (i <= 0) {
    rest.push(line);
    continue;
  }
  const k = line.slice(0, i).trim();
  if (KEYS.has(k)) continue;
  rest.push(line);
}

const header = `# Carbon WMS — local public URLs (gitignored). See .env.example / README.\n`;
const block = `WMS_APP_PUBLIC_BASE_URL=${LOCAL}\nNEXT_PUBLIC_BASE_URL=${LOCAL}\n`;
const tail = rest.filter((l) => l.trim().length > 0).join("\n");
const out = tail ? `${header}\n${block}\n${tail}\n` : `${header}\n${block}`;

fs.writeFileSync(target, out, "utf8");
console.log("Wrote", target);
console.log("  WMS_APP_PUBLIC_BASE_URL=" + LOCAL);
console.log("  NEXT_PUBLIC_BASE_URL=" + LOCAL);
