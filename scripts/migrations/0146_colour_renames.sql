-- Colour renames (2026-11-07). Renaming a colour re-creates the product's
-- Shopify variants, so Social product tags on the old colour go stale and
-- Instagram refuses the whole post (Elena Reel, 2026-11-06: Riley BEIGE → IVORY).
-- The Social tag refresh (lib/server/marketing/tag-refresh.ts) reads this log
-- to know which new colour a stale tag should move to.
CREATE TABLE IF NOT EXISTS public.colour_renames (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NULL,
  matrix_id           uuid NULL,
  shopify_product_id  text NULL,
  from_colour         text NOT NULL,
  to_colour           text NOT NULL,
  source              text NOT NULL DEFAULT '',
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS colour_renames_product_idx ON public.colour_renames (shopify_product_id, created_at DESC);

-- Backfill: the Nov 2026 catalog pass renames (2026-11-04), once.
INSERT INTO public.colour_renames (tenant_id, matrix_id, shopify_product_id, from_colour, to_colour, source, created_at)
SELECT NULL::uuid, m.id, m.shopify_product_id, v.f, v.t, 'seo_pass_2026_11', v.at::timestamptz
  FROM (VALUES
  ('71997272-e083-4517-9e40-46406e202fc7', 'BLACK', 'GREY', '2026-11-04T01:53:21.257Z'),
  ('587b8c36-802c-4951-a845-fb74cbae22c2', 'BRONZE', 'CAMEL', '2026-11-04T01:54:03.303Z'),
  ('f2d54363-c818-465c-bfcc-42b657c932cd', 'TURQUOISE', 'DARK TEAL', '2026-11-04T01:54:10.814Z'),
  ('53a22a21-ad57-4006-9cbc-a4db42766739', 'TURQUOISE', 'DARK TEAL', '2026-11-04T01:54:33.493Z'),
  ('76ac2ac2-02db-4191-9ecf-46575c1c65ed', 'ALMOND', 'GREY', '2026-11-04T06:17:29.393Z'),
  ('560106a5-27a3-42a5-9ae0-1f594d8dd2d6', 'BRONZE', 'BROWN', '2026-11-04T06:17:35.414Z'),
  ('74fb5c0c-7d99-492a-910e-52c3e130a15b', 'STONE', 'PEACH', '2026-11-04T06:21:36.261Z'),
  ('a47f86c6-c582-4393-8e65-a94bab2ab793', 'PURPLE', 'BROWN', '2026-11-04T06:25:43.285Z'),
  ('e8dd0069-d00b-4746-b303-00294ed46e87', 'BEIGE', 'MUSTARD', '2026-11-04T06:33:38.204Z'),
  ('e93dd63b-3137-4b71-ba6f-751e5d63f476', 'WHITE', 'GOLD', '2026-11-04T06:37:44.532Z'),
  ('7196a994-5ede-4486-87ce-2706848d51a9', 'BEIGE', 'MUSTARD', '2026-11-04T06:37:51.014Z'),
  ('b0e97e2a-2964-4ae0-b72c-496e0971fcaf', 'TEAL', 'MINT', '2026-11-04T06:42:09.866Z'),
  ('4574c9a6-6bfe-4e84-91c3-11be35d19158', 'TEAL', 'TURQUOISE', '2026-11-04T06:42:16.417Z'),
  ('f9cf4a57-9bc1-48a2-8002-12dd25bd3079', 'GRAVITY GREY', 'SAGE', '2026-11-04T06:42:22.984Z'),
  ('d6443e11-fb8b-4d03-8bb7-aa910757acfd', 'BRONZE', 'TAUPE', '2026-11-04T06:46:41.548Z'),
  ('880cb595-4647-46b3-8cb4-202292a69a34', 'MINK', 'CAMEL', '2026-11-04T06:50:54.803Z'),
  ('16bff211-a525-47f4-83fd-a8810fb5b81f', 'BURGUNDY', 'BROWN', '2026-11-04T06:55:06.241Z'),
  ('fe740781-0241-4919-971d-c29296268526', 'BURGUNDY', 'BROWN', '2026-11-04T06:55:13.145Z'),
  ('3ec03586-50f5-4079-bfc3-c9b0e2b69d6a', 'WHITE', 'LIGHT GREY', '2026-11-04T06:55:20.045Z'),
  ('32826106-6d7d-402f-bf84-56dcac1576bc', 'MINT', 'TURQUOISE', '2026-11-04T06:55:26.900Z'),
  ('0d7ea0be-0aee-4add-8c27-ba1c6333a2fa', 'WILD MUSHROOM', 'CAMEL', '2026-11-04T06:59:46.369Z'),
  ('c7edea9d-0c0b-4d1e-9186-128c187b9363', 'BEIGE', 'MUSTARD', '2026-11-04T06:59:58.228Z'),
  ('6f144069-6207-4c35-8c52-889ad8628721', 'MINK', 'CAMEL', '2026-11-04T07:04:06.105Z'),
  ('bbea717d-d25f-4a48-a86e-fe51a74a8828', 'BLUE', 'BLACK', '2026-11-04T07:04:13.106Z'),
  ('663fa390-ed7d-46c3-aecd-79f96e19dc5f', 'BRONZE', 'CAMEL', '2026-11-04T07:08:21.044Z'),
  ('5207ab0d-f769-4aca-bc31-b66c477d7922', 'WILD MUSHROOM', 'CAMEL', '2026-11-04T07:08:28.164Z'),
  ('f175668d-9897-4de6-8486-b9550b9da286', 'WILD MUSHROOM', 'CAMEL', '2026-11-04T07:08:34.834Z'),
  ('044919b2-8645-4c92-bb36-a0a3d308dfd0', 'TEAL', 'SAGE', '2026-11-04T07:12:35.647Z'),
  ('4815f54d-8776-41aa-804d-572b7b45e58a', 'SILVER', 'GOLD', '2026-11-04T07:12:42.360Z'),
  ('90409588-51b4-4da6-89b0-d8018fbd31f7', 'SILVER', 'GOLD', '2026-11-04T07:12:49.092Z'),
  ('c42f1959-8cd3-4e7b-aeec-46f5124fd029', 'SALMON', 'DUSTY PINK', '2026-11-04T07:17:03.452Z'),
  ('4546ba96-9fff-46d2-b278-b79fe0a839f5', 'SALMON', 'DUSTY PINK', '2026-11-04T07:17:10.001Z'),
  ('39b5d291-a91b-4b95-8502-157344633f6c', 'SALMON', 'DUSTY PINK', '2026-11-04T07:17:16.524Z'),
  ('dc4525af-d71a-42da-8052-0d8e5752bd77', 'MINK', 'CAMEL', '2026-11-04T07:17:23.043Z'),
  ('d5c0b484-f479-4778-a051-d666111d1d9a', 'CAMEL FLUSH WHITE', 'WHITE', '2026-11-04T07:17:29.617Z'),
  ('3c7bcc84-4c89-42f1-9f93-1ecc2fc1cf5d', 'WHITE STONE', 'BEIGE', '2026-11-04T07:17:36.184Z'),
  ('52dd5d52-9698-42cf-a8e4-c93477717d38', 'TURQUOISE', 'TEAL', '2026-11-04T07:22:04.990Z'),
  ('8525e921-95a3-4ab1-ae2b-e7399e3577f4', 'SILVER', 'GOLD', '2026-11-04T07:22:11.555Z'),
  ('9c80b03e-e025-478b-a83b-bb335d647481', 'BLUE', 'CHARCOAL', '2026-11-04T07:22:18.246Z'),
  ('e8b79b12-f205-4b0a-ba57-ecdfe06b1699', 'JEANS', 'LIGHT GREY', '2026-11-04T07:22:25.417Z'),
  ('e21c9746-657e-4719-820c-ceeb70136a2a', 'BRONZE', 'RUST', '2026-11-04T07:26:46.741Z'),
  ('05005d87-9c72-4dbc-a697-2d541f7ccc54', 'BURGUNDY', 'RED', '2026-11-04T07:26:53.549Z'),
  ('74f5eedf-3a7a-45cd-83c1-c0677ae05f6e', 'TEAL', 'MINT', '2026-11-04T07:27:00.388Z'),
  ('5137be1a-eaa5-42ca-9ed5-8f802fa91dd2', 'GREY', 'NAVY', '2026-11-04T07:31:23.531Z'),
  ('8f41f3dc-178e-4f65-8265-810fa31c4a12', 'GREY', 'NAVY', '2026-11-04T07:31:30.114Z'),
  ('ae1a52a3-240d-4fe6-8db4-353a29eff03b', 'GALLNUT', 'DUSTY PINK', '2026-11-04T07:31:36.648Z'),
  ('ae1a52a3-240d-4fe6-8db4-353a29eff03b', 'GRAVITY GREY', 'SAGE', '2026-11-04T07:31:43.874Z'),
  ('ca53cb98-f875-4289-8ee4-c4ff9ff1ed70', 'LIGHT LIME', 'YELLOW', '2026-11-04T07:31:50.697Z'),
  ('2335331e-6478-41d3-8e35-2a70f4e43a66', 'BEIGE', 'IVORY', '2026-11-04T07:31:58.135Z'),
  ('d6b202cf-161d-40bc-8264-a92872f0368e', 'NUDE', 'CREAM', '2026-11-04T07:37:02.432Z'),
  ('6f33c0e0-c153-4588-86db-ed73a994233d', 'SILVER', 'GOLD', '2026-11-04T07:37:10.571Z'),
  ('345a862e-32ae-4e1d-8578-8d306df2e06d', 'TURQUOISE', 'NAVY', '2026-11-04T07:41:47.339Z'),
  ('977855fc-430d-4520-b227-9ac2b7ea7a22', 'BROWN', 'MAUVE', '2026-11-04T07:46:35.377Z'),
  ('2a8811d8-1fa1-456d-93f5-d7dafbfd248f', 'BRONZE', 'ORANGE', '2026-11-04T07:50:47.570Z'),
  ('b913ac6a-3a90-4493-8707-f2d543b93e8c', 'NECTAR', 'YELLOW', '2026-11-04T07:50:55.939Z'),
  ('7b31a5df-f61c-4408-8d5d-d225f55aacc3', 'Sage Green', 'SAGE GREEN', '2026-11-04T16:58:39.430Z'),
  ('73909387-db7b-402b-93d5-5be5a4602cd3', 'TIE-DIE BLUE', 'TIE-DYE BLUE', '2026-11-04T16:58:45.580Z'),
  ('73909387-db7b-402b-93d5-5be5a4602cd3', 'TIE-DIE GREY', 'TIE-DYE GREY', '2026-11-04T16:58:51.740Z'),
  ('d830983b-af78-406a-b4cb-d426d38ab12e', 'TIE-DIE PURPLE', 'TIE-DYE PURPLE', '2026-11-04T16:58:57.886Z')
  ) AS v(mid, f, t, at)
  JOIN public.matrices m ON m.id = v.mid::uuid
 WHERE NOT EXISTS (SELECT 1 FROM public.colour_renames WHERE source = 'seo_pass_2026_11');
