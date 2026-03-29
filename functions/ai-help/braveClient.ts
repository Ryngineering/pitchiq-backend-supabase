import { AiMode, BraveSnippet, MatchSnapshot } from "./types.ts";
import { pickMatchPhase } from "./matchSnapshot.ts";

const BRAVE_URL = "https://api.search.brave.com/res/v1/web/search";
const VERBOSE_LOGS = Deno.env.get("AI_HELP_VERBOSE_LOGS") === "true";
const RELEVANT_DOMAINS = [
  "espncricinfo.com",
  "cricbuzz.com",
  "icc-cricket.com",
  "bbc.com",
  "reuters.com",
  "thehindu.com",
  "wisden.com",
  "espn.com",
  "skysports.com",
  "crictracker.com",
  "ndtv.com",
  "scroll.in",
  "sportstar.thehindu.com",
  "news18.com",
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function currentYear(): number {
  return new Date().getFullYear();
}

function buildMatchQuery(snapshot: MatchSnapshot, _mode: AiMode): string {
  const phase = pickMatchPhase(snapshot);
  const teams = `${snapshot.homeTeam.name} vs ${snapshot.awayTeam.name}`;
  const venue = snapshot.venue ? ` ${snapshot.venue}` : "";
  const year = currentYear();

  if (phase === "pre-match") {
    return `${teams}${venue} ${year} match preview playing XI pitch report team news today`;
  }

  if (phase === "death overs pressure") {
    return `${teams} live score ${year} death overs bowling pressure key moments today`;
  }

  return `${teams} live score ${year} chase momentum partnerships wickets today`;
}

function buildExpertQuery(snapshot: MatchSnapshot, _mode: AiMode): string {
  const phase = pickMatchPhase(snapshot);
  const teams = `${snapshot.homeTeam.name} vs ${snapshot.awayTeam.name}`;
  const year = currentYear();

  if (phase === "pre-match") {
    return `${teams} ${year} expert prediction analysis head to head form injuries`;
  }

  return `${teams} ${year} expert analysis prediction who will win live`;
}

function isCricketRelevant(
  title: string,
  snippet: string,
  url: string,
): boolean {
  const source = `${title} ${snippet}`.toLowerCase();
  const cricketTerms = [
    "cricket",
    "t20",
    "odi",
    "innings",
    "wicket",
    "run rate",
    "ipl",
    "batsman",
    "batter",
    "bowler",
    "bowling",
    "partnership",
    "powerplay",
    "over",
    "pitch",
    "toss",
    "playing xi",
    "squad",
    "test match",
    "world cup",
    "bbl",
    "psl",
    "cpl",
    "sa20",
    "prediction",
    "preview",
    "score",
    "chase",
    "target",
  ];
  const hasTerm = cricketTerms.some((term) => source.includes(term));
  const hasTrustedDomain = RELEVANT_DOMAINS.some((domain) =>
    url.includes(domain),
  );
  return hasTerm || hasTrustedDomain;
}

async function fetchBrave(
  apiKey: string,
  query: string,
  freshness: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<any> {
  const url = new URL(BRAVE_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("count", "10");
  url.searchParams.set("freshness", freshness);

  if (VERBOSE_LOGS) {
    console.log("brave_search_request_payload", {
      request_url: url.toString(),
      request_method: "GET",
      request_headers: {
        Accept: "application/json",
        "X-Subscription-Token": "[REDACTED]",
      },
      query,
      freshness,
      timeout_ms: timeoutMs,
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url.toString(), {
      method: "GET",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
    });

    if (!response.ok) {
      throw new Error(`Brave search failed: ${response.status}`);
    }

    const payload = await response.json();

    if (VERBOSE_LOGS) {
      console.log("brave_search_response_payload", {
        status: response.status,
        payload,
      });
    }

    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

function parseResults(
  payload: any,
): Array<{ title: string; url: string; snippet: string }> {
  const results = (payload?.web?.results ?? []) as Array<
    Record<string, unknown>
  >;
  return results
    .map((entry) => ({
      title: String(entry.title ?? ""),
      url: String(entry.url ?? ""),
      snippet: String(entry.description ?? entry.snippet ?? ""),
    }))
    .filter(
      (entry) =>
        entry.title &&
        entry.url &&
        isCricketRelevant(entry.title, entry.snippet, entry.url),
    );
}

async function fetchWithRetry(
  apiKey: string,
  query: string,
  freshness: string,
  timeoutMs: number,
  retries: number,
  fetchImpl: typeof fetch,
  requestId: string,
  label: string,
): Promise<Array<{ title: string; url: string; snippet: string }>> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const startedAt = Date.now();
    try {
      const payload = await fetchBrave(
        apiKey,
        query,
        freshness,
        timeoutMs,
        fetchImpl,
      );
      const snippets = parseResults(payload);

      console.log("brave_search_succeeded", {
        request_id: requestId,
        label,
        attempt: attempt + 1,
        duration_ms: Date.now() - startedAt,
        raw_results_count: (payload?.web?.results ?? []).length,
        returned_snippets_count: snippets.length,
      });

      return snippets;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        console.warn("brave_search_retry", {
          request_id: requestId,
          label,
          attempt: attempt + 1,
          reason: error instanceof Error ? error.message : String(error),
        });
        await sleep(200 * 2 ** attempt);
      }
    }
  }

  console.warn("brave_search_query_failed", {
    request_id: requestId,
    label,
    reason: lastError instanceof Error ? lastError.message : String(lastError),
  });
  return [];
}

export async function braveSearchEnrichment(
  snapshot: MatchSnapshot,
  mode: AiMode,
  options?: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    retries?: number;
    requestId?: string;
  },
): Promise<BraveSnippet[]> {
  const requestId = options?.requestId ?? "unknown";
  const apiKey = Deno.env.get("BRAVE_API_KEY");
  if (!apiKey) {
    console.log("brave_search_skipped", {
      request_id: requestId,
      reason: "missing_brave_api_key",
      match_id: snapshot.matchId,
      mode,
    });
    return [];
  }

  const fetchImpl = options?.fetchImpl ?? fetch;
  const timeoutMs = options?.timeoutMs ?? 3500;
  const retries = options?.retries ?? 2;
  const phase = pickMatchPhase(snapshot);
  const freshness = phase === "pre-match" ? "pw" : "pd";

  const matchQuery = buildMatchQuery(snapshot, mode);
  const expertQuery = buildExpertQuery(snapshot, mode);

  console.log("brave_search_started", {
    request_id: requestId,
    match_id: snapshot.matchId,
    mode,
    phase,
    freshness,
    queries: [matchQuery, expertQuery],
  });

  // Run both queries in parallel for richer context
  const [matchResults, expertResults] = await Promise.all([
    fetchWithRetry(
      apiKey,
      matchQuery,
      freshness,
      timeoutMs,
      retries,
      fetchImpl,
      requestId,
      "match_info",
    ),
    fetchWithRetry(
      apiKey,
      expertQuery,
      freshness,
      timeoutMs,
      retries,
      fetchImpl,
      requestId,
      "expert_opinion",
    ),
  ]);

  // Merge and deduplicate by URL
  const seen = new Set<string>();
  const merged: BraveSnippet[] = [];
  for (const item of [...matchResults, ...expertResults]) {
    if (!seen.has(item.url)) {
      seen.add(item.url);
      merged.push(item);
    }
  }

  const snippets = merged.slice(0, 7);

  console.log("brave_search_complete", {
    request_id: requestId,
    match_id: snapshot.matchId,
    match_results: matchResults.length,
    expert_results: expertResults.length,
    merged_unique: merged.length,
    returned: snippets.length,
  });

  return snippets;
}
