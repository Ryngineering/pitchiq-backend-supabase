# Predicta Supabase Backend

This workspace contains Supabase configuration and Edge Functions for syncing cricket match data into a `cricket_matches` table.

## Overview

### Deno in this project
Supabase Edge Functions run on **Deno**, a secure TypeScript/JavaScript runtime.
In this repo, each function is implemented with `Deno.serve(...)`, which exposes an HTTP endpoint.

### What are Edge Functions?
Edge Functions are server-side functions that run close to users and can:
- handle HTTP requests
- call third-party APIs
- read/write your Supabase database securely

In this project, they live under `functions/`.

### What `sync-match` does
`functions/sync-match/index.ts`:
1. reads `matchId` from request JSON
2. fetches match data from Highlightly Cricket API
3. maps key fields into a `payload`
4. upserts into `public.cricket_matches` using `id` as conflict key
5. returns the upserted row(s)

---

## Prerequisites

- Docker Desktop running (for local Supabase stack)
- Supabase CLI installed
- A RapidAPI/Highlightly key

Check CLI:

```bash
supabase --version
```

---

## Local Development

### 1) Start Supabase locally
From this `supabase/` folder:

```bash
supabase start
```

This starts local API, Postgres, Studio, Auth, etc.

### 2) Create the table
Run the SQL in `functions/sync-match/DDL.sql` in one of these ways:

- Supabase Studio SQL Editor (`http://127.0.0.1:54323`)
- `supabase db reset` (if you later move SQL into migrations)

Current table schema:
- `id` primary key
- team names/scores/info
- pre-match/live prediction fields
- status/report/venue
- `raw` JSONB payload
- `last_updated` timestamp

### 3) Configure local function secrets
Create `functions/sync-match/.env`:

```env
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_SERVICE_ROLE_KEY=<your-local-service-role-key>
HIGHLIGHTLY_API_KEY=<your-rapidapi-key>
```

Get local keys with:

```bash
supabase status
```

### 4) Serve the function locally

```bash
supabase functions serve sync-match --env-file ./functions/sync-match/.env
```

### 5) Invoke locally

```bash
curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/sync-match' \
  --header 'Authorization: Bearer <local-anon-key>' \
  --header 'Content-Type: application/json' \
  --data '{"matchId":12345}'
```

You can also invoke `hello-world`:

```bash
curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/hello-world' \
  --header 'Authorization: Bearer <local-anon-key>' \
  --header 'Content-Type: application/json' \
  --data '{"name":"Functions"}'
```

---

## Deploy to Supabase Cloud

### 1) Login and link project

```bash
supabase login
supabase link --project-ref <your-project-ref>
```

### 2) Push database schema
Recommended: move `functions/sync-match/DDL.sql` into a migration, then run:

```bash
supabase db push
```

Alternative: run the SQL manually in Supabase Cloud SQL Editor.

### 3) Set required function secrets
Set at least your external API key (and any overrides you need):

```bash
supabase secrets set HIGHLIGHTLY_API_KEY=<your-rapidapi-key>
```

For `ai-help`, also set:

```bash
supabase secrets set BRAVE_API_KEY=<your-brave-api-key>
supabase secrets set OPENAI_API_KEY=<your-openai-api-key>
```

Optional `ai-help` model routing (defaults shown):

```bash
supabase secrets set AI_HELP_LLM_ANALYST_MODEL=gpt-4.1-mini
supabase secrets set AI_HELP_LLM_COMPOSER_MODEL=gpt-4o-mini
supabase secrets set AI_HELP_LLM_ARBITER_MODEL=gpt-4.1-mini
```

Optional `ai-help` decision fusion tuning:

```bash
supabase secrets set AI_HELP_HYBRID_AGREE_LLM_WEIGHT=0.3
supabase secrets set AI_HELP_HYBRID_DISAGREE_LLM_WEIGHT=0.2
supabase secrets set AI_HELP_HYBRID_OVERRIDE_LLM_WEIGHT=0.45
supabase secrets set AI_HELP_DETERMINISTIC_WEAK_MAX_CONFIDENCE=60
supabase secrets set AI_HELP_DETERMINISTIC_WEAK_MAX_EDGE=8
supabase secrets set AI_HELP_LLM_OVERRIDE_MIN_CONFIDENCE=72
```

To enable verbose debugging logs (Brave request/response payloads and LLM prompt/response payloads):

```bash
supabase secrets set AI_HELP_VERBOSE_LOGS=true
```

To disable verbose debugging logs:

```bash
supabase secrets set AI_HELP_VERBOSE_LOGS=false
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided in Supabase Functions runtime.

### 4) Deploy function

```bash
supabase functions deploy sync-match
```

(Optionally deploy hello-world too)

```bash
supabase functions deploy hello-world
```

Deploy `ai-help`:

```bash
supabase functions deploy ai-help
```

### 5) Invoke cloud function

```bash
curl -i --location --request POST 'https://<your-project-ref>.supabase.co/functions/v1/sync-match' \
  --header 'Authorization: Bearer <anon-or-user-jwt>' \
  --header 'Content-Type: application/json' \
  --data '{"matchId":12345}'
```

---

## Notes

- `sync-match` uses the service role key server-side to upsert into `cricket_matches`.
- Keep service role keys only in secure runtime secrets, never in frontend code.
- The function currently expects the Highlightly API response as an array and uses `data[0]`.

---

## AI Help Runtime Notes

`functions/ai-help` uses a hybrid decision pipeline:

1. Deterministic scoring computes recommendation, confidence, and factor breakdown.
2. Brave search snippets are collected as external context.
3. LLM workflow runs three stages:
  - deep analysis
  - final composition
  - decision arbiter
4. Final recommendation and confidence are fused from deterministic + LLM signals.

The final payload includes debug fields such as:
- `deterministicScore`
- `factorBreakdown`
- `llmCallsUsed`
- `llmRecommendedTeamId`
- `llmConfidence`
- `finalDecisionSource`

One-request-per-match is enforced via `ai_help_usage` + `claim_ai_help`.
To re-run AI Help for the same user/match, an admin must delete that usage row.

### Recommended Fusion Profiles

Use these as practical starting points for production. Keep model choices constant and tune only the fusion knobs first.

| Profile | Use Case | AI_HELP_HYBRID_AGREE_LLM_WEIGHT | AI_HELP_HYBRID_DISAGREE_LLM_WEIGHT | AI_HELP_HYBRID_OVERRIDE_LLM_WEIGHT | AI_HELP_DETERMINISTIC_WEAK_MAX_CONFIDENCE | AI_HELP_DETERMINISTIC_WEAK_MAX_EDGE | AI_HELP_LLM_OVERRIDE_MIN_CONFIDENCE |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Conservative | Prefer deterministic stability, only rare LLM overrides | 0.25 | 0.10 | 0.35 | 58 | 6 | 82 |
| Balanced (default-like) | Good general production baseline | 0.30 | 0.20 | 0.45 | 60 | 8 | 72 |
| Aggressive | Let LLM adapt more often in volatile live matches | 0.40 | 0.30 | 0.55 | 64 | 10 | 66 |

Operational guidance:
- Start with Balanced for 1-2 weeks and compare win-rate calibration vs your current baseline.
- Move toward Conservative if recommendations become noisy or flip too often.
- Move toward Aggressive if deterministic logic is lagging late-innings momentum shifts.
- Change one knob at a time, then monitor at least 100+ decisions before the next adjustment.

### Run tests for `ai-help`

From `functions/ai-help/`:

```bash
deno test _tests/scoring.test.ts --no-check
deno test _tests/handler.test.ts --no-check --allow-env
```
