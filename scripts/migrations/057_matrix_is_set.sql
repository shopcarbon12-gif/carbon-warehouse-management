-- "SET" flag and set membership on a matrix.
--
-- Some products are one piece of a two- or three-piece outfit: "Thank You
-- Hoodie Set" and "Thank You Pants Set" are sold separately but photographed
-- and described as one look. Nothing in the data said so — the only signal was
-- the word "set" in the description, which is prose, not a field. SEO
-- generation in particular needs to know, because copy for half an outfit
-- should read differently from copy for a standalone garment.
--
-- Two columns, not one:
--   is_set        this product is part of a set
--   set_group_id  WHICH set — every piece of one outfit shares this id
--
-- A shared group id rather than a list of partners on each row, so membership
-- can only ever be consistent: adding a third piece is one assignment, and no
-- row can think it is paired with something that disagrees.
--
-- Real columns rather than matching on the word "set" in the name, because the
-- operator can correct them from the Matrix window and a rename must not
-- silently change what a product is.

ALTER TABLE matrices
  ADD COLUMN IF NOT EXISTS is_set boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS set_group_id uuid;

COMMENT ON COLUMN matrices.is_set IS
  'Product is one piece of a multi-piece set. Seeded from the audited UPC list; editable in the Matrix window.';
COMMENT ON COLUMN matrices.set_group_id IS
  'Every piece of the same outfit shares this id. NULL = flagged as a set piece but no partner recorded yet.';

-- Seeding matches UPC *and* description, never UPC alone: matrices.upc is not
-- unique in this catalog. UPC 1123305 is held by both "Leopard Shorts Set" and
-- "Luke Denim Shorts", and 2521340 by five different rows — matching on the
-- number alone flags plain garments as set pieces.
UPDATE matrices m SET is_set = true
FROM (VALUES
    ('2123561', '2 Pieces Ann Set'),
    ('1125306', '73 Shorts Set'),
    ('1125406', '73 T-Shirt Set'),
    ('1125210', 'Adam Shirt Set'),
    ('1125310', 'Adam Shorts Set'),
    ('1223803', 'Alo Pants Set'),
    ('1223303', 'Alo Top Set'),
    ('1125209', 'Asher Shirt Set'),
    ('1125309', 'Asher Shorts Set'),
    ('1124358', 'Bascketball Shorts Set'),
    ('1124457', 'Bascketball Top Set'),
    ('1125327', 'Basic OS Shorts Set'),
    ('1125227', 'Basic OS Top Set'),
    ('2541920', 'Bikini Bottom Set B'),
    ('2541921', 'Bikini Top Set B'),
    ('2541916', 'Bikini Top Set B'),
    ('1124336', 'Brave And Wild Short Set'),
    ('1124435', 'Brave And Wild Top Set'),
    ('2222875', 'Callie Pants Set'),
    ('2222375', 'Callie Top Set'),
    ('1222216', 'Chaos Hoodie Set'),
    ('1222817', 'Chaos Pants Set'),
    ('1125335', 'Checkers Shorts Set'),
    ('1125735', 'Checkers Top Set'),
    ('2122408', 'Chris Top Set'),
    ('2222861', 'Clan Pants Set'),
    ('2222460', 'Clan Top Set'),
    ('1123331', 'Cocktails Shorts Set'),
    ('1123731', 'Cocktails Top Set'),
    ('2222867', 'Collar Pants Set'),
    ('2222467', 'Collar Top Set'),
    ('1124334', 'Dario Short Set'),
    ('1124433', 'Dario Top Set'),
    ('1124313', 'Disaster Shorts Set'),
    ('1124413', 'Disaster Top Set'),
    ('1124315', 'Dream Shorts Set'),
    ('1124415', 'Dream Top Set'),
    ('1223802', 'Dreamin Pants Set'),
    ('1223202', 'Dreamin Top Set'),
    ('1122304', 'Edge Shorts Set'),
    ('1122405', 'Edge T-Shirt Set'),
    ('1222226', 'Eric Hoodie Set'),
    ('1222827', 'Eric Pants Set'),
    ('1123356', 'Everything Satin Bottom Set'),
    ('1123755', 'Everything Satin Top Set'),
    ('2222865', 'Eyes Pants Set'),
    ('2222465', 'Eyes Top Set'),
    ('2222209', 'Fiona Jacket Set'),
    ('2222810', 'Fiona Pants Set'),
    ('2222872', 'Freya Pants Set'),
    ('2222372', 'Freya Top Set'),
    ('2222868', 'Furry Pants Set'),
    ('2222468', 'Furry Top Set'),
    ('1123734', 'Giovanni Top Set'),
    ('1222230', 'Gordon Hoodie Set'),
    ('1222831', 'Gordon Pants Set'),
    ('1125359', 'Gothic Shorts Set'),
    ('1125459', 'Gothic T-Shirt Set'),
    ('1125411', 'Harper Shirt Set'),
    ('1125311', 'Harper Shorts Set'),
    ('2222844', 'Helen Pants Set'),
    ('2222343', 'Helen Sweater Set'),
    ('1124868', 'HQ Pants Set'),
    ('1124467', 'HQ Top Set'),
    ('1222232', 'Ian Hoodie Set'),
    ('1222833', 'Ian Pants Set'),
    ('1124308', 'James Shorts Set'),
    ('1124408', 'James Top Set'),
    ('2222848', 'Jolene Pants Set'),
    ('2222347', 'Jolene Top Set'),
    ('1125208', 'Joseph Shirt Set'),
    ('1125308', 'Joseph Shorts Set'),
    ('1124311', 'Josh Shorts Set'),
    ('1124411', 'Josh Top Set'),
    ('1125407', 'Joshua Shirt Set'),
    ('1125307', 'Joshua Shorts Set'),
    ('1123333', 'Legend Shorts Set'),
    ('1123733', 'Legend Top Set'),
    ('1123705', 'Leopard Shirt Set'),
    ('1123305', 'Leopard Shorts Set'),
    ('1124320', 'Levi Shorts Set'),
    ('1124420', 'Levi Top Set'),
    ('2222270', 'Lily Jacket Set'),
    ('2222870', 'Lily Pants Set'),
    ('2222470', 'Lily Top Set'),
    ('1123332', 'Louie Shorts Set'),
    ('1123432', 'Louie Top Set'),
    ('1125212', 'Luca Shirt Set'),
    ('1125312', 'Luca Shorts Set'),
    ('1123706', 'Miami Shirt Set'),
    ('1123306', 'Miami Shorts Set'),
    ('1125361', 'Mind Shorts Set'),
    ('1125461', 'Mind T-Shirt Set'),
    ('1124350', 'More Shorts Set'),
    ('1124449', 'More Top Set'),
    ('2222876', 'Morgan Pants Set'),
    ('2222376', 'Morgan Top Set'),
    ('1124316', 'Muse Shorts Set'),
    ('1124416', 'Muse Top Set'),
    ('2122812', 'Natalie Bottom Set'),
    ('2122411', 'Natalie Top Set'),
    ('1122302', 'Nick Shorts Set'),
    ('1122403', 'Nick T-Shirt Set'),
    ('1112861', 'Night Glow Tracksuit Bottom Set'),
    ('1112260', 'Night Glow Tracksuit Top Set'),
    ('2222218', 'Nina Jacket Set'),
    ('2222519', 'Nina Skirt Set'),
    ('1223804', 'No Risk Pants Set'),
    ('1223204', 'No Risk Top Set'),
    ('1124310', 'Obey Shorts Set'),
    ('1124410', 'Obey Top Set'),
    ('1124361', 'Palm Shorts Set'),
    ('1124260', 'Palm Top Set'),
    ('2222846', 'Paris Pants Set'),
    ('2222345', 'Paris Top Set'),
    ('2222777', 'Remi Bodysuit Set'),
    ('2222277', 'Remi Jacket Set'),
    ('2222877', 'Remi Pants Set'),
    ('1124363', 'Retrowave Shorts Set'),
    ('1124262', 'Retrowave Top Set'),
    ('2122510', 'River Bottom Set'),
    ('2122409', 'River Top Set'),
    ('1124309', 'Rob Shorts Set'),
    ('1124409', 'Rob Top Set'),
    ('1222228', 'Rostory Hoodie Set'),
    ('1222829', 'Rostory Pants Set'),
    ('1123358', 'Royal Satin Bottom Set'),
    ('1123757', 'Royal Satin Top Set'),
    ('1124314', 'Ryland Short Set'),
    ('1124714', 'Ryland Top Set'),
    ('2222837', 'Rylie Pants Set'),
    ('2222336', 'Rylie Top Set'),
    ('1125326', 'Sage Shorts Set'),
    ('1125226', 'Sage Top Set'),
    ('2521340', 'Shorts Suit Set Bottom A Grey'),
    ('1223801', 'Something Pants Set'),
    ('1223201', 'Something Top Set'),
    ('1124352', 'Steven Shorts Set'),
    ('1124451', 'Steven Top Set'),
    ('2222866', 'Strap Pants Set'),
    ('2222466', 'Strap Top Set'),
    ('1222224', 'Thank You Hoodie Set'),
    ('1222825', 'Thank You Pants Set'),
    ('1124317', 'Vacation Shorts Set'),
    ('1124417', 'Vacation Top Set'),
    ('1124319', 'Yes No Shorts Set'),
    ('1124419', 'Yes No Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.is_set = false;

-- Group the 69 sets. Ids come from the set name via uuid5, so a re-run and
-- a fresh environment produce the same ids. Only fills empties, so regrouping
-- done by hand in the Matrix window survives.
UPDATE matrices m SET set_group_id = '9bcf4dfd-2ed3-5204-b144-f3548c97e429'
FROM (VALUES
    ('1125306', '73 Shorts Set'),
    ('1125406', '73 T-Shirt Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '43aec1a8-ecc7-5720-86c6-3896e98f51a3'
FROM (VALUES
    ('1125210', 'Adam Shirt Set'),
    ('1125310', 'Adam Shorts Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '40508b3a-92cf-55b0-a822-1a509715349b'
FROM (VALUES
    ('1223803', 'Alo Pants Set'),
    ('1223303', 'Alo Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = 'f4a55e2f-52f8-5c06-afd9-5a03c498419a'
FROM (VALUES
    ('1125209', 'Asher Shirt Set'),
    ('1125309', 'Asher Shorts Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = 'cf29c91c-5a5d-5048-9701-db4d21ed0dfc'
FROM (VALUES
    ('1124358', 'Bascketball Shorts Set'),
    ('1124457', 'Bascketball Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '20d13e5a-1c92-59c3-82b2-037799b0f912'
FROM (VALUES
    ('1125327', 'Basic OS Shorts Set'),
    ('1125227', 'Basic OS Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '6a179016-de4f-5476-ad9a-1ec0b2267607'
FROM (VALUES
    ('1124336', 'Brave And Wild Short Set'),
    ('1124435', 'Brave And Wild Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = 'e1401254-c53a-5d76-9847-90452a17b21e'
FROM (VALUES
    ('2222875', 'Callie Pants Set'),
    ('2222375', 'Callie Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '8ba336fb-14bf-564d-9769-f1db45255123'
FROM (VALUES
    ('1222216', 'Chaos Hoodie Set'),
    ('1222817', 'Chaos Pants Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = 'fc7ee231-8ec4-5f4b-ad8a-e11ec3f99395'
FROM (VALUES
    ('1125335', 'Checkers Shorts Set'),
    ('1125735', 'Checkers Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '34dbb771-ee1b-529b-808e-5749aae0dbdb'
FROM (VALUES
    ('2222861', 'Clan Pants Set'),
    ('2222460', 'Clan Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = 'b9e84e68-2e52-5924-93c9-da538823df22'
FROM (VALUES
    ('1123331', 'Cocktails Shorts Set'),
    ('1123731', 'Cocktails Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '72a05f3d-26f2-5886-84f3-0953cec3f08d'
FROM (VALUES
    ('2222867', 'Collar Pants Set'),
    ('2222467', 'Collar Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = 'f6984345-5776-532b-948d-06bb1196bfa4'
FROM (VALUES
    ('1124334', 'Dario Short Set'),
    ('1124433', 'Dario Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '25e42e84-42b6-51ef-a667-a4e8b44bcbfb'
FROM (VALUES
    ('1124313', 'Disaster Shorts Set'),
    ('1124413', 'Disaster Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = 'ed0603ba-66b8-58a7-8b5f-6022da6800e0'
FROM (VALUES
    ('1124315', 'Dream Shorts Set'),
    ('1124415', 'Dream Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = 'b97db068-ef5b-5466-8349-f0030c25b6f4'
FROM (VALUES
    ('1223802', 'Dreamin Pants Set'),
    ('1223202', 'Dreamin Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '1460f84d-ea47-54de-8af8-6e9074cfe396'
FROM (VALUES
    ('1122304', 'Edge Shorts Set'),
    ('1122405', 'Edge T-Shirt Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = 'b63eb96c-4f84-5e5b-b972-55f8ffdb3277'
FROM (VALUES
    ('1222226', 'Eric Hoodie Set'),
    ('1222827', 'Eric Pants Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '069c7ec5-7af9-546e-9cda-0fa4b8f83c75'
FROM (VALUES
    ('1123356', 'Everything Satin Bottom Set'),
    ('1123755', 'Everything Satin Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '0c8b56e8-1426-5f75-8214-035724c3c8c4'
FROM (VALUES
    ('2222865', 'Eyes Pants Set'),
    ('2222465', 'Eyes Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '6b80c637-48ef-55be-af89-778b883e0884'
FROM (VALUES
    ('2222209', 'Fiona Jacket Set'),
    ('2222810', 'Fiona Pants Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '551382b8-260f-5047-b21e-44912f2e0bc4'
FROM (VALUES
    ('2222872', 'Freya Pants Set'),
    ('2222372', 'Freya Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '3832f96c-7ade-5964-b63e-3c5f5076cfab'
FROM (VALUES
    ('2222868', 'Furry Pants Set'),
    ('2222468', 'Furry Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '4e9dcb83-b176-5446-ab0a-dd1694077b55'
FROM (VALUES
    ('1222230', 'Gordon Hoodie Set'),
    ('1222831', 'Gordon Pants Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '74a4b030-abb1-5e32-acd8-83ead1edd29a'
FROM (VALUES
    ('1125359', 'Gothic Shorts Set'),
    ('1125459', 'Gothic T-Shirt Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = 'cc2907bb-abf5-55e1-81f3-22350a3349a0'
FROM (VALUES
    ('1125411', 'Harper Shirt Set'),
    ('1125311', 'Harper Shorts Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = 'aa69a457-5770-53b4-b318-76d68fcf96a1'
FROM (VALUES
    ('2222844', 'Helen Pants Set'),
    ('2222343', 'Helen Sweater Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '66e70333-cbde-593b-b4fd-df5581254272'
FROM (VALUES
    ('1124868', 'HQ Pants Set'),
    ('1124467', 'HQ Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '8e5d403c-ed00-5e98-a278-dbdfb0075287'
FROM (VALUES
    ('1222232', 'Ian Hoodie Set'),
    ('1222833', 'Ian Pants Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '8cff91bf-f702-50db-825f-c093df2764d7'
FROM (VALUES
    ('1124308', 'James Shorts Set'),
    ('1124408', 'James Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '7ae4d9f0-d0fc-54c2-8d91-41ecae3450b5'
FROM (VALUES
    ('2222848', 'Jolene Pants Set'),
    ('2222347', 'Jolene Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = 'b0c224d9-0d2e-512c-8e69-c9b6ebc668f9'
FROM (VALUES
    ('1125208', 'Joseph Shirt Set'),
    ('1125308', 'Joseph Shorts Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '0374edd6-268a-5251-aae2-17370c966dfc'
FROM (VALUES
    ('1124311', 'Josh Shorts Set'),
    ('1124411', 'Josh Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '6df52551-ee08-5a46-a45a-2504b85489a1'
FROM (VALUES
    ('1125407', 'Joshua Shirt Set'),
    ('1125307', 'Joshua Shorts Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '7cca0941-f2e3-57b6-aea2-11191939cf96'
FROM (VALUES
    ('1123333', 'Legend Shorts Set'),
    ('1123733', 'Legend Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '6a8e7ad2-e620-59cd-a989-eb0208478dc8'
FROM (VALUES
    ('1123705', 'Leopard Shirt Set'),
    ('1123305', 'Leopard Shorts Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '4434e421-f4ca-5843-b029-1d39255cd90f'
FROM (VALUES
    ('1124320', 'Levi Shorts Set'),
    ('1124420', 'Levi Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '3d8db26a-07d0-53d4-8549-27883aaa32dc'
FROM (VALUES
    ('2222270', 'Lily Jacket Set'),
    ('2222870', 'Lily Pants Set'),
    ('2222470', 'Lily Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '7cb154a2-5748-5706-ae16-4ce3096bb3a7'
FROM (VALUES
    ('1123332', 'Louie Shorts Set'),
    ('1123432', 'Louie Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '859e0085-2f38-5d85-8f2d-368c32002ce2'
FROM (VALUES
    ('1125212', 'Luca Shirt Set'),
    ('1125312', 'Luca Shorts Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = 'f6b52cb9-10c1-52aa-86fb-16f001ff4496'
FROM (VALUES
    ('1123706', 'Miami Shirt Set'),
    ('1123306', 'Miami Shorts Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '548a4f90-9ccc-5c8a-8efd-5cb540e3cf51'
FROM (VALUES
    ('1125361', 'Mind Shorts Set'),
    ('1125461', 'Mind T-Shirt Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '06e14deb-6085-5197-8ca7-de4147522806'
FROM (VALUES
    ('1124350', 'More Shorts Set'),
    ('1124449', 'More Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = 'a29fe026-c823-5c3e-be7f-ba9aaaff4fa8'
FROM (VALUES
    ('2222876', 'Morgan Pants Set'),
    ('2222376', 'Morgan Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '4b0f7f3a-8b17-530d-9ae2-5e5b3a670c0b'
FROM (VALUES
    ('1124316', 'Muse Shorts Set'),
    ('1124416', 'Muse Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '24f974e6-155e-5dca-8360-1379103fcbdc'
FROM (VALUES
    ('2122812', 'Natalie Bottom Set'),
    ('2122411', 'Natalie Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = 'd97b6012-d958-5fdf-960a-ddaf68d7adec'
FROM (VALUES
    ('1122302', 'Nick Shorts Set'),
    ('1122403', 'Nick T-Shirt Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '1baffd50-19fc-5fe9-9860-57d0f28855dc'
FROM (VALUES
    ('1112861', 'Night Glow Tracksuit Bottom Set'),
    ('1112260', 'Night Glow Tracksuit Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = 'ff81a525-4c71-51a0-831d-ccb372121d9c'
FROM (VALUES
    ('2222218', 'Nina Jacket Set'),
    ('2222519', 'Nina Skirt Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = 'a7b6f49c-e267-564c-9abc-a61e4c5d671f'
FROM (VALUES
    ('1223804', 'No Risk Pants Set'),
    ('1223204', 'No Risk Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '2fa131c4-b89c-5e39-b76a-b943483cf2ba'
FROM (VALUES
    ('1124310', 'Obey Shorts Set'),
    ('1124410', 'Obey Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '0e0bec76-f062-5631-aa75-d16c04f35f21'
FROM (VALUES
    ('1124361', 'Palm Shorts Set'),
    ('1124260', 'Palm Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '09c0421f-72dd-54fd-a068-ee4468bd80d3'
FROM (VALUES
    ('2222846', 'Paris Pants Set'),
    ('2222345', 'Paris Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '44c0c645-84b5-5318-8002-9f0b43fba3ae'
FROM (VALUES
    ('2222777', 'Remi Bodysuit Set'),
    ('2222277', 'Remi Jacket Set'),
    ('2222877', 'Remi Pants Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = 'e03e1d8a-c8b0-50f4-bce0-5de05b79566f'
FROM (VALUES
    ('1124363', 'Retrowave Shorts Set'),
    ('1124262', 'Retrowave Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '514e40b7-28af-56ae-bd3d-8fa57230cdeb'
FROM (VALUES
    ('2122510', 'River Bottom Set'),
    ('2122409', 'River Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '480d8ee4-416f-5ed5-a588-3e5c06668db8'
FROM (VALUES
    ('1124309', 'Rob Shorts Set'),
    ('1124409', 'Rob Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '76197593-079f-5d34-bcf5-2c5ce3d796a5'
FROM (VALUES
    ('1222228', 'Rostory Hoodie Set'),
    ('1222829', 'Rostory Pants Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '24d0a946-2e4b-5822-9ae7-6bee93be5fe5'
FROM (VALUES
    ('1123358', 'Royal Satin Bottom Set'),
    ('1123757', 'Royal Satin Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = 'd8c77556-d97c-5621-992e-161a957e72e3'
FROM (VALUES
    ('1124314', 'Ryland Short Set'),
    ('1124714', 'Ryland Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = 'b76cd799-dea3-5b96-afd9-5fe8d936c046'
FROM (VALUES
    ('2222837', 'Rylie Pants Set'),
    ('2222336', 'Rylie Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '5ddb051b-8767-52c9-b50c-df2245780433'
FROM (VALUES
    ('1125326', 'Sage Shorts Set'),
    ('1125226', 'Sage Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '975480ab-7210-50c1-91f3-9981f20dc403'
FROM (VALUES
    ('1223801', 'Something Pants Set'),
    ('1223201', 'Something Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '845a8597-ea73-5be7-89cf-60652e7c46f4'
FROM (VALUES
    ('1124352', 'Steven Shorts Set'),
    ('1124451', 'Steven Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '92630aa4-525e-5f0f-9c7b-5a9cbced7079'
FROM (VALUES
    ('2222866', 'Strap Pants Set'),
    ('2222466', 'Strap Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = '7223b494-ef98-5ad7-9fe5-cefcaf5a6bb6'
FROM (VALUES
    ('1222224', 'Thank You Hoodie Set'),
    ('1222825', 'Thank You Pants Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = 'c2db6508-047b-53e7-9843-c9226a1e9e26'
FROM (VALUES
    ('1124317', 'Vacation Shorts Set'),
    ('1124417', 'Vacation Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;
UPDATE matrices m SET set_group_id = 'b7b66ddc-92d6-540b-8fb6-49c9e76c622a'
FROM (VALUES
    ('1124319', 'Yes No Shorts Set'),
    ('1124419', 'Yes No Top Set')
) AS s(upc, description)
WHERE m.upc = s.upc AND m.description = s.description AND m.set_group_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_matrices_is_set ON matrices(is_set) WHERE is_set;
CREATE INDEX IF NOT EXISTS idx_matrices_set_group ON matrices(set_group_id) WHERE set_group_id IS NOT NULL;
