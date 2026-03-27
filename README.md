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

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided in Supabase Functions runtime.

### 4) Deploy function

```bash
supabase functions deploy sync-match
```

(Optionally deploy hello-world too)

```bash
supabase functions deploy hello-world
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
