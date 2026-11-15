-- CarbonWMS Creative — six more Looks (owner, 2026-11-15): Golden Hour, Rain Noir, Studio, Film 35,
-- Black & White, Night Flash. Brand Brains that already keep their own Looks get the ones they don't have
-- (by key; nothing is overwritten, a Look the owner deletes later is not re-added once this has run).
-- Then one half-price OpenAI batch draws sample frames for every Look without them (owner asked for it).
-- Runs on every deploy: guarded by a marker row in creative_jobs so it happens once per tenant.
DO $$
DECLARE
  new_looks jsonb := '[{"key": "golden", "name": "CARBON Golden Hour", "look": "low warm sun just before sunset, long soft shadows, gentle lens flare, glowing skin, hotel entrances and glass doors catching the light, the moment of arriving", "grade": {"contrast": 1.06, "saturation": 1.04, "brightness": 0.03, "warmth": 0.14, "grain": 0.08}, "pacing": "medium", "samples": []}, {"key": "rain_noir", "name": "CARBON Rain Noir", "look": "night rain, wet asphalt mirroring neon and street lights, cool teal shadows against amber highlights, cinematic and moody, umbrellas and puddle reflections", "grade": {"contrast": 1.2, "saturation": 0.88, "brightness": -0.06, "warmth": -0.06, "grain": 0.12}, "pacing": "medium", "samples": []}, {"key": "studio", "name": "CARBON Studio", "look": "seamless light-grey studio sweep, one hard key light with a crisp shadow, clean high-fashion editorial, nothing but the clothes and the pose", "grade": {"contrast": 1.1, "saturation": 0.95, "brightness": 0.04, "warmth": 0, "grain": 0.03}, "pacing": "fast", "samples": []}, {"key": "film35", "name": "CARBON Film 35", "look": "35mm film snapshot, soft natural colour, gentle halation and visible grain, candid street moment caught between steps, slightly imperfect framing", "grade": {"contrast": 1.02, "saturation": 0.92, "brightness": 0.02, "warmth": 0.05, "grain": 0.3}, "pacing": "medium", "samples": []}, {"key": "mono", "name": "CARBON Black & White", "look": "black and white, deep rich blacks and bright whites, strong graphic shadows and architecture, timeless monochrome editorial", "grade": {"contrast": 1.25, "saturation": 0, "brightness": -0.02, "warmth": 0, "grain": 0.15}, "pacing": "slow", "samples": []}, {"key": "flash", "name": "CARBON Night Flash", "look": "direct on-camera flash at night, paparazzi energy, glossy highlights on dark backgrounds, arriving at the party, sharp and bold", "grade": {"contrast": 1.18, "saturation": 1.02, "brightness": 0, "warmth": 0.02, "grain": 0.06}, "pacing": "fast", "samples": []}]'::jsonb;
  r record;
BEGIN
  FOR r IN SELECT tenant_id, presets FROM public.creative_brand LOOP
    IF EXISTS (SELECT 1 FROM public.creative_jobs WHERE tenant_id = r.tenant_id AND kind = 'preset_samples' AND payload->>'origin' = '0164') THEN
      CONTINUE;
    END IF;
    IF jsonb_array_length(r.presets) > 0 THEN
      UPDATE public.creative_brand
         SET presets = presets || COALESCE((SELECT jsonb_agg(l) FROM jsonb_array_elements(new_looks) l
                                     WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r.presets) e WHERE e->>'key' = l->>'key')), '[]'::jsonb),
             updated_at = now()
       WHERE tenant_id = r.tenant_id;
    END IF;
    INSERT INTO public.creative_jobs (tenant_id, kind, payload, requested_by, run_after, progress)
    VALUES (r.tenant_id, 'preset_samples', '{"keys":"missing","origin":"0164"}'::jsonb, 'owner (2026-11-15 chat)', now(), 'Queued for the OpenAI batch (half price)');
  END LOOP;
END $$;
