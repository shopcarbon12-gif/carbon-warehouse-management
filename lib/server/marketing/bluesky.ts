/**
 * Social → Bluesky (owner, 2026-10-25: every channel). Signs in with the
 * account's handle and an APP PASSWORD (Bluesky › Settings › Privacy and
 * security › App passwords — never the real password), and posts text with up
 * to 4 pictures. Bluesky posts are at most 300 characters, so the caption is
 * cut at a sentence and the first hashtags are added as real tags; pictures
 * are sent as JPEG under 1 MB (Bluesky's limit). Videos are not sent.
 */
import sharp from "sharp";

const PDS = "https://bsky.social/xrpc";
const MAX_CHARS = 300;

type Session = { accessJwt: string; did: string; handle: string };

export async function blueskyLogin(identifier: string, appPassword: string): Promise<Session> {
  const res = await fetch(`${PDS}/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: identifier.trim().replace(/^@/, ""), password: appPassword.trim() }),
    signal: AbortSignal.timeout(30_000),
  });
  const j = (await res.json().catch(() => ({}))) as Partial<Session> & { message?: string };
  if (!res.ok || !j.accessJwt || !j.did) throw new Error(`Bluesky sign-in failed: ${j.message ?? res.status}`);
  return { accessJwt: j.accessJwt, did: j.did, handle: j.handle ?? identifier };
}

const graphemes = (s: string) => [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(s)].length;

/** The caption fitted to Bluesky: whole sentences that fit, then as many hashtags as fit. */
export function blueskyText(caption: string, hashtags: string[]): { text: string; tags: string[] } {
  const clean = caption.replace(/\s+\n/g, "\n").trim();
  let text = clean;
  if (graphemes(text) > MAX_CHARS - 20) {
    const sentences = clean.split(/(?<=[.!?])\s+/);
    text = "";
    for (const s of sentences) {
      const next = text ? `${text} ${s}` : s;
      if (graphemes(next) > MAX_CHARS - 20) break;
      text = next;
    }
    if (!text) text = [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(clean)].slice(0, MAX_CHARS - 21).map((x) => x.segment).join("") + "…";
  }
  const tags: string[] = [];
  for (const h of hashtags.map((x) => x.replace(/^#+/, "")).filter(Boolean)) {
    const candidate = `${text}${tags.length ? " " : "\n\n"}${[...tags, h].map((t) => `#${t}`).join(" ")}`;
    if (graphemes(candidate) > MAX_CHARS) break;
    tags.push(h);
  }
  return { text: tags.length ? `${text}\n\n${tags.map((t) => `#${t}`).join(" ")}` : text, tags };
}

/** Tag facets: byte offsets of each #tag in the UTF-8 text. */
function tagFacets(text: string, tags: string[]) {
  const enc = new TextEncoder();
  const facets: unknown[] = [];
  for (const t of tags) {
    const i = text.lastIndexOf(`#${t}`);
    if (i < 0) continue;
    const start = enc.encode(text.slice(0, i)).length;
    facets.push({ index: { byteStart: start, byteEnd: start + enc.encode(`#${t}`).length }, features: [{ $type: "app.bsky.richtext.facet#tag", tag: t }] });
  }
  return facets;
}

export async function publishBluesky(
  identifier: string,
  appPassword: string,
  caption: string,
  hashtags: string[],
  media: { kind: string; url: string }[],
): Promise<{ remoteId: string; permalink: string | null }> {
  const s = await blueskyLogin(identifier, appPassword);
  const auth = { Authorization: `Bearer ${s.accessJwt}` };
  const images: unknown[] = [];
  for (const m of media.filter((x) => x.kind === "image").slice(0, 4)) {
    const src = Buffer.from(await (await fetch(m.url, { signal: AbortSignal.timeout(60_000) })).arrayBuffer());
    let q = 85;
    let jpg = await sharp(src).rotate().resize(2000, 2000, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: q, mozjpeg: true }).toBuffer();
    while (jpg.length > 950_000 && q > 45) {
      q -= 10;
      jpg = await sharp(src).rotate().resize(1600, 1600, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: q, mozjpeg: true }).toBuffer();
    }
    const meta = await sharp(jpg).metadata();
    const up = await fetch(`${PDS}/com.atproto.repo.uploadBlob`, { method: "POST", headers: { ...auth, "Content-Type": "image/jpeg" }, body: new Uint8Array(jpg), signal: AbortSignal.timeout(120_000) });
    const uj = (await up.json().catch(() => ({}))) as { blob?: unknown; message?: string };
    if (!up.ok || !uj.blob) throw new Error(`Bluesky picture upload failed: ${uj.message ?? up.status}`);
    images.push({ alt: "", image: uj.blob, aspectRatio: { width: meta.width ?? 4, height: meta.height ?? 5 } });
  }
  const { text, tags } = blueskyText(caption, hashtags);
  const record: Record<string, unknown> = { $type: "app.bsky.feed.post", text, createdAt: new Date().toISOString(), langs: ["en"], facets: tagFacets(text, tags) };
  if (images.length) record.embed = { $type: "app.bsky.embed.images", images };
  const res = await fetch(`${PDS}/com.atproto.repo.createRecord`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ repo: s.did, collection: "app.bsky.feed.post", record }),
    signal: AbortSignal.timeout(60_000),
  });
  const j = (await res.json().catch(() => ({}))) as { uri?: string; message?: string };
  if (!res.ok || !j.uri) throw new Error(`Bluesky post failed: ${j.message ?? res.status}`);
  const rkey = j.uri.split("/").pop();
  return { remoteId: j.uri, permalink: rkey ? `https://bsky.app/profile/${s.handle}/post/${rkey}` : null };
}
