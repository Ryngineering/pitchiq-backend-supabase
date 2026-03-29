import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createAiHelpHandlerWithDeps } from "../handler.ts";
import { MatchSnapshot } from "../types.ts";

function makeSnapshot(overrides?: Partial<MatchSnapshot>): MatchSnapshot {
  return {
    matchId: 777,
    status: "live",
    venue: "Chinnaswamy",
    homeTeam: { id: 10, name: "Royal Challengers", abbreviation: "RCB" },
    awayTeam: { id: 20, name: "Mumbai", abbreviation: "MI" },
    homeScore: { runs: 120, wickets: 3 },
    awayScore: { runs: 180, wickets: 7 },
    homeOvers: 14,
    awayOvers: 20,
    currentOvers: 14,
    battingTeamId: 10,
    bowlingTeamId: 20,
    inningNumber: 2,
    target: 181,
    format: "T20",
    totalOvers: 20,
    liveHomeProb: 52,
    liveAwayProb: 48,
    prematchHomeProb: 49,
    prematchAwayProb: 51,
    recentOverRuns: [4, 5, 9, 11],
    batsmenAtCrease: [{ strikeRate: 142 }, { strikeRate: 128 }],
    activeBowlers: [
      { economy: 8.2, overs: 3 },
      { economy: 7.8, overs: 2 },
    ],
    venueBias: 0.1,
    h2hBias: -0.05,
    rawUpdatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/ai-help", {
    method: "POST",
    headers: {
      Authorization: "Bearer token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function baseDeps(overrides?: Record<string, unknown>) {
  const deps = {
    makeUserClient: () => ({ rpc: async () => ({ data: true, error: null }) }),
    makeServiceClient: () => ({}),
    getUser: async () => ({ user: { id: "user-1" }, error: null }),
    loadSnapshot: async () => makeSnapshot(),
    claim: async () => true,
    deterministic: () => ({
      recommendedTeamId: 10,
      confidence: 67,
      deterministicScore: 61,
      factorBreakdown: [{ factor: "baseline", weight: 0.3, impact: 0.2 }],
      riskFlags: ["Momentum can swing quickly."],
      invalidationConditions: ["Two wickets in 12 balls"],
    }),
    brave: async () => [
      {
        title: "Cricbuzz Live",
        url: "https://www.cricbuzz.com/live",
        snippet: "Match update",
      },
    ],
    llm: async () => ({
      headline: "RCB have the edge",
      insights: ["Powerplay recovery improved scoring trajectory."],
      riskWarning: "Wicket burst can flip pressure instantly.",
      invalidationConditions: ["Two wickets in 12 balls"],
      llmCallsUsed: 2,
      tokenEstimateIn: 500,
      tokenEstimateOut: 120,
    }),
    now: () => 1000,
    randomId: () => "req-test-1",
    ...(overrides ?? {}),
  };

  return deps;
}

Deno.test("first success path returns 200 with payload", async () => {
  const deps = baseDeps();
  const handler = createAiHelpHandlerWithDeps(deps);

  const res = await handler(makeRequest({ matchId: 777, mode: "value" }));
  assertEquals(res.status, 200);

  const body = await res.json();
  assertEquals(body.payload.mode, "value");
  assertEquals(body.payload.debug.llmCallsUsed, 2);
});

Deno.test("second attempt blocked returns 409", async () => {
  const deps = baseDeps({ claim: async () => false });
  const handler = createAiHelpHandlerWithDeps(deps);

  const res = await handler(makeRequest({ matchId: 777, mode: "safe" }));
  assertEquals(res.status, 409);
  const body = await res.json();
  assertEquals(body.friendlyMessage.includes("already used"), true);
});

Deno.test("brave failure falls back and still succeeds", async () => {
  const deps = baseDeps({
    brave: async () => {
      throw new Error("brave down");
    },
  });
  const handler = createAiHelpHandlerWithDeps(deps);

  const res = await handler(makeRequest({ matchId: 777, mode: "safe" }));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(Array.isArray(body.payload.sources), true);
});

Deno.test("llm failure falls back to deterministic response", async () => {
  const deps = baseDeps({
    llm: async () => {
      throw new Error("llm down");
    },
  });
  const handler = createAiHelpHandlerWithDeps(deps);

  const res = await handler(makeRequest({ matchId: 777, mode: "safe" }));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.payload.debug.llmCallsUsed, 0);
  assertEquals(typeof body.payload.headline, "string");
});

Deno.test(
  "when LLM agrees, confidence is blended and source is hybrid",
  async () => {
    const deps = baseDeps({
      llm: async () => ({
        headline: "RCB still ahead",
        insights: ["Signals align with deterministic edge."],
        riskWarning: "Late wickets could tighten the game.",
        invalidationConditions: ["Two wickets in 12 balls"],
        llmRecommendedTeamId: 10,
        llmConfidence: 80,
        llmCallsUsed: 3,
        tokenEstimateIn: 820,
        tokenEstimateOut: 220,
      }),
    });
    const handler = createAiHelpHandlerWithDeps(deps);

    const res = await handler(makeRequest({ matchId: 777, mode: "safe" }));
    assertEquals(res.status, 200);
    const body = await res.json();

    // 67 * 0.7 + 80 * 0.3 = 70.9 -> 71
    assertEquals(body.payload.confidence, 71);
    assertEquals(body.payload.recommendedTeam.id, 10);
    assertEquals(body.payload.debug.finalDecisionSource, "hybrid");
  },
);

Deno.test(
  "strong LLM disagreement can override weak deterministic edge",
  async () => {
    const deps = baseDeps({
      deterministic: () => ({
        recommendedTeamId: 10,
        confidence: 58,
        deterministicScore: 53,
        factorBreakdown: [{ factor: "baseline", weight: 0.3, impact: 0.05 }],
        riskFlags: ["Close game."],
        invalidationConditions: ["Two wickets in 12 balls"],
      }),
      llm: async () => ({
        headline: "MI take the edge",
        insights: ["Bowling matchup and fresh death specialist favor MI."],
        riskWarning: "One explosive over can still swing it back.",
        invalidationConditions: ["20+ run over"],
        llmRecommendedTeamId: 20,
        llmConfidence: 84,
        llmCallsUsed: 3,
        tokenEstimateIn: 900,
        tokenEstimateOut: 260,
      }),
    });
    const handler = createAiHelpHandlerWithDeps(deps);

    const res = await handler(makeRequest({ matchId: 777, mode: "value" }));
    assertEquals(res.status, 200);
    const body = await res.json();

    assertEquals(body.payload.recommendedTeam.id, 20);
    assertEquals(body.payload.debug.finalDecisionSource, "llm");
  },
);

Deno.test(
  "env threshold can disable LLM override for disagreement",
  async () => {
    const prior = Deno.env.get("AI_HELP_LLM_OVERRIDE_MIN_CONFIDENCE");
    Deno.env.set("AI_HELP_LLM_OVERRIDE_MIN_CONFIDENCE", "95");

    try {
      const deps = baseDeps({
        deterministic: () => ({
          recommendedTeamId: 10,
          confidence: 58,
          deterministicScore: 53,
          factorBreakdown: [{ factor: "baseline", weight: 0.3, impact: 0.05 }],
          riskFlags: ["Close game."],
          invalidationConditions: ["Two wickets in 12 balls"],
        }),
        llm: async () => ({
          headline: "MI take the edge",
          insights: ["Bowling matchup and fresh death specialist favor MI."],
          riskWarning: "One explosive over can still swing it back.",
          invalidationConditions: ["20+ run over"],
          llmRecommendedTeamId: 20,
          llmConfidence: 84,
          llmCallsUsed: 3,
          tokenEstimateIn: 900,
          tokenEstimateOut: 260,
        }),
      });
      const handler = createAiHelpHandlerWithDeps(deps);

      const res = await handler(makeRequest({ matchId: 777, mode: "value" }));
      assertEquals(res.status, 200);
      const body = await res.json();

      assertEquals(body.payload.recommendedTeam.id, 10);
      assertEquals(body.payload.debug.finalDecisionSource, "deterministic");
    } finally {
      if (prior == null) {
        Deno.env.delete("AI_HELP_LLM_OVERRIDE_MIN_CONFIDENCE");
      } else {
        Deno.env.set("AI_HELP_LLM_OVERRIDE_MIN_CONFIDENCE", prior);
      }
    }
  },
);
