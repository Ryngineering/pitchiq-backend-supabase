// ============================================================================
// Rate Limiter — enforces minimum delay between API calls
// ============================================================================
export class RateLimiter {
  private lastCallTime = 0;
  private minIntervalMs: number;

  constructor(minIntervalMs = 200) {
    this.minIntervalMs = minIntervalMs;
  }

  async waitIfNeeded() {
    const now = Date.now();
    const elapsed = now - this.lastCallTime;
    if (elapsed < this.minIntervalMs) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.minIntervalMs - elapsed),
      );
    }
    this.lastCallTime = Date.now();
  }
}

// ============================================================================
// Match Prediction Type
// ============================================================================
export type MatchPrediction = {
  generatedAt?: string;
  probabilities?: {
    home?: string;
    away?: string;
    draw?: string;
  };
};

// ============================================================================
// Get Latest Prediction — reused helper
// ============================================================================
export function getLatestPrediction(
  predictions?: MatchPrediction[],
): MatchPrediction | undefined {
  if (!predictions?.length) {
    return undefined;
  }

  const toEpoch = (value?: string) => {
    const epoch = Date.parse(value ?? "");
    return Number.isNaN(epoch) ? 0 : epoch;
  };

  return [...predictions].sort(
    (a, b) => toEpoch(b.generatedAt) - toEpoch(a.generatedAt),
  )[0];
}

// ============================================================================
// Build Match Payload — transforms raw API match into upsert-ready shape
// ============================================================================
export function buildMatchPayload(match: any) {
  const latestPrematchPrediction = getLatestPrediction(
    match.predictions?.prematch,
  );
  const latestLivePrediction = getLatestPrediction(match.predictions?.live);

  return {
    id: match.id,
    home_team_id: match.homeTeam?.id,
    away_team_id: match.awayTeam?.id,
    start_date_time: match.startTime,
    home_score: match.state?.teams?.home?.score,
    away_score: match.state?.teams?.away?.score,
    home_info: match.state?.teams?.home?.info,
    away_info: match.state?.teams?.away?.info,
    prematch_home_win_prediction: latestPrematchPrediction?.probabilities?.home,
    prematch_away_win_prediction: latestPrematchPrediction?.probabilities?.away,
    prematch_draw_prediction: latestPrematchPrediction?.probabilities?.draw,
    live_home_win_prediction: latestLivePrediction?.probabilities?.home,
    live_away_win_prediction: latestLivePrediction?.probabilities?.away,
    live_draw_prediction: latestLivePrediction?.probabilities?.draw,
    status: match.state?.description,
    report: match.state?.report,
    venue: match.venue?.name,
    raw: match,
    last_updated: new Date().toISOString(),
  };
}

// ============================================================================
// Upsert Match — persists to Supabase with error handling
// ============================================================================
export async function upsertMatch(
  supabase: any,
  payload: any,
): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    const { data: upserted, error } = await supabase
      .from("cricket_matches")
      .upsert(payload, {
        onConflict: "id",
      })
      .select();

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true, data: upserted };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

// ============================================================================
// Fetch Match from Highlightly API with rate limiting
// ============================================================================
export async function fetchMatchDetailsWithRateLimit(
  matchId: string | number,
  apiKey: string,
  baseUrl: string,
  rateLimiter: RateLimiter,
): Promise<any> {
  await rateLimiter.waitIfNeeded();

  const response = await fetch(`${baseUrl}/matches/${matchId}`, {
    headers: {
      "x-rapidapi-key": apiKey,
      "x-rapidapi-host": "cricket-highlights-api.p.rapidapi.com",
    },
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data[0]; // API returns array
}

// ============================================================================
// Fetch Matches List (paginated) from Highlightly API with rate limiting
// ============================================================================
export async function fetchMatchesListWithRateLimit(
  apiKey: string,
  baseUrl: string,
  leagueId: number,
  leagueName: string,
  season: number,
  limit: number = 100,
  offset: number = 0,
  rateLimiter: RateLimiter,
): Promise<any> {
  await rateLimiter.waitIfNeeded();

  const params = new URLSearchParams({
    leagueId: String(leagueId),
    leagueName: leagueName,
    season: String(season),
    limit: String(limit),
    offset: String(offset),
  });

  const response = await fetch(`${baseUrl}/matches?${params}`, {
    headers: {
      "x-rapidapi-key": apiKey,
      "x-rapidapi-host": "cricket-highlights-api.p.rapidapi.com",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch matches list: ${response.status} ${response.statusText}`,
    );
  }

  return await response.json();
}
