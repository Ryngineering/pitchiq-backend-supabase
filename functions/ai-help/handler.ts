import { createClient } from "@supabase/supabase-js";
import {
  AiMode,
  DeterministicResult,
  FinalAiHelpPayload,
  MatchSnapshot,
  RateLimitDecision,
  TeamLite,
} from "./types.ts";
import {
  HttpError,
  jsonResponse,
  parseJsonBody,
  requireBearerToken,
  validateInput,
} from "./validators.ts";
import { braveSearchEnrichment } from "./braveClient.ts";
import { loadMatchSnapshot } from "./matchSnapshot.ts";
import { runLlmWorkflow } from "./llmChain.ts";
import { runDeterministicScoring } from "./scoring.ts";

const RATE_WINDOW_MS = 60_000;
const inMemoryRate = new Map<string, number[]>();

function parseAllowedOrigins(): string[] {
  const raw = Deno.env.get("AI_HELP_ALLOWED_ORIGINS") ?? "*";
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildCorsHeaders(req: Request): HeadersInit {
  const requestOrigin = req.headers.get("origin") ?? "";
  const allowedOrigins = parseAllowedOrigins();
  const allowAll = allowedOrigins.includes("*");
  const allowOrigin = allowAll
    ? "*"
    : allowedOrigins.includes(requestOrigin)
      ? requestOrigin
      : (allowedOrigins[0] ?? "*");

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-request-id",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export interface HandlerDeps {
  makeUserClient: (token: string) => any;
  makeServiceClient: () => any;
  getUser: (userClient: any) => Promise<{
    user: { id: string } | null;
    error: { message: string } | null;
  }>;
  loadSnapshot: (serviceClient: any, matchId: number) => Promise<MatchSnapshot>;
  claim: (
    userClient: any,
    matchId: number,
    requestId: string,
  ) => Promise<boolean>;
  deterministic: (snapshot: MatchSnapshot, mode: AiMode) => DeterministicResult;
  brave: (
    snapshot: MatchSnapshot,
    mode: AiMode,
    options?: { requestId?: string },
  ) => Promise<Array<{ title: string; url: string; snippet: string }>>;
  llm: (args: {
    requestId?: string;
    mode: AiMode;
    snapshot: MatchSnapshot;
    deterministicSummary: {
      deterministicScore: number;
      confidence: number;
      factorBreakdown: Array<{
        factor: string;
        weight: number;
        impact: number;
      }>;
      riskFlags: string[];
      invalidationConditions: string[];
    };
    webSnippets: Array<{ title: string; url: string; snippet: string }>;
    recommendedTeam: TeamLite;
  }) => Promise<{
    headline: string;
    insights: string[];
    riskWarning: string;
    invalidationConditions: string[];
    llmRecommendedTeamId?: number | null;
    llmConfidence?: number | null;
    decisionRationale?: string;
    llmCallsUsed: number;
    tokenEstimateIn: number;
    tokenEstimateOut: number;
  }>;
  now: () => number;
  randomId: () => string;
}

function trackRate(userId: string, maxPerWindow: number): RateLimitDecision {
  const now = Date.now();
  const existing = inMemoryRate.get(userId) ?? [];
  const recent = existing.filter((ts) => now - ts <= RATE_WINDOW_MS);

  if (recent.length >= maxPerWindow) {
    const oldest = recent[0];
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((RATE_WINDOW_MS - (now - oldest)) / 1000),
    );
    inMemoryRate.set(userId, recent);
    return { allowed: false, retryAfterSeconds };
  }

  recent.push(now);
  inMemoryRate.set(userId, recent);
  return { allowed: true };
}

function resolveRecommendedTeam(
  snapshot: MatchSnapshot,
  teamId: number,
): TeamLite {
  return teamId === snapshot.homeTeam.id
    ? snapshot.homeTeam
    : snapshot.awayTeam;
}

function sanitizeInsights(insights: string[]): string[] {
  return insights
    .filter((item) => typeof item === "string" && item.trim().length > 0)
    .slice(0, 5);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function parseEnvNumber(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = Deno.env.get(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return clamp(parsed, min, max);
}

interface FusionConfig {
  agreeLlmWeight: number;
  disagreeLlmWeight: number;
  overrideLlmWeight: number;
  deterministicWeakMaxConfidence: number;
  deterministicWeakMaxEdge: number;
  llmOverrideMinConfidence: number;
}

function getFusionConfig(): FusionConfig {
  return {
    agreeLlmWeight: parseEnvNumber(
      "AI_HELP_HYBRID_AGREE_LLM_WEIGHT",
      0.3,
      0,
      1,
    ),
    disagreeLlmWeight: parseEnvNumber(
      "AI_HELP_HYBRID_DISAGREE_LLM_WEIGHT",
      0.2,
      0,
      1,
    ),
    overrideLlmWeight: parseEnvNumber(
      "AI_HELP_HYBRID_OVERRIDE_LLM_WEIGHT",
      0.45,
      0,
      1,
    ),
    deterministicWeakMaxConfidence: parseEnvNumber(
      "AI_HELP_DETERMINISTIC_WEAK_MAX_CONFIDENCE",
      60,
      35,
      96,
    ),
    deterministicWeakMaxEdge: parseEnvNumber(
      "AI_HELP_DETERMINISTIC_WEAK_MAX_EDGE",
      8,
      0,
      50,
    ),
    llmOverrideMinConfidence: parseEnvNumber(
      "AI_HELP_LLM_OVERRIDE_MIN_CONFIDENCE",
      72,
      35,
      96,
    ),
  };
}

function resolveFinalDecision(input: {
  snapshot: MatchSnapshot;
  deterministic: DeterministicResult;
  llm: {
    llmRecommendedTeamId?: number | null;
    llmConfidence?: number | null;
  };
}): {
  recommendedTeamId: number;
  confidence: number;
  decisionSource: "deterministic" | "hybrid" | "llm";
} {
  const cfg = getFusionConfig();
  const deterministicTeamId = input.deterministic.recommendedTeamId;
  const deterministicConfidence = input.deterministic.confidence;

  const llmTeamId = input.llm.llmRecommendedTeamId;
  const llmConfidenceRaw = input.llm.llmConfidence;

  const llmConfidence =
    typeof llmConfidenceRaw === "number" && Number.isFinite(llmConfidenceRaw)
      ? clamp(Math.round(llmConfidenceRaw), 35, 96)
      : null;

  const llmTeamValid =
    llmTeamId === input.snapshot.homeTeam.id ||
    llmTeamId === input.snapshot.awayTeam.id
      ? llmTeamId
      : null;

  if (!llmTeamValid || llmConfidence == null) {
    return {
      recommendedTeamId: deterministicTeamId,
      confidence: deterministicConfidence,
      decisionSource: "deterministic",
    };
  }

  const sameTeam = llmTeamValid === deterministicTeamId;
  const deterministicEdge = Math.abs(
    input.deterministic.deterministicScore - 50,
  );

  if (sameTeam) {
    return {
      recommendedTeamId: deterministicTeamId,
      confidence: Math.round(
        deterministicConfidence * (1 - cfg.agreeLlmWeight) +
          llmConfidence * cfg.agreeLlmWeight,
      ),
      decisionSource: "hybrid",
    };
  }

  const deterministicWeak =
    deterministicConfidence <= cfg.deterministicWeakMaxConfidence ||
    deterministicEdge <= cfg.deterministicWeakMaxEdge;
  const llmStrong = llmConfidence >= cfg.llmOverrideMinConfidence;

  if (deterministicWeak && llmStrong) {
    return {
      recommendedTeamId: llmTeamValid,
      confidence: Math.round(
        deterministicConfidence * (1 - cfg.overrideLlmWeight) +
          llmConfidence * cfg.overrideLlmWeight,
      ),
      decisionSource: "llm",
    };
  }

  return {
    recommendedTeamId: deterministicTeamId,
    confidence: Math.round(
      deterministicConfidence * (1 - cfg.disagreeLlmWeight) +
        llmConfidence * cfg.disagreeLlmWeight,
    ),
    decisionSource: "deterministic",
  };
}

function getEnvOrThrow(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new HttpError(500, `Missing env var: ${name}`);
  return value;
}

async function claimUsage(
  userClient: any,
  matchId: number,
  requestId: string,
): Promise<boolean> {
  const { data, error } = await userClient.rpc("claim_ai_help", {
    p_match_id: matchId,
    p_request_id: requestId,
  });

  if (error) {
    throw new HttpError(500, `Failed to claim AI help: ${error.message}`);
  }

  return Boolean(data);
}

function buildFinalPayload(input: {
  mode: AiMode;
  recommendedTeam: TeamLite;
  confidence: number;
  deterministicScore: number;
  factorBreakdown: Array<{ factor: string; weight: number; impact: number }>;
  riskFlags: string[];
  invalidationConditions: string[];
  llm: {
    headline: string;
    insights: string[];
    riskWarning: string;
    invalidationConditions: string[];
    llmRecommendedTeamId?: number | null;
    llmConfidence?: number | null;
    llmCallsUsed: number;
  };
  decisionSource: "deterministic" | "hybrid" | "llm";
  sources: Array<{ title: string; url: string }>;
}): FinalAiHelpPayload {
  return {
    recommendedTeam: input.recommendedTeam,
    mode: input.mode,
    confidence: input.confidence,
    headline: input.llm.headline,
    insights: sanitizeInsights(input.llm.insights),
    riskWarning:
      input.llm.riskWarning ||
      input.riskFlags[0] ||
      "Momentum can shift quickly in T20.",
    invalidationConditions: input.llm.invalidationConditions.length
      ? input.llm.invalidationConditions
      : input.invalidationConditions,
    sources: input.sources.slice(0, 5),
    debug: {
      deterministicScore: input.deterministicScore,
      factorBreakdown: input.factorBreakdown,
      llmCallsUsed: input.llm.llmCallsUsed,
      llmRecommendedTeamId: input.llm.llmRecommendedTeamId ?? null,
      llmConfidence: input.llm.llmConfidence ?? null,
      finalDecisionSource: input.decisionSource,
    },
  };
}

export function createAiHelpHandler() {
  const url = getEnvOrThrow("SUPABASE_URL");
  const anonKey = getEnvOrThrow("SUPABASE_ANON_KEY");
  const serviceRole = getEnvOrThrow("SUPABASE_SERVICE_ROLE_KEY");

  const defaults: HandlerDeps = {
    makeUserClient: (token: string) =>
      createClient(url, anonKey, {
        global: { headers: { Authorization: `Bearer ${token}` } },
      }),
    makeServiceClient: () => createClient(url, serviceRole),
    getUser: async (userClient: any) => {
      const { data, error } = await userClient.auth.getUser();
      return {
        user: data?.user ?? null,
        error: error ? { message: error.message } : null,
      };
    },
    loadSnapshot: loadMatchSnapshot,
    claim: claimUsage,
    deterministic: runDeterministicScoring,
    brave: braveSearchEnrichment,
    llm: runLlmWorkflow,
    now: () => Date.now(),
    randomId: () => crypto.randomUUID(),
  };

  return createAiHelpHandlerWithDeps(defaults);
}

export function createAiHelpHandlerWithDeps(overrides: Partial<HandlerDeps>) {
  const deps: HandlerDeps = {
    ...{
      makeUserClient: (_token: string) => {
        throw new Error("makeUserClient not configured");
      },
      makeServiceClient: () => {
        throw new Error("makeServiceClient not configured");
      },
      getUser: async (_userClient: any) => ({
        user: null,
        error: { message: "not configured" },
      }),
      loadSnapshot: loadMatchSnapshot,
      claim: claimUsage,
      deterministic: runDeterministicScoring,
      brave: braveSearchEnrichment,
      llm: runLlmWorkflow,
      now: () => Date.now(),
      randomId: () => crypto.randomUUID(),
    },
    ...overrides,
  };

  return async (req: Request): Promise<Response> => {
    const corsHeaders = buildCorsHeaders(req);
    const requestId = req.headers.get("x-request-id") ?? deps.randomId();
    const startedAt = deps.now();

    try {
      if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
      }

      if (req.method !== "POST") {
        throw new HttpError(422, "Only POST is supported.");
      }

      const token = requireBearerToken(req);
      const userClient = deps.makeUserClient(token);
      const serviceClient = deps.makeServiceClient();

      const userResult = await deps.getUser(userClient);
      if (userResult.error || !userResult.user) {
        throw new HttpError(401, "Unauthorized");
      }

      const body = await parseJsonBody(req);
      const { matchId, mode } = validateInput(body);

      const maxPerMinute = Number(
        Deno.env.get("AI_HELP_MAX_REQUESTS_PER_MINUTE") ?? "8",
      );
      const decision = trackRate(userResult.user.id, Math.max(1, maxPerMinute));
      if (!decision.allowed) {
        return jsonResponse(
          429,
          {
            error: "Too many requests. Please try again shortly.",
            request_id: requestId,
          },
          {
            ...corsHeaders,
            "Retry-After": String(decision.retryAfterSeconds ?? 1),
          },
        );
      }

      const snapshot = await deps.loadSnapshot(serviceClient, matchId);

      const claimed = await deps.claim(userClient, matchId, requestId);
      if (!claimed) {
        return jsonResponse(
          409,
          {
            error: "AI Help has already been used for this match.",
            request_id: requestId,
            friendlyMessage: "You have already used AI Help for this match.",
          },
          corsHeaders,
        );
      }

      const deterministic = deps.deterministic(snapshot, mode);
      const recommendedTeam = resolveRecommendedTeam(
        snapshot,
        deterministic.recommendedTeamId,
      );

      const braveSnippets = await deps
        .brave(snapshot, mode, {
          requestId,
        })
        .catch((error) => {
          console.warn("brave_enrichment_failed", {
            request_id: requestId,
            reason: error instanceof Error ? error.message : String(error),
          });
          return [];
        });

      const llmDraft = await deps
        .llm({
          requestId,
          mode,
          snapshot,
          deterministicSummary: {
            deterministicScore: deterministic.deterministicScore,
            confidence: deterministic.confidence,
            factorBreakdown: deterministic.factorBreakdown,
            riskFlags: deterministic.riskFlags,
            invalidationConditions: deterministic.invalidationConditions,
          },
          webSnippets: braveSnippets,
          recommendedTeam,
        })
        .catch((error) => {
          console.warn("llm_workflow_failed", {
            request_id: requestId,
            reason: error instanceof Error ? error.message : String(error),
          });

          return {
            headline: `${recommendedTeam.abbreviation} keeps the stronger projection`,
            insights: deterministic.factorBreakdown
              .slice(0, 4)
              .map(
                (factor) =>
                  `${factor.factor} impact: ${(factor.impact * 100).toFixed(0)}`,
              ),
            riskWarning:
              deterministic.riskFlags[0] ??
              "Volatility remains high in short-format cricket.",
            invalidationConditions: deterministic.invalidationConditions,
            llmRecommendedTeamId: deterministic.recommendedTeamId,
            llmConfidence: deterministic.confidence,
            decisionRationale:
              "LLM unavailable; deterministic recommendation retained.",
            llmCallsUsed: 0,
            tokenEstimateIn: 0,
            tokenEstimateOut: 0,
          };
        });

      const finalDecision = resolveFinalDecision({
        snapshot,
        deterministic,
        llm: {
          llmRecommendedTeamId: llmDraft.llmRecommendedTeamId,
          llmConfidence: llmDraft.llmConfidence,
        },
      });

      const finalTeam = resolveRecommendedTeam(
        snapshot,
        finalDecision.recommendedTeamId,
      );

      const finalPayload = buildFinalPayload({
        mode,
        recommendedTeam: finalTeam,
        confidence: finalDecision.confidence,
        deterministicScore: deterministic.deterministicScore,
        factorBreakdown: deterministic.factorBreakdown,
        riskFlags: deterministic.riskFlags,
        invalidationConditions: deterministic.invalidationConditions,
        llm: llmDraft,
        decisionSource: finalDecision.decisionSource,
        sources: braveSnippets.map((snippet) => ({
          title: snippet.title,
          url: snippet.url,
        })),
      });

      const elapsedMs = deps.now() - startedAt;
      console.log("ai_help_request", {
        request_id: requestId,
        match_id: matchId,
        mode,
        llm_calls_used: finalPayload.debug.llmCallsUsed,
        token_estimate_in: llmDraft.tokenEstimateIn,
        token_estimate_out: llmDraft.tokenEstimateOut,
        latency_ms: elapsedMs,
      });

      return jsonResponse(
        200,
        {
          payload: finalPayload,
          request_id: requestId,
        },
        corsHeaders,
      );
    } catch (error) {
      const elapsedMs = deps.now() - startedAt;
      const httpError = error instanceof HttpError ? error : null;
      const status = httpError?.status ?? 500;
      const message = httpError?.message ?? "Internal server error.";

      console.error("ai_help_error", {
        request_id: requestId,
        status,
        message,
        latency_ms: elapsedMs,
      });

      return jsonResponse(
        status,
        {
          error: message,
          request_id: requestId,
        },
        corsHeaders,
      );
    }
  };
}
