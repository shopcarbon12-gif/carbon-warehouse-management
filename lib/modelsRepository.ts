/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import { Pool } from "pg";

export type ModelRecord = {
  model_id: string;
  user_id: string;
  name: string;
  gender: string;
  ref_image_urls: string[];
  created_at: string | null;
};

type DbMode = "postgres";

let cachedMode: DbMode | null = null;
let pgPool: Pool | null = null;
let pgReady = false;
let fileConnectionChecked = false;
let fileConnectionString = "";

function resolvePgConnectionFromFile() {
  if (fileConnectionChecked) return fileConnectionString;
  fileConnectionChecked = true;

  const candidates = [
    (process.env.COOLIFY_DATABASE_URL_FILE || "").trim(),
    "/app/.coolify-database-url",
  ].filter(Boolean);

  for (const path of candidates) {
    try {
      const value = readFileSync(path, "utf8").trim();
      if (value) {
        fileConnectionString = value;
        return fileConnectionString;
      }
    } catch {
      // Ignore missing/unreadable file and continue fallback chain.
    }
  }
  return "";
}

function normalizeMode(value: unknown) {
  const v = String(value || "").trim().toLowerCase();
  if (v === "postgres") return "postgres";
  return "postgres";
}

function hasCoolifySqlHint() {
  return Boolean(
    (process.env.COOLIFY_DATABASE_URL || "").trim() ||
      (process.env.COOLIFY_DATABASE_URL_FILE || "").trim() ||
      (process.env.DATABASE_URL_FILE || "").trim() ||
      process.env.COOLIFY_FQDN
  );
}

function resolveMode(): DbMode {
  if (cachedMode) return cachedMode;
  const explicit = normalizeMode(process.env.RUNTIME_DB_PROVIDER);
  cachedMode = explicit === "postgres" || hasCoolifySqlHint() ? "postgres" : "postgres";
  return cachedMode;
}

function getPgPool() {
  if (pgPool) return pgPool;
  const url =
    resolvePgConnectionFromFile() ||
    (process.env.COOLIFY_DATABASE_URL || "").trim() ||
    (process.env.POSTGRES_URL || "").trim() ||
    (process.env.DATABASE_URL || "").trim();
  if (!url) {
    throw new Error("Postgres mode enabled but COOLIFY_DATABASE_URL/POSTGRES_URL/DATABASE_URL is missing.");
  }
  pgPool = new Pool({ connectionString: url });
  return pgPool;
}

async function ensurePgReady() {
  if (pgReady) return;
  const pool = getPgPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS models (
      model_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      gender TEXT NOT NULL,
      ref_image_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_models_user_created ON models(user_id, created_at DESC)`);
  pgReady = true;
}

function toModelRecord(row: any): ModelRecord {
  return {
    model_id: String(row?.model_id || ""),
    user_id: String(row?.user_id || ""),
    name: String(row?.name || ""),
    gender: String(row?.gender || ""),
    ref_image_urls: Array.isArray(row?.ref_image_urls) ? row.ref_image_urls.map((v: unknown) => String(v || "")) : [],
    created_at: row?.created_at ? String(row.created_at) : null,
  };
}

export function getModelsDbMode(): DbMode {
  return resolveMode();
}

export async function listModelsForUser(userId: string) {
  resolveMode();
  await ensurePgReady();
  const pool = getPgPool();
  const { rows } = await pool.query(
    `SELECT model_id, user_id, name, gender, ref_image_urls, created_at
     FROM models
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );
  return rows.map(toModelRecord);
}

export async function modelNameExistsForUser(userId: string, candidateName: string) {
  const normalizedCandidate = String(candidateName || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
  if (!userId || !normalizedCandidate) return false;

  resolveMode();
  await ensurePgReady();
  const pool = getPgPool();
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM models
       WHERE user_id = $1
         AND lower(regexp_replace(trim(name), '\s+', ' ', 'g')) = $2
     ) AS exists`,
    [userId, normalizedCandidate]
  );
  return Boolean(rows[0]?.exists);
}

export async function listAllModelsAsc() {
  resolveMode();
  await ensurePgReady();
  const pool = getPgPool();
  const { rows } = await pool.query(
    `SELECT model_id, user_id, name, gender, ref_image_urls, created_at
     FROM models
     ORDER BY created_at ASC`
  );
  return rows.map(toModelRecord);
}

export async function insertModelRow(params: {
  model_id: string;
  user_id: string;
  name: string;
  gender: string;
  ref_image_urls: string[];
}) {
  resolveMode();
  await ensurePgReady();
  const pool = getPgPool();
  const { rows } = await pool.query(
    `INSERT INTO models (model_id, user_id, name, gender, ref_image_urls)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING model_id, user_id, name, gender, ref_image_urls, created_at`,
    [params.model_id, params.user_id, params.name, params.gender, JSON.stringify(params.ref_image_urls)]
  );
  return rows[0] ? toModelRecord(rows[0]) : null;
}

export async function deleteModelByIdForUser(modelId: string, userId: string) {
  resolveMode();
  await ensurePgReady();
  const pool = getPgPool();
  await pool.query(`DELETE FROM models WHERE model_id = $1 AND user_id = $2`, [modelId, userId]);
}

export async function deleteAllModelsForUser(userId: string) {
  resolveMode();
  await ensurePgReady();
  const pool = getPgPool();
  await pool.query(`DELETE FROM models WHERE user_id = $1`, [userId]);
}

export async function deleteModelsByIds(ids: string[], userId?: string | null) {
  const deduped = Array.from(new Set(ids.map((v) => String(v || "").trim()).filter(Boolean)));
  if (!deduped.length) return;

  resolveMode();
  await ensurePgReady();
  const pool = getPgPool();
  if (userId) {
    await pool.query(`DELETE FROM models WHERE model_id = ANY($1::text[]) AND user_id = $2`, [deduped, userId]);
    return;
  }
  await pool.query(`DELETE FROM models WHERE model_id = ANY($1::text[])`, [deduped]);
}

export async function updateModelRefImageUrls(params: {
  modelId: string;
  userId?: string | null;
  refImageUrls: string[];
}) {
  const modelId = String(params.modelId || "").trim();
  const refImageUrls = Array.isArray(params.refImageUrls)
    ? params.refImageUrls.map((v) => String(v || "").trim()).filter(Boolean)
    : [];
  if (!modelId) return;

  resolveMode();
  await ensurePgReady();
  const pool = getPgPool();
  if (params.userId) {
    await pool.query(
      `UPDATE models SET ref_image_urls = $1::jsonb WHERE model_id = $2 AND user_id = $3`,
      [JSON.stringify(refImageUrls), modelId, String(params.userId)]
    );
    return;
  }
  await pool.query(`UPDATE models SET ref_image_urls = $1::jsonb WHERE model_id = $2`, [
    JSON.stringify(refImageUrls),
    modelId,
  ]);
}
