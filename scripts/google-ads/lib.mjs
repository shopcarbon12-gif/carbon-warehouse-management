/**
 * Shared helpers for the Google Ads scripts.
 *
 * No SDK on purpose. The google-ads-api / googleapis packages pull a large
 * dependency tree for what is, at this level, three REST calls. Everything here
 * is plain fetch against documented endpoints.
 *
 * Credentials are read from .env.agent-secrets (gitignored) then process.env,
 * matching the convention in AGENT_CREDENTIALS.md. Nothing is ever written to
 * a tracked file.
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Searched in order, first hit wins. .env.agent-secrets is the documented home
 * per AGENT_CREDENTIALS.md, but people reasonably reach for a plain .env, so
 * accept both rather than fail with a "missing variable" that is actually a
 * wrong-filename error. All of these match the .env* gitignore rule.
 */
const SECRET_FILES = ['.env.agent-secrets', '.env.local', '.env']

/** Parse a dotenv-style file. Ignores comments, tolerates quotes and `export`. */
function parseEnvFile(file) {
  if (!existsSync(file)) return {}
  const out = {}
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).replace(/^export\s+/, '').trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

/** Merge every candidate file, earlier files winning over later ones. */
export function loadSecrets(files = SECRET_FILES) {
  const merged = {}
  for (const name of files) {
    const parsed = parseEnvFile(resolve(process.cwd(), name))
    for (const [key, value] of Object.entries(parsed)) {
      if (!(key in merged)) merged[key] = value
    }
  }
  return merged
}

/** Which of the candidate files actually exist, for error messages. */
export function secretFilesFound() {
  return SECRET_FILES.filter((name) => existsSync(resolve(process.cwd(), name)))
}

/** Env lookup: real environment wins over the file, so CI can override. */
export function env(name, { required = false } = {}) {
  const value = process.env[name] ?? loadSecrets()[name]
  if (required && !value) {
    const found = secretFilesFound()
    const where = found.length
      ? `Looked in ${found.join(', ')} and the environment.`
      : `No ${SECRET_FILES.join(' / ')} file found in ${process.cwd()}.`
    throw new Error(
      `Missing ${name}. ${where}\n` +
        `  Add it to .env.agent-secrets (or .env) or export it.\n` +
        `  See docs/google-ads-agent-access.md.`
    )
  }
  return value
}

/**
 * The Google Ads API is versioned in the URL path and Google sunsets versions
 * roughly every four months. Pin it in the env rather than in code so a bump
 * never needs a commit.
 */
export const API_VERSION = env('GOOGLE_ADS_API_VERSION') || 'v21'

/** Customer IDs travel as bare digits in the API, but humans copy them dashed. */
export const stripDashes = (id) => String(id ?? '').replace(/\D/g, '')

/** Exchange the long-lived refresh token for a short-lived access token. */
export async function getAccessToken() {
  const body = new URLSearchParams({
    client_id: env('GOOGLE_ADS_CLIENT_ID', { required: true }),
    client_secret: env('GOOGLE_ADS_CLIENT_SECRET', { required: true }),
    refresh_token: env('GOOGLE_ADS_REFRESH_TOKEN', { required: true }),
    grant_type: 'refresh_token',
  })

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })

  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    // invalid_grant is by far the most common failure and the message Google
    // returns for it is famously unhelpful, so name the real causes.
    const hint =
      json.error === 'invalid_grant'
        ? '\n  The refresh token is expired, revoked, or was minted by a different OAuth client.' +
          '\n  Re-run: npm run ads:auth'
        : ''
    throw new Error(
      `Token exchange failed (${res.status}): ${json.error ?? ''} ${json.error_description ?? ''}${hint}`
    )
  }
  return json.access_token
}

/** Headers every Google Ads REST call needs. */
export async function adsHeaders() {
  const headers = {
    Authorization: `Bearer ${await getAccessToken()}`,
    'developer-token': env('GOOGLE_ADS_DEVELOPER_TOKEN', { required: true }),
    'Content-Type': 'application/json',
  }
  // Only required when the calling user reaches the account through a manager.
  const loginCustomerId = stripDashes(env('GOOGLE_ADS_LOGIN_CUSTOMER_ID'))
  if (loginCustomerId) headers['login-customer-id'] = loginCustomerId
  return headers
}

/** Surface the API's structured error detail instead of a bare status code. */
export async function assertOk(res) {
  if (res.ok) return
  const text = await res.text()
  let detail = text
  try {
    const parsed = JSON.parse(text)
    detail = parsed?.error?.message ?? text
    const errors = parsed?.error?.details?.[0]?.errors
    if (Array.isArray(errors)) {
      detail += '\n' + errors.map((e) => `  - ${e.message}`).join('\n')
    }
  } catch {
    /* non-JSON body, keep the raw text */
  }
  throw new Error(`Google Ads API ${res.status}:\n${detail}`)
}
