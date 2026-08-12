// Small, self-contained LLM text helpers for the SEO routes.
// Mirrors the patterns used in app/api/generate/route.ts but kept standalone
// so SEO features don't depend on the image-generation route internals.

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return (await Promise.race([promise, timeout])) as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Extract plain text from an OpenAI Responses API or Chat Completions result. */
export function extractOpenAiOutputText(result: any): string {
  if (!result) return "";
  if (typeof result.output_text === "string" && result.output_text.trim()) {
    return result.output_text;
  }
  // Responses API: output[].content[].text
  const out = result.output;
  if (Array.isArray(out)) {
    const parts: string[] = [];
    for (const item of out) {
      const content = item?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (typeof c?.text === "string") parts.push(c.text);
        }
      }
    }
    if (parts.length) return parts.join("\n");
  }
  // Chat Completions fallback
  const choice = result?.choices?.[0]?.message?.content;
  if (typeof choice === "string") return choice;
  return "";
}

/** Parse the first JSON object found in a text blob (handles code fences/prose). */
export function parseJsonObjectFromText(text: string): Record<string, any> | null {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    /* fall through to brace extraction */
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const slice = raw.slice(start, end + 1);
    try {
      return JSON.parse(slice);
    } catch {
      return null;
    }
  }
  return null;
}

export function asStringArray(value: unknown, max = 30): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => String(v ?? "").trim())
    .filter(Boolean)
    .slice(0, max);
}
