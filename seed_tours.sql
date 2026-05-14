-- ============================================================
-- STEP 1: Insert tour_config entries (skip if bokun_id exists)
-- ============================================================
INSERT INTO tour_config (bokun_id, title, active, sort_order)
SELECT v.bokun_id, v.title, true, v.sort_order
FROM (VALUES
  ('442611',  'Shooting Range',                                                          10),
  ('699787',  'Zakopane Tour with Krupówki and cheese tasting',                          20),
  ('702803',  'Zakopane Day Tour with Tasting & Funicular ride',                         30),
  ('225214',  'Zakopane Tour with Hot Bath Pools and Hotel Pickup',                      40),
  ('431283',  'Krakow Guided Tour by E-Scooter with Food Tasting',                       50),
  ('718091',  'Auschwitz Guided by MINIVAN',                                             60),
  ('775634',  'Auschwitz & Wieliczka In one day',                                        70),
  ('442321',  'Wieliczka Guided Tour with hotel transfer',                               80),
  ('717144',  'Krakow: Extreme Off-Road Quad Bike Tour',                                 90),
  ('225210',  'Krakow: Energylandia Amusement Park Full Day Access with Hotel Transfer', 100),
  ('225212',  'ZOO with hotel transfer',                                                 110),
  ('225213',  'Airport transfer',                                                        120),
  ('722118',  'Cracow: Rynek Underground Museum Guided Tour',                            130),
  ('700859',  'Krakow: Wawel Castle & Cathedral Guided Tour',                            140),
  ('722213',  'Krakow: Schindler''s Factory & Jewish Ghetto Guided Tour',                150),
  ('722117',  'Jewish Quarter Kazimierz Guided Tour',                                    160),
  ('722208',  'Krakow: Jewish Ghetto Guided Tour',                                       170),
  ('722121',  'Krakow: Plaszow Concentration Camp Guided Walking Tour',                  180),
  ('754055',  'Traditional Dunajec River Rafting with Palenica Mountain Chairlift',      190),
  ('897231',  'Krakow: UNESCO Bochnia Salt Mine Tour & Boat Expedition',                 200),
  ('976794',  'Zakopane: Quad Biking Adventure with Thermal Pools and Hotel Pickup',     210)
) AS v(bokun_id, title, sort_order)
WHERE NOT EXISTS (
  SELECT 1 FROM tour_config tc WHERE tc.bokun_id::text = v.bokun_id
);

-- ============================================================
-- STEP 2: Insert tour_commissions (skip if title already exists for that tour)
-- ============================================================
INSERT INTO tour_commissions (title, category, price_pln, commission_pln, tour_config_id, active, sort_order)
SELECT v.title, v.category, v.price_pln, v.commission_pln,
       (SELECT id FROM tour_config WHERE bokun_id::text = v.bokun_id),
       true, v.sort_order
FROM (VALUES
  -- Shooting (442611) — 7 pakietów
  ('442611', 'Shooting 15 boll Band of Brothers',              'shooting',  299, 60,  10),
  ('442611', 'Shooting 25 boll Soldier',                       'shooting',  359, 70,  20),
  ('442611', 'Shooting Army Beginner',                         'shooting',  479, 90,  30),
  ('442611', 'Shooting 50 bolls Ranger',                       'shooting',  539, 100, 40),
  ('442611', 'Shooting US/RED Army',                           'shooting',  559, 110, 50),
  ('442611', 'Shooting 75 bolls Commando',                     'shooting',  699, 120, 60),
  ('442611', 'Shooting 100 bolls Veteran',                     'shooting',  779, 130, 70),
  -- Zakopane opcja 1 (699787)
  ('699787', 'Zakopane Tour with Krupówki and cheese tasting', 'zakopane',  299, 80,  10),
  -- Zakopane opcja 2 (702803)
  ('702803', 'Zakopane Day Tour with Tasting & Funicular ride','zakopane',  349, 100, 10),
  -- Zakopane opcja 3 (225214)
  ('225214', 'Zakopane Tour with Hot Bath Pools and Hotel Pickup','zakopane',445, 110, 10),
  -- E-Scooter (431283)
  ('431283', 'Krakow Guided Tour by E-Scooter with Food Tasting','krakow',  269, 90,  10),
  -- Auschwitz MINIVAN (718091)
  ('718091', 'Auschwitz Guided by MINIVAN',                    'auschwitz', 349, 100, 10),
  -- Auschwitz & Wieliczka (775634)
  ('775634', 'Auschwitz & Wieliczka In one day',               'auschwitz', 599, 100, 10),
  -- Wieliczka (442321)
  ('442321', 'Wieliczka Guided Tour with hotel transfer',      'auschwitz', 319, 80,  10),
  -- Quads (717144) — 2 opcje czasu
  ('717144', 'Quad Bike Tour 30 min',                          'active',    449, 100, 10),
  ('717144', 'Quad Bike Tour 60 min',                          'active',    599, 120, 20),
  -- Energylandia (225210)
  ('225210', 'Energylandia Full Day Access with Hotel Transfer','krakow',   479, 90,  10),
  -- ZOO (225212)
  ('225212', 'ZOO with hotel transfer',                        'krakow',    179, 40,  10),
  -- Airport transfer (225213) — 2 opcje
  ('225213', 'Airport transfer (up to 8 pax)',                 'transfer',  199, 30,  10),
  ('225213', 'Airport transfer (up to 3 pax)',                 'transfer',  159, 30,  20),
  -- Rynek Underground (722118)
  ('722118', 'Cracow: Rynek Underground Museum Guided Tour',   'krakow',    149, 50,  10),
  -- Wawel (700859)
  ('700859', 'Krakow: Wawel Castle & Cathedral Guided Tour',   'krakow',    199, 50,  10),
  -- Schindler (722213)
  ('722213', 'Krakow: Schindler''s Factory & Jewish Ghetto Guided Tour','krakow',169,60,10),
  -- Jewish Quarter (722117)
  ('722117', 'Jewish Quarter Kazimierz Guided Tour',           'krakow',    99,  30,  10),
  -- Jewish Ghetto (722208)
  ('722208', 'Krakow: Jewish Ghetto Guided Tour',              'krakow',    99,  30,  10),
  -- Plaszow (722121)
  ('722121', 'Krakow: Plaszow Concentration Camp Guided Walking Tour','auschwitz',149,50,10),
  -- Dunajec (754055)
  ('754055', 'Traditional Dunajec River Rafting with Palenica Mountain Chairlift','active',449,100,10),
  -- Bochnia (897231)
  ('897231', 'Krakow: UNESCO Bochnia Salt Mine Tour & Boat Expedition','krakow',289,100,10),
  -- Zakopane Quads (976794)
  ('976794', 'Zakopane: Quad Biking Adventure with Thermal Pools and Hotel Pickup','zakopane',499,120,10)
) AS v(bokun_id, title, category, price_pln, commission_pln, sort_order)
WHERE NOT EXISTS (
  SELECT 1 FROM tour_commissions tc
  WHERE tc.title = v.title
    AND tc.tour_config_id = (SELECT id FROM tour_config WHERE bokun_id::text = v.bokun_id)
);
