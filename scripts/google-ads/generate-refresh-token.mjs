/**
 * Mint a Google Ads refresh token on this machine.
 *
 * This is the step that actually grants an agent access to the ads account.
 * There is no "add Claude as a user" flow: Google Ads permissions attach to a
 * Google account, and an agent does not have one. Instead the owner consents
 * once in their own browser, and the resulting refresh token carries whatever
 * access that Google account already has. Grant less by signing in as a
 * read-only user; grant more by signing in as an admin.
 *
 * The token is written straight into .env.agent-secrets (gitignored) and never
 * printed: a printed token lands in terminal scrollback and chat transcripts,
 * which is how a client secret for this project leaked once already. Revoke
 * any time at myaccount.google.com/permissions.
 *
 * Usage:  npm run ads:auth
 */
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { env } from './lib.mjs'

/**
 * One consent covers every Google surface this repo automates. Requesting them
 * together avoids three separate browser round-trips and three refresh tokens
 * to keep in sync.
 *
 * Each scope needs its API enabled in the same Cloud project and listed on the
 * consent screen, or Google rejects the grant. If that happens, narrow the set
 * rather than abandoning the run:
 *
 *   GOOGLE_OAUTH_SCOPES='https://www.googleapis.com/auth/adwords' npm run ads:auth
 */
const DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/adwords', // Google Ads
  'https://www.googleapis.com/auth/tagmanager.edit.containers', // GTM: edit tags
  // GTM: turn a workspace into a version. Without it every edit is stranded in
  // the workspace, because publish only accepts a version.
  'https://www.googleapis.com/auth/tagmanager.edit.containerversions',
  'https://www.googleapis.com/auth/tagmanager.publish', // GTM: publish versions
  'https://www.googleapis.com/auth/content', // Merchant Center
]
const SCOPE = (process.env.GOOGLE_OAUTH_SCOPES || DEFAULT_SCOPES.join(' ')).trim()
const PORT = Number(process.env.OAUTH_PORT || 8787)
// Desktop-app OAuth clients accept any loopback port, so no console config
// change is needed if this port is already taken.
const REDIRECT_URI = `http://localhost:${PORT}`

const clientId = env('GOOGLE_ADS_CLIENT_ID', { required: true })
const clientSecret = env('GOOGLE_ADS_CLIENT_SECRET', { required: true })

// CSRF guard: Google echoes this back and we refuse anything that does not match.
const state = randomBytes(16).toString('hex')

const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPE,
    // offline + consent together are what force Google to return a refresh
    // token. Without prompt=consent a second run returns only an access token.
    access_type: 'offline',
    prompt: 'consent',
    state,
  })

async function exchange(code) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(
      `Code exchange failed (${res.status}): ${json.error ?? ''} ${json.error_description ?? ''}`
    )
  }
  return json
}

const SECRETS_FILE = resolve(process.cwd(), '.env.agent-secrets')

/**
 * Replace rather than append. The loader takes the last occurrence within a
 * file, so a stale token left above a new one is harmless today, but an edit
 * that reorders the file would silently resurrect it.
 */
function storeRefreshToken(token) {
  const text = existsSync(SECRETS_FILE) ? readFileSync(SECRETS_FILE, 'utf8') : ''
  const kept = text.replace(/^GOOGLE_ADS_REFRESH_TOKEN=.*(\n|$)/gm, '')
  const sep = kept && !kept.endsWith('\n') ? '\n' : ''
  writeFileSync(SECRETS_FILE, `${kept}${sep}GOOGLE_ADS_REFRESH_TOKEN=${token}\n`, { mode: 0o600 })
}

const page = (title, body) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:16px system-ui;padding:3rem;max-width:34rem">` +
  `<h2>${title}</h2><p>${body}</p></body>`

const server = createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI)
  if (url.pathname !== '/') {
    res.writeHead(404).end()
    return
  }

  const send = (code, html) => {
    res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' }).end(html)
  }

  const error = url.searchParams.get('error')
  if (error) {
    send(400, page('Authorization declined', `Google returned: ${error}`))
    console.error(`\nAuthorization declined: ${error}`)
    server.close()
    process.exitCode = 1
    return
  }

  const code = url.searchParams.get('code')
  if (!code) return send(400, page('Missing code', 'No authorization code in the callback.'))

  if (url.searchParams.get('state') !== state) {
    send(400, page('State mismatch', 'Ignoring this callback.'))
    console.error('\nState mismatch — refusing the callback. Re-run the script.')
    server.close()
    process.exitCode = 1
    return
  }

  try {
    const token = await exchange(code)
    // prompt=consent should guarantee one; if Google withholds it anyway, an
    // access token alone is useless an hour from now, so fail loudly.
    if (!token.refresh_token) throw new Error('Google returned no refresh token. Re-run npm run ads:auth.')
    storeRefreshToken(token.refresh_token)
    send(200, page('Done', 'Refresh token issued. Return to your terminal.'))
    console.log(`\nRefresh token written to ${SECRETS_FILE} (not printed).`)
    // Google grants only what the user actually approved, which can be less
    // than we asked for. Print it so a partial grant is obvious now rather
    // than as a 403 from one API later.
    const granted = (token.scope ?? '').split(' ').filter(Boolean)
    console.log(`\nScopes granted (${granted.length}):`)
    for (const s of granted) console.log(`  ${s.replace('https://www.googleapis.com/auth/', '')}`)
    const missing = SCOPE.split(' ').filter((s) => !granted.includes(s))
    if (missing.length) {
      console.log('\nNot granted:')
      for (const s of missing) console.log(`  ${s.replace('https://www.googleapis.com/auth/', '')}`)
    }
    console.log('\nThen confirm it works:  npm run ads:verify')
    console.log('Revoke any time at:     https://myaccount.google.com/permissions')
  } catch (err) {
    send(500, page('Exchange failed', 'See your terminal for details.'))
    console.error('\n' + err.message)
    process.exitCode = 1
  } finally {
    server.close()
  }
})

server.listen(PORT, () => {
  console.log('\nSign in as the Google account whose access you want to grant.')
  console.log('Open this URL:\n')
  console.log(authUrl + '\n')
  console.log(`Waiting for the callback on ${REDIRECT_URI} ...`)
})
