-- Remove ai_help_cache table — caching has been removed from ai-help edge function.
-- The ai_help_usage table and claim_ai_help function remain for one-request-per-match enforcement.

drop policy if exists "ai_help_cache_read_authenticated" on public.ai_help_cache;
drop policy if exists "ai_help_cache_service_all" on public.ai_help_cache;

drop index if exists idx_ai_help_cache_match_over_mode;
drop index if exists idx_ai_help_cache_expires_at;

drop table if exists public.ai_help_cache;
