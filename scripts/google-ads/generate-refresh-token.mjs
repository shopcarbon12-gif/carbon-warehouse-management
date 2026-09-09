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
 * The token is printed here and never leaves the machine. Paste it into
 * .env.agent-secrets (gitignored). Revoke any time at
 * myaccount.google.com/permissions.
 *
 * Usage:  npm run ads:auth
 */
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { env } from './lib.mjs'

const SCOPE = 'https://www.googleapis.com/auth/adwords'
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
    send(200, page('Done', 'Refresh token issued. Return to your terminal.'))
    console.log('\n' + '='.repeat(64))
    console.log('Add this line to .env.agent-secrets (gitignored):\n')
    console.log(`GOOGLE_ADS_REFRESH_TOKEN=${token.refresh_token}`)
    console.log('\n' + '='.repeat(64))
    console.log('Then confirm it works:  npm run ads:verify')
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
