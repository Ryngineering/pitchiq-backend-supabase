create table public.cricket_team (
  id bigint not null,
  name character varying not null default 'UNKNOWN'::character varying,
  abbreviation character varying not null,
  league_id bigint not null,
  logo_url character varying null,
  created_at timestamp with time zone not null default now(),
  constraint cricket_team_pkey primary key (id)
) TABLESPACE pg_default;

create table cricket_matches (
  id bigint primary key,
  home_team_id bigint references cricket_team(id),
  away_team_id bigint references cricket_team(id),
  home_score text,
  away_score text,
  home_info text,
  away_info text,
  prematch_home_win_prediction text,
  prematch_away_win_prediction text,
  prematch_draw_prediction text,
  live_home_win_prediction text,
  live_away_win_prediction text,
  live_draw_prediction text,
  status text,
  venue text,
  report text,
  last_updated timestamptz default now(),
  raw jsonb
);

create table if not exists public.user_profile (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_profile
  add column if not exists is_approved boolean not null default false,
  add column if not exists is_admin boolean not null default false;

-- RLS for cricket_matches

alter table public.cricket_matches enable row level security;

create policy "authenticated can read cricket_matches"
on public.cricket_matches
for select
to authenticated
using (true);

-- RLS for cricket_team

alter table public.cricket_team enable row level security;

create policy "authenticated can read cricket_team"
on public.cricket_team
for select
to authenticated
using (true);

-- RLS for user_profile

alter table public.user_profile enable row level security;

drop policy if exists "profile_select_authenticated" on public.user_profile;
create policy "profile_select_authenticated"
on public.user_profile
for select
to authenticated
using (auth.uid() = id or public.is_admin());

-- NOTE: INSERT is intentionally omitted — profile rows are created exclusively
-- by the tg_create_user_profile trigger on auth.users. We still allow
-- authenticated users to insert ONLY their own row as a safe fallback.
drop policy if exists "profile_insert_own" on public.user_profile;
create policy "profile_insert_own"
on public.user_profile
for insert
to authenticated
with check (auth.uid() = id);

drop policy if exists "profile_update_own" on public.user_profile;
create policy "profile_update_own"
on public.user_profile
for update
to authenticated
using (auth.uid() = id)
with check (auth.uid() = id);

create or replace function public.is_admin()
returns boolean
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_is_admin boolean;
begin
  select up.is_admin
  into v_is_admin
  from public.user_profile up
  where up.id = auth.uid();

  return coalesce(v_is_admin, false);
end;
$$;

create or replace function public.tg_prevent_profile_privilege_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (
    old.is_approved is distinct from new.is_approved
    or old.is_admin is distinct from new.is_admin
  ) and not public.is_admin() then
    raise exception 'Only admins can change approval settings.';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_prevent_profile_privilege_escalation on public.user_profile;
create trigger trg_prevent_profile_privilege_escalation
before update on public.user_profile
for each row execute function public.tg_prevent_profile_privilege_escalation();

drop policy if exists "admin_can_update_any_profile" on public.user_profile;
create policy "admin_can_update_any_profile"
on public.user_profile
for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

-- One-time bootstrap after your first login:
-- update public.user_profile
-- set is_approved = true, is_admin = true
-- where email = 'you@example.com';

-- DB trigger: auto-create a minimal profile row when a new auth user is created.
-- This fires before the client upsert and guarantees the row always exists.
create or replace function public.tg_create_user_profile()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.user_profile (id, email, display_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(
      new.raw_user_meta_data->>'full_name',
      new.raw_user_meta_data->>'name',
      split_part(new.email, '@', 1)
    ),
    new.raw_user_meta_data->>'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_create_user_profile on auth.users;
create trigger trg_create_user_profile
after insert on auth.users
for each row execute function public.tg_create_user_profile();


-- Inseting data


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


INSERT INTO "public"."cricket_team" ("id", "name", "abbreviation", "league_id", "logo_url", "created_at") VALUES (33384787, 'Lahore Qalandars', 'LQ', 53050832, 'https://highlightly.net/cricket/images/teams/33384787.png', '2026-03-26 16:10:30.269272+00'), (53333107, 'Hyderabad Houston Kingsmen', 'HHK', 53050832, 'https://highlightly.net/cricket/images/teams/33384787.png', '2026-03-26 16:11:59.079754+00');

-- ============================================================
-- MIGRATION: Prediction scoring and leaderboard
-- Run this block once after the base schema above exists.
-- All statements are idempotent / safe to re-run.
-- ============================================================

-- 1) Prediction result enum
do $$ begin
  create type public.prediction_result as enum (
    'pending',    -- match still live or upcoming
    'correct',    -- user picked the winner
    'incorrect',  -- user picked the wrong team
    'void'        -- match abandoned / cancelled / no result / not played / postponed
  );
exception when duplicate_object then null;
end $$;

-- 2) Predictions table (one row per user per match enforced by unique key)
create table if not exists public.user_predictions (
  id                 bigserial primary key,
  user_id            uuid          not null references public.user_profile(id) on delete cascade,
  match_id           bigint        not null references public.cricket_matches(id) on delete cascade,
  picked_team_id     bigint        not null references public.cricket_team(id),
  probability_at_pick numeric(5,2) not null,
  result             public.prediction_result not null default 'pending',
  points_awarded     numeric(8,1),
  settlement_reason  text,
  picked_at          timestamptz   not null default now(),
  settled_at         timestamptz,
  created_at         timestamptz   not null default now(),
  updated_at         timestamptz   not null default now(),

  constraint uq_user_match_prediction unique (user_id, match_id),
  constraint ck_probability_range check (probability_at_pick >= 0 and probability_at_pick <= 100),
  constraint ck_points_non_negative check (points_awarded is null or points_awarded >= 0)
);

create index if not exists idx_user_predictions_user_id      on public.user_predictions(user_id);
create index if not exists idx_user_predictions_match_id     on public.user_predictions(match_id);
create index if not exists idx_user_predictions_result       on public.user_predictions(result);
create index if not exists idx_user_predictions_user_result  on public.user_predictions(user_id, result);

-- 3) Auto-update updated_at
create or replace function public.tg_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_user_predictions_updated_at on public.user_predictions;
create trigger trg_user_predictions_updated_at
before update on public.user_predictions
for each row execute function public.tg_set_updated_at();

-- 4) Terminal / void status classifiers
-- A match is "terminal" only when it is truly completed.
create or replace function public.is_match_terminal(p_status text)
returns boolean language sql immutable as $$
  select coalesce(p_status, '') ~* '(finished|abandon|cancelled|canceled)';
$$;

-- A match is "void" when it ended without a winner (no points awarded).
create or replace function public.is_match_void(p_status text)
returns boolean language sql immutable as $$
  select coalesce(p_status, '') ~* '(abandon|cancelled|canceled)';
$$;

-- 5) Run-count extractor from raw score strings like "198/4" or "198-4"
create or replace function public.extract_runs(p_score text)
returns integer language sql immutable as $$
  select case
    when p_score is null then null
    else (regexp_match(trim(p_score), '^(\d+)'))[1]::int
  end;
$$;

-- 6) Winner resolver — returns the team_id with more runs, null on draw/unparseable
create or replace function public.get_match_winner_team_id(
  p_home_team_id bigint,
  p_away_team_id bigint,
  p_home_score   text,
  p_away_score   text
)
returns bigint language plpgsql immutable as $$
declare
  home_runs int := public.extract_runs(p_home_score);
  away_runs int := public.extract_runs(p_away_score);
begin
  if home_runs is null or away_runs is null or home_runs = away_runs then
    return null;
  end if;
  return case when home_runs > away_runs then p_home_team_id else p_away_team_id end;
end;
$$;

-- 7) Points formula — mirrors frontend calcPts(prob) = round((100-prob)/10, 1)
create or replace function public.compute_points(p_probability numeric)
returns numeric language sql immutable as $$
  select round((100 - p_probability) / 10.0, 1);
$$;

-- 8) Core settlement function — idempotent, only touches 'pending' rows
create or replace function public.settle_predictions_for_match(p_match_id bigint)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_match  public.cricket_matches%rowtype;
  v_winner bigint;
  v_void   boolean;
begin
  select * into v_match from public.cricket_matches where id = p_match_id;
  if not found then return; end if;
  if not public.is_match_terminal(v_match.status) then return; end if;

  v_void   := public.is_match_void(v_match.status);
  v_winner := public.get_match_winner_team_id(
    v_match.home_team_id, v_match.away_team_id,
    v_match.home_score,   v_match.away_score
  );

  -- If terminal and not explicitly void but winner unresolvable, treat as void
  if not v_void and v_winner is null then
    v_void := true;
  end if;

  update public.user_predictions
  set
    result = case
      when v_void                        then 'void'::public.prediction_result
      when picked_team_id = v_winner     then 'correct'::public.prediction_result
      else                                    'incorrect'::public.prediction_result
    end,
    points_awarded = case
      when v_void                        then 0
      when picked_team_id = v_winner     then public.compute_points(probability_at_pick)
      else                                    0
    end,
    settlement_reason = case
      when v_void then coalesce(v_match.status, 'void')
      else null
    end,
    settled_at  = now(),
    updated_at  = now()
  where match_id = p_match_id
    and result   = 'pending'::public.prediction_result;
end;
$$;

-- 9) Trigger — fires when match status or scores change
create or replace function public.tg_settle_predictions_on_match_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if public.is_match_terminal(new.status) then
      perform public.settle_predictions_for_match(new.id);
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if new.status is distinct from old.status and public.is_match_terminal(new.status) then
      perform public.settle_predictions_for_match(new.id);
    end if;
    return new;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_settle_predictions_on_match_change on public.cricket_matches;
create trigger trg_settle_predictions_on_match_change
after insert or update of status, home_score, away_score on public.cricket_matches
for each row execute function public.tg_settle_predictions_on_match_change();

-- 10) RLS for user_predictions
alter table public.user_predictions enable row level security;

drop policy if exists "predictions_select_own"                         on public.user_predictions;
drop policy if exists "predictions_insert_own"                         on public.user_predictions;
drop policy if exists "predictions_update_own_pending"                 on public.user_predictions;
drop policy if exists "predictions_delete_own_pending"                 on public.user_predictions;

-- Users read only their own predictions
create policy "predictions_select_own"
on public.user_predictions for select to authenticated
using (auth.uid() = user_id);

-- Users can only insert for themselves on non-terminal matches
create policy "predictions_insert_own"
on public.user_predictions for insert to authenticated
with check (
  auth.uid() = user_id
  and result = 'pending'::public.prediction_result
  and exists (
    select 1 from public.cricket_matches m
    where m.id = match_id and not public.is_match_terminal(m.status)
  )
);

-- Users can update/change their pick only while prediction is still pending
-- and the match is not yet terminal (i.e. still live or upcoming)
create policy "predictions_update_own_pending"
on public.user_predictions for update to authenticated
using  (auth.uid() = user_id and result = 'pending'::public.prediction_result)
with check (
  auth.uid() = user_id
  and result = 'pending'::public.prediction_result
  and exists (
    select 1 from public.cricket_matches m
    where m.id = match_id and not public.is_match_terminal(m.status)
  )
);

-- Users can retract a pending pick on a non-terminal match
create policy "predictions_delete_own_pending"
on public.user_predictions for delete to authenticated
using (
  auth.uid() = user_id
  and result = 'pending'::public.prediction_result
  and exists (
    select 1 from public.cricket_matches m
    where m.id = match_id and not public.is_match_terminal(m.status)
  )
);

create or replace view public.leaderboard
with (security_invoker = false) as
select
  upf.id as user_id,
  coalesce(upf.display_name, split_part(upf.email, '@', 1), 'Player') as name,
  upper(
    left(split_part(coalesce(upf.display_name, split_part(upf.email, '@', 1), 'P'), ' ', 1), 1) ||
    coalesce(left(nullif(split_part(coalesce(upf.display_name, split_part(upf.email, '@', 1), 'P'), ' ', 2), ''), 1), '')
  ) as av,
  coalesce(
    sum(case when p.result in ('correct','incorrect') then p.points_awarded else 0 end),
    0
  )::numeric(10,1)                                                    as pts,
  count(*) filter (where p.result = 'correct')::int                   as correct,
  count(*) filter (where p.result in ('correct','incorrect'))::int     as total,
  row_number() over (
    order by
      coalesce(sum(case when p.result in ('correct','incorrect') then p.points_awarded else 0 end), 0) desc,
      count(*) filter (where p.result = 'correct') desc,
      upf.created_at asc
  )::int                                                               as rank
from public.user_profile upf
left join public.user_predictions p on p.user_id = upf.id
group by upf.id, upf.display_name, upf.email, upf.created_at;

grant select on public.leaderboard to authenticated;

-- ============================================================
-- MIGRATION: League Sync Configuration and Logging
-- ============================================================

-- 1) League sync configuration table
create table if not exists public.league_sync_config (
  id                   bigserial primary key,
  league_id            bigint        not null,
  league_name          text          not null,
  season               integer       not null,
  scheduled_time       time          not null default '00:00:00',
  sync_interval_hours  integer       not null default 24,
  enabled              boolean       not null default true,
  last_sync_at         timestamptz,
  next_sync_at         timestamptz,
  created_at           timestamptz   not null default now(),
  updated_at           timestamptz   not null default now(),

  constraint uq_league_season unique (league_id, season)
);

create index if not exists idx_league_sync_config_enabled_next_sync
  on public.league_sync_config(enabled, next_sync_at)
  where enabled = true;

-- 2) League sync logs table
create table if not exists public.league_sync_logs (
  id                   bigserial primary key,
  league_id            bigint        not null,
  league_name          text          not null,
  season               integer       not null,
  sync_started_at      timestamptz   not null default now(),
  sync_ended_at        timestamptz,
  matches_found        integer       not null default 0,
  matches_synced       integer       not null default 0,
  matches_failed       integer       not null default 0,
  error_summary        jsonb,
  created_at           timestamptz   not null default now()
);

create index if not exists idx_league_sync_logs_league_id_date
  on public.league_sync_logs(league_id, created_at desc);

-- 3) Auto-update updated_at for league_sync_config
drop trigger if exists trg_league_sync_config_updated_at on public.league_sync_config;
create trigger trg_league_sync_config_updated_at
before update on public.league_sync_config
for each row execute function public.tg_set_updated_at();

-- 4) RLS for league_sync_config and league_sync_logs
alter table public.league_sync_config enable row level security;
alter table public.league_sync_logs enable row level security;

create policy "league_sync_config_read_all"
on public.league_sync_config for select
to authenticated using (true);

create policy "league_sync_logs_read_all"
on public.league_sync_logs for select
to authenticated using (true);

-- 5) Seed example league configs
insert into public.league_sync_config (league_id, league_name, season, scheduled_time, sync_interval_hours, enabled)
values
  (52875307, 'IPL', 2026, '06:00:00', 24, true)
on conflict (league_id, season) do nothing;

-- alter table to add start_date_time to cricket_matches for better scheduling and prediction timing logic
alter table public.cricket_matches
add column if not exists start_date_time timestamptz;

-- ============================================================
-- FEATURE: Crowd pick counts for social-proof tooltip
-- Exposes aggregated pick counts per team per match.
-- SECURITY DEFINER bypasses user_predictions RLS (which only
-- lets users read their OWN rows) but only returns COUNT
-- aggregates — no user_id or personal data is ever exposed.
-- Run this block once in the Supabase SQL editor.
-- ============================================================

create or replace function public.get_match_pick_counts(p_match_ids bigint[])
returns table(match_id bigint, picked_team_id bigint, pick_count bigint)
language sql
security definer
set search_path = public
stable
as $$
  select
    up.match_id,
    up.picked_team_id,
    count(*)::bigint as pick_count
  from public.user_predictions up
  where up.match_id = any(p_match_ids)
    and up.result != 'void'::public.prediction_result
  group by up.match_id, up.picked_team_id;
$$;

grant execute on function public.get_match_pick_counts(bigint[]) to authenticated;