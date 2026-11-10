/** CarbonWMS Email — input checks shared by the routes. */
import { z } from "zod";
import type { Audience } from "./contacts";
import type { Offer } from "./campaigns";
import { cleanPrefix } from "./rules";
import { isRules, type SegRule } from "@/lib/email-editor/segments";

const audienceSchema = z
  .object({
    who: z.enum(["all", "subscribed"]).default("all"),
    sinceYear: z.number().int().min(2000).max(2100).nullable().optional(),
    beforeYear: z.number().int().min(2000).max(2100).nullable().optional(),
    notEmailedDays: z.number().int().min(1).max(365).nullable().optional(),
    emails: z.array(z.string().email().max(254)).max(50).nullable().optional(),
    segment: z
      .object({ id: z.string().max(40), name: z.string().max(80), rules: z.custom<SegRule[]>((v) => isRules(v), "Invalid segment rules") })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

export function parseAudience(v: unknown): Audience | null {
  const p = audienceSchema.safeParse(v ?? {});
  if (!p.success) return null;
  return { ...p.data, emails: p.data.emails?.map((e) => e.toLowerCase()) ?? null };
}

const offerSchema = z
  .object({
    amount: z.number().min(1).max(500),
    endsAt: z.string().datetime({ offset: true }),
    minSubtotal: z.number().min(0).max(10000).nullable().optional(),
    prefix: z.string().max(12).optional(),
    kind: z.enum(["amount", "percent"]).optional(),
  })
  .strict()
  .refine((o) => o.kind !== "percent" || o.amount <= 90, { message: "At most 90% off" });

export function parseOffer(v: unknown): Offer | null | "invalid" {
  if (v === null || v === undefined) return null;
  const p = offerSchema.safeParse(v);
  if (!p.success) return "invalid";
  const kind = p.data.kind ?? "amount";
  return {
    amount: kind === "percent" ? Math.round(p.data.amount) : Math.round(p.data.amount * 100) / 100,
    endsAt: new Date(p.data.endsAt).toISOString(),
    minSubtotal: p.data.minSubtotal || null,
    prefix: cleanPrefix(p.data.prefix),
    kind,
  };
}
