# Scheduled Live Score Sync (Function-Based)

This document explains the updated cron design for live score and prediction updates.

## Why this version is more reliable

You moved from running the full HTTP logic directly in `cron.schedule(...)` to calling a dedicated SQL function (`public.trigger_match_syncs()`).

This helps because:
- The cron payload stays simple (`SELECT public.trigger_match_syncs();`).
- Function-level logging (`RAISE LOG`) makes each run visible in `cron.job_run_details`.
- A second cleanup scheduler keeps `net._http_response` small, which can prevent silent failures over time.

## 1) Create or update the sync function

What this does:
- Finds only due matches (`start_date_time <= now()`).
- Restricts to recent matches (last 12 hours).
- Skips terminal matches (`NOT public.is_match_terminal(...)`).
- Calls the `sync-match` Edge Function once per eligible match.
- Logs how many requests were dispatched.

```sql
CREATE OR REPLACE FUNCTION public.trigger_match_syncs()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  match_row RECORD;
  request_count INT := 0;
BEGIN
  FOR match_row IN
    SELECT id
    FROM public.cricket_matches
    WHERE start_date_time <= now()
      AND start_date_time >= now() - interval '12 hours'
      AND NOT public.is_match_terminal(coalesce(status, ''))
  LOOP
    PERFORM net.http_post(
      url     := 'https://evgwdwsintxaiafscvwt.supabase.co/functions/v1/sync-match',
      headers := jsonb_build_object(
                   'Authorization', 'Bearer <token>',
                   'Content-Type',  'application/json'
                 ),
      body    := jsonb_build_object('matchId', match_row.id)
    );

    request_count := request_count + 1;
  END LOOP;

  RAISE LOG 'trigger_match_syncs: dispatched % requests at %', request_count, now();
END;
$$;
```

## 2) Replace old scheduler (if already created)

What this does:
- Removes the old `sync-active-matches` job so you do not end up with duplicate schedulers.

```sql
SELECT cron.unschedule('sync-active-matches');
```

## 3) Schedule the sync job

What this does:
- Runs the function on a regular interval.
- Current setup runs every 30 seconds.

```sql
SELECT cron.schedule(
  'sync-active-matches',
  '30 seconds',
  $$ SELECT public.trigger_match_syncs(); $$
);
```

Optional minute-based schedule (if you prefer standard cron syntax):

```sql
-- SELECT cron.schedule(
--   'sync-active-matches',
--   '* * * * *',
--   $$ SELECT public.trigger_match_syncs(); $$
-- );
```

## 4) Schedule cleanup for pg_net responses

What this does:
- Every 10 minutes, deletes stale rows from `net._http_response` older than 30 minutes.
- Reduces response-table buildup that may contribute to jobs terminating unexpectedly.

```sql
SELECT cron.schedule(
  'purge-net-responses',
  '*/10 * * * *',
  $$ DELETE FROM net._http_response WHERE created < now() - interval '30 minutes'; $$
);
```

## 5) Check recent cron runs

What this does:
- Shows execution history for `sync-active-matches`.
- Includes `return_message` where function logs appear.

```sql
SELECT
  start_time,
  end_time,
  status,
  return_message
FROM cron.job_run_details
WHERE jobid = (
  SELECT jobid
  FROM cron.job
  WHERE jobname = 'sync-active-matches'
)
ORDER BY start_time DESC
LIMIT 10;
```

## 6) Useful checks and notes

```sql
-- List active cron jobs
SELECT jobid, jobname, schedule, active
FROM cron.job
ORDER BY jobid;
```

```sql
-- Quick view of eligible matches for sync
SELECT id, status, start_date_time
FROM public.cricket_matches
WHERE start_date_time <= now()
  AND start_date_time >= now() - interval '12 hours'
  AND NOT public.is_match_terminal(coalesce(status, ''));
```

Operational notes:
- Replace `<token>` with the correct key for your deployment model.
- Keep both schedulers enabled: one for sync, one for cleanup.
- If runs stop unexpectedly, first inspect `cron.job_run_details`, then verify `purge-net-responses` is executing on schedule.