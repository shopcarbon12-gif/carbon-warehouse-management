/**
 * Shared scope for the Defective EPCs KPI and its modal.
 *
 * ## What changed and why
 *
 * The original scope was every `tag_killed` row at the location, forever. It
 * only ever grew: a count that read 115 unmatched tags added 115 to the tile,
 * the next count added its own, and nothing ever came off unless somebody
 * dismissed rows by hand. By 2026-09-02 it stood at 718 with not one dismissal
 * ever recorded, which makes the number un-actionable — you cannot tell what
 * this count found from what has been silting up since May.
 *
 * The tile now answers "what does the LATEST count say, plus what have we
 * decided by hand", which is two genuinely different things deliberately kept
 * together:
 *
 *   1. **Whatever failed in the most recent committed cycle count.** Fresh
 *      every count. Tags that failed two counts ago and were not seen in the
 *      latest one drop off on their own — no dismissing required.
 *
 *   2. **Every tag a human marked as killed, at any time.** These are
 *      decisions, not observations, so they persist until a human reverses
 *      them. A count going by does not clear them.
 *
 * ## How manual and automatic kills are told apart
 *
 * By whether an audit row exists. Manual status changes write a
 * `inventory_audit_logs` STATUS_CHANGE row; `epc-ingress` — the path every
 * scan module converges on — writes none at all. So "has a STATUS_CHANGE row
 * naming tag_killed" is exactly "a human did this", and its absence is
 * exactly "a scan decided this". That asymmetry is load-bearing here: if
 * ingest ever starts writing audit rows, this predicate needs an explicit
 * source column instead.
 */

/**
 * SQL fragment; both call sites must use it so the tile and the modal can
 * never disagree about what "defective" means.
 *
 * Expects `$1` = tenant id, `$2` = location id, and the queried items table
 * aliased as `i`. Supply it as a CTE prefix plus a WHERE clause.
 */
export const DEFECTIVE_SCOPE_CTE = `
  latest_count AS (
    -- Committed only. A cancelled or still-running session must not reset the
    -- tile — a count is not authoritative until it is committed.
    SELECT scanned_epcs
      FROM cycle_count_sessions
     WHERE tenant_id = $1::uuid
       AND location_id = $2::uuid
       AND status = 'committed'
     ORDER BY completed_at DESC NULLS LAST, started_at DESC
     LIMIT 1
  ),
  latest_scanned AS (
    SELECT upper(e) AS epc
      FROM latest_count, jsonb_array_elements_text(scanned_epcs) AS e
  )`;

/**
 * The WHERE predicate. Assumes [DEFECTIVE_SCOPE_CTE] is in scope and the
 * items row is aliased `i`.
 */
export const DEFECTIVE_SCOPE_WHERE = `
    i.location_id = $2::uuid
    AND i.status = 'tag_killed'
    AND (
      -- A human's decision: persists across counts.
      EXISTS (
        SELECT 1 FROM inventory_audit_logs al
         WHERE al.entity_reference = i.epc
           AND al.log_type = 'STATUS_CHANGE'
           AND al.new_value = 'tag_killed'
      )
      -- Or this count's own failures.
      OR EXISTS (SELECT 1 FROM latest_scanned ls WHERE ls.epc = i.epc)
    )
    -- Dismissal still hides a row until it is seen again, unchanged.
    AND (i.defective_acknowledged_at IS NULL
         OR i.last_seen_at > i.defective_acknowledged_at)`;
