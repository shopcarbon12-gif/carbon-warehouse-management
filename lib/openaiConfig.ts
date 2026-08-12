import fs from "node:fs";

function readFirstExistingFile(paths: string[]) {
  for (const p of paths) {
    const filePath = String(p || "").trim();
    if (!filePath) continue;
    try {
      if (fs.existsSync(filePath)) {
        const value = fs.readFileSync(filePath, "utf8").trim();
        if (value) return value;
      }
    } catch {
      // Ignore unreadable files and continue fallback chain.
    }
  }
  return "";
}

export function getOpenAiApiKey() {
  const direct =
    (process.env.OPENAI_API_KEY || "").trim() ||
    (process.env.OPENAI_KEY || "").trim() ||
    (process.env.OPENAI_SECRET_KEY || "").trim() ||
    (process.env.OPENAI_API_TOKEN || "").trim();
  if (direct) return direct;

  return readFirstExistingFile([
    process.env.OPENAI_API_KEY_FILE || "",
    process.env.OPENAI_KEY_FILE || "",
    process.env.OPENAI_SECRET_KEY_FILE || "",
    "/app/.openai-api-key",
  ]);
}

