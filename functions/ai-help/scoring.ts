import {
  AiMode,
  DeterministicResult,
  FactorImpact,
  MatchSnapshot,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function average(values: Array<number | null | undefined>): number | null {
  const valid = values.filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
  if (!valid.length) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

// ---------------------------------------------------------------------------
// Phase detection — powerplay / middle / death
// ---------------------------------------------------------------------------

type MatchPhase = "powerplay" | "middle" | "death" | "unknown";

function detectPhase(currentOvers: number | null): MatchPhase {
  if (currentOvers == null || currentOvers <= 0) return "unknown";
  if (currentOvers <= 6) return "powerplay";
  if (currentOvers <= 15) return "middle";
  return "death";
}

// ---------------------------------------------------------------------------
// Innings detection — is this the 2nd innings (a chase)?
// ---------------------------------------------------------------------------

function isSecondInnings(snapshot: MatchSnapshot): boolean {
  if (snapshot.inningNumber != null) {
    return snapshot.inningNumber >= 2;
  }
  // Fallback for when inningNumber is unavailable
  if (snapshot.battingTeamId === snapshot.awayTeam.id) {
    return (
      snapshot.homeOvers != null &&
      snapshot.homeOvers >= snapshot.totalOvers - 0.6
    );
  }
  if (snapshot.battingTeamId === snapshot.homeTeam.id) {
    return (
      snapshot.awayOvers != null &&
      snapshot.awayOvers >= snapshot.totalOvers - 0.6
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// DLS-inspired resource percentage:  f(oversLeft, wicketsInHand)
// Approximation of the Standard Edition resource table for T20 (20 overs).
// Uses the exponential-decay formula from the DLS paper:
//   Z(u,w) = Z0(w) * (1 - e^(-b(w)*u))
// where u = overs remaining, w = wickets lost.  We normalise by Z(20,0)=100%.
// The parameters below are fitted to the published Standard Edition table
// scaled down from 50-over to 20-over cricket.
// ---------------------------------------------------------------------------

const DLS_Z0 = [
  /* 0 wkt */ 250, /* 1 */ 230, /* 2 */ 200, /* 3 */ 170, /* 4 */ 140,
  /* 5 */ 105, /* 6 */ 75, /* 7 */ 50, /* 8 */ 28, /* 9 */ 10,
];

const DLS_B = [
  /* 0 wkt */ 0.045, /* 1 */ 0.048, /* 2 */ 0.052, /* 3 */ 0.056, /* 4 */ 0.062,
  /* 5 */ 0.07, /* 6 */ 0.082, /* 7 */ 0.1, /* 8 */ 0.13, /* 9 */ 0.2,
];

function dlsResourcePct(
  oversRemaining: number,
  wicketsLost: number,
  totalOvers: number = 20,
): number {
  const w = clamp(Math.round(wicketsLost), 0, 9);
  const u = Math.max(0, oversRemaining);
  const z = DLS_Z0[w] * (1 - Math.exp(-DLS_B[w] * u));
  const full = DLS_Z0[0] * (1 - Math.exp(-DLS_B[0] * totalOvers));
  return clamp(z / full, 0, 1);
}

// ---------------------------------------------------------------------------
// Factor computations
// ---------------------------------------------------------------------------

function computeBaselineImpact(snapshot: MatchSnapshot): number {
  const homeProb = snapshot.liveHomeProb ?? snapshot.prematchHomeProb ?? 50;
  const awayProb =
    snapshot.liveAwayProb ?? snapshot.prematchAwayProb ?? 100 - homeProb;
  return clamp((homeProb - awayProb) / 100, -1, 1);
}

function computeRunRatePressureImpact(snapshot: MatchSnapshot): number {
  const battingTeamId = snapshot.battingTeamId;
  if (
    !battingTeamId ||
    snapshot.currentOvers == null ||
    snapshot.currentOvers <= 0
  ) {
    return 0;
  }

  const battingScore =
    battingTeamId === snapshot.homeTeam.id
      ? snapshot.homeScore
      : snapshot.awayScore;
  const bowlingScore =
    battingTeamId === snapshot.homeTeam.id
      ? snapshot.awayScore
      : snapshot.homeScore;
  if (battingScore.runs == null) return 0;

  const overs = snapshot.currentOvers;
  const phase = detectPhase(overs);

  // 1st innings: compare current RR against phase-expected benchmark
  if (!isSecondInnings(snapshot)) {
    const currentRR = battingScore.runs / Math.max(overs, 0.1);
    // Phase benchmarks for T20 (expected run-rate)
    const benchmark =
      phase === "powerplay" ? 7.5 : phase === "middle" ? 7.8 : 9.5;
    const impact = clamp((currentRR - benchmark) / 5, -1, 1);
    return battingTeamId === snapshot.homeTeam.id ? impact : -impact;
  }

  // 2nd innings: required-rate based pressure
  if (bowlingScore.runs == null) return 0;
  const target = snapshot.target ?? bowlingScore.runs + 1;
  const currentRuns = battingScore.runs;
  const ballsRemaining = Math.max(0, (snapshot.totalOvers - overs) * 6);
  if (ballsRemaining <= 0) return 0;

  const oversRemaining = ballsRemaining / 6;
  const currentRR = currentRuns / Math.max(overs, 0.1);
  const requiredRR = Math.max(0, (target - currentRuns) / oversRemaining);

  // In death overs, even a small RRR gap is much harder to close
  const phaseMultiplier =
    phase === "death" ? 1.4 : phase === "middle" ? 1.0 : 0.8;
  const pressureDelta = clamp(
    ((currentRR - requiredRR) / 6) * phaseMultiplier,
    -1,
    1,
  );

  return battingTeamId === snapshot.homeTeam.id
    ? pressureDelta
    : -pressureDelta;
}

/**
 * DLS-inspired non-linear wickets impact.
 * Uses the resource-percentage approach: losing your 7th wicket at over 16
 * is catastrophically more damaging than losing your 2nd at over 6.
 */
function computeWicketsImpact(snapshot: MatchSnapshot): number {
  if (!snapshot.battingTeamId) return 0;
  const battingScore =
    snapshot.battingTeamId === snapshot.homeTeam.id
      ? snapshot.homeScore
      : snapshot.awayScore;
  if (battingScore.wickets == null) return 0;

  const overs = snapshot.currentOvers ?? 0;
  const oversRemaining = Math.max(0, snapshot.totalOvers - overs);
  const wicketsLost = battingScore.wickets;

  // Current resource remaining
  const resourceNow = dlsResourcePct(
    oversRemaining,
    wicketsLost,
    snapshot.totalOvers,
  );
  // Ideal resource (no wickets lost at this stage)
  const resourceIdeal = dlsResourcePct(oversRemaining, 0, snapshot.totalOvers);

  if (resourceIdeal <= 0) return 0;
  // How much of ideal resource does batting team retain? (1 = perfect, 0 = all out)
  const resourceRatio = resourceNow / resourceIdeal;
  // Centre around 0.6 (avg T20 resource retention with 4-5 wickets down)
  const normalized = clamp((resourceRatio - 0.6) / 0.4, -1, 1);

  return snapshot.battingTeamId === snapshot.homeTeam.id
    ? normalized
    : -normalized;
}

function computeMomentumImpact(snapshot: MatchSnapshot): number {
  if (!snapshot.battingTeamId) return 0;
  const runs = snapshot.recentOverRuns;
  if (runs.length < 4) return 0;

  // Weighted momentum: recent overs matter more than older ones
  const recent2 = runs.slice(-2).reduce((s, v) => s + v, 0);
  const prior2 = runs.slice(-4, -2).reduce((s, v) => s + v, 0);
  const shortTermDelta = (recent2 - prior2) / 20;

  // If we have 6+ overs of data, also consider medium-term trend
  let mediumTermDelta = 0;
  if (runs.length >= 6) {
    const recentHalf = runs.slice(-3).reduce((s, v) => s + v, 0) / 3;
    const olderHalf = runs.slice(-6, -3).reduce((s, v) => s + v, 0) / 3;
    mediumTermDelta = (recentHalf - olderHalf) / 15;
  }

  // Phase context: momentum swings in death overs are more decisive
  const phase = detectPhase(snapshot.currentOvers);
  const phaseBoost =
    phase === "death" ? 1.3 : phase === "powerplay" ? 0.85 : 1.0;

  const delta = clamp(
    (shortTermDelta * 0.65 + mediumTermDelta * 0.35) * phaseBoost,
    -1,
    1,
  );

  return snapshot.battingTeamId === snapshot.homeTeam.id ? delta : -delta;
}

function computeBatsmenQualityImpact(snapshot: MatchSnapshot): number {
  if (!snapshot.battingTeamId) return 0;

  const srAvg = average(snapshot.batsmenAtCrease.map((p) => p.strikeRate));
  if (srAvg == null) return 0;

  const phase = detectPhase(snapshot.currentOvers);

  // Phase-adjusted SR benchmarks: higher SR expected in death, lower in powerplay
  const benchmark = phase === "death" ? 145 : phase === "powerplay" ? 120 : 130;
  const srImpact = (srAvg - benchmark) / 60;

  // Role awareness: finisher present in death overs is a big plus
  const hasFinisher = snapshot.batsmenAtCrease.some((p) =>
    (p.role ?? "").toLowerCase().includes("finisher"),
  );
  const roleBoost =
    hasFinisher && phase === "death" ? 0.12 : hasFinisher ? 0.06 : 0;

  const impact = clamp(srImpact + roleBoost, -1, 1);
  return snapshot.battingTeamId === snapshot.homeTeam.id ? impact : -impact;
}

function computeBowlingPressureImpact(snapshot: MatchSnapshot): number {
  if (!snapshot.bowlingTeamId) return 0;

  const bowlers = snapshot.activeBowlers;
  const econAvg = average(bowlers.map((b) => b.economy));
  if (econAvg == null) return 0;

  const phase = detectPhase(snapshot.currentOvers);

  // Phase-adjusted economy benchmarks
  const benchmark = phase === "death" ? 9.0 : phase === "powerplay" ? 7.2 : 7.8;
  const econImpact = (benchmark - econAvg) / 4;

  // Bowler overs depth: bowlers with overs left provide control
  const oversAvg = average(bowlers.map((b) => b.overs));
  const depthBoost = oversAvg != null && oversAvg < 3 ? 0.05 : 0; // fresh bowlers available

  const bowlingSideImpact = clamp(econImpact + depthBoost, -1, 1);

  return snapshot.bowlingTeamId === snapshot.homeTeam.id
    ? bowlingSideImpact
    : -bowlingSideImpact;
}

function computeVenueH2hImpact(snapshot: MatchSnapshot): number {
  const venue = snapshot.venueBias ?? 0;
  const h2h = snapshot.h2hBias ?? 0;
  return clamp((venue + h2h) / 2, -1, 1);
}

/**
 * DLS-resource factor: how much batting resource remains relative to the
 * match situation.  Captures the crucial overs × wickets interaction that
 * single-factor models miss.
 */
function computeResourceImpact(snapshot: MatchSnapshot): number {
  if (!snapshot.battingTeamId) return 0;
  const battingScore =
    snapshot.battingTeamId === snapshot.homeTeam.id
      ? snapshot.homeScore
      : snapshot.awayScore;
  if (battingScore.wickets == null || snapshot.currentOvers == null) return 0;

  const oversRemaining = Math.max(
    0,
    snapshot.totalOvers - snapshot.currentOvers,
  );
  const resource = dlsResourcePct(
    oversRemaining,
    battingScore.wickets,
    snapshot.totalOvers,
  );

  // In 2nd innings, compare resource against what's needed
  if (isSecondInnings(snapshot)) {
    const bowlingScore =
      snapshot.battingTeamId === snapshot.homeTeam.id
        ? snapshot.awayScore
        : snapshot.homeScore;
    if (bowlingScore.runs != null && battingScore.runs != null) {
      const target = snapshot.target ?? bowlingScore.runs + 1;
      const runsNeeded = target - battingScore.runs;
      const maxFromResource = resource * snapshot.totalOvers * 10;
      const ratio =
        runsNeeded > 0 ? clamp(maxFromResource / runsNeeded, 0, 3) : 2;
      const impact = clamp((ratio - 1) / 1.5, -1, 1);
      return snapshot.battingTeamId === snapshot.homeTeam.id ? impact : -impact;
    }
  }

  // 1st innings: high resource = batting team can accelerate
  const impact = clamp((resource - 0.4) / 0.4, -1, 1);
  return snapshot.battingTeamId === snapshot.homeTeam.id ? impact : -impact;
}

// ---------------------------------------------------------------------------
// Phase-aware weight distribution
// ---------------------------------------------------------------------------

function buildWeights(mode: AiMode, phase: MatchPhase): Record<string, number> {
  // Base weights by mode
  let w: Record<string, number>;

  if (mode === "safe") {
    w = {
      baseline: 0.28,
      runRatePressure: 0.18,
      wickets: 0.14,
      momentum: 0.08,
      batsmenQuality: 0.08,
      bowlingPressure: 0.08,
      venueH2h: 0.04,
      resource: 0.12,
    };
  } else if (mode === "contrarian") {
    w = {
      baseline: 0.16,
      runRatePressure: 0.16,
      wickets: 0.12,
      momentum: 0.16,
      batsmenQuality: 0.12,
      bowlingPressure: 0.1,
      venueH2h: 0.04,
      resource: 0.14,
    };
  } else {
    // value
    w = {
      baseline: 0.22,
      runRatePressure: 0.18,
      wickets: 0.14,
      momentum: 0.12,
      batsmenQuality: 0.1,
      bowlingPressure: 0.08,
      venueH2h: 0.04,
      resource: 0.12,
    };
  }

  // Phase modifiers: shift weight towards situational factors in death overs,
  // towards structural factors in powerplay
  if (phase === "death") {
    w.baseline -= 0.06;
    w.runRatePressure += 0.03;
    w.wickets += 0.02;
    w.resource += 0.02;
    w.momentum += 0.02;
    w.venueH2h -= 0.02;
    w.batsmenQuality -= 0.01;
  } else if (phase === "powerplay") {
    w.baseline += 0.04;
    w.venueH2h += 0.02;
    w.runRatePressure -= 0.04;
    w.resource -= 0.02;
  }

  return w;
}

// ---------------------------------------------------------------------------
// Confidence, recommendation, risk flags, invalidation
// ---------------------------------------------------------------------------

function computeConfidence(
  netImpact: number,
  baselineImpact: number,
  mode: AiMode,
  phase: MatchPhase,
  dataQuality: number,
): number {
  let confidence =
    50 + Math.abs(netImpact) * 36 + Math.abs(baselineImpact) * 14;

  if (mode === "safe") confidence += 5;
  if (mode === "contrarian") confidence -= 6;

  // Death overs have more decisive data — slight boost
  if (phase === "death") confidence += 3;
  // Pre-match/powerplay is more uncertain
  if (phase === "powerplay" || phase === "unknown") confidence -= 3;

  // Penalise when we have sparse data
  confidence += (dataQuality - 0.5) * 8;

  return Math.round(clamp(confidence, 35, 96));
}

function chooseRecommendation(
  snapshot: MatchSnapshot,
  mode: AiMode,
  netImpact: number,
  baselineImpact: number,
): number {
  let adjusted = baselineImpact + netImpact;

  if (mode === "value") {
    adjusted += Math.sign(netImpact) * 0.06;
  } else if (mode === "contrarian") {
    if (Math.abs(adjusted) < 0.2) {
      adjusted = -adjusted;
    }
    adjusted += Math.sign(netImpact) * 0.08;
  }

  return adjusted >= 0 ? snapshot.homeTeam.id : snapshot.awayTeam.id;
}

function buildRiskFlags(
  snapshot: MatchSnapshot,
  confidence: number,
  phase: MatchPhase,
): string[] {
  const flags: string[] = [];
  const overs = snapshot.currentOvers ?? 0;
  const battingScore =
    snapshot.battingTeamId === snapshot.homeTeam.id
      ? snapshot.homeScore
      : snapshot.awayScore;
  const wickets = battingScore?.wickets ?? 0;

  if (confidence < 55) {
    flags.push("Low confidence — match is genuinely on a knife-edge.");
  } else if (confidence < 65) {
    flags.push("Moderate confidence — a single big over could flip this.");
  }

  if (snapshot.recentOverRuns.length < 4) {
    flags.push("Limited over-by-over data — momentum signal is weak.");
  }

  if (snapshot.batsmenAtCrease.length === 0) {
    flags.push("No current batsmen data — quality factor is estimated.");
  }

  if (snapshot.activeBowlers.length === 0) {
    flags.push("No active bowler data — bowling pressure is estimated.");
  }

  // Phase-specific risks
  if (phase === "death" && wickets >= 6) {
    flags.push("Tail exposed in death overs — collapse risk is elevated.");
  }

  if (phase === "death" && isSecondInnings(snapshot)) {
    const bowlingScore =
      snapshot.battingTeamId === snapshot.homeTeam.id
        ? snapshot.awayScore
        : snapshot.homeScore;
    if (bowlingScore?.runs != null && battingScore?.runs != null) {
      const target = snapshot.target ?? bowlingScore.runs + 1;
      const rrr =
        (target - battingScore.runs) /
        Math.max(snapshot.totalOvers - overs, 0.1);
      if (rrr > 12) {
        flags.push(
          `Required rate of ${rrr.toFixed(1)} is near-impossible at this stage.`,
        );
      } else if (rrr > 10) {
        flags.push(
          `Required rate of ${rrr.toFixed(1)} demands boundary-heavy hitting.`,
        );
      }
    }
  }

  if (phase === "powerplay" && wickets >= 3) {
    flags.push("Early wicket cluster — top-order wobble increases variance.");
  }

  return flags;
}

function buildInvalidationConditions(
  snapshot: MatchSnapshot,
  phase: MatchPhase,
): string[] {
  const conditions: string[] = [];
  const overs = snapshot.currentOvers ?? 0;
  const battingScore =
    snapshot.battingTeamId === snapshot.homeTeam.id
      ? snapshot.homeScore
      : snapshot.awayScore;
  const wickets = battingScore?.wickets ?? 0;

  // Universal conditions
  conditions.push("Two or more wickets in the next 12 balls");

  if (isSecondInnings(snapshot)) {
    conditions.push("Required run rate jumps by 2.0+ inside a single over");
  }

  // Phase-specific invalidation triggers
  if (phase === "powerplay") {
    conditions.push("Three wickets fall in the powerplay with < 30 runs");
    if (wickets <= 1) {
      conditions.push("Set batsman dismissed — new batter needs rebuild time");
    }
  }

  if (phase === "middle") {
    conditions.push("A 15+ run over that suddenly shifts run-rate equilibrium");
    conditions.push(
      "A partnership crossing 50 that stabilises or accelerates the innings",
    );
  }

  if (phase === "death") {
    conditions.push("Yorker execution breaks down for two consecutive overs");
    if (wickets >= 5) {
      conditions.push("New batsman faces > 6 dot balls in first two overs");
    }
    conditions.push("20+ runs in a single over changes the equation entirely");
  }

  return conditions;
}

// ---------------------------------------------------------------------------
// Data quality score (0-1) — how much signal do we actually have?
// ---------------------------------------------------------------------------

function computeDataQuality(snapshot: MatchSnapshot): number {
  let score = 0;
  let checks = 0;

  // Live probabilities available?
  checks++;
  if (snapshot.liveHomeProb != null) score++;

  // Recent overs data?
  checks++;
  if (snapshot.recentOverRuns.length >= 4) score++;
  else if (snapshot.recentOverRuns.length >= 2) score += 0.5;

  // Batsmen data?
  checks++;
  if (snapshot.batsmenAtCrease.length >= 2) score++;
  else if (snapshot.batsmenAtCrease.length >= 1) score += 0.5;

  // Bowler data?
  checks++;
  if (snapshot.activeBowlers.length >= 2) score++;
  else if (snapshot.activeBowlers.length >= 1) score += 0.5;

  // Venue/H2H data?
  checks++;
  if (snapshot.venueBias != null || snapshot.h2hBias != null) score++;

  return checks > 0 ? score / checks : 0.5;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function runDeterministicScoring(
  snapshot: MatchSnapshot,
  mode: AiMode,
): DeterministicResult {
  const phase = detectPhase(snapshot.currentOvers);
  const weights = buildWeights(mode, phase);
  const dataQuality = computeDataQuality(snapshot);

  const impacts: Record<string, number> = {
    baseline: computeBaselineImpact(snapshot),
    runRatePressure: computeRunRatePressureImpact(snapshot),
    wickets: computeWicketsImpact(snapshot),
    momentum: computeMomentumImpact(snapshot),
    batsmenQuality: computeBatsmenQualityImpact(snapshot),
    bowlingPressure: computeBowlingPressureImpact(snapshot),
    venueH2h: computeVenueH2hImpact(snapshot),
    resource: computeResourceImpact(snapshot),
  };

  const factorBreakdown: FactorImpact[] = Object.entries(impacts).map(
    ([factor, impact]) => ({
      factor,
      weight: weights[factor],
      impact: Number(impact.toFixed(4)),
    }),
  );

  const netImpact = factorBreakdown.reduce(
    (sum, factor) => sum + factor.weight * factor.impact,
    0,
  );

  const baselineImpact = impacts.baseline;
  const confidence = computeConfidence(
    netImpact,
    baselineImpact,
    mode,
    phase,
    dataQuality,
  );
  const recommendedTeamId = chooseRecommendation(
    snapshot,
    mode,
    netImpact,
    baselineImpact,
  );

  return {
    recommendedTeamId,
    confidence,
    deterministicScore: Number((50 + netImpact * 50).toFixed(2)),
    factorBreakdown,
    riskFlags: buildRiskFlags(snapshot, confidence, phase),
    invalidationConditions: buildInvalidationConditions(snapshot, phase),
  };
}
