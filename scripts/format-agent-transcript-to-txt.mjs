/**
 * One-off / reusable: JSONL parent transcript → clean user/cursor .txt
 * Usage: node scripts/format-agent-transcript-to-txt.mjs <input.jsonl> <output.txt>
 */
import fs from "node:fs";
import path from "node:path";

const [,, inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error("Usage: node scripts/format-agent-transcript-to-txt.mjs <in.jsonl> <out.txt>");
  process.exit(1);
}

function textFromMessage(msg) {
  const c = msg?.message?.content;
  if (!Array.isArray(c)) return "";
  const parts = [];
  for (const block of c) {
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n").trim();
}

function sanitizeUserText(s) {
  let t = s;
  // Strip image_files blocks → short note
  t = t.replace(
    /\[Image\][\s\S]*?<\/image_files>/gi,
    "[Image attached]\n",
  );
  t = t.replace(/<external_links>[\s\S]*?<\/external_links>\s*/gi, "");
  t = t.replace(/<\/?user_query>\s*/gi, "");
  return t.trim();
}

function stripMarkdownNoise(s) {
  // Bold only; leave backticks/code fences intact for readability
  return s.replace(/\*\*([^*]+)\*\*/g, "$1");
}

const raw = fs.readFileSync(inPath, "utf8");
const lines = raw.split(/\r?\n/).filter((l) => l.trim());

const blocks = [];
let pendingAssistant = [];

function flushAssistant() {
  if (pendingAssistant.length === 0) return;
  const merged = pendingAssistant
    .map((s) => stripMarkdownNoise(s).trim())
    .filter(Boolean)
    .join("\n\n");
  blocks.push({ role: "assistant", text: merged });
  pendingAssistant = [];
}

for (const line of lines) {
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    continue;
  }
  const text = textFromMessage(row);
  if (!text) continue;

  if (row.role === "user") {
    flushAssistant();
    blocks.push({ role: "user", text: sanitizeUserText(text) });
  } else if (row.role === "assistant") {
    pendingAssistant.push(text);
  }
}
flushAssistant();

const out = [];
for (const b of blocks) {
  if (b.role === "user") {
    out.push("user: (me)");
    out.push(b.text);
    out.push("");
  } else {
    out.push("cursor: (you)");
    out.push(b.text);
    out.push("");
  }
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, out.join("\n").trimEnd() + "\n", "utf8");
console.log("Wrote", outPath, "blocks:", blocks.length);
