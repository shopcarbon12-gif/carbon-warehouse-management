-- CarbonWMS Creative — the owner's Sydney Dress UGC redone under the new UGC rules (2026-11-15: the first
-- one came out as a cinematic stairwell shoot). A new UGC project, same dress and model (Elena), queued
-- for 3 concepts (cheap: text + low-quality thumbnails); the owner picks one. Runs on every deploy: only
-- once (guarded by the title), and only where the original project exists.
WITH src AS (
  SELECT tenant_id, products, cast_ids, preset, created_by
    FROM public.creative_projects
   WHERE id = 'b8d804f9-c9de-4fb4-afaf-4215b3cc799d'
     AND NOT EXISTS (SELECT 1 FROM public.creative_projects x WHERE x.title = 'Sydney Dress — real UGC')
), p AS (
  INSERT INTO public.creative_projects (tenant_id, title, kind, products, cast_ids, preset, sizes, created_by, status, brief)
  SELECT tenant_id, 'Sydney Dress — real UGC', 'ugc', products, cast_ids, preset, ARRAY['9:16'], created_by, 'brief', '{"recipe":null,"template":null}'::jsonb FROM src
  RETURNING id, tenant_id
)
INSERT INTO public.creative_jobs (tenant_id, project_id, kind, payload, requested_by, run_after, progress)
SELECT tenant_id, id, 'project_concepts', '{}'::jsonb, 'owner (2026-11-15 chat)', now() + interval '5 minutes', 'Reading the products' FROM p;
