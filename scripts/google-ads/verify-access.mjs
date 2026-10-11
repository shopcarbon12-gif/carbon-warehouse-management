/**
 * Confirm the credentials work, before trusting them with anything.
 *
 * Checks in order, because each failure has a different fix:
 *   1. refresh token   -> can we mint an access token at all
 *   2. developer token -> is it approved, and for which access level
 *   3. account reach   -> which customer IDs does this login actually see
 *
 * Usage:  npm run ads:verify
 */
import { adsHeaders, assertOk, env, stripDashes, API_VERSION } from './lib.mjs'

const BASE = `https://googleads.googleapis.com/${API_VERSION}`

const ok = (msg) => console.log(`  ok    ${msg}`)
const fail = (msg) => console.log(`  FAIL  ${msg}`)

async function main() {
  console.log(`\nGoogle Ads access check (API ${API_VERSION})\n`)

  const headers = await adsHeaders()
  ok('refresh token exchanged for an access token')
  ok(`developer token loaded (${env('GOOGLE_ADS_DEVELOPER_TOKEN').slice(0, 4)}...)`)
  if (headers['login-customer-id']) ok(`login-customer-id ${headers['login-customer-id']}`)

  const res = await fetch(`${BASE}/customers:listAccessibleCustomers`, { headers })
  await assertOk(res)
  const { resourceNames = [] } = await res.json()

  if (resourceNames.length === 0) {
    fail('the token authenticated but reaches zero accounts')
    console.log('\n  You signed in as a Google account with no Google Ads access.')
    console.log('  Re-run npm run ads:auth and sign in as an admin of the account.\n')
    process.exitCode = 1
    return
  }

  console.log(`\nAccounts reachable with these credentials (${resourceNames.length}):`)
  for (const name of resourceNames) {
    const id = name.split('/').pop()
    console.log(`  ${id.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3')}`)
  }

  const target = stripDashes(env('GOOGLE_ADS_CUSTOMER_ID'))
  if (!target) {
    console.log('\nSet GOOGLE_ADS_CUSTOMER_ID to one of the above to enable the reports.\n')
    return
  }
  if (!resourceNames.some((n) => n.endsWith(`/${target}`))) {
    // Not fatal: manager accounts reach child accounts that never appear in
    // listAccessibleCustomers. But it is the usual cause of a later 403.
    console.log(
      `\nNote: GOOGLE_ADS_CUSTOMER_ID ${target} is not in the list above.` +
        `\n  That is expected if it sits under a manager, so long as` +
        `\n  GOOGLE_ADS_LOGIN_CUSTOMER_ID names that manager.\n`
    )
  } else {
    console.log(`\nTarget account ${target} is directly accessible.\n`)
  }
}

main().catch((err) => {
  console.error(`\n${err.message}\n`)
  process.exitCode = 1
})
