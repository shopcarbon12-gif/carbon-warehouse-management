/**
 * POSTs Coolify’s application deploy webhook. Set COOLIFY_DEPLOY_WEBHOOK_URL in the environment.
 * @see README.md — optional after git push if Coolify is not wired to Git auto-deploy.
 */
const url = process.env.COOLIFY_DEPLOY_WEBHOOK_URL?.trim();
if (!url) {
  console.error(
    "COOLIFY_DEPLOY_WEBHOOK_URL is not set. Add it in .env or the shell, or redeploy from the Coolify UI.",
  );
  process.exit(1);
}

const res = await fetch(url, { method: "POST" });
const body = await res.text();
console.log(res.status, res.statusText, body ? body.slice(0, 200) : "");
process.exit(res.ok ? 0 : 1);
