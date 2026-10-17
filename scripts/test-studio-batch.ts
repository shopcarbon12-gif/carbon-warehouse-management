/**
 * Checks for the Studio night batch (lib/server/studio-batch.ts). No OpenAI
 * call, no R2: OpenAI and the image store are fakes.
 *
 *   npx tsx scripts/test-studio-batch.ts
 *   DATABASE_URL=postgres://… npx tsx scripts/test-studio-batch.ts   # + the queue → send → store run
 *
 * What must hold: only a run Generate could have sent is queued (no anchored
 * panel, no other product's panel); each reference photo is uploaded to OpenAI
 * once per batch however many panels use it; a finished batch lands every
 * image with its own panel and every refusal with its reason; the uploaded
 * files are deleted afterwards; a run that cannot be prepared fails instead of
 * being retried every night; and the nightly window is 1–6 AM Eastern, once.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { File as NodeFile } from "node:buffer";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type OpenAI from "openai";
import {
  customId,
  enqueueBatchItem,
  listBatchItems,
  nightlySendDue,
  parseCustomId,
  pollStudioBatches,
  submitQueuedBatch,
  validateEnqueue,
  type PrepareFn,
} from "@/lib/server/studio-batch";

// Production runs Node 20 (global File); a Node 18 shell needs it for the OpenAI upload helper.
(globalThis as { File?: unknown }).File ??= NodeFile;

const MATRIX = "7fbfcc4a-bd5a-43c7-b339-cb93ce0e9576";
const body = (panel: number, extra: Record<string, unknown> = {}) => ({
  prompt: `panel ${panel} prompt`,
  modelRefs: ["https://example.com/m.jpg"],
  itemRefs: ["https://example.com/i.jpg"],
  matrixId: MATRIX,
  panelQa: { panelNumber: panel, poseA: panel * 2 - 1, poseB: panel * 2, modelName: "Victor", modelGender: "male", itemType: "Pants" },
  ...extra,
});
const input = (panels: unknown[], over: Record<string, unknown> = {}) => ({
  matrixId: MATRIX,
  runTag: "mgu1abcd",
  modelName: "Victor",
  modelGender: "male",
  itemColour: "BLACK",
  itemType: "Pants",
  panels,
  ...over,
});

test("validateEnqueue: a normal run is accepted, panels sorted", () => {
  const v = validateEnqueue(input([{ panel: 3, body: body(3) }, { panel: 1, body: body(1) }]));
  assert.equal(v.ok, true);
  if (v.ok) assert.deepEqual(v.value.panels.map((p) => p.panel), [1, 3]);
});

test("validateEnqueue: refuses what a batch cannot render", () => {
  const bad: [string, unknown][] = [
    ["no panels", input([])],
    ["duplicate panel", input([{ panel: 1, body: body(1) }, { panel: 1, body: body(1) }])],
    ["panel 9", input([{ panel: 9, body: body(9) }])],
    ["no prompt", input([{ panel: 1, body: { ...body(1), prompt: "" } }])],
    ["no item photos", input([{ panel: 1, body: { ...body(1), itemRefs: [] } }])],
    ["waits on a live panel 1", input([{ panel: 2, body: body(2, { anchor: { runId: "x", role: "follower" } }) }])],
    ["another product's panel", input([{ panel: 1, body: body(1, { matrixId: randomUUID() }) }])],
    ["bad run tag", input([{ panel: 1, body: body(1) }], { runTag: "../x" })],
    ["bad product id", input([{ panel: 1, body: body(1) }], { matrixId: "nope" })],
  ];
  for (const [why, raw] of bad) assert.equal(validateEnqueue(raw).ok, false, why);
});

test("custom ids round-trip and reject anything else", () => {
  const id = randomUUID();
  assert.deepEqual(parseCustomId(customId(id, 4)), { itemId: id, panel: 4 });
  for (const v of ["", "x:1", `${id}:0`, `${id}:9`, `${id}`, null]) assert.equal(parseCustomId(v), null, String(v));
});

test("nightly window: 1:00–5:59 AM Eastern, once, only with something queued", () => {
  assert.equal(nightlySendDue(0, false, 3), false);
  assert.equal(nightlySendDue(1, false, 3), true);
  assert.equal(nightlySendDue(5, false, 3), true);
  assert.equal(nightlySendDue(6, false, 3), false);
  assert.equal(nightlySendDue(1, true, 3), false);
  assert.equal(nightlySendDue(1, false, 0), false);
});

/* ── queue → send → store, against a real Postgres ───────────────────────── */

const dbUrl = process.env.DATABASE_URL?.trim();
const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function fakeOpenAi(output: (lines: Record<string, unknown>[]) => { out: string; err: string }) {
  const uploads: { purpose: string; name: string; text?: string }[] = [];
  const deleted: string[] = [];
  let sent: Record<string, unknown>[] = [];
  let n = 0;
  const files = new Map<string, string>();
  const client = {
    files: {
      create: async ({ file, purpose }: { file: File; purpose: string }) => {
        const id = `file-${++n}`;
        const text = purpose === "batch" ? await file.text() : undefined;
        if (text) sent = text.trim().split("\n").map((l) => JSON.parse(l));
        uploads.push({ purpose, name: file.name, text });
        return { id };
      },
      delete: async (id: string) => {
        deleted.push(id);
        return { id, deleted: true };
      },
      content: async (id: string) => new Response(files.get(id) ?? ""),
    },
    batches: {
      create: async () => ({ id: "batch_test_1", status: "validating" }),
      retrieve: async () => {
        const { out, err } = output(sent);
        files.set("file-out", out);
        files.set("file-err", err);
        return { id: "batch_test_1", status: "completed", output_file_id: "file-out", error_file_id: "file-err" };
      },
    },
  };
  return { client: client as unknown as OpenAI, uploads, deleted, sent: () => sent };
}

test("queue → send → store (needs DATABASE_URL)", { skip: !dbUrl }, async () => {
  const pool = new Pool({ connectionString: dbUrl, max: 2 });
  const tenantId = randomUUID();
  const session = { sub: randomUUID(), email: "test@example.com", tid: tenantId, lid: randomUUID(), role: "admin" };
  const m = await pool.query<{ id: string }>(`INSERT INTO matrices (description) VALUES ('studio-batch test') RETURNING id::text`);
  const matrixId = m.rows[0].id;
  try {
    const mk = (panel: number) => ({ panel, body: { ...body(panel), matrixId } });
    const v = validateEnqueue(input([mk(1), mk(2), mk(3)], { matrixId }));
    assert.ok(v.ok);
    const item = await enqueueBatchItem(pool, session, v.value);

    /* Panel 3 is refused while being built (as the generate route refuses a
       back pose nobody photographed); 1 and 2 share both reference photos. */
    const prepare: PrepareFn = async (b, actor) => {
      assert.equal(actor.addedEmail, "test@example.com");
      if (b.panelQa?.panelNumber === 3) return { error: "no Back photo" };
      return {
        prepared: {
          model: "gpt-image-2.5-sunburst",
          prompt: String(b.prompt),
          size: "1536x1024",
          quality: "high",
          moderation: "low",
          images: [
            { name: "ref-1.png", type: "image/png", b64: PNG_1x1 },
            { name: "ref-2.png", type: "image/png", b64: PNG_1x1 + "AA" },
          ],
        },
        meta: { imageQuality: "high", modelRefCount: 1, itemRefCount: 1 },
      };
    };
    const ai = fakeOpenAi((lines) => ({
      // Panel 1 renders; panel 2 is refused by OpenAI.
      out: JSON.stringify({
        custom_id: lines[0].custom_id,
        response: { status_code: 200, body: { data: [{ b64_json: PNG_1x1 }], usage: { output_tokens: 1372 } } },
      }) + "\n",
      err: JSON.stringify({
        custom_id: lines[1].custom_id,
        response: { status_code: 400, body: { error: { message: "Your request was rejected by the safety system.", code: "moderation_blocked" } } },
      }) + "\n",
    }));

    const sent = await submitQueuedBatch(pool, { tenantId, trigger: "manual", prepare, openai: ai.client, log: () => {} });
    assert.equal(sent.requests, 2);
    assert.equal(sent.failedPanels, 1);
    assert.equal(ai.uploads.filter((u) => u.purpose === "vision").length, 2, "each photo uploaded once");
    const lines = ai.sent();
    assert.equal(lines.length, 2);
    assert.equal(lines[0].url, "/v1/images/edits");
    const b0 = lines[0].body as { model: string; images: { file_id: string }[]; n: number };
    assert.equal(b0.model, "gpt-image-2.5-sunburst");
    assert.deepEqual(b0.images.map((x) => x.file_id), ["file-1", "file-2"]);
    assert.equal(b0.n, 1);
    let [row] = await listBatchItems(pool, tenantId, { matrixId });
    assert.equal(row.status, "submitted");

    const stored: string[] = [];
    const polled = await pollStudioBatches(pool, {
      openai: ai.client,
      tenantId,
      log: () => {},
      store: async (path) => {
        stored.push(path);
        return { path };
      },
    });
    assert.equal(polled.processed, 1);
    assert.deepEqual(stored, [`carbon-studio/batch/${tenantId}/${matrixId}/${item.id}/panel-1.png`]);
    [row] = await listBatchItems(pool, tenantId, { matrixId });
    assert.equal(row.status, "ready");
    assert.deepEqual(row.ready, [1]);
    assert.deepEqual(row.failed.map((f) => f.panel), [2, 3]);
    assert.match(row.failed[0].error, /safety system/);
    assert.match(row.failed[1].error, /no Back photo/);
    for (const id of ["file-1", "file-2", "file-3", "file-out", "file-err"]) assert.ok(ai.deleted.includes(id), `deleted ${id}`);
    const b = await pool.query(`SELECT status FROM studio_batches WHERE tenant_id = $1::uuid`, [tenantId]);
    assert.equal(b.rows[0].status, "processed");

    /* A run none of whose panels can be built fails — it is not re-queued. */
    const v2 = validateEnqueue(input([mk(3)], { matrixId, runTag: "mgu2abcd" }));
    assert.ok(v2.ok);
    await enqueueBatchItem(pool, session, v2.value);
    const none = await submitQueuedBatch(pool, { tenantId, trigger: "nightly", prepare, openai: ai.client, log: () => {} });
    assert.equal(none.requests, 0);
    const rows = await listBatchItems(pool, tenantId, { matrixId });
    assert.equal(rows.find((r) => r.runTag === "mgu2abcd")?.status, "failed");
  } finally {
    await pool.query(`DELETE FROM studio_batches WHERE tenant_id = $1::uuid`, [tenantId]);
    await pool.query(`DELETE FROM matrices WHERE id = $1::uuid`, [matrixId]);
    await pool.end();
  }
});
