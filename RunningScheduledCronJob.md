# Running a Scheduled Cron Job for Live Match Sync

This cron setup is used to invoke the `sync-match` Edge Function at regular intervals so live scores and predictions stay updated.

How it works:
- The cron runs every minute.
- On each run, it finds matches that have already started (`start_date_time <= now()`).
- It limits work to recent matches (last 12 hours).
- It skips terminal match states using `public.is_match_terminal(...)`.
- For each eligible match, it calls the Edge Function with the match ID.

## 1) Enable required extensions

This enables:
- `pg_cron` for scheduling recurring jobs.
- `pg_net` for making HTTP calls from SQL.

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
```

## 2) Schedule the job (runs every minute)

This registers a cron job named `sync-active-matches` with schedule `* * * * *` (every minute). The job sends an HTTP POST request to the `sync-match` Edge Function for each match that is due and non-terminal.

Replace `<YOUR_API_KEY>` with a valid key (for example, your Supabase service role key if appropriate for your security model).

```sql
select cron.schedule(
  'sync-active-matches',
  '* * * * *',
  $$
    select net.http_post(
      url     := 'https://evgwdwsintxaiafscvwt.supabase.co/functions/v1/sync-match',
      headers := jsonb_build_object(
                   'Authorization', 'Bearer <YOUR_API_KEY>',
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
```

## 3) Verify the job is registered

Use this to confirm the cron job exists and is active.

```sql
select jobid, jobname, schedule, active
from cron.job;
```

## 4) Check recent execution history

Use this to review whether recent runs succeeded or failed.

```sql
select jobid, status, start_time, return_message
from cron.job_run_details
order by start_time desc
limit 10;
```

## 5) Preview which matches are eligible for sync

This helps validate that your filter picks only started, recent, non-terminal matches.

```sql
select id, status, start_date_time
from public.cricket_matches
where start_date_time <= now()
  and start_date_time >= now() - interval '12 hours'
  and not public.is_match_terminal(coalesce(status, ''));
```

## 6) Unschedule the job (if needed)

Use this when you need to stop the recurring job.

```sql
select cron.unschedule('sync-active-matches');
```