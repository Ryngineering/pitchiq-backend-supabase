import {
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { runDeterministicScoring } from "../scoring.ts";
import { MatchSnapshot } from "../types.ts";

function makeSnapshot(overrides?: Partial<MatchSnapshot>): MatchSnapshot {
  return {
    matchId: 123,
    status: "live",
    venue: "Wankhede",
    homeTeam: { id: 1, name: "Home", abbreviation: "HME" },
    awayTeam: { id: 2, name: "Away", abbreviation: "AWY" },
    homeScore: { runs: 155, wickets: 4 },
    awayScore: { runs: 149, wickets: 6 },
    homeOvers: 18.1,
    awayOvers: 20,
    currentOvers: 18.1,
    battingTeamId: 1,
    bowlingTeamId: 2,
    inningNumber: 2,
    target: 150,
    format: "T20",
    totalOvers: 20,
    liveHomeProb: 62,
    liveAwayProb: 38,
    prematchHomeProb: 55,
    prematchAwayProb: 45,
    recentOverRuns: [6, 7, 13, 12],
    batsmenAtCrease: [
      { strikeRate: 150, role: "finisher" },
      { strikeRate: 138, role: "anchor" },
    ],
    activeBowlers: [
      { economy: 8.9, overs: 4 },
      { economy: 7.5, overs: 3 },
    ],
    venueBias: 0.15,
    h2hBias: 0.12,
    rawUpdatedAt: new Date().toISOString(),
    ...overrides,
  };
}

Deno.test(
  "deterministic scorer returns bounded confidence and 8 factors",
  () => {
    const result = runDeterministicScoring(makeSnapshot(), "safe");

    assertEquals(result.recommendedTeamId, 1);
    assertEquals(result.factorBreakdown.length, 8);
    assertEquals(result.confidence >= 35 && result.confidence <= 96, true);
    assertEquals(Array.isArray(result.riskFlags), true);
    assertEquals(Array.isArray(result.invalidationConditions), true);

    // Verify resource factor is present
    const resourceFactor = result.factorBreakdown.find(
      (f) => f.factor === "resource",
    );
    assertNotEquals(resourceFactor, undefined);
  },
);

Deno.test("contrarian mode can differ from safe mode recommendation", () => {
  const closeGame = makeSnapshot({
    liveHomeProb: 54,
    liveAwayProb: 46,
    recentOverRuns: [5, 4, 14, 16],
    battingTeamId: 2,
    bowlingTeamId: 1,
    awayScore: { runs: 142, wickets: 4 },
    homeScore: { runs: 168, wickets: 7 },
    currentOvers: 17.2,
    awayOvers: 17.2,
    homeOvers: 20,
  });

  const safe = runDeterministicScoring(closeGame, "safe");
  const contrarian = runDeterministicScoring(closeGame, "contrarian");

  assertNotEquals(safe.recommendedTeamId, 0);
  assertNotEquals(contrarian.recommendedTeamId, 0);
});

Deno.test(
  "wickets pressure lowers batting side confidence when wickets are down",
  () => {
    const stable = runDeterministicScoring(
      makeSnapshot({
        homeScore: { runs: 130, wickets: 2 },
        currentOvers: 14.0,
      }),
      "value",
    );
    const collapse = runDeterministicScoring(
      makeSnapshot({
        homeScore: { runs: 130, wickets: 8 },
        currentOvers: 14.0,
      }),
      "value",
    );

    assertEquals(collapse.confidence <= stable.confidence, true);
  },
);

Deno.test("death overs with tail exposed produces collapse risk flag", () => {
  const result = runDeterministicScoring(
    makeSnapshot({
      homeScore: { runs: 140, wickets: 7 },
      currentOvers: 17.0,
    }),
    "safe",
  );

  const hasCollapseFlag = result.riskFlags.some((f) =>
    f.includes("Tail exposed"),
  );
  assertEquals(hasCollapseFlag, true);
});

Deno.test(
  "death-overs invalidation includes yorker breakdown condition",
  () => {
    const result = runDeterministicScoring(makeSnapshot(), "safe");

    const hasYorkerCondition = result.invalidationConditions.some((c) =>
      c.toLowerCase().includes("yorker"),
    );
    assertEquals(hasYorkerCondition, true);
  },
);

Deno.test("powerplay phase uses structural weight distribution", () => {
  const ppSnapshot = makeSnapshot({
    currentOvers: 4.3,
    homeOvers: 4.3,
    awayOvers: null,
    homeScore: { runs: 42, wickets: 1 },
    awayScore: { runs: null, wickets: null },
    battingTeamId: 1,
    bowlingTeamId: 2,
    inningNumber: 1,
    target: null,
    liveHomeProb: null,
    liveAwayProb: null,
  });

  const result = runDeterministicScoring(ppSnapshot, "safe");
  assertEquals(result.confidence >= 35 && result.confidence <= 96, true);
  assertEquals(result.factorBreakdown.length, 8);
});

Deno.test("DLS-inspired resource factor penalises collapsed innings", () => {
  // 7 wickets down at over 12 = very low resource remaining
  const collapsed = runDeterministicScoring(
    makeSnapshot({
      homeScore: { runs: 85, wickets: 7 },
      currentOvers: 12.0,
    }),
    "value",
  );
  // 2 wickets down at over 12 = high resource remaining
  const comfortable = runDeterministicScoring(
    makeSnapshot({
      homeScore: { runs: 85, wickets: 2 },
      currentOvers: 12.0,
    }),
    "value",
  );

  const collapsedResource = collapsed.factorBreakdown.find(
    (f) => f.factor === "resource",
  )!;
  const comfortableResource = comfortable.factorBreakdown.find(
    (f) => f.factor === "resource",
  )!;

  // Comfortable should have a much higher resource impact than collapsed
  assertEquals(comfortableResource.impact > collapsedResource.impact, true);
});

Deno.test(
  "2nd innings chase detected via inningNumber even when awayOvers is null",
  () => {
    // Simulates the RCB vs SRH bug: home team chasing, away_info=null
    const chaseSnapshot = makeSnapshot({
      homeTeam: { id: 1, name: "RCB", abbreviation: "RCB" },
      awayTeam: { id: 2, name: "SRH", abbreviation: "SRH" },
      homeScore: { runs: 160, wickets: 3 },
      awayScore: { runs: 201, wickets: 9 },
      homeOvers: 15.4,
      awayOvers: null, // null because 1st innings is complete
      currentOvers: 15.4,
      battingTeamId: 1,
      bowlingTeamId: 2,
      inningNumber: 2,
      target: 202,
      format: "T20",
      totalOvers: 20,
      liveHomeProb: 80,
      liveAwayProb: 20,
    });

    const result = runDeterministicScoring(chaseSnapshot, "safe");

    // Run rate pressure should reflect 2nd innings chase logic (required rate)
    const rrFactor = result.factorBreakdown.find(
      (f) => f.factor === "runRatePressure",
    )!;
    // With 42 needed off 4.6 overs (~27.6 balls), RRR is ~9.1
    // Current RR is 160/15.4 ≈ 10.4, so batting team has positive pressure
    assertNotEquals(rrFactor.impact, 0);

    // Resource factor should also work in 2nd innings
    const resourceFactor = result.factorBreakdown.find(
      (f) => f.factor === "resource",
    )!;
    assertNotEquals(resourceFactor.impact, 0);

    // Invalidation conditions should include required rate condition
    const hasRrrCondition = result.invalidationConditions.some((c) =>
      c.toLowerCase().includes("required run rate"),
    );
    assertEquals(hasRrrCondition, true);
  },
);

Deno.test("1st innings detected via inningNumber=1", () => {
  const firstInnings = makeSnapshot({
    homeScore: { runs: 85, wickets: 2 },
    awayScore: { runs: null, wickets: null },
    homeOvers: 10.0,
    awayOvers: null,
    currentOvers: 10.0,
    battingTeamId: 1,
    bowlingTeamId: 2,
    inningNumber: 1,
    target: null,
    liveHomeProb: null,
    liveAwayProb: null,
  });

  const result = runDeterministicScoring(firstInnings, "value");
  // Run rate pressure should use 1st innings benchmark logic
  const rrFactor = result.factorBreakdown.find(
    (f) => f.factor === "runRatePressure",
  )!;
  // 85 runs in 10 overs = 8.5 RR, middle phase benchmark is 7.8
  // So impact should be positive for home team
  assertEquals(rrFactor.impact > 0, true);
});
