export type AiMode = "safe" | "value" | "contrarian";

export interface TeamLite {
  id: number;
  name: string;
  abbreviation: string;
}

export interface ParsedScore {
  runs: number | null;
  wickets: number | null;
}

export interface MatchSnapshot {
  matchId: number;
  status: string;
  venue: string | null;
  homeTeam: TeamLite;
  awayTeam: TeamLite;
  homeScore: ParsedScore;
  awayScore: ParsedScore;
  homeOvers: number | null;
  awayOvers: number | null;
  currentOvers: number | null;
  battingTeamId: number | null;
  bowlingTeamId: number | null;
  inningNumber: number | null;
  target: number | null;
  format: string | null;
  totalOvers: number;
  liveHomeProb: number | null;
  liveAwayProb: number | null;
  prematchHomeProb: number | null;
  prematchAwayProb: number | null;
  recentOverRuns: number[];
  batsmenAtCrease: Array<{ strikeRate: number | null; role?: string | null }>;
  activeBowlers: Array<{ economy: number | null; overs: number | null }>;
  venueBias?: number | null;
  h2hBias?: number | null;
  rawUpdatedAt: string | null;
}

export interface FactorImpact {
  factor: string;
  weight: number;
  impact: number;
}

export interface DeterministicResult {
  recommendedTeamId: number;
  confidence: number;
  deterministicScore: number;
  factorBreakdown: FactorImpact[];
  riskFlags: string[];
  invalidationConditions: string[];
}

export interface BraveSnippet {
  title: string;
  url: string;
  snippet: string;
}

export interface LlmFinalDraft {
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
}

export interface FinalAiHelpPayload {
  recommendedTeam: TeamLite;
  mode: AiMode;
  confidence: number;
  headline: string;
  insights: string[];
  riskWarning: string;
  invalidationConditions: string[];
  sources: Array<{ title: string; url: string }>;
  debug: {
    deterministicScore: number;
    factorBreakdown: FactorImpact[];
    llmCallsUsed: number;
    llmRecommendedTeamId?: number | null;
    llmConfidence?: number | null;
    finalDecisionSource?: "deterministic" | "hybrid" | "llm";
  };
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds?: number;
}
