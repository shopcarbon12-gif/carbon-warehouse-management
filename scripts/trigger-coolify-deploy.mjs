/**
 * POSTs Coolify’s deploy API URL (from Application → Configuration → Webhooks).
 * Requires COOLIFY_API_TOKEN (Keys & Tokens → API Tokens, enable **deploy** permission).
 * @see README.md
 */
const url = process.env.COOLIFY_DEPLOY_WEBHOOK_URL?.trim();
if (!url) {
  console.error(
    "COOLIFY_DEPLOY_WEBHOOK_URL is not set. Copy from Coolify → WMS app → Webhooks → Deploy Webhook.",
  );
  process.exit(1);
}

const token = process.env.COOLIFY_API_TOKEN?.trim();
const headers = { Accept: "application/json" };
if (token) {
  headers.Authorization = `Bearer ${token}`;
}

const res = await fetch(url, { method: "POST", headers });
const body = await res.text();
console.log(res.status, res.statusText, body ? body.slice(0, 200) : "");
if (res.status === 401 && !token) {
  console.error(
    "Got 401: set COOLIFY_API_TOKEN (Bearer) from Coolify → Security → API Tokens (deploy permission).",
  );
}
process.exit(res.ok ? 0 : 1);
