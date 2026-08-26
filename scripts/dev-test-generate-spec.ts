/**
 * DEV-ONLY end-to-end check for the Studio pipeline against a LOCAL standalone
 * server (never production): item analysis → real panel prompt (built with the
 * app's own builder, pose libraries included) → one real panel generation with
 * the spec sent as its own field. Verifies: no "string too long" 400, the spec
 * survives inside the server lock block, and the QA gate is decisive.
 *
 *   BASE=http://127.0.0.1:3041 ITEM_REF=<url> MODEL_REFS='["u1","u2","u3"]' \
 *   npx tsx scripts/dev-test-generate-spec.ts
 */
import { buildMasterPanelPrompt, getPanelPosePair, getPanelButtonLabel, pickExpressionDirective } from "../lib/panelGeneration";

const BASE = process.env.BASE || "http://127.0.0.1:3041";
const ITEM_REF = process.env.ITEM_REF || "";
const MODEL_REFS: string[] = JSON.parse(process.env.MODEL_REFS || "[]");
const ITEM_TYPE = process.env.ITEM_TYPE || "jeans";

async function main() {
  if (!ITEM_REF || MODEL_REFS.length < 3) throw new Error("ITEM_REF and ≥3 MODEL_REFS required");
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@example.com", password: "ChangeMeOnFirstLogin!1" }),
  });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  if (!login.ok || !cookie) throw new Error(`login failed ${login.status}`);
  const H = { "Content-Type": "application/json", Cookie: cookie };

  const t0 = Date.now();
  const spec = await fetch(`${BASE}/api/openai/item-spec`, { method: "POST", headers: H, body: JSON.stringify({ itemRefs: [ITEM_REF], itemType: ITEM_TYPE }) });
  const specJson = (await spec.json()) as { lockText?: string; error?: string };
  if (!specJson.lockText) throw new Error(`item-spec failed: ${specJson.error}`);
  console.log(`analysis: ${Date.now() - t0} ms, ${specJson.lockText.split("\n").length} lines, ${Buffer.byteLength(specJson.lockText)} bytes`);

  const panel = 1;
  const gender = "female";
  const [poseA, poseB] = getPanelPosePair(gender, panel);
  const prompt = buildMasterPanelPrompt({
    panelNumber: panel,
    panelLabel: getPanelButtonLabel(gender, panel),
    poseA,
    poseB,
    modelName: "test",
    modelGender: gender,
    modelRefs: MODEL_REFS,
    itemRefs: [ITEM_REF],
    itemType: ITEM_TYPE,
    expressionDirective: pickExpressionDirective(),
  });
  console.log(`client prompt: ${prompt.length} chars / ${Buffer.byteLength(prompt)} bytes`);

  const t1 = Date.now();
  const gen = await fetch(`${BASE}/api/generate`, {
    method: "POST",
    headers: { ...H, "x-generate-stream": "1" },
    body: JSON.stringify({
      prompt,
      size: "1536x1024",
      modelRefs: MODEL_REFS,
      itemRefs: [ITEM_REF],
      panelQa: { panelNumber: panel, panelLabel: getPanelButtonLabel(gender, panel), poseA, poseB, modelName: "test", modelGender: gender, itemType: ITEM_TYPE },
      itemSpec: specJson.lockText,
    }),
  });
  const raw = await gen.text();
  const json = JSON.parse(raw) as { imageBase64?: string; error?: unknown; degraded?: boolean; warning?: string };
  console.log(`generate: ${Date.now() - t1} ms, http ${gen.status}, image=${json.imageBase64 ? `${json.imageBase64.length} b64 chars` : "none"}, degraded=${!!json.degraded}`);
  if (json.error) console.log("error:", JSON.stringify(json.error).slice(0, 400));
  if (json.warning) console.log("warning:", json.warning.slice(0, 300));
  if (json.imageBase64 && !json.degraded) {
    const fs = await import("node:fs");
    fs.writeFileSync("/tmp/claude-1000/-home-carbondev-dev-carbon-warehouse-management/e3b44287-94a0-4742-85b6-293423ea6b3b/scratchpad/panel-test.png", Buffer.from(json.imageBase64, "base64"));
    console.log("saved panel → scratchpad/panel-test.png");
  }
}
main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
