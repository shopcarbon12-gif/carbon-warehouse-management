/**
 * Reads Cursor parent-chat *.jsonl files and writes a plain-text log:
 *   User:
 *   ...
 *   Cursor:
 *   ...
 *
 * Usage:
 *   node scripts/export-cursor-transcripts-human.mjs [transcriptsDir] [outFile]
 *
 * Env:
 *   CURSOR_AGENT_TRANSCRIPTS_DIR — folder containing chat UUID subdirs with .jsonl
 *
 * Default transcriptsDir (Windows): ~/.cursor/projects/d-Projects-My-project-carbon-warehouse-management/agent-transcripts
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

/** Oldest first: use transcript file birthtime (Windows: Creation time), else mtime. */
function transcriptSortKey(filePath) {
  const st = fs.statSync(filePath);
  const birth = st.birthtimeMs;
  if (birth && birth > 0) return birth;
  return st.mtimeMs;
}

function cleanUserText(text) {
  if (!text) return "";
  let t = String(text).trim();
  const wrapped = t.match(/^<user_query>\s*([\s\S]*?)\s*<\/user_query>$/i);
  if (wrapped) t = wrapped[1].trim();
  if (t.includes("<image_files>")) {
    t = t.replace(/<image_files>[\s\S]*?<\/image_files>/gi, "[Attached image(s)]").trim();
  }
  return t;
}

function textFromContent(content) {
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      parts.push(block.text);
    } else if (block.type && block.type !== "text") {
      parts.push(`[${block.type}]`);
    }
  }
  return parts.join("\n").trim();
}

function formatTurn(role, body) {
  const label = role === "user" ? "User" : "Cursor";
  const lines = body.split(/\r?\n/);
  return [`${label}:`, ...lines.map((line) => (line.length ? `  ${line}` : ""))].join("\n");
}

const transcriptDir =
  process.argv[2] ||
  process.env.CURSOR_AGENT_TRANSCRIPTS_DIR ||
  defaultTranscriptRoot;

const outFile =
  process.argv[3] ||
  path.join(repoRoot, "combined-cursor-conversations-user-cursor.txt");

const files = walkJsonlFiles(transcriptDir).sort(
  (a, b) => transcriptSortKey(a) - transcriptSortKey(b),
);

if (files.length === 0) {
  console.error(
    "No .jsonl files under:",
    transcriptDir,
    "\nPass the agent-transcripts directory as the first argument or set CURSOR_AGENT_TRANSCRIPTS_DIR.",
  );
  process.exit(1);
}

const header = [
  "Carbon Warehouse Management — Cursor chats (plain text)",
  `Generated: ${new Date().toISOString()}`,
  `Source: ${transcriptDir}`,
  `Chats (files): ${files.length}`,
  "Chats: oldest → newest (by transcript .jsonl file creation time on this machine).",
  "Format: User / Cursor (chronological within each chat).",
  "",
].join("\n");

const sections = [header];

for (const file of files) {
  const id = path.basename(file, ".jsonl");
  const st = fs.statSync(file);
  const created = st.birthtimeMs > 0 ? st.birthtime : st.mtime;
  const createdLabel = created.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  });
  sections.push("=".repeat(80));
  sections.push(`Chat: ${id}`);
  sections.push(`Transcript file created: ${createdLabel}`);
  sections.push("=".repeat(80));
  sections.push("");

  const raw = fs.readFileSync(file, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      sections.push(`Cursor:\n  [unparseable line]\n`);
      continue;
    }
    const role = rec.role;
    if (role !== "user" && role !== "assistant") continue;

    let body = textFromContent(rec.message?.content);
    if (role === "user") body = cleanUserText(body);
    if (!body) continue;

    sections.push(formatTurn(role === "assistant" ? "assistant" : "user", body));
    sections.push("");
  }
}

fs.writeFileSync(outFile, sections.join("\n"), "utf8");
console.log("Wrote", outFile, "bytes:", fs.statSync(outFile).size);
