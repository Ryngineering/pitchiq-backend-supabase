import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import {
  buildMatchPayload,
  upsertMatch,
  RateLimiter,
  fetchMatchDetailsWithRateLimit,
  fetchMatchesListWithRateLimit,
} from "../lib/matchSyncUtils.ts";

const RATE_LIMIT_MS = 200; // milliseconds between API calls

interface SyncResult {
  league_id: number;
  league_name: string;
  season: number;
  matches_found: number;
  matches_synced: number;
  matches_failed: number;
  errors: Array<{ match_id: string | number; error: string }>;
}

async function logSyncResult(supabase: any, result: SyncResult): Promise<void> {
  const { error } = await supabase.from("league_sync_logs").insert({
    league_id: result.league_id,
    league_name: result.league_name,
    season: result.season,
    sync_ended_at: new Date().toISOString(),
    matches_found: result.matches_found,
    matches_synced: result.matches_synced,
    matches_failed: result.matches_failed,
    error_summary: result.errors.length > 0 ? result.errors : null,
  });

  if (error) {
    console.error("Failed to log sync result:", error);
  }
}

async function updateLeagueConfigNextSync(
  supabase: any,
  leagueId: number,
  season: number,
): Promise<void> {
  const now = new Date();

  const { data: config } = await supabase
    .from("league_sync_config")
    .select("sync_interval_hours")
    .eq("league_id", leagueId)
    .eq("season", season)
    .single();

  if (!config) {
    console.warn(`No config found for league ${leagueId}, season ${season}`);
    return;
  }

  const nextSyncTime = new Date(
    now.getTime() + config.sync_interval_hours * 3600 * 1000,
  );

  const { error } = await supabase
    .from("league_sync_config")
    .update({
      last_sync_at: now.toISOString(),
      next_sync_at: nextSyncTime.toISOString(),
    })
    .eq("league_id", leagueId)
    .eq("season", season);

  if (error) {
    console.error("Failed to update league config:", error);
  }
}

async function getAllMatchesForLeague(
  apiKey: string,
  baseUrl: string,
  leagueId: number,
  leagueName: string,
  season: number,
  rateLimiter: RateLimiter,
): Promise<Array<{ id: string | number }>> {
  const allMatches: Array<{ id: string | number }> = [];
  let offset = 0;
  const limit = 100;
  let hasMore = true;

  while (hasMore) {
    try {
      const response = await fetchMatchesListWithRateLimit(
        apiKey,
        baseUrl,
        leagueId,
        leagueName,
        season,
        limit,
        offset,
        rateLimiter,
      );

      const matches = response.data || [];
      if (matches.length === 0) {
        hasMore = false;
        break;
      }

      allMatches.push(...matches);

      // Check if there are more pages
      if (matches.length < limit) {
        hasMore = false;
      } else {
        offset += limit;
      }
    } catch (error: unknown) {
      console.error(`Error fetching matches page at offset ${offset}:`, error);
      hasMore = false;
    }
  }

  return allMatches;
}

Deno.serve(async (req: Request) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const apiKey = Deno.env.get("HIGHLIGHTLY_API_KEY")!;
  const baseUrl = Deno.env.get("CRICKET_API_BASE_URL")!;
  const rateLimiter = new RateLimiter(RATE_LIMIT_MS);

  try {
    // Check for manual override league_id in query params
    const url = new URL(req.url);
    const manualLeagueId = url.searchParams.get("league_id");
    const forceSync = url.searchParams.get("force") === "true";

    // Get configs to sync
    let query = supabase
      .from("league_sync_config")
      .select("*")
      .eq("enabled", true);

    if (manualLeagueId) {
      query = query.eq("league_id", parseInt(manualLeagueId));
    } else if (!forceSync) {
      // Only sync those that are due
      const now = new Date().toISOString();
      query = query.or(`next_sync_at.is.null,next_sync_at.lte.${now}`);
    }

    const { data: configs, error: configError } = await query;

    if (configError) {
      throw new Error(`Failed to fetch configs: ${configError.message}`);
    }

    if (!configs || configs.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          message: "No leagues to sync at this time",
          results: [],
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    const results: SyncResult[] = [];

    for (const config of configs) {
      const result: SyncResult = {
        league_id: config.league_id,
        league_name: config.league_name,
        season: config.season,
        matches_found: 0,
        matches_synced: 0,
        matches_failed: 0,
        errors: [],
      };

      try {
        // Fetch list of matches for this league with pagination
        console.log(
          `Fetching matches for ${config.league_name} (${config.season})...`,
        );

        const matchesList = await getAllMatchesForLeague(
          apiKey,
          baseUrl,
          config.league_id,
          config.league_name,
          config.season,
          rateLimiter,
        );

        result.matches_found = matchesList.length;
        console.log(
          `Found ${matchesList.length} matches for ${config.league_name} (${config.season})`,
        );

        // Sync each match
        for (const match of matchesList) {
          try {
            const fullMatch = await fetchMatchDetailsWithRateLimit(
              match.id,
              apiKey,
              baseUrl,
              rateLimiter,
            );

            const payload = buildMatchPayload(fullMatch);
            const upsertResult = await upsertMatch(supabase, payload);

            if (upsertResult.success) {
              result.matches_synced++;
              console.log(`✓ Synced match ${match.id}`);
            } else {
              result.matches_failed++;
              result.errors.push({
                match_id: match.id,
                error: upsertResult.error || "Unknown error",
              });
              console.error(
                `✗ Failed to sync match ${match.id}:`,
                upsertResult.error,
              );
            }
          } catch (matchError: unknown) {
            result.matches_failed++;
            const errorMsg =
              matchError instanceof Error
                ? matchError.message
                : String(matchError);
            result.errors.push({ match_id: match.id, error: errorMsg });
            console.error(`✗ Error syncing match ${match.id}:`, errorMsg);
          }
        }

        // Update config with next sync time
        await updateLeagueConfigNextSync(
          supabase,
          config.league_id,
          config.season,
        );

        // Log this sync run
        await logSyncResult(supabase, result);

        results.push(result);

        console.log(
          `Completed sync for ${config.league_name}: ${result.matches_synced} synced, ${result.matches_failed} failed`,
        );
      } catch (leagueError: unknown) {
        const errorMsg =
          leagueError instanceof Error
            ? leagueError.message
            : String(leagueError);
        console.error(`Error syncing league ${config.league_name}:`, errorMsg);

        result.errors.push({
          match_id: "league-level",
          error: `League-level error: ${errorMsg}`,
        });

        await logSyncResult(supabase, result);
        results.push(result);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        results: results,
        summary: {
          total_leagues: results.length,
          total_matches_found: results.reduce(
            (sum, r) => sum + r.matches_found,
            0,
          ),
          total_matches_synced: results.reduce(
            (sum, r) => sum + r.matches_synced,
            0,
          ),
          total_matches_failed: results.reduce(
            (sum, r) => sum + r.matches_failed,
            0,
          ),
        },
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Sync-league error:", message);

    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
