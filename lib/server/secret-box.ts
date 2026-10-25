/**
 * Seal and open small secrets kept in the database (a channel's app password
 * or token): AES-256-GCM with a key derived from SESSION_SECRET, so a database
 * copy alone does not reveal them. Format: v1.<iv>.<tag>.<data>, base64url.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

function key(): Buffer {
  const s = (process.env.SESSION_SECRET || "").trim();
  if (!s) throw new Error("SESSION_SECRET is not set");
  return createHash("sha256").update(`carbon-secret-box:${s}`).digest();
}

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}

export function open(sealed: string): string {
  const [v, iv, tag, data] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || !data) throw new Error("Unreadable secret");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(data, "base64url")), d.final()]).toString("utf8");
}
