alter table public.cricket_matches enable row level security;

drop policy if exists "authenticated can read cricket_matches" on public.cricket_matches;

create policy "authenticated can read cricket_matches"
on public.cricket_matches
for select
to authenticated
using (true);

alter publication supabase_realtime add table public.cricket_matches;
