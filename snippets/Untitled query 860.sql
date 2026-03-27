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