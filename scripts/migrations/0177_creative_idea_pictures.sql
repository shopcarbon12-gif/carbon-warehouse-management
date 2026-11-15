-- CarbonWMS Creative — one preview picture per idea card (owner, 2026-11-15), drawn once in the half-price batch.
ALTER TABLE public.creative_ideas ADD COLUMN IF NOT EXISTS scene text NULL;
ALTER TABLE public.creative_ideas ADD COLUMN IF NOT EXISTS picture_path text NULL;
ALTER TABLE public.creative_ideas ADD COLUMN IF NOT EXISTS picture_status text NULL;
-- The ideas already on the page get their pictures too (once: marker job origin 0177).
WITH t AS (
  SELECT tenant_id, array_agg(id::text) AS ids FROM public.creative_ideas
   WHERE status = 'new' AND picture_path IS NULL AND created_at > now() - interval '30 days'
   GROUP BY tenant_id
), u AS (
  UPDATE public.creative_ideas i SET picture_status = 'queued' FROM t
   WHERE i.tenant_id = t.tenant_id AND i.id::text = ANY(t.ids)
     AND NOT EXISTS (SELECT 1 FROM public.creative_jobs j WHERE j.tenant_id = t.tenant_id AND j.kind = 'idea_pictures' AND j.payload->>'origin' = '0177')
  RETURNING i.id
)
INSERT INTO public.creative_jobs (tenant_id, kind, payload, requested_by, run_after, progress)
SELECT t.tenant_id, 'idea_pictures', jsonb_build_object('ids', to_jsonb(t.ids), 'origin', '0177'), 'owner (2026-11-15 chat)', now() + interval '4 minutes', 'Drawing a picture for each idea (half-price batch)'
  FROM t
 WHERE NOT EXISTS (SELECT 1 FROM public.creative_jobs j WHERE j.tenant_id = t.tenant_id AND j.kind = 'idea_pictures' AND j.payload->>'origin' = '0177');
