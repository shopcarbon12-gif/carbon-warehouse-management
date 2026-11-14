/**
 * CarbonWMS Creative — the "brain" (OpenAI, owner's key). `json()` = one structured call when the
 * owner is waiting; `submitBatch()` / `collectBatch()` = the Batch API (50% off, ≤ 24 h) for
 * everything that can wait (Radar tagging, idea lists, caption variations).
 */
import { z } from "zod";
import type { Pool } from "pg";
import { openai, recordSpend, spendGate, textModel, PlainError } from "./config";
import { textCost } from "./routing";

export type LlmImage = { url: string } | { b64: string; mime?: string };

export type JsonOpts = {
  tenantId: string;
  what: string;
  images?: LlmImage[];
  model?: string;
  projectId?: string | null;
  /** Rough upper bound used for the cap check before the call. */
  estimate?: number;
  maxOutputTokens?: number;
};

function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const s = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  delete s.$schema;
  return s;
}

function content(prompt: string, images: LlmImage[] = []) {
  return [
    { type: "input_text" as const, text: prompt },
    ...images.map((im) => ({
      type: "input_image" as const,
      detail: "auto" as const,
      image_url: "url" in im ? im.url : `data:${im.mime ?? "image/jpeg"};base64,${im.b64}`,
    })),
  ];
}

/** Pull the first JSON object out of a model reply (tolerates code fences). */
export function parseJsonText(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf("{");
    const b = t.lastIndexOf("}");
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error("The AI reply was not JSON");
  }
}

/**
 * The model's JSON is not schema-enforced (strict: false), so a reply can be a little off — 4 items
 * where 3 are allowed, a sentence past the length cap, an option spelled differently — and the whole
 * step used to fail (owner, 2026-11-14: "expected array to have <=3 items"). Mend what can be mended
 * without guessing content: cut over-long lists and text, swap an unknown option for the first allowed
 * one, drop a null where a value was optional. Anything else still fails.
 */
export function parseLenient<T>(schema: z.ZodType<T>, raw: unknown): ReturnType<z.ZodType<T>["safeParse"]> {
  const value = raw;
  let parsed = schema.safeParse(value);
  for (let round = 0; round < 25 && !parsed.success; round++) {
    let mended = false;
    for (const issue of parsed.error.issues) {
      const path = issue.path as (string | number)[];
      if (!path.length) continue;
      let parent: unknown = value;
      for (const k of path.slice(0, -1)) parent = (parent as Record<string | number, unknown> | null)?.[k];
      if (!parent || typeof parent !== "object") continue;
      const key = path[path.length - 1];
      const box = parent as Record<string | number, unknown>;
      const cur = box[key];
      if (issue.code === "too_big" && typeof issue.maximum === "number") {
        const max = Number(issue.maximum);
        const next = Array.isArray(cur) ? cur.slice(0, max) : typeof cur === "string" ? [...cur].slice(0, max).join("") : typeof cur === "number" ? max : undefined;
        if (next !== undefined) {
          box[key] = next;
          mended = true;
        }
      } else if (issue.code === "too_small" && typeof issue.minimum === "number" && typeof cur === "number") {
        box[key] = Number(issue.minimum);
        mended = true;
      } else if (issue.code === "invalid_value" && Array.isArray(issue.values) && issue.values.length) {
        const want = typeof cur === "string" ? cur.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
        box[key] = issue.values.find((v) => String(v).toLowerCase() === want) ?? issue.values[0];
        mended = true;
      }
    }
    if (!mended) break;
    parsed = schema.safeParse(value);
  }
  return parsed;
}

export async function json<T>(pool: Pool, prompt: string, schema: z.ZodType<T>, opts: JsonOpts): Promise<{ value: T; cost: number }> {
  await spendGate(pool, opts.tenantId, "openai", opts.estimate ?? 0.05);
  const model = opts.model ?? textModel();
  const r = await openai().responses.create({
    model,
    input: [{ role: "user", content: content(prompt, opts.images) }],
    text: { format: { type: "json_schema", name: "result", schema: jsonSchemaOf(schema), strict: false } },
    max_output_tokens: opts.maxOutputTokens ?? 8000,
  });
  const cost = textCost(model, r.usage?.input_tokens ?? 0, r.usage?.output_tokens ?? 0);
  await recordSpend(pool, opts.tenantId, { provider: "openai", what: opts.what, cost, projectId: opts.projectId });
  const parsed = parseLenient(schema, parseJsonText(r.output_text ?? ""));
  if (!parsed.success) throw new PlainError(`The AI answer for "${opts.what}" did not have the right shape (${parsed.error.issues[0]?.message ?? "invalid"}). Try again.`);
  return { value: parsed.data, cost };
}

/* ------------------------------------------------------------------ Batch API */

export type BatchLine = { customId: string; prompt: string; images?: LlmImage[]; schema: z.ZodType; model?: string };

export async function submitBatch(lines: BatchLine[], meta: Record<string, string>): Promise<{ batchId: string; model: string }> {
  if (!lines.length) throw new Error("empty batch");
  const model = lines[0].model ?? textModel();
  const jsonl = lines
    .map((l) =>
      JSON.stringify({
        custom_id: l.customId,
        method: "POST",
        url: "/v1/responses",
        body: {
          model: l.model ?? model,
          input: [{ role: "user", content: content(l.prompt, l.images) }],
          text: { format: { type: "json_schema", name: "result", schema: jsonSchemaOf(l.schema), strict: false } },
          max_output_tokens: 4000,
        },
      }),
    )
    .join("\n");
  const client = openai();
  const file = await client.files.create({ file: new File([jsonl], "creative-batch.jsonl", { type: "application/jsonl" }), purpose: "batch" });
  const batch = await client.batches.create({ input_file_id: file.id, endpoint: "/v1/responses", completion_window: "24h", metadata: meta });
  return { batchId: batch.id, model };
}

export type BatchOutcome =
  | { state: "pending"; status: string }
  | { state: "failed"; status: string; error: string }
  | { state: "done"; results: { customId: string; ok: boolean; value?: unknown; error?: string; inTok: number; outTok: number }[] };

export async function collectBatch(batchId: string): Promise<BatchOutcome> {
  const client = openai();
  const b = await client.batches.retrieve(batchId);
  if (["validating", "in_progress", "finalizing", "cancelling"].includes(b.status)) return { state: "pending", status: b.status };
  if (b.status !== "completed") return { state: "failed", status: b.status, error: b.errors?.data?.[0]?.message ?? b.status };
  const results: { customId: string; ok: boolean; value?: unknown; error?: string; inTok: number; outTok: number }[] = [];
  for (const fileId of [b.output_file_id, b.error_file_id].filter(Boolean) as string[]) {
    const text = await (await client.files.content(fileId)).text();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      const body = row.response?.body;
      const usage = body?.usage ?? {};
      if (row.error || row.response?.status_code !== 200) {
        results.push({ customId: row.custom_id, ok: false, error: row.error?.message ?? body?.error?.message ?? "failed", inTok: 0, outTok: 0 });
        continue;
      }
      const text2 =
        body.output_text ??
        (body.output ?? [])
          .flatMap((o: { content?: { type: string; text?: string }[] }) => o.content ?? [])
          .filter((c: { type: string }) => c.type === "output_text")
          .map((c: { text?: string }) => c.text ?? "")
          .join("");
      try {
        results.push({ customId: row.custom_id, ok: true, value: parseJsonText(text2), inTok: usage.input_tokens ?? 0, outTok: usage.output_tokens ?? 0 });
      } catch (e) {
        results.push({ customId: row.custom_id, ok: false, error: (e as Error).message, inTok: usage.input_tokens ?? 0, outTok: usage.output_tokens ?? 0 });
      }
    }
  }
  return { state: "done", results };
}

/* ------------------------------------------------------------------ embeddings (Similar ads) */

export async function embed(pool: Pool, tenantId: string, texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  const r = await openai().embeddings.create({ model: "text-embedding-3-small", input: texts, dimensions: 256 });
  const tokens = r.usage?.total_tokens ?? 0;
  await recordSpend(pool, tenantId, { provider: "openai", what: "radar embeddings", cost: Math.round(((tokens * 0.02) / 1_000_000) * 10000) / 10000 });
  return r.data.map((d) => d.embedding as number[]);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
