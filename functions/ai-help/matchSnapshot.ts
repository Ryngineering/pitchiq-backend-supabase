import { HttpError } from "./validators.ts";
import { MatchSnapshot, ParsedScore, TeamLite } from "./types.ts";

type DbError = { message: string } | null;

interface MatchRow {
  id: number;
  home_team_id: number;
  away_team_id: number;
  home_score: string | null;
  away_score: string | null;
  home_info: string | null;
  away_info: string | null;
  status: string | null;
  venue: string | null;
  prematch_home_win_prediction: string | null;
  prematch_away_win_prediction: string | null;
  live_home_win_prediction: string | null;
  live_away_win_prediction: string | null;
  raw: unknown;
  last_updated: string | null;
}

interface TeamRow {
  id: number;
  name: string | null;
  abbreviation: string | null;
}

interface SupabaseQueryResult<T> {
  data: T | null;
  error: DbError;
}

interface SupabaseClientLike {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (
        column: string,
        value: number,
      ) => {
        single: () => Promise<SupabaseQueryResult<MatchRow>>;
      };
      in: (
        column: string,
        values: Array<number | null>,
      ) => Promise<SupabaseQueryResult<TeamRow[]>>;
    };
  };
}

function parseScore(score: string | null | undefined): ParsedScore {
  if (!score) {
    return { runs: null, wickets: null };
  }

  const [runsRaw, wicketsRaw] = String(score).split("/");
  const runs = Number(runsRaw);
  const wickets = wicketsRaw == null ? null : Number(wicketsRaw);

  return {
    runs: Number.isFinite(runs) ? runs : null,
    wickets: Number.isFinite(wickets) ? wickets : null,
  };
}

function parseOvers(info: string | null | undefined): number | null {
  if (!info) return null;
  const match = String(info).match(/(\d{1,2}(?:\.\d)?)(?:\s*ov|\s*overs)?/i);
  if (!match) return null;
  const overs = Number(match[1]);
  return Number.isFinite(overs) ? overs : null;
}

function parseProbability(value: string | null | undefined): number | null {
  if (!value) return null;
  const normalized = String(value).replace("%", "").trim();
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < 0 || parsed > 100) return null;
  return parsed;
}

function parseTarget(info: string | null | undefined): number | null {
  if (!info) return null;
  const m = String(info).match(/T:(\d+)/);
  if (!m) return null;
  const target = Number(m[1]);
  return Number.isFinite(target) ? target : null;
}

function extractFormat(raw: Record<string, unknown>): string | null {
  const format = raw?.format;
  return typeof format === "string" ? format : null;
}

function totalOversForFormat(format: string | null): number {
  if (!format) return 20;
  const upper = format.toUpperCase();
  if (upper === "ODI") return 50;
  if (upper === "TEST") return 90;
  return 20;
}

function extractInningNumber(
  raw: Record<string, unknown>,
  teamId: number,
): number | null {
  const stats = raw?.statistics;
  if (!Array.isArray(stats)) return null;

  for (const entry of stats) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const team = e.team as Record<string, unknown> | undefined;
    if (!team) continue;
    if (Number(team.id) === teamId) {
      const inning = Number(e.inningNumber);
      return Number.isFinite(inning) ? inning : null;
    }
  }
  return null;
}

interface BattingResult {
  battingTeamId: number | null;
  bowlingTeamId: number | null;
  currentOvers: number | null;
  inningNumber: number | null;
}

function pickBattingTeam(
  raw: Record<string, unknown>,
  homeOvers: number | null,
  awayOvers: number | null,
  homeTeamId: number,
  awayTeamId: number,
): BattingResult {
  // Primary: use statistics[].inningNumber from raw API response
  const stats = raw?.statistics;
  if (Array.isArray(stats) && stats.length > 0) {
    let maxInning = 0;
    let battingId: number | null = null;

    for (const entry of stats) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const team = e.team as Record<string, unknown> | undefined;
      if (!team) continue;
      const id = Number(team.id);
      const inning = Number(e.inningNumber);
      if (Number.isFinite(inning) && inning > maxInning) {
        maxInning = inning;
        battingId = id;
      }
    }

    if (battingId === homeTeamId) {
      return {
        battingTeamId: homeTeamId,
        bowlingTeamId: awayTeamId,
        currentOvers: homeOvers,
        inningNumber: maxInning,
      };
    }
    if (battingId === awayTeamId) {
      return {
        battingTeamId: awayTeamId,
        bowlingTeamId: homeTeamId,
        currentOvers: awayOvers,
        inningNumber: maxInning,
      };
    }
  }

  // Fallback: overs comparison heuristic
  if (homeOvers == null && awayOvers == null) {
    return {
      battingTeamId: null,
      bowlingTeamId: null,
      currentOvers: null,
      inningNumber: null,
    };
  }

  if (awayOvers == null || (homeOvers != null && homeOvers > awayOvers)) {
    return {
      battingTeamId: homeTeamId,
      bowlingTeamId: awayTeamId,
      currentOvers: homeOvers,
      inningNumber: null,
    };
  }

  return {
    battingTeamId: awayTeamId,
    bowlingTeamId: homeTeamId,
    currentOvers: awayOvers,
    inningNumber: null,
  };
}

function coerceNumber(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function pullRecentOverRuns(raw: Record<string, unknown>): number[] {
  const candidates: unknown[] = [raw?.statistics, raw?.state, raw];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const objectCandidate = candidate as Record<string, unknown>;
    const overRuns = objectCandidate.overRuns ?? objectCandidate.over_runs;
    if (Array.isArray(overRuns)) {
      const parsed = overRuns
        .map((item) => coerceNumber(item))
        .filter((value): value is number => value != null)
        .slice(-8);
      if (parsed.length >= 4) return parsed;
    }
  }

  return [];
}

function pullBatsmen(
  raw: Record<string, unknown>,
): Array<{ strikeRate: number | null; role?: string | null }> {
  const stats = raw.statistics as Record<string, unknown> | undefined;
  const batsmen = stats?.batsmen;
  if (!Array.isArray(batsmen)) return [];

  return batsmen.slice(0, 6).map((player) => {
    if (!player || typeof player !== "object") {
      return { strikeRate: null, role: null };
    }
    const p = player as Record<string, unknown>;
    return {
      strikeRate: coerceNumber(p.strikeRate ?? p.strike_rate ?? p.sr),
      role: typeof p.role === "string" ? p.role : null,
    };
  });
}

function pullBowlers(
  raw: Record<string, unknown>,
): Array<{ economy: number | null; overs: number | null }> {
  const stats = raw.statistics as Record<string, unknown> | undefined;
  const bowlers = stats?.bowlers;
  if (!Array.isArray(bowlers)) return [];

  return bowlers.slice(0, 5).map((bowler) => {
    if (!bowler || typeof bowler !== "object") {
      return { economy: null, overs: null };
    }
    const b = bowler as Record<string, unknown>;
    return {
      economy: coerceNumber(b.economy ?? b.econ),
      overs: coerceNumber(b.overs),
    };
  });
}

function readBias(
  raw: Record<string, unknown>,
  key: "venueBias" | "h2hBias",
): number | null {
  const value = (raw as Record<string, unknown>)[key];
  const parsed = coerceNumber(value);
  if (parsed == null) return null;
  return Math.max(-1, Math.min(1, parsed));
}

export async function loadMatchSnapshot(
  supabase: unknown,
  matchId: number,
): Promise<MatchSnapshot> {
  const client = supabase as SupabaseClientLike;

  const { data: match, error: matchError } = await client
    .from("cricket_matches")
    .select(
      "id, home_team_id, away_team_id, home_score, away_score, home_info, away_info, status, venue, prematch_home_win_prediction, prematch_away_win_prediction, live_home_win_prediction, live_away_win_prediction, raw, last_updated",
    )
    .eq("id", matchId)
    .single();

  if (matchError || !match) {
    throw new HttpError(422, "Match not found.");
  }

  const teamIds = [match.home_team_id, match.away_team_id].filter(
    (id) => id != null,
  );
  const { data: teams, error: teamError } = await client
    .from("cricket_team")
    .select("id, name, abbreviation")
    .in("id", teamIds);

  if (teamError || !teams || teams.length < 2) {
    throw new HttpError(500, "Failed to load team metadata.");
  }

  const teamById = new Map<number, TeamLite>();
  for (const team of teams) {
    teamById.set(Number(team.id), {
      id: Number(team.id),
      name: String(team.name ?? "Unknown"),
      abbreviation: String(team.abbreviation ?? "UNK"),
    });
  }

  const homeTeamId = Number(match.home_team_id);
  const awayTeamId = Number(match.away_team_id);
  const homeTeam = teamById.get(homeTeamId);
  const awayTeam = teamById.get(awayTeamId);

  if (!homeTeam || !awayTeam) {
    throw new HttpError(500, "Team lookup failed for match.");
  }

  const homeOvers = parseOvers(match.home_info);
  const awayOvers = parseOvers(match.away_info);

  const raw =
    match.raw && typeof match.raw === "object"
      ? (match.raw as Record<string, unknown>)
      : {};

  const innings = pickBattingTeam(
    raw,
    homeOvers,
    awayOvers,
    homeTeamId,
    awayTeamId,
  );

  const format = extractFormat(raw);
  const totalOvers = totalOversForFormat(format);

  // Derive target from the chasing team's info field ("T:XXX" pattern)
  const homeTarget = parseTarget(match.home_info);
  const awayTarget = parseTarget(match.away_info);
  const target =
    innings.inningNumber === 2
      ? innings.battingTeamId === homeTeamId
        ? homeTarget
        : awayTarget
      : null;

  return {
    matchId,
    status: String(match.status ?? "unknown"),
    venue: match.venue ? String(match.venue) : null,
    homeTeam,
    awayTeam,
    homeScore: parseScore(match.home_score),
    awayScore: parseScore(match.away_score),
    homeOvers,
    awayOvers,
    currentOvers: innings.currentOvers,
    battingTeamId: innings.battingTeamId,
    bowlingTeamId: innings.bowlingTeamId,
    inningNumber: innings.inningNumber,
    target,
    format,
    totalOvers,
    liveHomeProb: parseProbability(match.live_home_win_prediction),
    liveAwayProb: parseProbability(match.live_away_win_prediction),
    prematchHomeProb: parseProbability(match.prematch_home_win_prediction),
    prematchAwayProb: parseProbability(match.prematch_away_win_prediction),
    recentOverRuns: pullRecentOverRuns(raw),
    batsmenAtCrease: pullBatsmen(raw),
    activeBowlers: pullBowlers(raw),
    venueBias: readBias(raw, "venueBias"),
    h2hBias: readBias(raw, "h2hBias"),
    rawUpdatedAt: match.last_updated ? String(match.last_updated) : null,
  };
}

export function computeOverBucket(currentOvers: number | null): number {
  if (currentOvers == null || currentOvers < 0) {
    return 0;
  }
  return Math.floor(currentOvers / 2);
}

export function pickMatchPhase(
  snapshot: MatchSnapshot,
): "pre-match" | "mid-innings chase" | "death overs pressure" {
  const overs = snapshot.currentOvers ?? 0;
  const hasLiveScores =
    snapshot.homeScore.runs != null || snapshot.awayScore.runs != null;

  if (!hasLiveScores || overs <= 0) {
    return "pre-match";
  }

  if (overs >= 16) {
    return "death overs pressure";
  }

  return "mid-innings chase";
}
