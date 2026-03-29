import {
  AiMode,
  BraveSnippet,
  LlmFinalDraft,
  MatchSnapshot,
  TeamLite,
} from "./types.ts";
import { estimateTokens } from "./validators.ts";

const MODEL = "gpt-4o-mini";
const ANALYST_MODEL =
  Deno.env.get("AI_HELP_LLM_ANALYST_MODEL") ?? "gpt-4.1-mini";
const COMPOSER_MODEL = Deno.env.get("AI_HELP_LLM_COMPOSER_MODEL") ?? MODEL;
const ARBITER_MODEL =
  Deno.env.get("AI_HELP_LLM_ARBITER_MODEL") ?? ANALYST_MODEL;
const VERBOSE_LOGS = Deno.env.get("AI_HELP_VERBOSE_LOGS") === "true";
const MAX_CALLS = 5;
const MAX_CALL_INPUT_TOKENS = 3000;
const MAX_CALL_OUTPUT_TOKENS = 600;
const TOTAL_INPUT_CAP = 7000;
const TOTAL_OUTPUT_CAP = 1200;

interface ChainState {
  callsUsed: number;
  inputTokens: number;
  outputTokens: number;
}

interface OpenAiResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

function parseJson(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

async function runCompletion(
  openAiApiKey: string,
  model: string,
  requestId: string,
  chainName: string,
  systemPrompt: string,
  userPayload: unknown,
  state: ChainState,
  maxOutputTokens: number,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  if (state.callsUsed >= MAX_CALLS) {
    throw new Error("LLM call cap reached");
  }

  const estimatedInput = estimateTokens({ systemPrompt, userPayload });
  if (estimatedInput > MAX_CALL_INPUT_TOKENS) {
    throw new Error(`oversized_input:${estimatedInput}`);
  }
  if (state.inputTokens + estimatedInput > TOTAL_INPUT_CAP) {
    throw new Error("total_input_cap_exceeded");
  }

  const body = {
    model,
    temperature: 0.2,
    max_tokens: maxOutputTokens,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: JSON.stringify(userPayload) },
    ],
  };

  if (VERBOSE_LOGS) {
    console.log("llm_chain_request_payload", {
      request_id: requestId,
      chain: chainName,
      model,
      max_tokens: maxOutputTokens,
      estimated_input_tokens: estimatedInput,
    });
  }

  const response = await fetchImpl(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openAiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`openai_error:${response.status}:${text.slice(0, 180)}`);
  }

  const payload = (await response.json()) as OpenAiResponse;
  const content = payload.choices?.[0]?.message?.content ?? "{}";
  const outputTokens = estimateTokens(content);

  if (VERBOSE_LOGS) {
    console.log("llm_chain_response_payload", {
      request_id: requestId,
      chain: chainName,
      status: response.status,
      raw_content: content,
      estimated_output_tokens: outputTokens,
    });
  }

  if (
    outputTokens > MAX_CALL_OUTPUT_TOKENS ||
    state.outputTokens + outputTokens > TOTAL_OUTPUT_CAP
  ) {
    throw new Error("output_token_cap_exceeded");
  }

  state.callsUsed += 1;
  state.inputTokens += estimatedInput;
  state.outputTokens += outputTokens;

  return parseJson(content);
}

function fallbackDraft(
  deterministicInsights: string[],
  recommendedTeam: TeamLite,
  mode: AiMode,
): LlmFinalDraft {
  return {
    headline: `${recommendedTeam.abbreviation} is the ${mode} edge based on current match signals`,
    insights: deterministicInsights.slice(0, 5),
    riskWarning:
      "Match momentum can reverse quickly due to wickets or one expensive over.",
    invalidationConditions: [
      "Two wickets in the next 12 balls",
      "Required rate jump of 2.0+ in one over",
    ],
    llmCallsUsed: 0,
    tokenEstimateIn: 0,
    tokenEstimateOut: 0,
  };
}

function buildMatchContext(snapshot: MatchSnapshot): Record<string, unknown> {
  const ctx: Record<string, unknown> = {
    homeTeam: snapshot.homeTeam,
    awayTeam: snapshot.awayTeam,
    venue: snapshot.venue,
    status: snapshot.status,
    format: snapshot.format,
    totalOvers: snapshot.totalOvers,
    homeScore: snapshot.homeScore,
    awayScore: snapshot.awayScore,
    homeOvers: snapshot.homeOvers,
    awayOvers: snapshot.awayOvers,
    currentOvers: snapshot.currentOvers,
    battingTeamId: snapshot.battingTeamId,
    bowlingTeamId: snapshot.bowlingTeamId,
    inningNumber: snapshot.inningNumber,
    target: snapshot.target,
    liveHomeProb: snapshot.liveHomeProb,
    liveAwayProb: snapshot.liveAwayProb,
    prematchHomeProb: snapshot.prematchHomeProb,
    prematchAwayProb: snapshot.prematchAwayProb,
    recentOverRuns: snapshot.recentOverRuns,
    batsmenAtCrease: snapshot.batsmenAtCrease,
    activeBowlers: snapshot.activeBowlers,
    venueBias: snapshot.venueBias,
    h2hBias: snapshot.h2hBias,
  };

  // Add human-readable innings situation for the LLM
  if (snapshot.inningNumber === 2 && snapshot.target != null) {
    const battingTeam =
      snapshot.battingTeamId === snapshot.homeTeam.id
        ? snapshot.homeTeam.abbreviation
        : snapshot.awayTeam.abbreviation;
    const battingScore =
      snapshot.battingTeamId === snapshot.homeTeam.id
        ? snapshot.homeScore
        : snapshot.awayScore;
    const runsNeeded = snapshot.target - (battingScore.runs ?? 0);
    ctx.inningsSituation = `2nd innings chase — ${battingTeam} chasing ${snapshot.target}, need ${runsNeeded} more runs`;
  } else if (snapshot.inningNumber === 1) {
    ctx.inningsSituation = "1st innings — setting a target";
  }

  return ctx;
}

const ANALYST_SYSTEM_PROMPT = `You are an elite cricket analyst with deep expertise in T20 and ODI match dynamics, scoring patterns, player matchups, and in-game momentum shifts.

Analyze the provided match data thoroughly:
- Match state: scores, overs, batting/bowling teams, win probabilities
- Statistical signals: deterministic factor breakdown (baseline, run rate pressure, wickets, momentum, batsmen quality, bowling pressure, venue/h2h)
- Latest web intelligence: recent news, expert opinions, team updates from trusted sources

Provide a detailed analysis covering:
1. Which team has the edge and why (cite specific data points)
2. Key factors driving the recommendation (run rate pressure, wickets in hand, momentum shifts, batting/bowling matchups)
3. What experts and news sources are saying (reference the web snippets)
4. Venue and conditions impact
5. Risks that could flip the outcome

Return strict JSON:
{
  "analysis": "string — detailed reasoning (3-5 sentences)",
  "headline": "string — one punchy headline summarizing the verdict",
  "insights": ["string[] — 5-7 specific data-backed observations"],
  "keyFactors": ["string[] — top 3 factors driving the recommendation"],
  "risks": ["string[] — top 3 risks that could change the outcome"]
}`;

const COMPOSER_SYSTEM_PROMPT = `You are a cricket broadcast expert creating a concise, punchy match insight card for fans.

You receive a deep analysis plus raw match data. Your job is to distill this into a crisp, actionable output that a cricket fan can immediately understand and act on.

Rules:
- Every insight bullet MUST reference a concrete data point, stat, or trend — no generic filler
- The headline must be specific to this match, not a template
- Risk warning should be the single most likely scenario that flips the outcome
- Invalidation conditions are specific, measurable events (e.g., "2 wickets in next 3 overs", "run rate drops below 7.5")

Return strict JSON:
{
  "headline": "string — specific, punchy, one sentence",
  "insights": ["string[] — max 5 crisp bullets, each citing a data point"],
  "riskWarning": "string — the #1 risk scenario",
  "invalidationConditions": ["string[] — max 4 specific measurable triggers"]
}`;

const ARBITER_SYSTEM_PROMPT = `You are a cricket match decision arbiter.

Your job is to choose the final recommendation between exactly two teams using:
- deterministic scoring signals
- live match state
- brave web intelligence snippets
- analyst/composer outputs

Rules:
- Select exactly one team id from homeTeam.id or awayTeam.id
- Confidence must be an integer from 35 to 96
- If signals conflict, explain why one side still has stronger edge
- Be decisive and avoid vague language

Return strict JSON:
{
  "llmRecommendedTeamId": 0,
  "llmConfidence": 0,
  "decisionRationale": "string (1-2 sentences)"
}`;

function parseTeamId(value: unknown): number | null {
  const teamId = Number(value);
  return Number.isFinite(teamId) ? teamId : null;
}

function parseConfidence(value: unknown): number | null {
  const confidence = Number(value);
  if (!Number.isFinite(confidence)) return null;
  return Math.max(35, Math.min(96, Math.round(confidence)));
}

export async function runLlmWorkflow(
  input: {
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
    webSnippets: BraveSnippet[];
    recommendedTeam: TeamLite;
  },
  options?: {
    fetchImpl?: typeof fetch;
  },
): Promise<LlmFinalDraft> {
  const requestId = input.requestId ?? "unknown";
  const killSwitch = Deno.env.get("AI_HELP_MODE") === "deterministic_only";
  const apiKey = Deno.env.get("OPENAI_API_KEY");

  const deterministicInsights = input.deterministicSummary.factorBreakdown
    .slice(0, 5)
    .map((factor) => {
      const direction =
        factor.impact >= 0
          ? input.snapshot.homeTeam.abbreviation
          : input.snapshot.awayTeam.abbreviation;
      return `${factor.factor} currently leans toward ${direction} (${(factor.impact * 100).toFixed(0)} impact).`;
    });

  if (killSwitch || !apiKey) {
    return fallbackDraft(
      deterministicInsights,
      input.recommendedTeam,
      input.mode,
    );
  }

  const fetchImpl = options?.fetchImpl ?? fetch;
  const state: ChainState = { callsUsed: 0, inputTokens: 0, outputTokens: 0 };

  let analysis: Record<string, unknown> = {};
  let composed: Record<string, unknown> = {};
  let arbiter: Record<string, unknown> = {};

  // Call 1 — Deep Analysis
  try {
    analysis = await runCompletion(
      apiKey,
      ANALYST_MODEL,
      requestId,
      "deep_analysis",
      ANALYST_SYSTEM_PROMPT,
      {
        mode: input.mode,
        recommendedTeam: input.recommendedTeam,
        match: buildMatchContext(input.snapshot),
        deterministic: input.deterministicSummary,
        webSnippets: input.webSnippets.slice(0, 7).map((s) => ({
          title: s.title,
          url: s.url,
          snippet: s.snippet,
        })),
      },
      state,
      600,
      fetchImpl,
    );
  } catch (error) {
    console.warn("llm_deep_analysis_fallback", {
      request_id: requestId,
      reason: String(error),
    });
  }

  // Call 2 — Final Composition
  try {
    composed = await runCompletion(
      apiKey,
      COMPOSER_MODEL,
      requestId,
      "final_composition",
      COMPOSER_SYSTEM_PROMPT,
      {
        mode: input.mode,
        recommendedTeam: input.recommendedTeam,
        matchSummary: {
          homeTeam: input.snapshot.homeTeam,
          awayTeam: input.snapshot.awayTeam,
          homeScore: input.snapshot.homeScore,
          awayScore: input.snapshot.awayScore,
          currentOvers: input.snapshot.currentOvers,
          status: input.snapshot.status,
        },
        deterministicConfidence: input.deterministicSummary.confidence,
        analysis,
      },
      state,
      400,
      fetchImpl,
    );
  } catch (error) {
    console.warn("llm_composition_fallback", {
      request_id: requestId,
      reason: String(error),
    });
  }

  // Call 3 — Decision Arbiter
  try {
    arbiter = await runCompletion(
      apiKey,
      ARBITER_MODEL,
      requestId,
      "decision_arbiter",
      ARBITER_SYSTEM_PROMPT,
      {
        mode: input.mode,
        homeTeam: input.snapshot.homeTeam,
        awayTeam: input.snapshot.awayTeam,
        deterministic: {
          recommendedTeamId: input.recommendedTeam.id,
          ...input.deterministicSummary,
        },
        matchSummary: {
          status: input.snapshot.status,
          homeScore: input.snapshot.homeScore,
          awayScore: input.snapshot.awayScore,
          currentOvers: input.snapshot.currentOvers,
          battingTeamId: input.snapshot.battingTeamId,
          bowlingTeamId: input.snapshot.bowlingTeamId,
        },
        braveSignals: input.webSnippets.slice(0, 7).map((snippet) => ({
          title: snippet.title,
          snippet: snippet.snippet,
          url: snippet.url,
        })),
        analysis,
        composed,
      },
      state,
      240,
      fetchImpl,
    );
  } catch (error) {
    console.warn("llm_arbiter_fallback", {
      request_id: requestId,
      reason: String(error),
    });
  }

  const parsedTeamId = parseTeamId(arbiter.llmRecommendedTeamId);
  const parsedConfidence = parseConfidence(arbiter.llmConfidence);
  const validArbiterTeamId =
    parsedTeamId === input.snapshot.homeTeam.id ||
    parsedTeamId === input.snapshot.awayTeam.id
      ? parsedTeamId
      : null;
  const decisionRationale =
    typeof arbiter.decisionRationale === "string"
      ? arbiter.decisionRationale
      : undefined;

  const headline =
    typeof composed.headline === "string"
      ? composed.headline
      : typeof analysis.headline === "string"
        ? analysis.headline
        : `${input.recommendedTeam.abbreviation} holds the current projected edge`;

  const insights = Array.isArray(composed.insights)
    ? composed.insights
        .filter((item): item is string => typeof item === "string")
        .slice(0, 5)
    : Array.isArray(analysis.insights)
      ? (analysis.insights as unknown[])
          .filter((item): item is string => typeof item === "string")
          .slice(0, 5)
      : deterministicInsights.slice(0, 5);

  const riskWarning =
    typeof composed.riskWarning === "string"
      ? composed.riskWarning
      : (input.deterministicSummary.riskFlags[0] ??
        "Momentum can swing with one wicket cluster.");

  const invalidationConditions = Array.isArray(composed.invalidationConditions)
    ? composed.invalidationConditions
        .filter((item): item is string => typeof item === "string")
        .slice(0, 4)
    : input.deterministicSummary.invalidationConditions.slice(0, 4);

  return {
    headline,
    insights,
    riskWarning,
    invalidationConditions,
    llmRecommendedTeamId: validArbiterTeamId,
    llmConfidence: parsedConfidence,
    decisionRationale,
    llmCallsUsed: state.callsUsed,
    tokenEstimateIn: state.inputTokens,
    tokenEstimateOut: state.outputTokens,
  };
}
