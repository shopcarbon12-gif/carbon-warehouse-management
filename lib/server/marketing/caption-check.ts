/**
 * Social — caption check (owner, 2026-10-26: "must have it"). Reads a post's
 * caption and hashtags against the copywriting skill's AI-tells blacklist, the
 * social skill's platform limits (5 hashtags on Instagram, the first ~125
 * characters before "more") and the owner's copy rules, then lists what is
 * wrong and offers a fixed version that changes only what breaks a rule.
 *
 * Nothing is saved here. The panel shows the result; "Use the fixed caption"
 * fills the fields and the post still needs saving and approval.
 */
import { claudeStructured } from "@/lib/server/claude";
import { COPY_RULES } from "./ai-changes";
import { campaignIdentity } from "./campaign-identity";

export type CaptionCheck = {
  ok: boolean;
  issues: { rule: string; quote: string; fix: string }[];
  caption: string;
  hashtags: string[];
};

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["issues", "caption", "hashtags"],
  properties: {
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["rule", "quote", "fix"],
        properties: { rule: { type: "string" }, quote: { type: "string" }, fix: { type: "string" } },
      },
    },
    caption: { type: "string" },
    hashtags: { type: "array", items: { type: "string" } },
  },
} as const;

const SYSTEM = `You check one social post caption for CARBON, a fashion boutique in Orlando, Florida, before the owner approves it.

${COPY_RULES}

Also check:
- The first 125 characters must say something concrete about the clothes or the moment (Instagram cuts the rest behind "more").
- One plain call to action at most.
- Facebook gets the same caption; Bluesky and TikTok may shorten it, so the opening sentence must work on its own. "link in bio" is fine: on Facebook it is replaced by the shop link automatically, so never flag it.
- Hashtags: 3 to 5, no # sign, no spaces, relevant to the pictures and to what shoppers search. CARBON's own tag counts as one.

How to answer:
- issues: every real problem, each with the rule it breaks (a few words), the exact words from the caption (quote), and the fix in a few words. Do not list matters of taste. An empty list when the caption is fine.
- caption: the caption with ONLY those problems fixed (no hashtags in it). Keep everything else word for word: the facts, product names, colours, the voice, the line breaks. Never add facts. If there are no issues, return the caption unchanged.
- hashtags: the fixed list without the # sign (unchanged when they were fine).`;

export async function checkCaption(input: { caption: string; hashtags: string[]; format: string; channels: string[]; campaign?: string | null }): Promise<CaptionCheck> {
  const identity = campaignIdentity(input.campaign);
  const r = await claudeStructured<{ issues: CaptionCheck["issues"]; caption: string; hashtags: string[] }>({
    system: identity ? `${SYSTEM}\n\n${identity}` : SYSTEM,
    content: [
      {
        type: "text",
        text: `Format: ${input.format}. Channels: ${input.channels.join(" + ") || "instagram + facebook"}.\n\nCAPTION:\n${input.caption}\n\nHASHTAGS: ${input.hashtags.map((h) => `#${h.replace(/^#+/, "")}`).join(" ") || "(none)"}`,
      },
    ],
    schema: SCHEMA as unknown as Record<string, unknown>,
    effort: "medium",
    maxTokens: 8000,
  });
  const hashtags = r.hashtags.map((h) => h.trim().replace(/^#+/, "").replace(/\s+/g, "")).filter(Boolean).slice(0, 5);
  const caption = r.caption.trim().slice(0, 2200) || input.caption;
  return { ok: r.issues.length === 0, issues: r.issues, caption, hashtags };
}
