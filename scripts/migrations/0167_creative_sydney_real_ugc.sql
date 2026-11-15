-- CarbonWMS Creative — the owner's Sydney Dress UGC redone under the new UGC rules (2026-11-15). Runs ONCE: the
-- marker (creative_markers) means deleting or renaming that project never brings it back (review 2026-11-15).
CREATE TABLE IF NOT EXISTS public.creative_markers (key text PRIMARY KEY, at timestamptz NOT NULL DEFAULT now());
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.creative_markers WHERE key = '0167_sydney_real_ugc') THEN
    IF NOT EXISTS (SELECT 1 FROM public.creative_projects WHERE title = 'Sydney Dress — real UGC') THEN
      WITH src AS (
        SELECT tenant_id, products, cast_ids, preset, created_by FROM public.creative_projects WHERE id = 'b8d804f9-c9de-4fb4-afaf-4215b3cc799d'
      ), p AS (
        INSERT INTO public.creative_projects (tenant_id, title, kind, products, cast_ids, preset, sizes, created_by, status, brief)
        SELECT tenant_id, 'Sydney Dress — real UGC', 'ugc', products, cast_ids, preset, ARRAY['9:16'], created_by, 'brief', '{"recipe":null,"template":null}'::jsonb FROM src
        RETURNING id, tenant_id
      )
      INSERT INTO public.creative_jobs (tenant_id, project_id, kind, payload, requested_by, run_after, progress)
      SELECT tenant_id, id, 'project_concepts', '{"origin":"0167"}'::jsonb, 'owner (2026-11-15 chat)', now() + interval '5 minutes', 'Reading the products' FROM p;
    END IF;
    INSERT INTO public.creative_markers (key) VALUES ('0167_sydney_real_ugc') ON CONFLICT DO NOTHING;
  END IF;
END $$;
