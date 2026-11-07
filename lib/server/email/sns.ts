/**
 * Amazon SNS message signature check for /api/public/email/sns (SES events).
 * https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html
 *
 * - the signing certificate must come from https://sns.<region>.amazonaws.com/…pem;
 * - SignatureVersion 1 = SHA1withRSA, 2 = SHA256withRSA;
 * - the string to sign is "Key\nValue\n" for a fixed list of keys per type.
 */
import { createVerify } from "node:crypto";

export type SnsMessage = {
  Type: "Notification" | "SubscriptionConfirmation" | "UnsubscribeConfirmation" | string;
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  Subject?: string;
  SubscribeURL?: string;
  Token?: string;
};

const CERT_HOST_RE = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;
const certCache = new Map<string, { pem: string; at: number }>();

export function stringToSign(m: SnsMessage): string {
  const keys =
    m.Type === "Notification"
      ? ["Message", "MessageId", ...(m.Subject !== undefined ? ["Subject"] : []), "Timestamp", "TopicArn", "Type"]
      : ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
  return keys.map((k) => `${k}\n${(m as Record<string, string | undefined>)[k] ?? ""}\n`).join("");
}

export function certUrlAllowed(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && CERT_HOST_RE.test(url.hostname) && url.pathname.endsWith(".pem");
  } catch {
    return false;
  }
}

async function cert(u: string): Promise<string> {
  const hit = certCache.get(u);
  if (hit && Date.now() - hit.at < 24 * 3600_000) return hit.pem;
  const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`certificate HTTP ${r.status}`);
  const pem = await r.text();
  if (!pem.includes("BEGIN CERTIFICATE")) throw new Error("not a certificate");
  certCache.set(u, { pem, at: Date.now() });
  return pem;
}

export async function verifySns(m: SnsMessage): Promise<boolean> {
  if (!m || typeof m !== "object" || !m.Signature || !m.SigningCertURL) return false;
  if (!certUrlAllowed(m.SigningCertURL)) return false;
  if (m.SignatureVersion !== "1" && m.SignatureVersion !== "2") return false;
  // Refuse stale replays (SNS retries for a while when we are down; events are idempotent by MessageId).
  const t = Date.parse(m.Timestamp);
  if (!Number.isFinite(t) || Math.abs(Date.now() - t) > 24 * 3600_000) return false;
  const pem = await cert(m.SigningCertURL);
  const v = createVerify(m.SignatureVersion === "1" ? "RSA-SHA1" : "RSA-SHA256");
  v.update(stringToSign(m), "utf8");
  return v.verify(pem, m.Signature, "base64");
}

export function subscribeUrlAllowed(u: string | undefined): boolean {
  if (!u) return false;
  try {
    const url = new URL(u);
    return url.protocol === "https:" && CERT_HOST_RE.test(url.hostname);
  } catch {
    return false;
  }
}
