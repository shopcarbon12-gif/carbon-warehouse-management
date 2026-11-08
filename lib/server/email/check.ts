/**
 * CarbonWMS Email — steps 5 and 6 (owner, 2026-11-08: "render it and have AI
 * look at the actual screenshots … never save the HTML as finished until the
 * rendered versions pass a quality review").
 *
 * After "Convert to email" writes the HTML: render it as a customer gets it
 * (sample name and code, real footer) at desktop and phone width, the
 * creative model reviews the screenshots against the facts, and when it fails,
 * the HTML is fixed (gpt-5.5) and checked again — at most 2 fixes. The design
 * becomes "ready" either way so the owner can see it, but a campaign can only
 * use it once it passed (or the owner chose "use it anyway").
 */
import sharp from "sharp";
import type { Pool } from "pg";
import { uploadBytesToStorage } from "@/lib/storageProvider";
import { getEmailSettings } from "./config";
import { previewHtml } from "./preview";
import { renderEmail } from "./render";
import { fixHtml, review, type Issue } from "./creative";
import { sanitizeEmailHtml } from "./rules";
import { STORE } from "./brand";
import type { TurnProduct } from "./designer";

export type CheckRound = { round: number; pass: boolean; score: number; summary: string; issues: Issue[]; desktop: string | null; phone: string | null; model: string; at: string; fixed?: boolean; error?: string };

const MAX_FIXES = 2;

function factsFor(products: TurnProduct[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const p of products) {
    if (p.set) {
      if (seen.has(p.set.name)) continue;
      seen.add(p.set.name);
      lines.push(`- ${p.set.name}: ${p.set.line}, Set $${p.set.total.toFixed(2)} (one set card)`);
    } else lines.push(`- ${p.title}: $${p.price.toFixed(2)}`);
  }
  return [
    lines.length ? `Products and prices:\n${lines.join("\n")}` : "No specific products.",
    `Store: ${STORE.address} · ${STORE.hours} · ${STORE.phone}.`,
    `The customer's name shows as "Maria" and their personal code as a sample code; the footer with unsubscribe and address is added by the system.`,
  ].join("\n");
}

async function keepShot(designId: string, round: number, view: "desktop" | "phone", png: Buffer): Promise<string> {
  const jpg = await sharp(png).resize({ width: view === "desktop" ? 1280 : 750, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
  const path = `email/designs/${designId}/check/${Date.now()}-${round}-${view}.jpg`;
  await uploadBytesToStorage({ path, bytes: jpg, contentType: "image/jpeg" });
  return path;
}

/** Render → review → fix → re-check. Leaves the design 'ready' with check_status passed | failed | error. */
export async function checkDesign(pool: Pool, designId: string, log: (m: string) => void = console.log): Promise<void> {
  const d = await pool.query<{ tenant_id: string; html: string | null; subject_hint: string | null; preheader_hint: string | null; chosen_message: string | null }>(
    `SELECT tenant_id::text, html, subject_hint, preheader_hint, chosen_message::text FROM email_designs WHERE id = $1::uuid`,
    [designId],
  );
  const row = d.rows[0];
  if (!row?.html) return;
  const m = row.chosen_message
    ? await pool.query<{ products: TurnProduct[] | null }>(`SELECT products FROM email_design_messages WHERE id = $1::uuid`, [row.chosen_message])
    : null;
  const settings = await getEmailSettings(pool, row.tenant_id);
  const facts = factsFor(m?.rows[0]?.products ?? []);
  await pool.query(`UPDATE email_designs SET check_status = 'running', check_rounds = '[]'::jsonb, check_override = false, updated_at = now() WHERE id = $1::uuid`, [designId]);
  const rounds: CheckRound[] = [];
  let html = row.html;
  let status: "passed" | "failed" | "error" = "failed";
  try {
    for (let round = 1; round <= MAX_FIXES + 1; round++) {
      const page = previewHtml({ html, subject: row.subject_hint ?? "", preheader: row.preheader_hint ?? "", postalAddress: settings.postalAddress });
      const shots = await renderEmail(page);
      const r = await review(settings.creativeModel, { desktop: shots.desktop, phone: shots.phone }, facts);
      const item: CheckRound = {
        round,
        pass: r.pass,
        score: r.score,
        summary: r.summary,
        issues: r.issues,
        desktop: await keepShot(designId, round, "desktop", shots.desktop),
        phone: await keepShot(designId, round, "phone", shots.phone),
        model: r.model,
        at: new Date().toISOString(),
      };
      rounds.push(item);
      await pool.query(`UPDATE email_designs SET check_rounds = $2 WHERE id = $1::uuid`, [designId, JSON.stringify(rounds)]);
      log(`[email-check] ${designId}: round ${round} ${r.pass ? "PASSED" : "failed"} (score ${r.score}, ${r.issues.length} issue(s), ${r.model})`);
      if (r.pass) {
        status = "passed";
        break;
      }
      if (round > MAX_FIXES) break;
      const fixed = sanitizeEmailHtml(await fixHtml(html, r.issues));
      html = fixed;
      item.fixed = true;
      await pool.query(`UPDATE email_designs SET html = $2, check_rounds = $3 WHERE id = $1::uuid`, [designId, html, JSON.stringify(rounds)]);
    }
  } catch (e) {
    status = "error";
    const msg = e instanceof Error ? e.message : String(e);
    rounds.push({ round: rounds.length + 1, pass: false, score: 0, summary: "The visual check could not run.", issues: [], desktop: null, phone: null, model: "", at: new Date().toISOString(), error: msg.slice(0, 400) });
    log(`[email-check] ${designId}: check could not run: ${msg}`);
  }
  await pool.query(`UPDATE email_designs SET status = 'ready', check_status = $2, check_rounds = $3, updated_at = now() WHERE id = $1::uuid`, [designId, status, JSON.stringify(rounds)]);
}

/** Designs whose owner pressed "Check again" (check_status 'queued'), one at a time (called by the tick). */
export async function runQueuedChecks(pool: Pool, log: (m: string) => void = console.log): Promise<number> {
  // A check cut off by a restart: run it again.
  await pool.query(`UPDATE email_designs SET check_status = 'queued' WHERE (status = 'checking' OR check_status = 'running') AND updated_at < now() - interval '30 minutes'`);
  const r = await pool.query<{ id: string }>(
    `UPDATE email_designs SET check_status = 'running' WHERE id = (SELECT id FROM email_designs WHERE check_status = 'queued' ORDER BY updated_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id::text`,
  );
  if (!r.rows[0]) return 0;
  await checkDesign(pool, r.rows[0].id, log);
  return 1;
}
