/**
 * Extracts project-oriented User prompts from Cursor parent-chat transcripts.
 *
 * **Source:** Reads `*.jsonl` directly (full message text as stored by Cursor).
 * Does not use combined-cursor-conversations-user-cursor.txt — that intermediate
 * format cannot add text missing from JSONL. If a prompt ends mid-sentence in
 * the export, Cursor’s log for that turn is incomplete; there is nothing else
 * to pull from these files.
 *
 * Order: oldest chat → newest (by .jsonl file birthtime), then line order within each file.
 * Consecutive duplicate prompts (after sanitize) are collapsed.
 *
 * Usage:
 *   node scripts/extract-project-prompts-from-transcript.mjs [agentTranscriptsDir] [output.txt]
 *
 * Env:
 *   CURSOR_AGENT_TRANSCRIPTS_DIR
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const defaultTranscriptRoot = path.join(
  os.homedir(),
  ".cursor",
  "projects",
  "d-Projects-My-project-carbon-warehouse-management",
  "agent-transcripts",
);

const defaultOut = path.join(repoRoot, "project-dev-prompts-chronological.txt");

function walkJsonlFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkJsonlFiles(p));
    else if (ent.isFile() && ent.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

function transcriptSortKey(filePath) {
  const st = fs.statSync(filePath);
  if (st.birthtimeMs > 0) return st.birthtimeMs;
  return st.mtimeMs;
}

function textFromContent(content) {
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n").trim();
}

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

function isNoiseOnly(body) {
  const t = body.trim();
  if (t.length === 0) return true;
  if (t.length < 8 && !/\S{4,}/.test(t)) return true;
  if (/^\[Attached image\(s\)\]\s*$/i.test(t)) return true;
  if (/^<git_status>[\s\S]*<\/git_status>\s*$/i.test(t) && !/<user_query>[\s\S]*\S/.test(t))
    return true;
  return false;
}

function shouldExclude(body) {
  if (isNoiseOnly(body)) return true;
  return EXCLUDE_BODY.some((re) => re.test(body));
}

function normalizeForDedupe(body) {
  return body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Strip Cursor-injected blobs. Prefer inner <user_query> when present.
 * Removes <attached_files> blocks (file paths / selections) but keeps surrounding text.
 */
function sanitizeBody(body) {
  let t = body;
  t = t.replace(/<external_links>[\s\S]*?<\/external_links>\s*/gi, "");
  t = t.replace(/<git_status>[\s\S]*?<\/git_status>\s*/gi, "");
  t = t.replace(/<agent_transcripts>[\s\S]*?<\/agent_transcripts>\s*/gi, "");
  t = t.replace(/<attached_folders>[\s\S]*?<\/attached_folders>\s*/gi, "");
  t = t.replace(/<attached_files>[\s\S]*?<\/attached_files>\s*/gi, "");
  const uq = t.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  if (uq) t = uq[1].trim();
  t = t.replace(/^\[Image\]\s*/i, "").trim();
  return t.trim();
}

function extractUserPromptsFromJsonl(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (rec.role !== "user") continue;
    const blob = textFromContent(rec.message?.content);
    if (!blob) continue;
    const body = sanitizeBody(blob);
    if (!body) continue;
    if (shouldExclude(body)) continue;
    out.push({
      body,
      chatId: path.basename(filePath, ".jsonl"),
      sourceFile: filePath,
    });
  }
  return out;
}

const transcriptDir =
  process.argv[2] || process.env.CURSOR_AGENT_TRANSCRIPTS_DIR || defaultTranscriptRoot;
const outputPath = process.argv[3] || defaultOut;

if (!fs.existsSync(transcriptDir)) {
  console.error("Transcripts directory not found:", transcriptDir);
  console.error("Set CURSOR_AGENT_TRANSCRIPTS_DIR or pass the path to agent-transcripts.");
  process.exit(1);
}

const files = walkJsonlFiles(transcriptDir).sort(
  (a, b) => transcriptSortKey(a) - transcriptSortKey(b),
);

const merged = [];
for (const file of files) {
  merged.push(...extractUserPromptsFromJsonl(file));
}

const kept = [];
let lastKey = null;
for (const { body, chatId, sourceFile } of merged) {
  const key = normalizeForDedupe(body);
  if (key === lastKey) continue;
  lastKey = key;
  kept.push({ body, chatId, sourceFile });
}

const header = [
  "Carbon WMS — project development prompts (User only)",
  `Extracted: ${new Date().toISOString()}`,
  `Source: ${transcriptDir} (*.jsonl, oldest → newest by file creation time)`,
  `Included: ${kept.length} prompts (consecutive duplicates removed; drive/SDK/PC-only cleanup excluded).`,
  "",
  "Note: Text is exactly what Cursor stored per user turn. If a line ends abruptly,",
  "that turn was incomplete in the chat log — reruns cannot recover missing words.",
  "",
  "---",
  "",
].join("\n");

const chunks = [header];
let n = 1;
for (const { body, chatId, sourceFile } of kept) {
  chunks.push(`${n}.`);
  chunks.push(`Chat: ${chatId}`);
  chunks.push("");
  chunks.push(body);
  chunks.push("");
  chunks.push("---");
  chunks.push("");
  n++;
}

fs.writeFileSync(outputPath, chunks.join("\n"), "utf8");
console.log("Wrote", outputPath);
console.log("Prompts:", kept.length, "bytes:", fs.statSync(outputPath).size);
console.log("JSONL files:", files.length);
