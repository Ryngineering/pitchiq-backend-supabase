-- ============================================================
-- pg_cron job: sync active matches every minute
-- Run this once in the Supabase SQL Editor (NOT in DDL.sql).
-- Requires pg_cron and pg_net extensions to be enabled.
-- Replace <your-project-ref> and <your-anon-key> before running.
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'sync-active-matches',
  '* * * * *',
  $$
    select net.http_post(
      url     := 'https://vgwdwsintxaiafscvwt.supabase.co/functions/v1/sync-match',
      headers := jsonb_build_object(
                   'Authorization', 'Bearer <your-anon-key>',
                   'Content-Type',  'application/json'
                 ),
      body    := jsonb_build_object('matchId', id)
    )
    from public.cricket_matches
    where start_date_time <= now()
      and start_date_time >= now() - interval '12 hours'
      and not public.is_match_terminal(coalesce(status, ''));
  $$
);

-- ============================================================
-- Verification queries (run after the schedule above)
-- ============================================================

-- Check the job is registered
select jobid, jobname, schedule, active from cron.job;

-- Check recent run history
select jobid, status, start_time, return_message
from cron.job_run_details
order by start_time desc
limit 10;

-- ============================================================
-- To remove the job if needed:
-- select cron.unschedule('sync-active-matches');
-- ============================================================
