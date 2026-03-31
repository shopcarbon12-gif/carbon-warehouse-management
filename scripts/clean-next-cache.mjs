/**
 * Remove `.next` (dev + build output). Use when `next dev` throws ENOENT under
 * `.next/dev` or webpack "invalid stored block lengths" — fixes broken login / uploads locally.
 *
 * Stop `npm run dev` first, then: `node scripts/clean-next-cache.mjs`
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const target = path.join(root, ".next");

if (!fs.existsSync(target)) {
  console.log("No .next folder; nothing to remove.");
  process.exit(0);
}

fs.rmSync(target, { recursive: true, force: true });
console.log("Removed .next — run npm run dev again.");
