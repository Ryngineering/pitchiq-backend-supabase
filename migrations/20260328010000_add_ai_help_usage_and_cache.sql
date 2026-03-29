create table if not exists public.ai_help_usage (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  match_id bigint not null references public.cricket_matches(id) on delete cascade,
  used_at timestamptz not null default now(),
  request_id text unique,
  constraint uq_ai_help_usage_user_match unique (user_id, match_id)
);

create index if not exists idx_ai_help_usage_user_match
  on public.ai_help_usage(user_id, match_id);

create table if not exists public.ai_help_cache (
  cache_key text primary key,
  match_id bigint not null references public.cricket_matches(id) on delete cascade,
  over_bucket int not null,
  mode text not null check (mode in ('safe', 'value', 'contrarian')),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists idx_ai_help_cache_match_over_mode
  on public.ai_help_cache(match_id, over_bucket, mode);

create index if not exists idx_ai_help_cache_expires_at
  on public.ai_help_cache(expires_at);

alter table public.ai_help_usage enable row level security;
alter table public.ai_help_cache enable row level security;

drop policy if exists "ai_help_usage_select_own" on public.ai_help_usage;
create policy "ai_help_usage_select_own"
on public.ai_help_usage
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "ai_help_usage_insert_own" on public.ai_help_usage;
create policy "ai_help_usage_insert_own"
on public.ai_help_usage
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "ai_help_cache_read_authenticated" on public.ai_help_cache;
create policy "ai_help_cache_read_authenticated"
on public.ai_help_cache
for select
to authenticated
using (true);

drop policy if exists "ai_help_cache_service_all" on public.ai_help_cache;
create policy "ai_help_cache_service_all"
on public.ai_help_cache
for all
to service_role
using (true)
with check (true);

create or replace function public.claim_ai_help(
  p_match_id bigint,
  p_request_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid;
  v_claimed integer := 0;
begin
  v_uid := auth.uid();

  if v_uid is null then
    raise exception 'Unauthorized' using errcode = '42501';
  end if;

  insert into public.ai_help_usage(user_id, match_id, request_id)
  values (v_uid, p_match_id, nullif(trim(p_request_id), ''))
  on conflict (user_id, match_id) do nothing;

  get diagnostics v_claimed = row_count;
  if v_claimed > 0 then
    return true;
  end if;

  if p_request_id is not null and exists (
    select 1
    from public.ai_help_usage
    where request_id = p_request_id
      and user_id = v_uid
      and match_id = p_match_id
  ) then
    return true;
  end if;

  return false;
end;
$$;

grant execute on function public.claim_ai_help(bigint, text) to authenticated;
