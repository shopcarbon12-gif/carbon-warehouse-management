# CARBON SEO revision 3 — review and implementation priorities

Reviewed October 11, 2026. Source: `D:/Downloads/SEO-EN11GINE-V2-SPEC.md`. Part D and the later D11 addendum were treated as the current design where they override earlier sections.

## Verdict

The strategic direction is now strong enough to start a narrowly scoped implementation. The changes to collections, search research, original-photo evidence, separate Shopping artifacts, image provenance, and reversible publication address the main earlier concerns.

The biggest improvement is the decision to use actual search data to prioritize work rather than assume rewriting every product will produce meaningful organic sales. However, the attached figures need reconciliation, the Merchant Center proof still has an inadequate success condition, and several implementation contracts remain incomplete. Fix these specific issues and validate a small implementation; another large expansion of the specification is unnecessary.

This is a review of the supplied document, current Google documentation, and small reproductions of its proposed validation logic. I did not inspect the referenced repository evidence files or private accounts. The document's owner-answer and approval notes are reported context, not independently verified approvals or instructions to execute changes in this chat.

## What is materially improved

| Area | Assessment |
|---|---|
| Separate organic and Shopping text | Addressed in D2; actual feed effectiveness still depends on D1 |
| Original evidence versus gallery images | Addressed in D5 with separate IDs and provenance |
| Unsupported nonvisual facts | Much stronger policy; token-level enforcement still has a semantic gap |
| Resume after partial writes | Correct architectural direction in D4; state and operation identity need correction |
| Restoring previous feed/metafield values | Addressed in principle; requires end-to-end tests |
| Keyword Planner versus organic competition | Addressed |
| Thin organic product traffic | Sensible acknowledgement in D11; impressions can measure visibility, not commercial success |
| Collections and local work earlier | Appropriate prioritization, subject to validated opportunity |

## 1. Reconcile Search Console figures before using them to allocate work

**D11 G1–G6. Important before interpreting the business opportunity.**

G1 reports 1,221 clicks in 90 days. G3 reports 1,230 homepage clicks alone, and the listed page buckets sum to 2,097 clicks. These are not a consistent, self-explanatory set of totals.

This need not mean the export is wrong. Google documents that property-versus-page aggregation, query filtering, anonymized queries, and truncation can produce different totals. But the report must label those differences instead of treating the numbers as interchangeable.

Request a compact evidence summary containing the exact property, date range, search type, filters, aggregation, row limits/pagination, and whether a number comes from unfiltered totals or returned query rows. Label any 95% branded share as the share of the relevant observable query set unless the denominator supports a whole-site claim. Keep unknown/anonymized traffic explicit.

Similarly, “130 nonbranded product clicks over 16 months” should be labeled as observed query-by-page rows if that is how it was calculated, rather than asserted as an exhaustive total. Common-name queries should remain ambiguous unless search intent is actually established; the names Alex, Andy, or Bradley alone do not prove another brand's intent.

Source: [Search Console data discrepancies](https://support.google.com/webmasters/answer/17010575?hl=en).

The direction of D11—investigate collections first for organic discovery—is plausible. Confirm it against comparable query/page data and sales potential. Feed coverage across thousands of listings likewise does not establish that Shopping is the largest revenue opportunity; include actual impressions, clicks, costs, purchases, and feed issues for paid and free listings where available.

## 2. Correct the Merchant Center proof's pass condition

**D1.2. Required before feed-text production writes.**

Step 2 sends ordinary and structured fields containing identical text and considers the configuration successful if the text is effective and structured fields remain present without a new issue.

That does not establish the intended behavior. Google explicitly says the ordinary field is used when both ordinary and structured title/description fields are supplied. Identical text makes it impossible to infer which representation produced the effective result, and the absence of a diagnostic does not prove the selected AI-content representation is compliant.

Do not accept “ordinary override plus structured fields retained” as sufficient proof. Demonstrate the supported effective structured-field configuration, including the primary-source rules needed to prevent ordinary-field precedence, or obtain explicit authoritative confirmation for the alternative configuration. Then test English, Spanish, labels, a normal Shopify refresh, and rollback.

Sources: [title and structured title](https://support.google.com/merchants/answer/6324415?hl=en), [description and structured description](https://support.google.com/merchants/answer/6324468?hl=en-GB).

The corrected API enum and single-writer approach are improvements. Make the causal source-mapping test reversible and use legitimate distinguishable product wording where feasible instead of exposing `ZZTEST` to shoppers. Avoid changing a customer-facing price merely to trigger synchronization when a suitable alternative is available.

## 3. Change the archived-product redirect policy

**D7 T2 and the D11 approval summary. Substantive SEO correction.**

An archived product returning 404 is not automatically a defect. A blanket redirect to its collection is not the right default.

- If the old page has a genuinely relevant replacement, use an appropriate permanent redirect.
- If it is permanently removed with no similar replacement, a 404 or 410 is appropriate.
- If the item is temporarily unavailable or the page still has useful product information, evaluate retaining the page with accurate availability.

Select the policy by product and user intent. Do not redirect every discontinued item merely to eliminate 404s.

Source: [Google's guidance for removed content and replacement pages](https://developers.google.com/search/docs/crawling-indexing/troubleshoot-crawling-errors).

## 4. Impressions are a useful indicator, but do not establish ROI or statistical power

**D6.2 and D11. Refine before starting the experiment.**

The revision correctly says an impression gain means visibility, not sales. Keep that distinction. More impressions for irrelevant or very low-position queries may have little commercial value.

Changing the primary outcome from clicks to impressions requires rerunning the eligibility and power analysis using the actual recent impression distribution. Counts accumulated over 16 months do not establish eligibility or power for a 56-day baseline. If the experiment remains too weak, use a clearly labeled directional evaluation rather than implying a precise test can settle the commercial question.

Use equal-duration comparison windows or explicitly model daily exposure: the written baseline is 56 days, while days +28 through +56 are 29 days inclusive. With sparse counts and `log(1+x)`, the exposure difference affects interpretation and cannot be ignored merely because the analysis is called difference-in-differences.

Do not automatically drop pairs that sell out after treatment. Improved conversion could itself cause a stock-out, so removing those products can remove successful treatment outcomes. Retain the original assigned cohort in the main report, and add availability-adjusted sensitivity analysis. Also specify how the optional extra four weeks affects uncertainty rather than repeatedly applying the same success threshold until it passes.

Freeze the branded/ambiguous query classification using baseline evidence for the primary analysis. Reclassifying a query because treatment improves its rank or CTR can move the outcome between categories during the experiment.

Keep clicks, relevant query coverage, add-to-cart behavior, purchases, and revenue as accompanying business indicators. Do not hold simple, clearly justified title or store-page corrections hostage to a potentially underpowered eight-week product-copy experiment.

## 5. Token coverage still does not prove correct factual wording

**D3.2. Required before treating the automated gate as a factual authority.**

The exact source-value check is useful, but the sentence validator then checks individual assertion terms against a cited claim. This can lose the relationship between numbers and materials.

Example:

- Verified fact: `98% cotton, 2% elastane`.
- Incorrect sentence: `2% cotton, 98% elastane`.

Every extracted token—`2%`, `cotton`, `98%`, `elastane`—occurs in the verified value. I reproduced that the stated token-coverage rule accepts all of them. The composition is still reversed.

Render composition, care, origin, and measurements directly from their structured fact values, or validate the complete field-value relationship. Do not permit free paraphrasing to defeat those bindings. Negation, fit guarantees, and included-versus-separately-sold pieces also need semantic checks. The secondary model and human review are useful safeguards, but the deterministic lexicon should be described as a screening tool rather than a complete truth validator.

D11's set behavior also needs customer-flow verification. It says each page buys only that piece while the cart guard adds/removes pieces in lockstep. Test normal add-to-cart, the solo override, cart price, and checkout before asserting purchase contents. WMS linkage by itself does not resolve the distinction between one product's price and the actual items automatically placed in the cart.

## 6. Close the remaining implementation contracts during the small build

These concern the written snippets, not tested production code:

1. **Operation identity:** the example key is `itemId:target:revisionHash`, but revert uses the same item, target, and revision. Include direction and a unique plan/version ID so revert and re-plans cannot collide with an existing primary key.
2. **State transitions:** D4 uses `reverting` and `partial_revert`, but the inherited item-status constraint does not include them. The executor also returns `partial` for failed revert, while its revert-entry condition accepts `partial_revert`. Specify and test one consistent state machine.
3. **Dependencies and completion:** topological ordering alone does not stop dependent writes after a prerequisite conflicts or fails. Define which operations can proceed independently, and verify the final expected state before reporting full publication.
4. **Facts migration:** D3 adds `performance` and checks `variant_scope`; the inherited `product_facts` table lacks that class and column. Add the actual schema changes and tests.
5. **Supplemental ownership:** the illustrated writer rejects a change from owner `backfill` to writer `seo`, while the text promises an explicit takeover. Implement and test that transition. Journal intended remote writes durably so an API success followed by a DB failure cannot be silently erased by the next unrelated label update.
6. **Revert and background sync:** D2 rebuilds dirty artifacts from the approved revision. After revert, define which revision becomes current; otherwise nightly sync could reapply the revision that was just reverted. Old Spanish overrides also need an explicit stale-content policy while replacement translations are pending.

These are bounded implementation tasks. Validate them with failure and recovery tests rather than expanding the document into another large architecture revision.

## 7. Revisit product identifier assumptions

**D0 E6–E7 and D7 T4. Feed correctness check.**

The seven-digit internal codes should not be submitted as GTINs. However, finding no valid GTIN in Shopify does not establish that no identifier has been assigned, or that `identifierExists=false` is correct for every product.

Confirm manufacturer/private-label status and supplier identifiers. For CARBON's own private-label products without GTINs, Google's guidance supports the brand plus an appropriate manufacturer part number, potentially a product SKU where CARBON is entitled to assign it. For third-party products, do not invent manufacturer identifiers. Reconcile `identifierExists` with the actual identifier situation rather than treating MPN as automatically low value.

Sources: [unique product identifiers and private-label products](https://support.google.com/merchants/answer/160161?hl=en), [identifier exists](https://support.google.com/merchants/answer/6324478?hl=en).

## Recommended execution order

1. Reconcile the search evidence and publish one current priority list.
2. Correct genuinely wrong/repeated titles and the showroom information after checking current live values; apply a product-specific retirement policy.
3. Improve a few high-opportunity collections using real query intent, stock depth, crawlable links, and useful buying guidance.
4. Run the corrected one-product feed proof and a minimal publishing/revert implementation.
5. Review 12 generated product samples, then expand selectively according to data and operational correctness.

Do not let the full engine delay those smaller improvements. The engine is an ongoing capability; the strategy should keep prioritizing useful, commercially relevant pages.

## Message to give Claude

> Revision 3 is a strong strategic improvement. Proceed with a small implementation after reconciling the GSC totals and correcting D1's acceptance criterion: ordinary-plus-structured fields with identical text do not prove the structured representation is used. Replace blanket archived-product redirects with a replacement-specific policy. Recalculate the impressions pilot using recent data and appropriate exposure, keep treatment-induced stock-outs visible, and freeze query classification. Render verified fact relationships exactly; token matching currently permits reversed composition percentages. Fix operation IDs, revert states, facts migrations, ownership takeover, and the active revision after rollback. Validate product identifiers. Consolidate the current decisions into one short execution plan rather than adding another large revision.
