INSERT INTO "public"."cricket_team" ("id", "name", "abbreviation", "league_id", "logo_url", "created_at") VALUES (33384787, 'Lahore Qalandars', 'LQ', 53050832, 'https://highlightly.net/cricket/images/teams/33384787.png', '2026-03-26 16:10:30.269272+00'), (53333107, 'Hyderabad Houston Kingsmen', 'HHK', 53050832, 'https://highlightly.net/cricket/images/teams/33384787.png', '2026-03-26 16:11:59.079754+00');

insert into public.cricket_team (id, name, abbreviation, league_id, logo_url)
values
  (11759092, 'Royal Challengers Bangalore', 'RCB', 52875307, 'https://highlightly.net/cricket/images/teams/11759092.png'),
  (11759372, 'Mumbai Indians', 'MI', 52875307, 'https://highlightly.net/cricket/images/teams/11759372.png'),
  (45457057, 'Gujarat Titans', 'GT', 52875307, 'https://highlightly.net/cricket/images/teams/45457057.png'),
  (45457022, 'Lucknow Super Giants', 'LSG', 52875307, 'https://highlightly.net/cricket/images/teams/45457022.png'),
  (21991797, 'Sunrisers Hyderabad', 'SRH', 52875307, 'https://highlightly.net/cricket/images/teams/21991797.png'),
  (11759197, 'Punjab Kings', 'PBKS', 52875307, 'https://highlightly.net/cricket/images/teams/11759197.png'),
  (11759267, 'Delhi Capitals', 'DC', 52875307, 'https://highlightly.net/cricket/images/teams/11759267.png'),
  (11759232, 'Chennai Super Kings', 'CSK', 52875307, 'https://highlightly.net/cricket/images/teams/11759232.png'),
  (11759337, 'Rajasthan Royals', 'RR', 52875307, 'https://highlightly.net/cricket/images/teams/11759337.png'),
  (11759127, 'Kolkata Knight Riders', 'KKR', 52875307, 'https://highlightly.net/cricket/images/teams/11759127.png')
on conflict (id) do nothing;