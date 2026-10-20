import type OpenAI from "openai";
import sharp from "sharp";
import { text } from "@/lib/server/item-spec-build";

const TURNS = [0, 90, 180, 270] as const;
const TURN_LETTERS = ["A", "B", "C", "D"] as const;
const UPRIGHT_BATCH = 6;

/**
 * Flat lays shot from above come out sideways or upside down — the phone cannot
 * tell which way is up and the files carry no rotation tag. Asked to NAME the
 * turn, the vision model got the direction wrong (both backs of a tee came out
 * upside down); shown all four turns of each photo and asked to PICK the
 * upright one, it was right on 11 of 11 real photos, twice. So: four small
 * versions per photo, one multiple-choice answer each. Returns photo number
 * (1-based, the analysis' numbering) → clockwise turn, only for photos that
 * need one.
 */
export async function detectUprightTurns(
  client: OpenAI,
  model: string,
  photos: Array<{ data: string }>,
): Promise<Map<number, 90 | 180 | 270>> {
  const out = new Map<number, 90 | 180 | 270>();
  const batches: number[][] = [];
  for (let i = 0; i < photos.length; i += UPRIGHT_BATCH) {
    batches.push(photos.slice(i, i + UPRIGHT_BATCH).map((_, k) => i + k));
  }
  await Promise.all(
    batches.map(async (batch) => {
      const content: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail: "low" } }> = [
        {
          type: "text",
          text: 'Each reference photo below is shown four times: A = as taken, B = turned 90° clockwise, C = turned 180°, D = turned 270° clockwise. For each photo pick the ONE version in which the garment stands upright the way it is worn: neckline / collar or waistband at the TOP, hem at the bottom, printed text reading normally. Answer JSON only: {"choices":[{"photo":1,"upright":"A"}]}',
        },
      ];
      for (const [k, idx] of batch.entries()) {
        const b64 = photos[idx].data.replace(/^data:[^,]*,/, "");
        const base = await sharp(Buffer.from(b64, "base64")).autoOrient().resize(448, 448, { fit: "inside" }).toBuffer();
        content.push({ type: "text", text: `Photo ${k + 1}:` });
        for (let t = 0; t < 4; t++) {
          const v = await sharp(base).rotate(TURNS[t]).jpeg({ quality: 80 }).toBuffer();
          content.push({ type: "text", text: `Photo ${k + 1} version ${TURN_LETTERS[t]}:` });
          content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${v.toString("base64")}`, detail: "low" } });
        }
      }
      const r = await client.chat.completions.create({
        model,
        temperature: 0,
        max_tokens: 300,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content }],
      });
      const j = JSON.parse(text(r.choices?.[0]?.message?.content) || "{}") as {
        choices?: Array<{ photo?: unknown; upright?: unknown }>;
      };
      for (const c of j.choices ?? []) {
        const k = Number(c?.photo);
        const t = TURN_LETTERS.indexOf(String(c?.upright ?? "").trim().toUpperCase() as (typeof TURN_LETTERS)[number]);
        if (!Number.isInteger(k) || k < 1 || k > batch.length || t <= 0) continue;
        out.set(batch[k - 1] + 1, TURNS[t] as 90 | 180 | 270);
      }
    }),
  );
  return out;
}

/**
 * Second opinion before turning a photo (Bulk Studio, 2026-10-20). On the
 * owner's own photos — garments on a hanger or lying on the floor, shot at an
 * angle — the pick-one-of-four check turned 4 of 6 already-upright photos 90°
 * or 180°. Shown only the photo as taken next to the proposed turn, the model
 * keeps the original unless the turned one is clearly more upright.
 */
export async function confirmTurn(client: OpenAI, model: string, img: Buffer, turn: 90 | 180 | 270): Promise<boolean> {
  const a = await sharp(img).resize(512, 512, { fit: "inside" }).jpeg({ quality: 80 }).toBuffer();
  const b = await sharp(a).rotate(turn).jpeg({ quality: 80 }).toBuffer();
  const r = await client.chat.completions.create({
    model,
    temperature: 0,
    max_tokens: 30,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              'Two versions of one clothing photo. Which one shows the garment the right way up — the way it hangs or is worn: the hanger, waistband or collar toward the TOP, hems toward the bottom, any printed text reading normally? A close-up or a photo where up and down cannot be told counts as already right: answer "A". Answer "B" only when version A is clearly sideways or upside down and B is clearly upright. JSON only: {"upright": "A"|"B"}',
          },
          { type: "text", text: "Version A:" },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${a.toString("base64")}`, detail: "low" } },
          { type: "text", text: "Version B:" },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b.toString("base64")}`, detail: "low" } },
        ],
      },
    ],
  });
  const j = JSON.parse(text(r.choices?.[0]?.message?.content) || "{}") as { upright?: unknown };
  return String(j.upright ?? "").trim().toUpperCase() === "B";
}
