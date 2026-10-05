/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Run-level QA for Carbon Studio: two judges that look at the whole run.
 *
 * WHY THIS REPLACED THE PER-PANEL JUDGE
 * The old judge audited one panel at a time against a list of locks: the back
 * must be plain, pose 5 is a legs crop, no nudity, and so on. Each lock asked
 * it to decide what OUGHT to be true and then look for a breach, and it
 * answered from the expectation rather than from the pixels. 118 of the 309
 * failures it ever logged were that shape — a chain "should not" be visible
 * from behind, a head "is visible" in a frame that has no head, footwear "not
 * visible" reported as a bare foot. Every one was the render being right and
 * the judge being wrong, and each one cost the operator a crop.
 *
 * What an operator actually needs answered is comparative: are these eight
 * pictures the same outfit on the same person, and is that outfit the one in
 * the photographs? Neither question requires an expectation to be inferred, so
 * neither can be answered from one. Hence two judges:
 *
 *   CONSISTENCY — sees only the generated panels. No references, no spec, no
 *   pose locks. It cannot hallucinate a requirement because it is never given
 *   one. It reports an attribute only when some frames disagree with the rest,
 *   and names which frames are the odd ones out, so only those get flagged.
 *
 *   ACCURACY — sees the panels, the item references and the model references.
 *   It judges the garment surface and the person, and nothing about framing,
 *   crop, pose or coverage. This is the pass that catches an invented crease,
 *   which pure consistency cannot: a fault present in all eight frames is
 *   perfectly consistent.
 *
 * Two calls per run instead of one per panel, so this is also cheaper.
 */
import type OpenAI from "openai";
import { withTimeout, extractOpenAiOutputText, parseJsonObjectFromText } from "@/lib/seo/aiText";
import type { RunPanelImage, RunQaFinding, RunQaVerdict } from "@/lib/server/run-qa-store";

export type ItemRefView = "general" | "front" | "back";

const QA_MIN_CONFIDENCE = 0.75;
const MAX_FINDINGS = 10;
const MAX_NOTES = 8;

const normalizeForCompare = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();

/**
 * A "finding" that is actually a confirmation ("the shoes match in every
 * frame"). Both judges emit these when asked for structured output, and shown
 * to the operator they read as red failures. A line that also names a defect
 * is not one.
 */
function looksLikeConfirmation(text: string): boolean {
  const t = text.toLowerCase();
  if (!t.trim()) return false;
  const defect =
    /\b(?:missing|absent|not (?:present|visible|shown|rendered|match\w*)|wrong|differ\w*|mismatch\w*|misspel\w*|garbled|merged|invent\w*|extra|added|moved|relocat\w*|resiz\w*|shrunk|shrink\w*|swap\w*|chang\w*|alter\w*|redesign\w*|simplif\w*|recolou?r\w*|duplicat\w*|omit\w*|lack\w*|remov\w*|older|younger|incorrect\w*|instead of|should be|does not|doesn't|isn't|is not|are not|aren't|however|although|except|whereas|but\b)|;/;
  if (defect.test(t)) return false;
  return /\b(?:matches|match(?:ing|ed)?|correct(?:ly)?|consistent|as expected|identical|same as|accurate|present and|confirmed|no (?:issue|mismatch|difference|problem)|looks (?:right|good|fine)|preserved|intact|faithful)\b/.test(
    t,
  );
}

/**
 * Phrases that mean "I could not see it". The old judge turned every one of
 * these into a failure; neither judge is allowed to, so they are filtered even
 * if a judge ignores the instruction.
 */
function looksLikeNonObservation(text: string): boolean {
  return /\b(?:not visible|cannot tell|can't tell|unclear|obscured|out of frame|not shown|not in frame|hidden from view|cannot be (?:seen|determined|assessed)|unable to (?:see|tell|determine)|appears cropped|is cropped|no information)\b/i.test(
    text,
  );
}

/** "P3L" / "p1r" / "P2B" → the crop it names. */
function parseFrameToken(token: unknown): { panel: number; frame: "left" | "right" | "both" } | null {
  const m = String(token ?? "").trim().match(/^P?\s*(\d{1,2})\s*([LRB])$/i);
  if (!m) return null;
  const panel = Number(m[1]);
  if (!Number.isFinite(panel) || panel < 1 || panel > 12) return null;
  const side = m[2].toUpperCase();
  return { panel, frame: side === "L" ? "left" : side === "R" ? "right" : "both" };
}

/** Item refs grouped and labelled by view, so a side claim is the operator's
 *  sorting rather than the judge's guess. */
function buildLabelledItemRefContent(itemRefs: string[], views?: ItemRefView[]): any[] {
  const tagged = itemRefs.map((url, i) => ({ url, view: views?.[i] ?? "general" }));
  const groups: { view: ItemRefView; label: string }[] = [
    { view: "general", label: "ITEM reference photographs — GENERAL (any view: accessories, flats, details):" },
    { view: "front", label: "ITEM reference photographs — FRONT of the garment (everything here is on the front only):" },
    { view: "back", label: "ITEM reference photographs — BACK of the garment (everything here is on the back only):" },
  ];
  const hasSorted = tagged.some((t) => t.view !== "general");
  if (!hasSorted) {
    return [
      { type: "input_text", text: "ITEM reference photographs (what the garment really looks like):" },
      ...tagged.map((t) => ({ type: "input_image", image_url: t.url })),
    ];
  }
  const out: any[] = [];
  for (const g of groups) {
    const urls = tagged.filter((t) => t.view === g.view).map((t) => t.url);
    if (!urls.length) continue;
    out.push({ type: "input_text", text: g.label });
    out.push(...urls.map((url) => ({ type: "input_image", image_url: url })));
  }
  return out;
}

/** One line per panel naming the frame tokens, then the image itself. */
function buildPanelContent(panels: RunPanelImage[]): any[] {
  const out: any[] = [];
  for (const p of panels) {
    out.push({
      type: "input_text",
      text:
        `Panel ${p.panel}. Left half = frame P${p.panel}L` +
        (p.poseA ? ` (pose ${p.poseA})` : "") +
        `. Right half = frame P${p.panel}R` +
        (p.poseB ? ` (pose ${p.poseB})` : "") +
        ".",
    });
    out.push({ type: "input_image", image_url: `data:image/png;base64,${p.b64}` });
  }
  return out;
}

function frameRoster(panels: RunPanelImage[]): string {
  return panels.map((p) => `P${p.panel}L, P${p.panel}R`).join(", ");
}

/** Details the spec puts on one side of the body: [{ what: "chain", side: "left" }]. */
export function extractSidedDetails(spec: string): { what: string; side: "left" | "right" }[] {
  const out: { what: string; side: "left" | "right" }[] = [];
  for (const line of String(spec || "").split("\n")) {
    const m = /^\s*\d+\.\s*[A-Z/ ]+:\s*([^,.\n]+)[^\n]*?the wearer's (left|right)/i.exec(line);
    if (!m) continue;
    const what = m[1].trim().toLowerCase().replace(/\s+×\s*\d+$/, "").slice(0, 40);
    if (what && !out.some((o) => o.what === what)) {
      out.push({ what, side: m[2].toLowerCase() as "left" | "right" });
    }
    if (out.length >= 3) break;
  }
  return out;
}

/**
 * Which hip is the chain on? Asked the way a camera can answer it.
 *
 * Told in prose that a detail must stay on the same side of the BODY, the
 * consistency judge missed a panel mirrored end to end — the same render
 * flipped, chain on the opposite hip, nothing else changed. That is the third
 * time a vision model has been asked to invert left and right and got it wrong;
 * the analyser and the generator both needed the same treatment.
 *
 * So it is no longer asked. Each frame answers two things it can simply SEE —
 * which side of the PICTURE the detail is on, and whether the model faces the
 * camera or is turned away — and the mirror is applied here:
 *
 *     facing away  → picture side IS the body side
 *     facing camera→ picture side is the body side REVERSED
 *
 * A three-quarter turn makes the mirror ambiguous, so that frame does not vote.
 */
function wearerSideFromPicture(
  pictureSide: "left" | "right",
  facing: "camera" | "away",
): "left" | "right" {
  if (facing === "away") return pictureSide;
  return pictureSide === "left" ? "right" : "left";
}

async function runSideAudit(args: {
  openai: OpenAI;
  model: string;
  panels: RunPanelImage[];
  details: { what: string; side: "left" | "right" }[];
  timeoutMs: number;
}): Promise<{ findings: RunQaFinding[]; notes: string[]; ok: boolean }> {
  const names = args.details.map((d) => `"${d.what}"`).join(", ");
  const content: any[] = [
    {
      type: "input_text",
      text: [
        `For every frame below, report only what you can SEE. Do not work out which side of the body anything is on — that is done for you afterwards, and every attempt to do it here has come out backwards.`,
        "",
        `For each frame answer:`,
        `- facing: is the model turned TOWARDS the camera ("camera"), away from it so you see their back ("away"), or side-on / three-quarter so you cannot tell ("unclear")?`,
        `- for each of these details — ${names} — which side of the PICTURE is it on: "left", "right", or "absent" if that frame does not show it?`,
        "",
        `"left" and "right" here mean the left and right of the photograph as you look at it. Nothing else. A detail that has swung or hangs at an angle still sits on one side of the picture; say which. If a frame is a close-up with no body in it, use facing "unclear".`,
        "",
        "Return JSON only:",
        '{ "frames": [ { "frame": "P1L", "facing": "camera"|"away"|"unclear", "details": [ { "what": string, "picture_side": "left"|"right"|"absent" } ] } ] }',
        `The frames are: ${frameRoster(args.panels)}. Include every one.`,
      ].join("\n"),
    },
    ...buildPanelContent(args.panels),
  ];

  const { parsed, error } = await callJudge(
    args.openai,
    args.model,
    "You report what is visible in a photograph. You never infer anatomy or left/right of a body. Return JSON only.",
    content,
    args.timeoutMs,
    "Studio side audit",
  );
  if (!parsed || error) return { findings: [], notes: [], ok: false };

  type Seen = { panel: number; frame: "left" | "right"; what: string; side: "left" | "right" };
  const seen: Seen[] = [];
  for (const row of Array.isArray(parsed.frames) ? parsed.frames : []) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const token = parseFrameToken(r.frame);
    if (!token || token.frame === "both") continue;
    const facing = String(r.facing ?? "").toLowerCase();
    if (facing !== "camera" && facing !== "away") continue; // unclear → no vote
    for (const d of Array.isArray(r.details) ? r.details : []) {
      if (!d || typeof d !== "object") continue;
      const dd = d as Record<string, unknown>;
      const what = String(dd.what ?? "").trim().toLowerCase();
      const pic = String(dd.picture_side ?? "").toLowerCase();
      if (!what || (pic !== "left" && pic !== "right")) continue;
      seen.push({
        panel: token.panel,
        frame: token.frame,
        what,
        side: wearerSideFromPicture(pic, facing),
      });
    }
  }

  const findings: RunQaFinding[] = [];
  const notes: string[] = [];
  for (const detail of args.details) {
    const votes = seen.filter((s) => s.what.includes(detail.what) || detail.what.includes(s.what));
    if (votes.length < 2) continue; // one sighting settles nothing
    /* The spec names the true side, so the odd frames are measured against it
       rather than against a majority that could itself be wrong. */
    const wrong = votes.filter((v) => v.side !== detail.side);
    if (!wrong.length) continue;
    if (wrong.length === votes.length) {
      // Every frame agrees with itself and disagrees with the spec: that is an
      // accuracy problem for the whole run, not an odd frame.
      notes.push(
        `Every frame puts the ${detail.what} on the wearer's ${wrong[0].side}; the spec says the wearer's ${detail.side}. Check the spec line before regenerating.`,
      );
      continue;
    }
    /* A NOTE, not a failure — on purpose.
       Computing the mirror in code fixed the blindness: the audit now sees a
       mirrored panel where prose never did. What it did NOT fix is perception.
       On a verified-correct frame (chain plainly on the picture's right, model
       facing the camera, spec says the wearer's left) it still reported the
       wrong hip, and only two of four frames produced a usable sighting at all.
       A check that wrong this often must not unselect a crop the operator would
       have kept — that is the exact failure this whole QA rewrite existed to
       end. So it points, and the operator looks. Promote it to a finding only
       once it has been measured against real runs and earns it. */
    for (const w of wrong) {
      findings.push({
        panel: w.panel,
        frame: w.frame,
        text: `Worth a look: the ${detail.what} may be on the wearer's ${w.side} here, where the spec says the wearer's ${detail.side}.`.slice(
          0,
          240,
        ),
      });
    }
  }
  return { findings, notes, ok: true };
}

async function callJudge(
  openai: OpenAI,
  model: string,
  system: string,
  content: any[],
  timeoutMs: number,
  label: string,
): Promise<{ parsed: Record<string, any> | null; raw: string; error: string | null }> {
  const attempts = Math.max(1, Number(process.env.PANEL_QA_ATTEMPTS) || 2);
  let lastErr: any = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await withTimeout(
        openai.responses.create({
          model,
          temperature: 0,
          max_output_tokens: 1600,
          input: [
            { role: "system", content: [{ type: "input_text", text: system }] },
            { role: "user", content },
          ],
        }),
        Math.max(30_000, Math.min(timeoutMs, 90_000)),
        label,
      );
      const raw = extractOpenAiOutputText(response).slice(0, 4000);
      return { parsed: parseJsonObjectFromText(raw), raw, error: null };
    } catch (e: any) {
      lastErr = e;
    }
  }
  return { parsed: null, raw: "", error: lastErr?.message || "unknown error" };
}

const CONSISTENCY_SYSTEM =
  "You compare photographs from a single fashion shoot against EACH OTHER. " +
  "You are not shown the product references and you must never guess what the product is supposed to look like. " +
  "Your only question is whether the frames agree with one another. " +
  "No prose. Return JSON only.";

const ACCURACY_SYSTEM =
  "You check whether a rendered fashion panel reproduces the garment in the reference photographs, " +
  "and whether the person shown is the model in the model references. " +
  "You judge the garment surface and the person. You never judge framing, crop, pose or coverage. " +
  "No prose. Return JSON only.";

/**
 * CONSISTENCY: do the frames agree with each other?
 * Deliberately blind to the references, the spec and the pose plan.
 */
async function runConsistencyCheck(args: {
  openai: OpenAI;
  model: string;
  panels: RunPanelImage[];
  itemType: string;
  timeoutMs: number;
}): Promise<{ findings: RunQaFinding[]; notes: string[]; ok: boolean }> {
  const roster = frameRoster(args.panels);
  const content: any[] = [
    {
      type: "input_text",
      text: [
        `These frames are all from ONE shoot: the same model, wearing the same outfit, photographed the same day.`,
        `The product being sold is: ${args.itemType || "an apparel item"}. Everything else worn is styling.`,
        `The frames are: ${roster}.`,
        "",
        "Compare them with each other on these attributes:",
        "- FOOTWEAR: the same pair of shoes, same style, same colour, same sole, same laces, on every frame that shows feet.",
        "- TOP / other garment: the same shirt or top, same colour, same neckline, same sleeve length.",
        "- SOCKS and ACCESSORIES: the same, or absent in all. A watch, belt, hat, bag or jewellery that appears in some frames and not others is an inconsistency.",
        "- PERSON: the same individual — same face, same hair colour and length, same build, same apparent age.",
        "- THE PRODUCT ITSELF: the same colour, same waistband, same pockets, same hardware, same stitching, same hems, same length and fit.",
        "",
        "Report an attribute ONLY when one or a few frames disagree with what the rest show.",
        "Name what the majority show, and list ONLY the odd frames in odd_frames. Frames that agree with the majority must never appear there.",
        "If every frame agrees on an attribute, say nothing about it. An empty list is the correct and expected answer for a good run.",
        "",
        "THESE ARE NOT INCONSISTENCIES, and must never be reported:",
        "- Camera angle, distance, zoom, crop, which body parts are in shot, or how much of the garment is visible.",
        "- Lighting, shadow, colour temperature, background tint, centring.",
        "- Pose, stance, expression, hand position, which way the model faces.",
        "- A hanging part — a chain, drawcord, strap or tie — swinging, lying at a different angle, or catching the light differently. Same object, different moment, is the same object.",
        "- A part of the garment being seen from the front in one frame and from the back in another.",
        "- WHICH SIDE OF THE BODY ANYTHING IS ON. Say nothing about left or right, ever. A chain, pocket, logo or vent that looks like it moved sides is NOT yours to report: a frame shot from behind reverses everything, and working that out from a picture is a separate check that does the arithmetic properly. Report colour, shape, style and presence. Never side.",
        "",
        "A FRAME THAT DOES NOT SHOW AN ATTRIBUTE SIMPLY DOES NOT VOTE ON IT.",
        "If the feet are out of shot, that frame says nothing about footwear — it does not disagree with anything.",
        'Never write "not visible", "cannot tell", "out of frame", "obscured" or "unclear" as a finding. Those are not findings. Omit them entirely.',
        "",
        "Return JSON only:",
        "{",
        '  "inconsistencies": [ { "attribute": string, "majority": string, "odd_frames": ["P3L"], "odd_shows": string, "confidence": number 0-1 } ],',
        '  "notes": string[]',
        "}",
        "confidence is how sure you are that this is a real difference in the object and not a difference in viewing conditions. Below 0.75 it will be treated as a note, so use a high value only when you can point at both versions.",
      ].join("\n"),
    },
    ...buildPanelContent(args.panels),
  ];

  const { parsed, error } = await callJudge(
    args.openai,
    args.model,
    CONSISTENCY_SYSTEM,
    content,
    args.timeoutMs,
    "Studio consistency check",
  );
  if (!parsed) return { findings: [], notes: [], ok: false };
  if (error) return { findings: [], notes: [], ok: false };

  const findings: RunQaFinding[] = [];
  const notes: string[] = [];
  const rows = Array.isArray(parsed.inconsistencies) ? parsed.inconsistencies.slice(0, MAX_FINDINGS * 2) : [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const attribute = String(r.attribute ?? "").trim();
    const majority = String(r.majority ?? "").trim();
    const oddShows = String(r.odd_shows ?? "").trim();
    const confidence = Number(r.confidence);
    const tokens = Array.isArray(r.odd_frames) ? r.odd_frames : [];
    const targets = tokens.map(parseFrameToken).filter((t): t is NonNullable<typeof t> => t !== null);
    if (!attribute && !oddShows) continue;
    const text = `INCONSISTENT ${attribute || "styling"}: this frame shows ${oddShows || "something different"}${
      majority ? `, the other frames show ${majority}` : ""
    }.`.slice(0, 240);
    if (looksLikeNonObservation(`${oddShows} ${majority} ${attribute}`)) continue;
    if (looksLikeConfirmation(text)) continue;
    if (majority && oddShows && normalizeForCompare(majority) === normalizeForCompare(oddShows)) continue;
    if (!Number.isFinite(confidence) || confidence < QA_MIN_CONFIDENCE) {
      notes.push(`${text} (${Number.isFinite(confidence) ? "low" : "no"} confidence)`);
      continue;
    }
    if (!targets.length) {
      // A real difference the judge could not pin to a frame is worth saying,
      // but it must not flag crops at random.
      notes.push(text);
      continue;
    }
    for (const t of targets) findings.push({ panel: t.panel, frame: t.frame, text });
  }
  for (const n of Array.isArray(parsed.notes) ? parsed.notes : []) {
    const t = String(n ?? "").trim();
    if (t) notes.push(t);
  }
  return { findings: findings.slice(0, MAX_FINDINGS), notes, ok: true };
}

/** Clothing that is usually styling around the product rather than the product. */
const STYLING_PIECES: [RegExp, RegExp][] = [
  [/\b(t-?shirt|tee|undershirt)\b/i, /\b(t-?shirt|tee|tank|vest|bralette)\b/i],
  [/\b(trousers|jeans|pants|denim|shorts|chinos)\b/i, /\b(trousers|jeans|pants|shorts|chinos|denim)\b/i],
  [/\b(shoes|sneakers|trainers|boots|footwear|socks)\b/i, /\b(shoe|sneaker|trainer|boot|footwear|sock|slide|sandal|flip)\b/i],
];

/** A layer worn UNDER the product ("the top worn underneath", "top under is
 *  black", "inner layer") is styling whatever the product is called — the
 *  product is the outer piece. Underwear products are the exception. */
const UNDER_LAYER =
  /\b(?:(?:top|shirt|tee|t-?shirt|layer|vest|tank)\s+(?:worn\s+)?(?:under|underneath)|(?:under|underneath)\s+(?:the\s+)?(?:jacket|shirt|top|overshirt|coat|blazer|hoodie)|worn\s+underneath|inner\s+(?:top|layer|shirt|tee))\b/i;
const UNDERWEAR = /\b(bra|bralette|boxer|brief|underwear|lingerie|camisole|cami)\b/i;

/** A complaint about a piece worn WITH the product (and not the product itself). */
function isStylingComplaint(what: string, itemType: string): boolean {
  if (UNDER_LAYER.test(what) && !UNDERWEAR.test(itemType || "")) return true;
  return STYLING_PIECES.some(([piece, productIs]) => piece.test(what) && !productIs.test(itemType || ""));
}

/** Words that name a visible difference between two people. */
const PERSON_TRAIT =
  /\b(hair|bald|shaved|fade|curl|braid|dread|beard|stubble|moustache|mustache|clean-shaven|skin|complexion|age|older|younger|face shape|jaw|nose|eyes|eyebrow|freckle|tattoo|glasses|build)\b/i;

/**
 * ACCURACY: does the garment match the photographs, and is it the right person?
 * Says nothing about crop, pose, framing or coverage.
 */
async function runAccuracyCheck(args: {
  openai: OpenAI;
  model: string;
  panels: RunPanelImage[];
  itemRefs: string[];
  itemRefViews?: ItemRefView[];
  modelRefs: string[];
  itemSpec?: string;
  itemType: string;
  /** Operator-confirmed colourway for this run, when one is active. */
  colorName?: string;
  /** The operator's instruction: it outranks the photographs and the spec. */
  instruction?: string;
  timeoutMs: number;
}): Promise<{ findings: RunQaFinding[]; notes: string[]; ok: boolean }> {
  const spec = String(args.itemSpec || "").trim();
  const roster = frameRoster(args.panels);
  const content: any[] = [
    {
      type: "input_text",
      text: [
        `The product is: ${args.itemType || "an apparel item"}.`,
        `The rendered frames are: ${roster}.`,
        "",
        "Compare the GARMENT SURFACE in the rendered frames against the item reference photographs:",
        "- TEXT: wording and spelling, letter by letter, and which side it sits on.",
        "- ARTWORK: logo, print or graphic — same artwork, same size relative to the garment, same position, same colours.",
        /* Colour is the one thing a photograph does NOT carry reliably: the same
           black cloth reads charcoal under room light and blue-black in shade.
           Judging shade from the references produced a failure on all eight
           frames of a run ("the photographs show very dark black, this frame
           shows lighter black") — a complaint about the lighting in the
           reference photo, charged to the render. */
        args.colorName
          ? `- COLOUR: this run renders the colourway "${args.colorName}", which the operator confirmed. Judge the cloth against THAT description, not against the reference photographs — they may show a different colourway entirely. Report only a clearly different colour (navy drawn red, black drawn white). Never report a shade: lighter, darker, warmer, cooler, more or less saturated are NOT failures.`
          : "- COLOUR: report only a clearly different colour family from the photographs (navy drawn red, black drawn white). A photograph does not carry colour reliably — the same cloth reads lighter under one light and darker under another — so never report a shade difference. Lighter, darker, warmer, cooler, more or less saturated are NOT failures.",
        "- CONSTRUCTION: seams, panels, pockets, waistband, closure, belt loops, hems, cuffs, collar.",
        "- HARDWARE the photographs show: buttons, zips, rivets, eyelets, chains, drawcords.",
        "",
        "ADDED FEATURES COUNT AS MISMATCHES. A detail the render put there that the photographs do not have — a pressed centre crease down the leg, a pleat, a turn-up, an extra pocket, a side stripe, contrast stitching, a brand tab, an extra button or zip — is a mismatch exactly like a missing one. Compare the garment feature by feature, not just by colour and shape.",
        "",
        /* The item photographs are often worn by a shop model. That wearer is
           not this shoot's model: comparing against them failed all eight
           frames of a correct run ("the photographs show Reference model, this
           frame shows Rendered model") because the jacket's product shots were
           worn by somebody else. */
        args.modelRefs.length
          ? "THE PERSON. Whoever wears the item in the ITEM reference photographs — a shop model, a mannequin, a hand — is NOT the model of this shoot. Never compare the rendered person with them. Judge the person ONLY against the MODEL reference photographs. Report a person mismatch only when a visible face is clearly a different individual from the MODEL references, and name the concrete trait that differs in both in_the_photos and in_the_render (hair style or colour, skin tone, beard, apparent age, face shape). Angle, expression and lighting are not a mismatch. Back views and frames with no visible face: say nothing about the person."
          : "There are no model reference photographs for this run: do not judge the person at all.",
        "",
        "YOU DO NOT JUDGE ANY OF THE FOLLOWING. They are somebody else's job and are never mismatches:",
        "- How the frame is cropped, which body parts are in shot, or whether the head, feet or torso appear.",
        "- Pose, stance, framing, centring, background, lighting.",
        "- Whether a garment or a body part is visible at all, and whether something 'should' be visible from a given angle.",
        "- Nudity or coverage of any kind.",
        "- Hardware being seen from an unexpected side. A chain, tie or drawcord may hang, swing and be visible from behind. That is never a mismatch.",
        `- Anything worn WITH the product that is not the product itself — the t-shirt underneath, trousers, shoes, accessories. That is styling, chosen elsewhere. Judge only the ${args.itemType || "product"}.`,
        "",
        "REPORT ONLY WHAT YOU CAN SEE in a named frame. If you cannot see it, say nothing about it.",
        'Never write "not visible", "cannot tell", "out of frame" or "unclear" as a mismatch.',
        "Small text in a full-body frame is only a few pixels tall: never judge its spelling or legibility there. Judge small text only in a close-up.",
        "Before reporting a misspelling, transcribe the letters you actually see into in_the_render. If they equal in_the_photos, it is NOT a mismatch — omit it.",
        "If every frame reproduces the garment, return an empty list. That is the expected answer for a good run.",
        "",
        "Return JSON only:",
        "{",
        '  "mismatches": [ { "kind": "garment" | "person", "frames": ["P1L","P1R"], "what": string, "in_the_photos": string, "in_the_render": string, "confidence": number 0-1 } ],',
        '  "notes": string[]',
        "}",
        "List a frame only if you can see the problem in that frame. Below 0.75 confidence it is treated as a note.",
      ].join("\n"),
    },
    ...(String(args.instruction || "").trim()
      ? [
          {
            type: "input_text",
            text: `OPERATOR INSTRUCTION — this overrides the reference photographs and the spec below: "${String(
              args.instruction,
            ).trim()}". Anything in a frame that follows this instruction is CORRECT, even where the photographs or the spec show something else. Never report it as a mismatch.`,
          },
        ]
      : []),
    ...(spec
      ? [
          {
            type: "input_text",
            text:
              "VERIFIED ITEM SPEC — what the reference photographs were found to contain. A ZONE line is a complete account of that area: where it says a zone is flat or plain, that zone really is empty and anything drawn there is an added feature.\n" +
              spec,
          },
        ]
      : []),
    {
      type: "input_text",
      text: "MODEL reference photographs — the ONLY source for who the person should be (never the people in the item photographs):",
    },
    ...args.modelRefs.slice(0, 6).map((url) => ({ type: "input_image", image_url: url })),
    ...buildLabelledItemRefContent(args.itemRefs, args.itemRefViews),
    { type: "input_text", text: "Rendered frames to check:" },
    ...buildPanelContent(args.panels),
  ];

  const { parsed, error } = await callJudge(
    args.openai,
    args.model,
    ACCURACY_SYSTEM,
    content,
    args.timeoutMs,
    "Studio accuracy check",
  );
  if (!parsed || error) return { findings: [], notes: [], ok: false };

  const findings: RunQaFinding[] = [];
  const notes: string[] = [];
  const rows = Array.isArray(parsed.mismatches) ? parsed.mismatches.slice(0, MAX_FINDINGS * 2) : [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const what = String(r.what ?? "").trim();
    const expected = String(r.in_the_photos ?? "").trim();
    const observed = String(r.in_the_render ?? "").trim();
    const confidence = Number(r.confidence);
    const tokens = Array.isArray(r.frames) ? r.frames : [];
    const targets = tokens.map(parseFrameToken).filter((t): t is NonNullable<typeof t> => t !== null);
    if (!what && !observed) continue;
    const isPerson =
      r.kind === "person" || /\b(model|person|individual|face|identity)\b/i.test(what);
    if (isPerson) {
      /* A person flag must name what differs. "Reference model" vs "Rendered
         model" names nothing — that judge was comparing against the wrong
         person — so it becomes a note, never a failed crop. */
      const traits = `${expected} ${observed}`;
      if (!args.modelRefs.length || !PERSON_TRAIT.test(traits)) {
        notes.push(`Person check without a concrete difference (ignored): ${what} — ${expected} / ${observed}`.slice(0, 240));
        continue;
      }
    }
    if (!isPerson && isStylingComplaint(what, args.itemType)) {
      notes.push(`Styling, not the product (ignored): ${what} — ${expected} / ${observed}`.slice(0, 240));
      continue;
    }
    const text = `${isPerson ? "MODEL" : "PRODUCT"} ${what || "mismatch"}: ${
      isPerson ? "the model photos show" : "the photographs show"
    } ${expected || "something else"}, this frame shows ${observed || "something different"}.`.slice(0, 240);
    if (looksLikeNonObservation(`${what} ${expected} ${observed}`)) continue;
    if (looksLikeConfirmation(text)) continue;
    if (expected && observed && normalizeForCompare(expected) === normalizeForCompare(observed)) continue;
    if (!Number.isFinite(confidence) || confidence < QA_MIN_CONFIDENCE) {
      notes.push(`${text} (${Number.isFinite(confidence) ? "low" : "no"} confidence)`);
      continue;
    }
    if (!targets.length) {
      notes.push(text);
      continue;
    }
    for (const t of targets) findings.push({ panel: t.panel, frame: t.frame, text });
  }
  for (const n of Array.isArray(parsed.notes) ? parsed.notes : []) {
    const t = String(n ?? "").trim();
    if (t) notes.push(t);
  }
  return { findings: findings.slice(0, MAX_FINDINGS), notes, ok: true };
}

/**
 * Both passes, in parallel, merged into one verdict.
 *
 * The consistency pass is skipped when there is only one frame to compare —
 * a single crop agrees with itself, and asking produces invention.
 */
export async function runRunQa(args: {
  openai: OpenAI;
  panels: RunPanelImage[];
  itemRefs: string[];
  itemRefViews?: ItemRefView[];
  modelRefs: string[];
  itemSpec?: string;
  itemType: string;
  colorName?: string;
  instruction?: string;
  timeoutMs: number;
}): Promise<RunQaVerdict> {
  const model = (process.env.OPENAI_IMAGE_QA_MODEL || "gpt-4o").trim() || "gpt-4o";
  const frameCount = args.panels.length * 2;
  const wantConsistency = frameCount >= 3;

  /* The side audit only has something to check when the spec actually puts a
     detail on one side of the body. */
  const sidedDetails = extractSidedDetails(args.itemSpec ?? "");

  const [consistency, accuracy, sides] = await Promise.all([
    wantConsistency
      ? runConsistencyCheck({
          openai: args.openai,
          model,
          panels: args.panels,
          itemType: args.itemType,
          timeoutMs: args.timeoutMs,
        }).catch(() => ({ findings: [] as RunQaFinding[], notes: [] as string[], ok: false }))
      : Promise.resolve({ findings: [] as RunQaFinding[], notes: [] as string[], ok: true }),
    runAccuracyCheck({
      openai: args.openai,
      model,
      panels: args.panels,
      itemRefs: args.itemRefs,
      itemRefViews: args.itemRefViews,
      modelRefs: args.modelRefs,
      itemSpec: args.itemSpec,
      itemType: args.itemType,
      colorName: args.colorName,
      instruction: args.instruction,
      timeoutMs: args.timeoutMs,
    }).catch(() => ({ findings: [] as RunQaFinding[], notes: [] as string[], ok: false })),
    sidedDetails.length && args.panels.length
      ? runSideAudit({
          openai: args.openai,
          model,
          panels: args.panels,
          details: sidedDetails,
          timeoutMs: args.timeoutMs,
        }).catch(() => ({ findings: [] as RunQaFinding[], notes: [] as string[], ok: false }))
      : Promise.resolve({ findings: [] as RunQaFinding[], notes: [] as string[], ok: true }),
  ]);

  const notes = [...consistency.notes, ...accuracy.notes, ...sides.notes].slice(0, MAX_NOTES);
  if (!consistency.ok && !accuracy.ok) {
    return { findings: [], advisories: [], notes, unavailable: true };
  }
  if (!consistency.ok && wantConsistency) {
    notes.unshift("The consistency check did not report back — these crops were compared against the references only.");
  }
  if (!accuracy.ok) {
    notes.unshift("The accuracy check did not report back — these crops were compared with each other only.");
  }
  // Same text on the same crop from both judges collapses to one flag.
  const seen = new Set<string>();
  const findings: RunQaFinding[] = [];
  /* Side is owned by the side audit alone, which asks only what a camera can
     answer and mirrors in code. A back-facing frame reverses everything, and
     the consistency judge read Pose 4 — deliberately a back view — as the chain
     having swapped hips, and failed a correct crop for it. Anything it says
     about sides is dropped here even when it ignores being told not to. */
  const SIDE_TALK = /\b(side|left|right|hip)\b/i;
  for (const f of [...consistency.findings.filter((f) => !SIDE_TALK.test(f.text)), ...accuracy.findings]) {
    const key = `${f.panel}|${f.frame}|${normalizeForCompare(f.text)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push(f);
  }
  return {
    findings,
    advisories: sides.findings.slice(0, MAX_FINDINGS),
    notes: notes.slice(0, MAX_NOTES),
    unavailable: false,
  };
}
