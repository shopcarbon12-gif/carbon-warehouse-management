/**
 * Why is nothing serving?
 *
 * The Ads UI banner "None of your ads are running" does not say whether a human
 * paused the campaigns, the budget is gone, or the account is suspended. Those
 * have completely different fixes, so this pulls the raw state:
 *
 *   - every campaign with its status and budget, including REMOVED
 *   - 30-day spend and conversions, to show what actually ran
 *
 * Read only. It never mutates the account.
 *
 * Usage:  npm run ads:status
 */
import { adsHeaders, assertOk, env, stripDashes, API_VERSION } from './lib.mjs'

/** Run one GAQL query, following pagination. */
async function query(customerId, gaql) {
  const base = `https://googleads.googleapis.com/${API_VERSION}/customers/${customerId}`
  const headers = await adsHeaders()
  const rows = []
  let pageToken
  do {
    const res = await fetch(`${base}/googleAds:search`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query: gaql, pageSize: 1000, pageToken }),
    })
    await assertOk(res)
    const json = await res.json()
    rows.push(...(json.results ?? []))
    pageToken = json.nextPageToken
  } while (pageToken)
  return rows
}

const micros = (v) => (Number(v ?? 0) / 1e6).toFixed(2)

async function main() {
  // Read config inside main so a missing value surfaces as one clean line
  // through the catch below, not a module-load stack trace.
  const customerId = stripDashes(env('GOOGLE_ADS_CUSTOMER_ID', { required: true }))

  // No date segment here on purpose: adding one drops campaigns that have never
  // served, which are exactly the ones being investigated.
  const campaigns = await query(customerId, `
    SELECT campaign.id, campaign.name, campaign.status,
           campaign.advertising_channel_type, campaign.serving_status,
           campaign_budget.amount_micros
    FROM campaign
    ORDER BY campaign.status, campaign.name
  `)

  console.log(`\nCampaigns in ${customerId} (${campaigns.length})\n`)
  const byStatus = {}
  for (const row of campaigns) {
    const status = row.campaign.status
    ;(byStatus[status] ??= []).push(row)
  }
  for (const [status, rows] of Object.entries(byStatus)) {
    console.log(`${status} (${rows.length})`)
    for (const r of rows) {
      const budget = r.campaignBudget?.amountMicros
      console.log(
        `  ${r.campaign.name}` +
          `\n      channel ${r.campaign.advertisingChannelType}` +
          `  serving ${r.campaign.servingStatus ?? 'n/a'}` +
          (budget ? `  budget $${micros(budget)}/day` : '')
      )
    }
    console.log('')
  }

  const perf = await query(customerId, `
    SELECT campaign.name, metrics.impressions, metrics.clicks,
           metrics.cost_micros, metrics.conversions
    FROM campaign
    WHERE segments.date DURING LAST_30_DAYS
  `)

  const totals = perf.reduce(
    (acc, r) => ({
      impressions: acc.impressions + Number(r.metrics?.impressions ?? 0),
      clicks: acc.clicks + Number(r.metrics?.clicks ?? 0),
      cost: acc.cost + Number(r.metrics?.costMicros ?? 0),
      conversions: acc.conversions + Number(r.metrics?.conversions ?? 0),
    }),
    { impressions: 0, clicks: 0, cost: 0, conversions: 0 }
  )

  console.log('Last 30 days')
  console.log(`  impressions  ${totals.impressions}`)
  console.log(`  clicks       ${totals.clicks}`)
  console.log(`  cost         $${micros(totals.cost)}`)
  console.log(`  conversions  ${totals.conversions}`)
  if (totals.impressions === 0) {
    console.log('\n  Zero impressions. Nothing served in 30 days.')
    console.log('  If every campaign above is PAUSED, this is a switch, not a penalty.')
    console.log('  If any campaign is ENABLED but not serving, read its serving status.\n')
  } else {
    console.log('')
  }
}

main().catch((err) => {
  console.error(`\n${err.message}\n`)
  process.exitCode = 1
})
