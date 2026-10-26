/**
 * The owner's official campaign identity, from the campaign prompt packs
 * ("OFFICIAL CAMPAIGN IDENTITY (MANDATORY FOR ALL FUTURE AGENTS)", AW2026
 * Complete Agent Prompt Packs, 2026-10-24 21:09 — the latest). Every AI that
 * writes or checks a caption for a post of that campaign gets it, and these
 * lines and hashtags are never treated as faults.
 */
const AW2026 = {
  match: /AW2026|Art of Arriving/i,
  storyLine: "CARBON · THE ART OF ARRIVING",
  text: `OFFICIAL CAMPAIGN IDENTITY (the owner's, mandatory — use it exactly, never treat it as a fault):
- Campaign: CARBON PRESENTS: THE ART OF ARRIVING. Collection: CARBON Autumn / Winter 2026 (AW2026). Never rename the campaign.
- Main tagline: "Every Entrance Makes a Statement." Short social line: "Arrive Different." Brand tagline: "Built Different. Made For Everyone." These are the brand's own lines: keep them word for word wherever they appear (they are not stock phrases, tidy closers or wisdom-shaped lines).
- Hashtags: #TheArtOfArriving and #CARBONAW26 are required on every post of the campaign; they count toward Instagram's 5, so add at most 3 others that shoppers search.
- Call to action: "Shop the Winter Collection". Website: shopcarbon.com.`,
};

export function campaignIdentity(campaign: string | null | undefined): string | null {
  return campaign && AW2026.match.test(campaign) ? AW2026.text : null;
}

/** The small line at the top of a campaign Story ("CARBON · THE ART OF ARRIVING"), or null. */
export function campaignStoryLine(campaign: string | null | undefined): string | null {
  return campaign && AW2026.match.test(campaign) ? AW2026.storyLine : null;
}
