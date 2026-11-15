-- CarbonWMS Creative — owner's review of the 20 recipes Radar proposed (2026-11-15).
-- New recipe status 'dismissed': hidden from Settings › More › Edit recipes, never used, and Radar
-- does not propose that key again (proposeRecipes skips every key already in the table).
-- Runs on every deploy, so it only touches rows still 'proposed' — later choices are kept.

-- Approved: the Creative Director can use these.
UPDATE public.creative_recipes SET status = 'active'
 WHERE status = 'proposed'
   AND key IN ('radar_restock_announcement', 'radar_product_hero_static', 'radar_color_variation_showcase',
               'radar_press_social_proof', 'radar_product_closeup');

-- Dismissed: not right for Carbon, or a repeat of 'Product carousel' (kept as the one proposal of that kind).
UPDATE public.creative_recipes SET status = 'dismissed'
 WHERE status = 'proposed'
   AND key IN ('radar_marketplace_resale_listing', 'radar_marketplace_product_listing', 'radar_western_lifestyle_portrait',
               'radar_nostalgia_pop_culture_reference', 'radar_product_only_graphic_tee', 'radar_collaboration_drop',
               'radar_humor_skit', 'radar_product_cutout_carousel',
               'radar_product_catalog_carousel', 'radar_catalog_product_carousel', 'radar_product_flatlay_carousel',
               'radar_product_grid', 'radar_product_flatlay', 'radar_flatlay_product_collage');
