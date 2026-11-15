-- CarbonWMS Creative — owner, 2026-11-15: in the Sydney take she took a silver ring OFF the dress. Shot 4 told her to
-- "hold the silver ring hardware near the lens". Rewritten: her fingers hold the FABRIC of the hem point, the ring
-- stays attached and swings; the camera comes close. (New shot lists can't write such actions any more.)
UPDATE public.creative_projects
   SET shot_list = jsonb_set(
         jsonb_set(shot_list, '{shots,3,subject_action}', to_jsonb('Elena lifts the curved pointed hem a little toward the phone by the FABRIC of the hem point — the silver ring stays attached and swings from the point — then lets it drop naturally.'::text)),
         '{shots,3,motion_prompt}', to_jsonb('Her fingers hold the fabric of the hem point (never the ring); the attached silver ring swings and catches the light as the phone comes closer, then she lets the hem fall back into place. Small, handheld, casual.'::text)),
       updated_at = now()
 WHERE id = 'd452441a-c49c-4f7c-9180-c7f357a8ced0'
   AND shot_list->'shots'->3->>'subject_action' LIKE '%holding the silver ring%';
