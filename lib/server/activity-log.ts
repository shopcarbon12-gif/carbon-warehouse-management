import { verifySessionToken, type SessionPayload } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { describeRoute } from "@/lib/activity-catalog";

/**
 * Activity logging for every data-changing API call.
 *
 * Each POST / PUT / PATCH / DELETE route handler is exported through
 * `withActivity("<route pattern>", handler)`. After the handler answers, one
 * `audit_log` row (action `api_request`) records WHO (session user), WHEN,
 * WHERE FROM (web page, handheld + device id, Shopify webhook, machine), WHAT
 * was sent (sanitised — passwords, tokens and secrets never stored), the
 * route's URL params, and HOW it ended (HTTP status, error text, small result
 * summary). The Activity history page turns these rows into plain English.
 *
 * The write is fire-and-forget: logging can never slow down or fail a request.
 */

/** Machine traffic and read-only lookups — far too frequent to log, and not
 *  anything a person did. */
const SKIP_ROUTES = new Set<string>([
  "cdm-agents/heartbeat",
  "cdm-agents/reads",
  "cdm-agents/reader-offline",
  "cdm-agents/reader-online",
  "cdm-agents/wiznet-discoveries",
  "cdm-agents/antenna-test-result",
  "cdm-agents/encode-jobs/[id]/result",
  "cdm-agents/lookup-by-epc",
  "edge/ingest",
  "antenna-test/ingest",
  "internal/models-sync",
  "internal/smoke/worker-queue",
  "agents/network-prewarm",
  "scan-sessions/touch",
  "scan-sessions/prewarm",
  "mobile/device-ping",
  "studio/state",
  "generate/run-qa",
  "generate/job",
  "image-handoff/session",
  "image-handoff/session/[sessionId]",
  "wishlist",
  "v1/rfid/serial/next",
  "handheld/epc-lookup",
  "handheld/epc-queue",
  "catalog/enrich-epcs",
  "operations/transfers/lookup",
  "rfid/bulk-geiger/decode",
  "rfid/bulk-geiger/parse",
  "inventory/putaway-preview",
  "shopify/metafields/suggest",
]);

const MAX_BODY_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 8 * 1024;
const MAX_STORED_JSON = 24 * 1024;

const SECRET_KEY =
  /pass(word|wd)?$|passcode|secret|token|api[_-]?key|authorization|cookie|credential|private|otp$|totp|mfa|two[_-]?factor|^pin$|_pin$|signature/i;

type Handler = (...args: never[]) => unknown;

export function withActivity<H extends Handler>(route: string, handler: H): H {
  if (SKIP_ROUTES.has(route)) return handler;
  const call = handler as unknown as (...a: unknown[]) => unknown;
  const wrapped = async (...args: unknown[]) => {
    const req = args[0] instanceof Request ? args[0] : null;
    if (!req) return call(...args);

    const started = Date.now();
    const sessionP = sessionFrom(req);
    const bodyP = captureBody(req);
    const ctx = args[1] as { params?: unknown } | undefined;

    let res: unknown;
    try {
      res = await call(...args);
    } catch (e) {
      void record(route, req, started, sessionP, bodyP, ctx, null, e);
      throw e;
    }
    void record(route, req, started, sessionP, bodyP, ctx, res instanceof Response ? res : null, null);
    return res;
  };
  return wrapped as unknown as H;
}

async function sessionFrom(req: Request): Promise<SessionPayload | null> {
  try {
    const auth = req.headers.get("authorization");
    const m = auth?.match(/^Bearer\s+(.+)$/i);
    if (m?.[1]) {
      const s = await verifySessionToken(m[1].trim());
      if (s) return s;
    }
    const cookie = req.headers.get("cookie") ?? "";
    const c = cookie.match(/(?:^|;\s*)wms_session=([^;]+)/)?.[1];
    return c ? await verifySessionToken(decodeURIComponent(c)) : null;
  } catch {
    return null;
  }
}

/** Clone synchronously (before the handler reads the body), read later. */
function captureBody(req: Request): Promise<unknown> {
  if (req.method === "GET" || req.method === "HEAD" || !req.body) return Promise.resolve(undefined);
  const type = (req.headers.get("content-type") ?? "").toLowerCase();
  const len = Number(req.headers.get("content-length") ?? "");
  if (type.includes("multipart/form-data")) {
    return Promise.resolve({ _upload: true, _bytes: Number.isFinite(len) ? len : null });
  }
  if (Number.isFinite(len) && len > MAX_BODY_BYTES) {
    return Promise.resolve({ _omitted: `large body (${Math.round(len / 1024)} KB)` });
  }
  let clone: Request;
  try {
    clone = req.clone();
  } catch {
    return Promise.resolve(undefined);
  }
  return readLimited(clone.body, MAX_BODY_BYTES).then((text) => {
    if (text === null) return { _omitted: "large body" };
    if (!text.trim()) return undefined;
    if (type.includes("json") || /^[[{]/.test(text.trim())) {
      try {
        return sanitize(JSON.parse(text));
      } catch {
        /* fall through */
      }
    }
    if (type.includes("x-www-form-urlencoded")) {
      return sanitize(Object.fromEntries(new URLSearchParams(text)));
    }
    return { _text: text.length > 300 ? `${text.slice(0, 300)}…` : text };
  });
}

/** Read up to `limit` bytes; null when the stream is longer than that. */
async function readLimited(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<string | null> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        void reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function sanitize(value: unknown, depth = 0, key = ""): unknown {
  if (key && SECRET_KEY.test(key)) return value == null || value === "" ? value : "[hidden]";
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.startsWith("data:")) return `[file ${Math.round(value.length / 1365)} KB]`;
    return value.length > 300 ? `${value.slice(0, 300)}… (${value.length} chars)` : value;
  }
  if (depth >= 4) return "[…]";
  if (Array.isArray(value)) {
    const head = value.slice(0, 40).map((v) => sanitize(v, depth + 1));
    if (value.length > 40) head.push(`… +${value.length - 40} more (${value.length} total)`);
    return head;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitize(v, depth + 1, k);
    }
    return out;
  }
  return String(value);
}

function sourceOf(req: Request, route: string, session: SessionPayload | null) {
  const h = req.headers;
  const deviceId = h.get("x-wms-device-id")?.trim() || null;
  const ua = h.get("user-agent") ?? "";
  let source: string;
  if (route.startsWith("webhooks/")) source = "shopify_webhook";
  else if (h.get("x-carbon-mobile") || /dart|okhttp/i.test(ua)) source = "handheld";
  else if (/^bearer\s/i.test(h.get("authorization") ?? "")) source = session ? "handheld" : "machine";
  else if (session) source = /CarbonWMS-PC|; wv\)/.test(ua) ? "web_app" : "web";
  else if (h.get("x-edge-api-key") || h.get("x-wms-edge-key") || h.get("x-wms-device-key")) source = "machine";
  else source = "external";

  let page: string | null = null;
  const ref = h.get("referer");
  if (ref) {
    try {
      const u = new URL(ref);
      page = `${u.pathname}${u.search}`.slice(0, 300);
    } catch {
      page = null;
    }
  }
  const ip = (h.get("x-forwarded-for") ?? h.get("x-real-ip") ?? "").split(",")[0]?.trim() || null;
  return { source, deviceId, page, ip, ua: ua.slice(0, 200) || null };
}

async function captureResult(res: Response | null): Promise<{ result?: unknown; error?: string }> {
  if (!res) return {};
  const type = (res.headers.get("content-type") ?? "").toLowerCase();
  if (!type.includes("json") || !res.body) return {};
  let text: string | null;
  try {
    text = await readLimited(res.clone().body, MAX_RESULT_BYTES);
  } catch {
    return {};
  }
  if (!text) return {};
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return {};
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return {};
  const o = j as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  let n = 0;
  for (const [k, v] of Object.entries(o)) {
    if (n >= 16) break;
    if (SECRET_KEY.test(k)) continue;
    if (v == null || typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && v.length <= 200)) {
      result[k] = v;
      n += 1;
    }
  }
  const err = typeof o.error === "string" ? o.error : typeof o.message === "string" && !res.ok ? o.message : undefined;
  return { result: n ? result : undefined, error: err };
}

let singleTenantId: string | null | undefined;

async function fallbackTenant(): Promise<string | null> {
  if (singleTenantId !== undefined) return singleTenantId;
  const pool = getPool();
  if (!pool) return null;
  const r = await pool.query<{ id: string }>(`SELECT id::text FROM tenants LIMIT 2`);
  singleTenantId = r.rows.length === 1 ? r.rows[0]!.id : null;
  return singleTenantId;
}

async function record(
  route: string,
  req: Request,
  started: number,
  sessionP: Promise<SessionPayload | null>,
  bodyP: Promise<unknown>,
  ctx: { params?: unknown } | undefined,
  res: Response | null,
  thrown: unknown,
): Promise<void> {
  try {
    const pool = getPool();
    if (!pool) return;
    const session = await sessionP;
    const tenantId = session?.tid ?? (await fallbackTenant());
    if (!tenantId) return;

    const [body, out, params] = await Promise.all([
      bodyP.catch(() => undefined),
      captureResult(res),
      Promise.resolve(ctx?.params).catch(() => undefined),
    ]);
    const url = new URL(req.url);
    const status = res ? res.status : 500;
    const where = sourceOf(req, route, session);
    const query = Object.fromEntries(url.searchParams);

    const what = describeRoute(req.method, route);
    const metadata: Record<string, unknown> = {
      v: 1,
      module: what.module,
      label: what.label,
      method: req.method,
      route,
      path: url.pathname,
      status,
      ok: status < 400,
      ms: Date.now() - started,
      ...where,
      user_email: session?.email ?? null,
      role: session?.role ?? null,
      location_id: session?.lid ?? null,
      params: params && typeof params === "object" ? sanitize(params) : undefined,
      query: Object.keys(query).length ? sanitize(query) : undefined,
      body,
      result: out.result,
      error: thrown ? String((thrown as Error)?.message ?? thrown).slice(0, 500) : out.error?.slice(0, 500),
    };
    let json = JSON.stringify(metadata);
    if (json.length > MAX_STORED_JSON) {
      metadata.body = { _omitted: `body too large to store (${Math.round(json.length / 1024)} KB)` };
      json = JSON.stringify(metadata);
    }

    await pool.query(
      `INSERT INTO audit_log (tenant_id, user_id, action, entity, metadata)
       SELECT $1::uuid, u.id, 'api_request', $3, $4::jsonb
       FROM (SELECT 1) one LEFT JOIN users u ON u.id = $2::uuid`,
      [tenantId, session?.sub && /^[0-9a-f-]{36}$/i.test(session.sub) ? session.sub : null, `${req.method} ${route}`, json],
    );
  } catch (e) {
    console.warn("[activity-log] write failed:", e instanceof Error ? e.message : e);
  }
}
