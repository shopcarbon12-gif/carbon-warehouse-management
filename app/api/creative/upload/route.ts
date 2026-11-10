/**
 * POST /api/creative/upload (multipart: kind + file [+ fields]) — files the owner adds:
 *   logo | font            Brand Brain logo (light/dark) and headline / body fonts
 *   location               a real photo of the showroom / a place (location library)
 *   music | sfx            the music + SFX library (tempo-tagged by beat detection)
 *   model                  a REAL person's photo → 4-view sheet (consent + not-a-celebrity required)
 *   twin                   a flat-lay / hanger photo replacing a bad cut-out
 *   radar                  manual import of an ad file into Radar
 */
import { NextResponse } from "next/server";
import sharp from "sharp";
import { withActivity } from "@/lib/server/activity-log";
import { guard, fail, kick } from "@/lib/server/creative/http";
import { getBrand, PlainError } from "@/lib/server/creative/config";
import { putFile, appFileUrl } from "@/lib/server/creative/storage";
import { addAudio } from "@/lib/server/creative/audio";
import { createModel } from "@/lib/server/creative/casting";
import { replaceCutout } from "@/lib/server/creative/twin";
import { ingestAd } from "@/lib/server/creative/radar/ingest";
import { queueTagging } from "@/lib/server/creative/radar/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX = 150 * 1024 * 1024;

async function POST_handler(req: Request) {
  const g = await guard(req);
  if ("error" in g) return g.error;
  const tid = g.session.tid;
  try {
    const form = await req.formData();
    const kind = String(form.get("kind") ?? "");
    const file = form.get("file");
    if (!(file instanceof File)) throw new PlainError("No file.");
    if (file.size > MAX) throw new PlainError("That file is too big (150 MB max).");
    const bytes = Buffer.from(await file.arrayBuffer());
    const type = file.type || "application/octet-stream";
    const name = file.name || "file";
    switch (kind) {
      case "logo": {
        const which = String(form.get("which") ?? "white") === "black" ? "black" : "white";
        const png = await sharp(bytes).png().toBuffer();
        const path = await putFile(`creative/brand/${tid}/logo-${which}-${Date.now()}.png`, png, "image/png");
        const b = await getBrand(g.pool, tid);
        await g.pool.query(`UPDATE creative_brand SET logos = $2::jsonb, updated_at = now() WHERE tenant_id = $1::uuid`, [tid, JSON.stringify({ ...b.logos, [which]: appFileUrl(path), [`${which}Path`]: path })]);
        return NextResponse.json({ ok: true, url: appFileUrl(path) });
      }
      case "font": {
        if (!/\.(woff2?|ttf|otf)$/i.test(name)) throw new PlainError("Fonts must be .woff2, .woff, .ttf or .otf.");
        const which = String(form.get("which") ?? "headline") === "body" ? "body" : "headline";
        const ext = name.match(/\.(woff2?|ttf|otf)$/i)![0].toLowerCase();
        const path = await putFile(`creative/brand/${tid}/font-${which}-${Date.now()}${ext}`, bytes, ext === ".woff2" ? "font/woff2" : ext === ".woff" ? "font/woff" : ext === ".otf" ? "font/otf" : "font/ttf");
        const b = await getBrand(g.pool, tid);
        const family = String(form.get("family") ?? "").trim() || name.replace(/\.[^.]+$/, "");
        await g.pool.query(`UPDATE creative_brand SET fonts = $2::jsonb, updated_at = now() WHERE tenant_id = $1::uuid`, [tid, JSON.stringify({ ...b.fonts, [which]: family, [`${which}File`]: path })]);
        return NextResponse.json({ ok: true });
      }
      case "location": {
        const jpg = await sharp(bytes).rotate().resize(2048, 2048, { fit: "inside" }).jpeg({ quality: 90 }).toBuffer();
        const path = await putFile(`creative/locations/${tid}/${Date.now()}.jpg`, jpg, "image/jpeg");
        await g.pool.query(`INSERT INTO creative_locations (tenant_id, name, description, storage_path, source) VALUES ($1::uuid, $2, $3, $4, 'upload')`, [tid, String(form.get("name") ?? "Showroom").slice(0, 80), String(form.get("description") ?? "").slice(0, 400), path]);
        return NextResponse.json({ ok: true, url: appFileUrl(path) });
      }
      case "music":
      case "sfx": {
        if (!/^audio\//.test(type) && !/\.(mp3|wav|m4a|aac)$/i.test(name)) throw new PlainError("Music and SFX must be audio files (mp3, wav, m4a).");
        const moods = String(form.get("moods") ?? "").split(",").map((m) => m.trim()).filter(Boolean);
        const license = String(form.get("license") ?? "owner").slice(0, 80);
        const t = await addAudio(g.pool, tid, { kind, name: String(form.get("name") ?? name).slice(0, 120), bytes, contentType: type, moods, license });
        return NextResponse.json({ track: { ...t, url: appFileUrl(t.storage_path) } });
      }
      case "model": {
        const consent = form.get("consent") === "true";
        const notCelebrity = form.get("notCelebrity") === "true";
        const gender = String(form.get("gender") ?? "female") === "male" ? "male" : "female";
        const id = await createModel(g.pool, tid, { name: String(form.get("name") ?? "New model"), gender, headshot: bytes, isRealPerson: true, consent, notCelebrity, by: g.session.email ?? null, personality: String(form.get("personality") ?? "") || undefined });
        return NextResponse.json({ modelId: id });
      }
      case "twin": {
        const productId = String(form.get("productId") ?? "");
        const angle = String(form.get("angle") ?? "front");
        if (!productId.startsWith("gid://shopify/Product/")) throw new PlainError("Which product?");
        await replaceCutout(g.pool, tid, productId, ["front", "back", "detail", "side"].includes(angle) ? angle : "front", bytes);
        return NextResponse.json({ ok: true });
      }
      case "radar": {
        const isVideo = /^video\//.test(type);
        const path = await putFile(`creative/radar/${tid}/manual-${Date.now()}.${isVideo ? "mp4" : "jpg"}`, isVideo ? bytes : await sharp(bytes).rotate().jpeg({ quality: 90 }).toBuffer(), isVideo ? "video/mp4" : "image/jpeg");
        const res = await ingestAd(g.pool, tid, {
          source: "manual",
          externalId: `upload:${path}`,
          platforms: [String(form.get("platform") ?? "manual")],
          advertiser: String(form.get("advertiser") ?? "Manual import").slice(0, 120),
          headline: String(form.get("headline") ?? "").slice(0, 300),
          body: String(form.get("body") ?? "").slice(0, 2000),
          media: [{ kind: isVideo ? "video" : "image", url: `stored:${path}` }],
          lastSeen: new Date().toISOString(),
        });
        if (res === "new") await queueTagging(g.pool, tid, g.session.email ?? null);
        kick(g.pool, tid);
        return NextResponse.json({ result: res });
      }
      default:
        throw new PlainError("Unknown upload kind.");
    }
  } catch (e) {
    return fail(e);
  }
}

export const POST = withActivity("creative/upload", POST_handler);
