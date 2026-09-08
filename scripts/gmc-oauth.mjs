/**
 * GMC OAuth helper — obtain a user-delegated refresh token for Merchant API v1.
 *
 * WHY: the service account (claude-merchant-reader@shopify-ai-catalog) cannot register
 * the GCP project with the merchant account — Google refuses:
 *   "GCP registration is not allowed for service accounts. Please use a human user account."
 * Content API v2.1 is sunset for this project (products/datafeeds return 410), so product-
 * and feed-level work requires Merchant API v1, which requires that registration.
 *
 * Usage:
 *   node scripts/gmc-oauth.mjs url                 # print the consent URL
 *   node scripts/gmc-oauth.mjs exchange <code>     # swap the code for a refresh token
 *   node scripts/gmc-oauth.mjs test                # verify the stored refresh token works
 *   node scripts/gmc-oauth.mjs register            # registerGcp as the human user
 *
 * Credentials live in .env.gmc-oauth (gitignored). Nothing is ever printed to stdout.
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';

const ENVFILE = '/home/carbondev/dev/carbon-warehouse-management/.env.gmc-oauth';
const MID = '779385360';
const SCOPE = 'https://www.googleapis.com/auth/content';
const REDIRECT = 'http://localhost'; // must match the client's registered redirect_uris exactly

function env() {
  const out = {};
  if (!existsSync(ENVFILE)) return out;
  for (const l of readFileSync(ENVFILE, 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}
const need = (e, k) => { if (!e[k]) { console.error(`Missing ${k} in ${ENVFILE}`); process.exit(1); } return e[k]; };

const cmd = process.argv[2];
const e = env();

if (cmd === 'url') {
  const id = need(e, 'GMC_OAUTH_CLIENT_ID');
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', id);
  u.searchParams.set('redirect_uri', REDIRECT);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', SCOPE);
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  console.log('\nOpen this URL in the browser signed in as the Merchant Center admin:\n');
  console.log(u.toString());
  console.log('\nAfter approving you will land on a "site can\'t be reached" page at localhost.');
  console.log('That is expected. Copy the FULL URL from the address bar — it contains ?code=...\n');
}

else if (cmd === 'exchange') {
  const raw = process.argv[3];
  if (!raw) { console.error('usage: exchange <code-or-full-redirect-url>'); process.exit(1); }
  let code = raw;
  if (raw.includes('code=')) { try { code = new URL(raw).searchParams.get('code'); } catch { code = decodeURIComponent(raw.split('code=')[1].split('&')[0]); } }
  const body = new URLSearchParams({
    code, client_id: need(e, 'GMC_OAUTH_CLIENT_ID'), client_secret: need(e, 'GMC_OAUTH_CLIENT_SECRET'),
    redirect_uri: REDIRECT, grant_type: 'authorization_code',
  });
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  const j = await r.json();
  if (!j.refresh_token) { console.error('No refresh_token returned. Response:', JSON.stringify({ ...j, access_token: j.access_token ? '<redacted>' : undefined })); process.exit(1); }
  appendFileSync(ENVFILE, `\nGMC_OAUTH_REFRESH_TOKEN=${j.refresh_token}\n`);
  console.log(`refresh token stored in ${ENVFILE} (not printed). scope=${j.scope}`);
}

else if (cmd === 'test' || cmd === 'register') {
  const body = new URLSearchParams({
    client_id: need(e, 'GMC_OAUTH_CLIENT_ID'), client_secret: need(e, 'GMC_OAUTH_CLIENT_SECRET'),
    refresh_token: need(e, 'GMC_OAUTH_REFRESH_TOKEN'), grant_type: 'refresh_token',
  });
  const tr = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  const tj = await tr.json();
  if (!tj.access_token) { console.error('token refresh failed:', JSON.stringify(tj)); process.exit(1); }
  const H = { authorization: `Bearer ${tj.access_token}`, 'content-type': 'application/json' };

  if (cmd === 'test') {
    const r = await fetch(`https://shoppingcontent.googleapis.com/content/v2.1/${MID}/accounts/authinfo`, { headers: H });
    console.log('authinfo ->', r.status, (await r.text()).slice(0, 300));
    const v1 = await fetch(`https://merchantapi.googleapis.com/accounts/v1/accounts/${MID}`, { headers: H });
    console.log('merchantapi v1 account ->', v1.status, (await v1.text()).slice(0, 300));
  } else {
    const r = await fetch(`https://merchantapi.googleapis.com/accounts/v1/accounts/${MID}/developerRegistration:registerGcp`,
      { method: 'POST', headers: H, body: JSON.stringify({ developerEmail: e.GMC_OAUTH_DEVELOPER_EMAIL || undefined }) });
    console.log('registerGcp ->', r.status);
    console.log(await r.text());
  }
}

else {
  console.log('commands: url | exchange <code> | test | register');
}
