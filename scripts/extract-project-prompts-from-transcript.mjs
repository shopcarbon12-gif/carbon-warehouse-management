/**
 * Reads combined-cursor-conversations-user-cursor.txt and writes a slimmer file:
 * only User messages that look like project dev work (WMS / mobile / deploy / repo),
 * excluding drive cleanup, personal SDK-on-D setup, OneDrive, 123Scan PC choice, etc.
 *
 * Order: same as source (oldest → newest). Consecutive duplicate prompts are collapsed.
 *
 * Usage:
 *   node scripts/extract-project-prompts-from-transcript.mjs [input.txt] [output.txt]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const defaultIn = path.join(repoRoot, "combined-cursor-conversations-user-cursor.txt");
const defaultOut = path.join(repoRoot, "project-dev-prompts-chronological.txt");

/** Non–project housekeeping / machine setup — drop if any matches (case-insensitive). */
const EXCLUDE_BODY = [
  /there are \d+ files in .*clause/i,
  /clause folder in c:\\?/i,
  /clause folder in c:\//i,
  /clean all your files you create on c:/i,
  /clean all files from c:\\?/i,
  /clean all files you created that no need/i,
  /clean after you c:\\?/i,
  /critically low on disk space/i,
  /find and delete all build artifacts/i,
  /heavy dependency folders you can safely delete/i,
  /remove all onedrive/i,
  /delete Flutter from c:\\?/i,
  /delete flutter from c:\\?/i,
  /reinstall on d:\\?/i,
  /make sure all files and cache it created will go to d:\\?/i,
  /do not adding any new files on c:\\?/i,
  /do i need to install dart sdk/i,
  /what is my gradle path/i,
  /what is my flutter sdk path/i,
  /check what android (?:auto )?studio gradle and flutter/i,
  /^this was your last output on the other chat:/i,
  /WHICH ONE SHOULD I DOWNLOAD[\s\S]*Zebra_123Scan/i,
  /Zebra_123Scan_\(\d+bit\)/i,
  /^clean it all(?:\s+again)?\s*$/i,
  /^clean it all\s*$/i,
];

/** Drop whole message if it looks like only Cursor/system scaffolding with no real ask. */
function isNoiseOnly(body) {
  const t = body.trim();
  if (t.length < 8) return true;
  if (/^\[Attached image\(s\)\]\s*$/i.test(t)) return true;
  if (/^<git_status>[\s\S]*<\/git_status>\s*$/i.test(t) && !/<user_query>[\s\S]*\S/.test(t))
    return true;
  return false;
}

function shouldExclude(body) {
  if (isNoiseOnly(body)) return true;
  const oneLine = body.replace(/\s+/g, " ").trim();
  if (oneLine.length < 12 && !/(deploy|migrate|wms|api|fix|build|apk|commit|push)/i.test(oneLine))
    return true;
  return EXCLUDE_BODY.some((re) => re.test(body));
}

function normalizeForDedupe(body) {
  return body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.replace(/^\s{2}/, "").trimEnd())
    .join("\n")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function formatBody(body) {
  return body
    .split("\n")
    .map((l) => (l.startsWith("  ") ? l.slice(2) : l))
    .join("\n")
    .trim();
}

/** Remove Cursor-injected context blobs; keep the user’s actual words when tagged. */
function sanitizeBody(body) {
  let t = body;
  t = t.replace(/<external_links>[\s\S]*?<\/external_links>\s*/gi, "");
  t = t.replace(/<git_status>[\s\S]*?<\/git_status>\s*/gi, "");
  t = t.replace(/<agent_transcripts>[\s\S]*?<\/agent_transcripts>\s*/gi, "");
  t = t.replace(/<attached_folders>[\s\S]*?<\/attached_folders>\s*/gi, "");
  const uq = t.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  if (uq) t = uq[1].trim();
  t = t.replace(/^\[Image\]\s*/i, "").trim();
  return t.trim();
}

function parseUserMessages(text) {
  const lines = text.split(/\n/);
  const messages = [];
  let collecting = false;
  let buf = [];

  const flush = () => {
    if (!collecting || buf.length === 0) return;
    const raw = buf.join("\n");
    const formatted = formatBody(raw);
    if (formatted) messages.push(formatted);
    buf = [];
  };

  for (const line of lines) {
    if (line === "User:") {
      flush();
      collecting = true;
      continue;
    }
    if (collecting && (line === "Cursor:" || line.startsWith("="))) {
      flush();
      collecting = false;
      continue;
    }
    if (collecting) buf.push(line);
  }
  flush();
  return messages;
}

const inputPath = process.argv[2] || defaultIn;
const outputPath = process.argv[3] || defaultOut;

if (!fs.existsSync(inputPath)) {
  console.error("Input not found:", inputPath);
  console.error("Run: node scripts/export-cursor-transcripts-human.mjs");
  process.exit(1);
}

const text = fs.readFileSync(inputPath, "utf8");
const allUser = parseUserMessages(text);

const kept = [];
let lastKey = null;
for (const raw of allUser) {
  const body = sanitizeBody(raw);
  if (!body) continue;
  if (shouldExclude(body)) continue;
  const key = normalizeForDedupe(body);
  if (key.length < 20 && !/\b(wms|deploy|migrate|lightspeed|inventory|rfid|flutter|api|docker|coolify|next|sql|tenant)\b/i.test(body))
    continue;
  if (key === lastKey) continue;
  lastKey = key;
  kept.push(body);
}

// Relax: some valid short prompts ("deploy", "yes do it") — second pass: re-include if we were too aggressive
// For bodies 12-19 chars, allow if project keyword
const header = [
  "Carbon WMS — project development prompts (User only)",
  `Extracted: ${new Date().toISOString()}`,
  `Source: ${inputPath}`,
  `Included: ${kept.length} prompts (consecutive duplicates removed; drive/SDK/PC-only cleanup excluded; websearch/git_status wrappers stripped).`,
  "",
  "---",
  "",
].join("\n");

const chunks = [header];
let n = 1;
for (const body of kept) {
  chunks.push(`${n}.`);
  chunks.push("");
  chunks.push(body);
  chunks.push("");
  chunks.push("---");
  chunks.push("");
  n++;
}

fs.writeFileSync(outputPath, chunks.join("\n"), "utf8");
console.log("Wrote", outputPath, "prompts:", kept.length, "bytes:", fs.statSync(outputPath).size);
