# Interview Prep Sheet

## 1. Project Overview

Predicta's Supabase backend is a cricket match intelligence service that does two core jobs:

1. Continuously ingest and update match data from an external cricket API into Postgres.
2. Provide an AI-assisted recommendation endpoint that combines deterministic cricket heuristics with LLM reasoning and web enrichment.

What problem it solves in interview terms:
1. Keeps sports match state current with scheduled synchronization.
2. Converts noisy live-match signals into a decision payload a frontend can consume.
3. Enforces user-level usage controls for costly AI recommendations.

Repository evidence:
- Sync purpose and flow: [README.md](README.md#L1), [README.md](README.md#L20)
- AI-help hybrid pipeline description: [README.md](README.md#L213)
- Single-use AI-help behavior: [README.md](README.md#L231), [functions/ai-help/handler.ts](functions/ai-help/handler.ts#L462)

## 2. High-Level Architecture

The architecture is an event-driven, function-centric backend on Supabase:

1. Data ingestion layer:
- Edge function receives a match id, fetches external data, maps payload, upserts Postgres.
- Evidence: [functions/sync-match/index.ts](functions/sync-match/index.ts#L12), [functions/lib/matchSyncUtils.ts](functions/lib/matchSyncUtils.ts#L98)

2. Scheduled orchestration layer:
- SQL cron triggers function invocations for due matches and uses cleanup jobs to control pg_net response table growth.
- Evidence: [RunningScheduledCronJob.md](RunningScheduledCronJob.md#L24), [RunningScheduledCronJob.md](RunningScheduledCronJob.md#L72), [RunningScheduledCronJob.md](RunningScheduledCronJob.md#L97)

3. AI recommendation layer:
- Handler authenticates user, claims one-time usage, loads snapshot, runs deterministic scoring, enriches with web snippets, runs 3-step LLM chain, fuses final decision.
- Evidence: [functions/ai-help/handler.ts](functions/ai-help/handler.ts#L355), [functions/ai-help/handler.ts](functions/ai-help/handler.ts#L455), [functions/ai-help/handler.ts](functions/ai-help/handler.ts#L529), [functions/ai-help/llmChain.ts](functions/ai-help/llmChain.ts#L327)

4. Database access model:
- User client for RLS-respecting calls and service-role client for privileged reads/writes.
- Evidence: [functions/ai-help/handler.ts](functions/ai-help/handler.ts#L362), [functions/ai-help/handler.ts](functions/ai-help/handler.ts#L365), [functions/sync-match/index.ts](functions/sync-match/index.ts#L19)

## 3. Data Flow Diagram

~~~mermaid
flowchart TD
  A[Client App] -->|POST matchId/mode + Bearer| B[ai-help Edge Function]
  B --> C[Auth User Client]
  C --> D[claim_ai_help RPC]
  B --> E[Service Client]
  E --> F[Load match snapshot from cricket_matches]
  B --> G[Deterministic scorer]
  B --> H[Brave enrichment]
  B --> I[LLM Chain: Analyst -> Composer -> Arbiter]
  G --> J[Decision Fusion]
  H --> I
  I --> J
  J --> K[Final payload with debug fields]
  K --> A

  L[pg_cron trigger_match_syncs] --> M[sync-match Edge Function]
  M --> N[Highlightly API]
  N --> M
  M --> O[buildMatchPayload + upsert cricket_matches]
  O --> F
~~~

Evidence:
- AI request handling and fusion: [functions/ai-help/handler.ts](functions/ai-help/handler.ts#L415), [functions/ai-help/handler.ts](functions/ai-help/handler.ts#L529)
- LLM chain stages: [functions/ai-help/llmChain.ts](functions/ai-help/llmChain.ts#L327)
- Sync path and upsert: [functions/sync-match/index.ts](functions/sync-match/index.ts#L12), [functions/lib/matchSyncUtils.ts](functions/lib/matchSyncUtils.ts#L98)
- Scheduled trigger design: [RunningScheduledCronJob.md](RunningScheduledCronJob.md#L24), [RunningScheduledCronJob.md](RunningScheduledCronJob.md#L72)

## 4. Tech Stack Used

Runtime and language:
1. Deno + TypeScript for Edge Functions.
- Evidence: [README.md](README.md#L8), [functions/sync-match/index.ts](functions/sync-match/index.ts#L12)

Backend platform:
1. Supabase Edge Functions, Auth, Realtime, Postgres.
- Evidence: [config.toml](config.toml#L77), [config.toml](config.toml#L146), [migrations/20260325000000_enable_cricket_matches_realtime.sql](migrations/20260325000000_enable_cricket_matches_realtime.sql#L11)

Database and SQL:
1. PostgreSQL 17 (local config), RLS policies, RPC function claim_ai_help.
- Evidence: [config.toml](config.toml#L36), [migrations/20260328010000_add_ai_help_usage_and_cache.sql](migrations/20260328010000_add_ai_help_usage_and_cache.sql#L61)

API style and integration:
1. HTTP JSON endpoints via Deno.serve.
2. External integrations: Highlightly API, Brave, OpenAI chat completions.
- Evidence: [functions/sync-match/index.ts](functions/sync-match/index.ts#L12), [functions/lib/matchSyncUtils.ts](functions/lib/matchSyncUtils.ts#L125), [functions/ai-help/llmChain.ts](functions/ai-help/llmChain.ts#L80), [README.md](README.md#L137)

Scheduling:
1. pg_cron + pg_net based invocation and cleanup.
- Evidence: [RunningScheduledCronJob.md](RunningScheduledCronJob.md#L72), [RunningScheduledCronJob.md](RunningScheduledCronJob.md#L97)

Testing:
1. Deno tests for scoring behavior and handler fallbacks.
- Evidence: [functions/ai-help/_tests/scoring.test.ts](functions/ai-help/_tests/scoring.test.ts#L46), [functions/ai-help/_tests/handler.test.ts](functions/ai-help/_tests/handler.test.ts#L90)

Reliability controls:
1. Rate limiting for external API sync calls.
2. LLM call/token caps and deterministic fallback switch.
- Evidence: [functions/lib/matchSyncUtils.ts](functions/lib/matchSyncUtils.ts#L4), [functions/ai-help/llmChain.ts](functions/ai-help/llmChain.ts#L17), [functions/ai-help/llmChain.ts](functions/ai-help/llmChain.ts#L295)

## 5. Core Concepts and Patterns

| Concept | Where Used | Why Chosen | Alternatives Considered | Tradeoffs |
|---|---|---|---|---|
| Edge-function microservice split | [functions/sync-match/index.ts](functions/sync-match/index.ts#L12), [functions/sync-league-matches/index.ts](functions/sync-league-matches/index.ts#L126), [functions/ai-help/handler.ts](functions/ai-help/handler.ts#L355) | Clear ownership by job type and easier independent deploy/debug | Single monolithic function; queue worker service outside Supabase | More endpoints/config surfaces to manage |
| Upsert-based idempotent ingestion | [functions/lib/matchSyncUtils.ts](functions/lib/matchSyncUtils.ts#L98) | Safe re-syncs for same match id without duplicate rows | Insert-only event table + materialized view; explicit merge transaction | Simpler but loses full change history unless separately logged |
| Hybrid deterministic + LLM decisioning | [functions/ai-help/handler.ts](functions/ai-help/handler.ts#L529), [functions/ai-help/scoring.ts](functions/ai-help/scoring.ts#L81), [functions/ai-help/llmChain.ts](functions/ai-help/llmChain.ts#L327) | Deterministic baseline gives stability; LLM adds context and adaptability | Pure deterministic model; pure LLM inference | Hybrid complexity and tuning overhead for weights/thresholds |
| Decision fusion with policy knobs | [functions/ai-help/handler.ts](functions/ai-help/handler.ts#L169), [functions/ai-help/handler.ts](functions/ai-help/handler.ts#L207) | Controlled rollout via env vars without code change | Hard-coded confidence blending; learned meta-model | Manual tuning can drift without evaluation loop |
| One-request-per-user-per-match gate | [migrations/20260328010000_add_ai_help_usage_and_cache.sql](migrations/20260328010000_add_ai_help_usage_and_cache.sql#L1), [functions/ai-help/handler.ts](functions/ai-help/handler.ts#L298) | Controls spend and abuse while preserving user fairness | Global rate limit only; paid quota system | May feel restrictive unless product has reset/admin controls |
| Security-definer RPC for claim semantics | [migrations/20260328010000_add_ai_help_usage_and_cache.sql](migrations/20260328010000_add_ai_help_usage_and_cache.sql#L61) | Atomic claim operation and less client-side race handling | Direct insert from client with retries; app-layer lock table | Requires careful privilege and policy review |
| Phase-aware cricket heuristics | [functions/ai-help/scoring.ts](functions/ai-help/scoring.ts#L104), [functions/ai-help/scoring.ts](functions/ai-help/scoring.ts#L333) | Domain-intelligent scoring understandable in interviews | Generic logistic regression on snapshots; black-box model | Heuristic calibration maintenance burden |
| Scheduled SQL trigger pattern | [RunningScheduledCronJob.md](RunningScheduledCronJob.md#L24), [RunningScheduledCronJob.md](RunningScheduledCronJob.md#L72) | Database-native scheduling near data and simple operations | External scheduler (GitHub Actions/Cloud Scheduler); background worker | SQL scheduler observability can be less rich than dedicated job platform |

## 6. Security, Reliability, and Scalability Notes

Security:
1. RLS enabled for cricket_matches plus authenticated read policy.
- Evidence: [migrations/20260325000000_enable_cricket_matches_realtime.sql](migrations/20260325000000_enable_cricket_matches_realtime.sql#L1), [migrations/20260325000000_enable_cricket_matches_realtime.sql](migrations/20260325000000_enable_cricket_matches_realtime.sql#L5)
2. Usage table has RLS plus ownership policies and authenticated RPC grant.
- Evidence: [migrations/20260328010000_add_ai_help_usage_and_cache.sql](migrations/20260328010000_add_ai_help_usage_and_cache.sql#L29), [migrations/20260328010000_add_ai_help_usage_and_cache.sql](migrations/20260328010000_add_ai_help_usage_and_cache.sql#L103)
3. Handler enforces bearer auth and input validation.
- Evidence: [functions/ai-help/handler.ts](functions/ai-help/handler.ts#L423), [functions/ai-help/handler.ts](functions/ai-help/handler.ts#L433)

Reliability:
1. Graceful fallback on Brave/LLM failures is tested.
- Evidence: [functions/ai-help/_tests/handler.test.ts](functions/ai-help/_tests/handler.test.ts#L112), [functions/ai-help/_tests/handler.test.ts](functions/ai-help/_tests/handler.test.ts#L126)
2. Token and call caps reduce runaway LLM costs.
- Evidence: [functions/ai-help/llmChain.ts](functions/ai-help/llmChain.ts#L17), [functions/ai-help/llmChain.ts](functions/ai-help/llmChain.ts#L20)
3. Cron response cleanup addresses long-running scheduler fragility.
- Evidence: [RunningScheduledCronJob.md](RunningScheduledCronJob.md#L97), [RunningScheduledCronJob.md](RunningScheduledCronJob.md#L146)

Scalability:
1. Pagination-based league sync and rate limiter support larger pull jobs.
- Evidence: [functions/sync-league-matches/index.ts](functions/sync-league-matches/index.ts#L77), [functions/lib/matchSyncUtils.ts](functions/lib/matchSyncUtils.ts#L4)
2. Current in-memory AI request throttling is per-function-instance and not globally distributed.
- Evidence: [functions/ai-help/handler.ts](functions/ai-help/handler.ts#L24), [functions/ai-help/handler.ts](functions/ai-help/handler.ts#L105)

## 7. Market-Current Trends and Interview Focus Areas

As of April 2026

Clearly labeled external trend guidance (Context7 + official docs streams):

1. Supabase:
- Trend: teams increasingly use pg_cron + pg_net for internal event orchestration and scheduled edge invocations.
- Interview focus: when to keep orchestration inside Postgres vs moving to external workflow engines, and how to secure secrets for scheduled invocations.
- Mapped project evidence: [RunningScheduledCronJob.md](RunningScheduledCronJob.md#L72), [RunningScheduledCronJob.md](RunningScheduledCronJob.md#L24)

2. OpenAI API:
- Trend: migration from loose JSON mode toward strict structured outputs with schema validation for production reliability.
- Interview focus: output correctness contracts, fallback behavior, and token budget governance.
- Mapped project evidence: [functions/ai-help/llmChain.ts](functions/ai-help/llmChain.ts#L69), [functions/ai-help/llmChain.ts](functions/ai-help/llmChain.ts#L17)

3. PostgreSQL 17:
- Trend: stronger emphasis on RLS correctness and performance-aware policy design in multi-tenant systems.
- Interview focus: policy composition, SECURITY DEFINER boundaries, and index strategy on high-churn tables.
- Mapped project evidence: [migrations/20260328010000_add_ai_help_usage_and_cache.sql](migrations/20260328010000_add_ai_help_usage_and_cache.sql#L61), [migrations/20260328010000_add_ai_help_usage_and_cache.sql](migrations/20260328010000_add_ai_help_usage_and_cache.sql#L10)

4. Deno serverless runtimes:
- Trend: permission-conscious testing and lean runtime surfaces for edge deployments.
- Interview focus: deterministic tests, dependency management, and runtime security posture.
- Mapped project evidence: [functions/ai-help/_tests/scoring.test.ts](functions/ai-help/_tests/scoring.test.ts#L46), [functions/ai-help/deno.json](functions/ai-help/deno.json#L3)

5. AI decision systems:
- Trend: interviewers look for hybrid architectures that blend rules/heuristics with LLMs and explicit confidence governance.
- Interview focus: explainability, override thresholds, offline evaluation loops, and rollback controls.
- Mapped project evidence: [functions/ai-help/handler.ts](functions/ai-help/handler.ts#L169), [functions/ai-help/handler.ts](functions/ai-help/handler.ts#L207), [functions/ai-help/_tests/handler.test.ts](functions/ai-help/_tests/handler.test.ts#L205)

## 8. Improvement Roadmap

| Improvement | Priority (P0/P1/P2) | Impact | Effort | Why It Matters in Interviews |
|---|---|---|---|---|
| Replace instance-local AI rate limiting with distributed limiter in Postgres/Redis | P0 | Prevents bypass under horizontal scale | Medium | Shows production-readiness thinking about distributed systems |
| Move from json_object to strict schema-enforced structured outputs | P0 | Reduces malformed LLM payload risk | Medium | Demonstrates API contract rigor in AI systems |
| Add explicit observability: latency, error-rate, token/cost, and sync throughput metrics | P0 | Faster incident response and capacity planning | Medium | Interviewers value measurable reliability practices |
| Introduce dead-letter/retry strategy for failed sync jobs | P1 | Better resilience during upstream API incidents | Medium | Strong system design signal for failure handling |
| Add immutable prediction-decision audit table for explainability | P1 | Easier post-match analysis and model governance | Medium | Helps explain responsible AI and debugging workflow |
| Revisit cache strategy intentionally (removed cache in migration) with TTL and hit-rate telemetry | P1 | Balances latency/cost under traffic spikes | Medium | Good tradeoff discussion on consistency vs cost |
| Add contract tests for external API shape changes (Highlightly, Brave, OpenAI) | P1 | Early detection of breaking vendor changes | Low | Shows defensive integration engineering |
| Add load tests for sync-league and ai-help endpoints | P2 | Capacity confidence and autoscaling inputs | Medium | Converts architecture discussion into evidence-backed numbers |

Evidence for cache removal baseline:
- [migrations/20260328010000_add_ai_help_usage_and_cache.sql](migrations/20260328010000_add_ai_help_usage_and_cache.sql#L13)
- [migrations/20260329000000_drop_ai_help_cache.sql](migrations/20260329000000_drop_ai_help_cache.sql#L10)

## 9. Likely Interview Questions and Strong Answer Angles

Project-specific questions:
1. Why did you choose a hybrid deterministic + LLM pipeline instead of pure LLM?
- Strong angle: deterministic path provides stable baseline and explainable factors, while LLM adds context and narrative; fusion thresholds and override confidence keep control.
- Evidence: [functions/ai-help/scoring.ts](functions/ai-help/scoring.ts#L333), [functions/ai-help/handler.ts](functions/ai-help/handler.ts#L207)

2. How do you control AI cost and degraded behavior?
- Strong angle: cap calls/tokens, deterministic kill switch, and fallback drafts when LLM unavailable.
- Evidence: [functions/ai-help/llmChain.ts](functions/ai-help/llmChain.ts#L17), [functions/ai-help/llmChain.ts](functions/ai-help/llmChain.ts#L295)

3. How is one-request-per-match enforced safely?
- Strong angle: unique constraint plus RPC claim semantics with SECURITY DEFINER and ownership policies.
- Evidence: [migrations/20260328010000_add_ai_help_usage_and_cache.sql](migrations/20260328010000_add_ai_help_usage_and_cache.sql#L7), [migrations/20260328010000_add_ai_help_usage_and_cache.sql](migrations/20260328010000_add_ai_help_usage_and_cache.sql#L61)

4. Why use SQL scheduling for sync?
- Strong angle: close-to-data orchestration, simple trigger payload, and operational logging through cron run details.
- Evidence: [RunningScheduledCronJob.md](RunningScheduledCronJob.md#L10), [RunningScheduledCronJob.md](RunningScheduledCronJob.md#L115)

System-design-style questions:
1. Design this for 10x traffic and multiple sports.
- Strong angle: separate ingestion and recommendation compute planes, queue-based fanout, partitioned match tables, distributed rate limits, and per-sport strategy plugins.

2. How would you ensure recommendation quality over time?
- Strong angle: offline replay dataset, calibration metrics by phase, drift detection on feature distributions, canary configs for fusion thresholds.

3. How would you prevent data corruption from upstream schema changes?
- Strong angle: schema validation gateways, contract tests, tolerant parsing, and quarantined raw payload lanes.

4. What would you present to non-technical stakeholders?
- Strong angle: confidence distribution, invalidation triggers, recommendation reversals, and incident summaries tied to match outcomes.

Behavioral walkthrough prompts:
1. Tell me about a risky architecture decision in this project.
- Angle: choosing hybrid decisioning and how you de-risked with fallback paths and tests.
2. Tell me about a production issue you anticipated.
- Angle: cron table growth and the cleanup scheduler mitigation.
- Evidence: [RunningScheduledCronJob.md](RunningScheduledCronJob.md#L97)

## 10. 30-60-90 Minute Revision Plan

30 minutes:
1. Memorize the end-to-end story using sections 1 to 3.
2. Practice explaining why hybrid scoring exists and where fallbacks happen.
3. Rehearse one clear answer on security model (RLS + service-role boundaries).

60 minutes:
1. Deep dive section 5 tradeoffs and be able to defend two alternatives for each major pattern.
2. Practice 6 project-specific questions from section 9 out loud.
3. Prepare one whiteboard walkthrough of the Mermaid flow from client request to fused decision.

90 minutes:
1. Add system-design extensions: queueing, observability, and failure-recovery architecture.
2. Prepare metrics you would monitor from day one and why.
3. Practice concise STAR narratives: architecture choice, reliability incident prevention, and cross-functional communication with product stakeholders.
