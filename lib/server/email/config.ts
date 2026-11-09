/**
 * CarbonWMS Email — settings, Amazon SES (sending + domain + event tracking)
 * and the OpenAI client. SES is only the delivery pipe; lists, codes, designs,
 * scheduling and results live in CarbonWMS (owner, 2026-11-07: "build the
 * Amazon SES for the email server").
 *
 * Sender: vip@shopcarbon.com (owner's choice, 2026-11-07; replies go to
 * support@shopcarbon.com). The root domain is shared with support@ and the
 * welcome emails, so the auto-pause limits (bounces, complaints) also protect
 * those.
 *
 * Server env (Coolify, web app):
 *   AWS_SES_ACCESS_KEY_ID, AWS_SES_SECRET_ACCESS_KEY  — IAM user "carbon-wms-email"
 *   AWS_SES_REGION                                     — default us-east-1
 *
 * "Set up Amazon SES" (setupSes) does, once and idempotently:
 *   1. the shopcarbon.com identity with Easy DKIM (3 CNAME records — they sit
 *      beside Resend's, nothing existing changes);
 *   2. a custom MAIL FROM, bounce.shopcarbon.com (MX + SPF records), so SPF
 *      also aligns for DMARC;
 *   3. configuration set "carbon-marketing": reputation metrics on, account
 *      suppression for bounces + complaints, open + click tracking;
 *   4. SNS topic "carbon-email-events" that SES may publish to, an event
 *      destination for every event type, and an HTTPS subscription to
 *      /api/public/email/sns (confirmed automatically when SNS calls it).
 */
import OpenAI from "openai";
import type { Pool } from "pg";
import {
  CreateConfigurationSetCommand,
  CreateConfigurationSetEventDestinationCommand,
  CreateEmailIdentityCommand,
  GetAccountCommand,
  GetConfigurationSetEventDestinationsCommand,
  GetEmailIdentityCommand,
  PutEmailIdentityMailFromAttributesCommand,
  SESv2Client,
  SendEmailCommand,
} from "@aws-sdk/client-sesv2";
import { CreateTopicCommand, ListSubscriptionsByTopicCommand, SNSClient, SetTopicAttributesCommand, SubscribeCommand } from "@aws-sdk/client-sns";
import { getOpenAiApiKey } from "@/lib/openaiConfig";

export const WMS_BASE = (process.env.WMS_APP_PUBLIC_BASE_URL || "https://wms.shopcarbon.com").replace(/\/+$/, "");
export const SHOP_URL = "https://shopcarbon.com";
export const INSTAGRAM_URL = "https://www.instagram.com/shopcarbon/";
export const MARKETING_DOMAIN = "shopcarbon.com";
/** The bounce (MAIL FROM) domain for a sending domain. */
export const mailFromFor = (domain: string) => `bounce.${domain}`;
export const SNS_TOPIC = "carbon-email-events";
export const SNS_ENDPOINT = `${WMS_BASE}/api/public/email/sns`;

export type EmailSettings = {
  fromName: string;
  fromEmail: string;
  replyTo: string;
  postalAddress: string;
  sendingEnabled: boolean;
  maxPerMinute: number;
  bouncePausePct: number;
  configurationSet: string;
  snsTopicArn: string | null;
  /** The creative director (concept + visual review) and the picture model, chosen in Email → Settings. */
  creativeModel: string;
  imageModel: string;
  updatedAt: string | null;
  updatedBy: string | null;
};

/**
 * The AI Designer (whole emails drawn by the picture model) is switched off (owner, 2026-11-09:
 * "$100 in the OpenAI API … none of it even give me 1 good option"). Emails are built in the
 * editor now. Nothing that spends on OpenAI for it runs: new messages, approvals, conversions,
 * visual checks and the worker's turns all stop here. The old designs stay readable and usable
 * in campaigns. EMAIL_AI_DESIGNER=on brings the server side back (the old tests run with it); the tab
 * would also need adding again in email-workspace.tsx.
 */
export const aiDesignerOff = (): boolean => process.env.EMAIL_AI_DESIGNER !== "on";
export const AI_DESIGNER_OFF_MSG = "The AI Designer is switched off. Build emails in Email Marketing → Emails → New email.";

/** The models the owner can pick from (2026-11-08: compare GPT-6 Astra with gpt-5.5; Sunburst 2.5 / 2.6). */
export const CREATIVE_MODELS = ["gpt-6-astra", "gpt-5.5"] as const;
export const IMAGE_MODELS = ["gpt-image-2.5-sunburst", "gpt-image-2.6-sunburst"] as const;

type Row = {
  from_name: string;
  from_email: string;
  reply_to: string;
  postal_address: string;
  sending_enabled: boolean;
  max_per_minute: number;
  bounce_pause_pct: string;
  configuration_set: string;
  sns_topic_arn: string | null;
  creative_model: string | null;
  image_model: string | null;
  updated_at: Date;
  updated_by: string | null;
};

export async function getEmailSettings(pool: Pool, tenantId: string): Promise<EmailSettings> {
  await pool.query(`INSERT INTO email_settings (tenant_id) VALUES ($1::uuid) ON CONFLICT DO NOTHING`, [tenantId]);
  const r = await pool.query<Row>(`SELECT * FROM email_settings WHERE tenant_id = $1::uuid`, [tenantId]);
  const s = r.rows[0];
  return {
    fromName: s.from_name,
    fromEmail: s.from_email,
    replyTo: s.reply_to,
    postalAddress: s.postal_address,
    sendingEnabled: s.sending_enabled,
    maxPerMinute: s.max_per_minute,
    bouncePausePct: Number(s.bounce_pause_pct),
    configurationSet: s.configuration_set,
    snsTopicArn: s.sns_topic_arn,
    creativeModel: s.creative_model || "gpt-6-astra",
    imageModel: s.image_model || imageModel(),
    updatedAt: s.updated_at?.toISOString() ?? null,
    updatedBy: s.updated_by,
  };
}

/* ------------------------------------------------------------------ OpenAI */

export function openai(): OpenAI {
  const apiKey = getOpenAiApiKey().trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set on the server");
  return new OpenAI({ apiKey, timeout: 15 * 60_000 });
}

/** Text + vision model for planning designs and converting them (env can override). */
export const textModel = () => (process.env.EMAIL_AI_MODEL || process.env.SIZE_GRADING_OPENAI_MODEL || "gpt-5.5").trim();
export const imageModel = () => (process.env.EMAIL_IMAGE_MODEL || process.env.OPENAI_IMAGE_MODEL || "gpt-image-2.5-sunburst").trim();
export const transcribeModel = () => (process.env.EMAIL_TRANSCRIBE_MODEL || "gpt-4o-transcribe").trim();
/**
 * The design pictures at the size a customer sees them (owner, 2026-11-08):
 *  desktop — the 600 px email column at 2× (1200 px wide; 3584 tall = 1,792 email px,
 *            the picture model's 3:1 limit);
 *  mobile  — a 375 px phone screen at ~3× (1120 px wide), drawn as a TOP part and a
 *            BOTTOM part of 1120x3344 each, joined into one 1120x6688 phone picture
 *            (about 2,240 phone px of email).
 */
export const DESKTOP_SIZE = (process.env.EMAIL_DESKTOP_SIZE || "1200x3584").trim();
export const MOBILE_SIZE = (process.env.EMAIL_MOBILE_SIZE || "1120x3344").trim();
/** Email (CSS) pixels per picture pixel, for the prompts. */
export const DESKTOP_SCALE = 2;
export const MOBILE_SCALE = 1120 / 375;

/* --------------------------------------------------------------------- SES */

export function sesConfigured(): boolean {
  return Boolean(process.env.AWS_SES_ACCESS_KEY_ID?.trim() && process.env.AWS_SES_SECRET_ACCESS_KEY?.trim());
}

export const sesRegion = () => (process.env.AWS_SES_REGION || "us-east-1").trim();

function creds() {
  if (!sesConfigured()) throw new Error("Amazon SES is not connected: AWS_SES_ACCESS_KEY_ID and AWS_SES_SECRET_ACCESS_KEY are not set on the server");
  return { accessKeyId: process.env.AWS_SES_ACCESS_KEY_ID!.trim(), secretAccessKey: process.env.AWS_SES_SECRET_ACCESS_KEY!.trim() };
}

let sesClient: SESv2Client | null = null;
let snsClient: SNSClient | null = null;
export function ses(): SESv2Client {
  return (sesClient ??= new SESv2Client({ region: sesRegion(), credentials: creds() }));
}
function sns(): SNSClient {
  return (snsClient ??= new SNSClient({ region: sesRegion(), credentials: creds() }));
}

export type DnsRecord = { type: "CNAME" | "MX" | "TXT"; name: string; value: string; purpose: string; status: string };

export type SesStatus = {
  configured: boolean;
  region: string;
  production: boolean | null;
  maxPerSecond: number | null;
  max24h: number | null;
  sent24h: number | null;
  enforcement: string | null;
  identity: { domain: string; mailFromDomain: string; exists: boolean; verified: boolean; dkim: string | null; mailFrom: string | null };
  tracking: { topicArn: string | null; subscription: string | null };
  records: DnsRecord[];
  dmarc: string | null;
  error?: string;
};

function errName(e: unknown): string {
  return (e as { name?: string })?.name ?? "";
}

export async function sesStatus(pool: Pool, tenantId: string): Promise<SesStatus> {
  const s = await getEmailSettings(pool, tenantId);
  const base: SesStatus = {
    configured: sesConfigured(),
    region: sesRegion(),
    production: null,
    maxPerSecond: null,
    max24h: null,
    sent24h: null,
    enforcement: null,
    identity: { domain: s.fromEmail.split("@")[1]?.toLowerCase() || MARKETING_DOMAIN, mailFromDomain: mailFromFor(s.fromEmail.split("@")[1]?.toLowerCase() || MARKETING_DOMAIN), exists: false, verified: false, dkim: null, mailFrom: null },
    tracking: { topicArn: s.snsTopicArn, subscription: null },
    records: [],
    dmarc: await dmarcRecord().catch(() => null),
  };
  if (!base.configured) return base;
  try {
    const a = await ses().send(new GetAccountCommand({}));
    base.production = a.ProductionAccessEnabled ?? false;
    base.maxPerSecond = a.SendQuota?.MaxSendRate ?? null;
    base.max24h = a.SendQuota?.Max24HourSend ?? null;
    base.sent24h = a.SendQuota?.SentLast24Hours ?? null;
    base.enforcement = a.EnforcementStatus ?? null;
    const domain = s.fromEmail.split("@")[1]?.toLowerCase() ?? MARKETING_DOMAIN;
    try {
      const id = await ses().send(new GetEmailIdentityCommand({ EmailIdentity: domain }));
      base.identity = {
        ...base.identity,
        exists: true,
        verified: Boolean(id.VerifiedForSendingStatus),
        dkim: id.DkimAttributes?.Status ?? null,
        mailFrom: id.MailFromAttributes?.MailFromDomainStatus ?? null,
      };
      for (const t of id.DkimAttributes?.Tokens ?? []) {
        base.records.push({ type: "CNAME", name: `${t}._domainkey.${domain}`, value: `${t}.dkim.amazonses.com`, purpose: "DKIM signature (proves the email is really from Carbon)", status: id.DkimAttributes?.Status ?? "PENDING" });
      }
      const mf = id.MailFromAttributes?.MailFromDomain;
      if (mf) {
        base.records.push({ type: "MX", name: mf, value: `10 feedback-smtp.${sesRegion()}.amazonses.com`, purpose: "Bounce handling for the sending address", status: id.MailFromAttributes?.MailFromDomainStatus ?? "PENDING" });
        base.records.push({ type: "TXT", name: mf, value: "v=spf1 include:amazonses.com ~all", purpose: `SPF (allows Amazon to send for ${domain})`, status: id.MailFromAttributes?.MailFromDomainStatus ?? "PENDING" });
      }
    } catch (e) {
      if (errName(e) !== "NotFoundException") throw e;
    }
    if (!base.dmarc) {
      base.records.push({ type: "TXT", name: "_dmarc.shopcarbon.com", value: "v=DMARC1; p=none; rua=mailto:support@shopcarbon.com; adkim=r; aspf=r", purpose: "DMARC (Gmail and Yahoo expect it from senders of marketing email)", status: "MISSING" });
    }
    if (s.snsTopicArn) {
      const subs = await sns().send(new ListSubscriptionsByTopicCommand({ TopicArn: s.snsTopicArn }));
      const mine = subs.Subscriptions?.find((x) => x.Endpoint === SNS_ENDPOINT);
      base.tracking.subscription = mine ? (mine.SubscriptionArn === "PendingConfirmation" ? "pending" : "confirmed") : "missing";
    }
  } catch (e) {
    base.error = e instanceof Error ? e.message : String(e);
  }
  return base;
}

/** Create (or repair) everything SES needs. Safe to press again. */
export async function setupSes(pool: Pool, tenantId: string): Promise<SesStatus> {
  const s = await getEmailSettings(pool, tenantId);
  const domain = s.fromEmail.split("@")[1]?.toLowerCase() || MARKETING_DOMAIN;
  try {
    await ses().send(new GetEmailIdentityCommand({ EmailIdentity: domain }));
  } catch (e) {
    if (errName(e) !== "NotFoundException") throw e;
    await ses().send(new CreateEmailIdentityCommand({ EmailIdentity: domain, ConfigurationSetName: undefined }));
  }
  await ses().send(new PutEmailIdentityMailFromAttributesCommand({ EmailIdentity: domain, MailFromDomain: mailFromFor(domain), BehaviorOnMxFailure: "USE_DEFAULT_VALUE" }));

  try {
    await ses().send(
      new CreateConfigurationSetCommand({
        ConfigurationSetName: s.configurationSet,
        ReputationOptions: { ReputationMetricsEnabled: true },
        SendingOptions: { SendingEnabled: true },
        SuppressionOptions: { SuppressedReasons: ["BOUNCE", "COMPLAINT"] },
        DeliveryOptions: { TlsPolicy: "OPTIONAL" },
      }),
    );
  } catch (e) {
    if (errName(e) !== "AlreadyExistsException") throw e;
  }

  const topic = await sns().send(new CreateTopicCommand({ Name: SNS_TOPIC }));
  const topicArn = topic.TopicArn!;
  const account = topicArn.split(":")[4];
  await sns().send(
    new SetTopicAttributesCommand({
      TopicArn: topicArn,
      AttributeName: "Policy",
      AttributeValue: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "ses-publish",
            Effect: "Allow",
            Principal: { Service: "ses.amazonaws.com" },
            Action: "SNS:Publish",
            Resource: topicArn,
            Condition: { StringEquals: { "AWS:SourceAccount": account } },
          },
        ],
      }),
    }),
  );
  const dests = await ses().send(new GetConfigurationSetEventDestinationsCommand({ ConfigurationSetName: s.configurationSet }));
  if (!dests.EventDestinations?.some((d) => d.Name === "carbon-wms")) {
    await ses().send(
      new CreateConfigurationSetEventDestinationCommand({
        ConfigurationSetName: s.configurationSet,
        EventDestinationName: "carbon-wms",
        EventDestination: {
          Enabled: true,
          MatchingEventTypes: ["SEND", "REJECT", "BOUNCE", "COMPLAINT", "DELIVERY", "OPEN", "CLICK", "RENDERING_FAILURE", "DELIVERY_DELAY"],
          SnsDestination: { TopicArn: topicArn },
        },
      }),
    );
  }
  await pool.query(`UPDATE email_settings SET sns_topic_arn = $2, updated_at = now() WHERE tenant_id = $1::uuid`, [tenantId, topicArn]);
  const subs = await sns().send(new ListSubscriptionsByTopicCommand({ TopicArn: topicArn }));
  if (!subs.Subscriptions?.some((x) => x.Endpoint === SNS_ENDPOINT)) {
    await sns().send(new SubscribeCommand({ TopicArn: topicArn, Protocol: "https", Endpoint: SNS_ENDPOINT }));
  }
  return sesStatus(pool, tenantId);
}

/** Is the sender's domain verified and is the account allowed to send? */
export async function senderReady(s: EmailSettings): Promise<{ ok: boolean; why: string | null; sandbox: boolean }> {
  if (!sesConfigured()) return { ok: false, why: "Amazon SES is not connected (AWS keys missing on the server).", sandbox: false };
  const domain = s.fromEmail.split("@")[1]?.toLowerCase() ?? "";
  try {
    const id = await ses().send(new GetEmailIdentityCommand({ EmailIdentity: domain }));
    const a = await ses().send(new GetAccountCommand({}));
    if (!id.VerifiedForSendingStatus) return { ok: false, why: `${domain} is not verified in Amazon SES yet. Add its DNS records (Email → Settings).`, sandbox: !a.ProductionAccessEnabled };
    if (a.SendingEnabled === false) return { ok: false, why: "Amazon has paused sending on this account.", sandbox: !a.ProductionAccessEnabled };
    return { ok: true, why: null, sandbox: !a.ProductionAccessEnabled };
  } catch (e) {
    if (errName(e) === "NotFoundException") return { ok: false, why: `${domain} has not been added to Amazon SES. Press "Set up Amazon SES" in Email → Settings.`, sandbox: false };
    return { ok: false, why: e instanceof Error ? e.message : String(e), sandbox: false };
  }
}

/** How many emails may go out per minute right now (SES max rate, capped by the setting). */
export async function sesPacing(s: EmailSettings): Promise<{ perMinute: number; leftToday: number }> {
  const a = await ses().send(new GetAccountCommand({}));
  const perSecond = a.SendQuota?.MaxSendRate ?? 1;
  const left = Math.max(0, Math.floor((a.SendQuota?.Max24HourSend ?? 0) - (a.SendQuota?.SentLast24Hours ?? 0)));
  return { perMinute: Math.max(1, Math.min(s.maxPerMinute, Math.floor(perSecond * 60 * 0.8))), leftToday: left };
}

export class SesSendError extends Error {
  constructor(message: string, public kind: "throttle" | "account" | "recipient" | "other") {
    super(message);
  }
}

export async function sesSend(
  s: EmailSettings,
  input: { to: string; subject: string; html: string; text: string; unsub: string; tags: { name: string; value: string }[] },
): Promise<string> {
  try {
    const r = await ses().send(
      new SendEmailCommand({
        FromEmailAddress: `"${s.fromName.replace(/"/g, "")}" <${s.fromEmail}>`,
        Destination: { ToAddresses: [input.to] },
        ReplyToAddresses: s.replyTo ? [s.replyTo] : undefined,
        ConfigurationSetName: s.configurationSet,
        EmailTags: input.tags.map((t) => ({ Name: t.name, Value: t.value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256) })),
        Content: {
          Simple: {
            Subject: { Data: input.subject, Charset: "UTF-8" },
            Body: { Html: { Data: input.html, Charset: "UTF-8" }, Text: { Data: input.text, Charset: "UTF-8" } },
            Headers: [
              { Name: "List-Unsubscribe", Value: `<${input.unsub}>` },
              { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
            ],
          },
        },
      }),
    );
    if (!r.MessageId) throw new Error("Amazon SES did not return a message id");
    return r.MessageId;
  } catch (e) {
    const name = errName(e);
    const msg = e instanceof Error ? e.message : String(e);
    if (/TooManyRequests|Throttling|LimitExceeded/i.test(name)) throw new SesSendError(msg, "throttle");
    if (/AccountSuspended|SendingPaused|MailFromDomainNotVerified|NotFound/i.test(name)) throw new SesSendError(msg, "account");
    if (/MessageRejected/i.test(name) && /not verified/i.test(msg)) throw new SesSendError(`${msg} (Amazon SES is still in sandbox mode: it only sends to verified addresses until production access is granted)`, "account");
    if (/MessageRejected|BadRequest/i.test(name)) throw new SesSendError(msg, "recipient");
    throw new SesSendError(msg, "other");
  }
}

/** DMARC for the root domain. */
export async function dmarcRecord(domain = "shopcarbon.com"): Promise<string | null> {
  const { promises: dns } = await import("node:dns");
  const rows = await dns.resolveTxt(`_dmarc.${domain}`).catch(() => [] as string[][]);
  return rows.map((r) => r.join("")).find((r) => r.toLowerCase().startsWith("v=dmarc1")) ?? null;
}
