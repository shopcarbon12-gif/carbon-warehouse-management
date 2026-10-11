/**
 * Minimal Anthropic Messages API client (no SDK dependency).
 *
 * Used by the Shopify translation job. The key is ANTHROPIC_API_KEY (Coolify
 * env); the model defaults to Claude Sonnet 5 and can be overridden with
 * CLAUDE_MODEL. Callers ask for JSON and get the parsed object back.
 */

const API_URL = "https://api.anthropic.com/v1/messages";

export function claudeConfigured(): boolean {
  return Boolean((process.env.ANTHROPIC_API_KEY || "").trim());
}

export function claudeModel(): string {
  return (process.env.CLAUDE_MODEL || "").trim() || "claude-sonnet-5";
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Pull the first JSON object out of a reply (models sometimes wrap it in ```json fences). */
function parseJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Claude reply had no JSON object");
  return JSON.parse(text.slice(start, end + 1));
}

/**
 * One system + user turn, answer parsed as JSON. Retries rate limits, overload
 * and malformed JSON (long HTML bodies occasionally come back truncated).
 */
export async function claudeJson<T>(
  system: string,
  user: string,
  opts: { maxTokens?: number; attempts?: number } = {},
): Promise<T> {
  const key = (process.env.ANTHROPIC_API_KEY || "").trim();
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
  const attempts = opts.attempts ?? 4;
  let lastErr = "unknown error";
  for (let a = 0; a < attempts; a++) {
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: claudeModel(),
          max_tokens: opts.maxTokens ?? 8000,
          system,
          messages: [{ role: "user", content: user }],
        }),
        cache: "no-store",
      });
      if (res.status === 429 || res.status === 529 || res.status >= 500) {
        lastErr = `Claude HTTP ${res.status}`;
        await sleep(2000 * (a + 1));
        continue;
      }
      const j = (await res.json()) as {
        content?: Array<{ type: string; text?: string }>;
        error?: { message?: string };
        stop_reason?: string;
      };
      if (!res.ok) throw new Error(j.error?.message || `Claude HTTP ${res.status}`);
      const text = (j.content || []).filter((c) => c.type === "text").map((c) => c.text || "").join("");
      return parseJsonObject(text) as T;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      await sleep(1500 * (a + 1));
    }
  }
  throw new Error(lastErr);
}
