import { withActivity } from "@/lib/server/activity-log";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { backfillMember, cutGroupDetail, UUID_RE } from "@/lib/server/grading-app";
import { PROFILE_BY_ID } from "@/lib/size-grading/grading-app-profiles";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET    → the group, its products, sizes and its size chart (latest reading per size)
 * PATCH  {name?, profile?, note?}
 * POST   {add?: matrixId[], remove?: matrixId[]} — a product added here leaves any
 *        other group it was in, and gets the readings already taken for its sizes
 * DELETE → the group goes; its products and readings stay
 */
export async function GET(req: Request, { params }: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Bad id" }, { status: 400 });
  const g = await cutGroupDetail(pool, id);
  if (!g) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ group: g });
}

const Patch = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  profile: z.string().refine((p) => p in PROFILE_BY_ID, "Unknown garment type").nullable().optional(),
  note: z.string().max(500).nullable().optional(),
});

async function PATCH_handler(req: Request, { params }: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Bad id" }, { status: 400 });
  const parsed = Patch.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid" }, { status: 400 });
  const b = parsed.data;
  const r = await pool.query(
    `UPDATE size_grading_cut_groups
        SET name = COALESCE($2, name),
            profile = CASE WHEN $3::boolean THEN $4 ELSE profile END,
            note = CASE WHEN $5::boolean THEN $6 ELSE note END,
            updated_at = now()
      WHERE id = $1::uuid`,
    [id, b.name ?? null, b.profile !== undefined, b.profile ?? null, b.note !== undefined, b.note ?? null],
  );
  if (!r.rowCount) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

const Members = z.object({
  add: z.array(z.string().regex(UUID_RE)).max(200).optional(),
  remove: z.array(z.string().regex(UUID_RE)).max(200).optional(),
});

async function POST_handler(req: Request, { params }: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Bad id" }, { status: 400 });
  const parsed = Members.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "add / remove must be product ids" }, { status: 400 });
  const exists = await pool.query(`SELECT 1 FROM size_grading_cut_groups WHERE id = $1::uuid`, [id]);
  if (!exists.rowCount) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const moved: { matrixId: string; from: string }[] = [];
  let copied = 0;
  /* One transaction: a product moving between cuts must never end up in neither. */
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const m of parsed.data.add ?? []) {
      const prev = await client.query<{ name: string; cut_group_id: string }>(
        `SELECT g.name, mm.cut_group_id FROM size_grading_cut_group_members mm JOIN size_grading_cut_groups g ON g.id = mm.cut_group_id
          WHERE mm.matrix_id = $1::uuid`,
        [m],
      );
      if (prev.rows[0]?.cut_group_id === id) continue;
      if (prev.rows[0]) moved.push({ matrixId: m, from: prev.rows[0].name });
      await client.query(`DELETE FROM size_grading_cut_group_members WHERE matrix_id = $1::uuid`, [m]);
      await client.query(
        `INSERT INTO size_grading_cut_group_members (cut_group_id, matrix_id, added_by) VALUES ($1::uuid, $2::uuid, $3)`,
        [id, m, session.sub ?? null],
      );
    }
    if (parsed.data.remove?.length) {
      await client.query(
        `DELETE FROM size_grading_cut_group_members WHERE cut_group_id = $1::uuid AND matrix_id = ANY($2::uuid[])`,
        [id, parsed.data.remove],
      );
    }
    await client.query(`UPDATE size_grading_cut_groups SET updated_at = now() WHERE id = $1::uuid`, [id]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  /* The cut's existing readings follow a product in, once it is safely a member. */
  for (const m of parsed.data.add ?? []) copied += await backfillMember(pool, id, m, session.sub ?? null);
  return NextResponse.json({ ok: true, moved, copiedReadings: copied });
}

async function DELETE_handler(req: Request, { params }: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Bad id" }, { status: 400 });
  const r = await pool.query(`DELETE FROM size_grading_cut_groups WHERE id = $1::uuid`, [id]);
  if (!r.rowCount) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export const PATCH = withActivity("grading-app/cut-groups/[id]", PATCH_handler);
export const POST = withActivity("grading-app/cut-groups/[id]", POST_handler);
export const DELETE = withActivity("grading-app/cut-groups/[id]", DELETE_handler);
