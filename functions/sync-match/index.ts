// supabase/functions/sync-match/index.ts

import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import {
  buildMatchPayload,
  upsertMatch,
  RateLimiter,
  fetchMatchDetailsWithRateLimit,
} from "../lib/matchSyncUtils.ts";

Deno.serve(async (req: Request) => {
  try {
    const { matchId } = await req.json();

    // Create a Supabase client using the service role key for server-side operations
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, // use service role for server-side
    );

    const apiBaseUrl = Deno.env.get("CRICKET_API_BASE_URL")!;
    const apiKey = Deno.env.get("HIGHLIGHTLY_API_KEY")!;
    const rateLimiter = new RateLimiter(200); // 200ms between calls

    const match = await fetchMatchDetailsWithRateLimit(
      matchId,
      apiKey,
      apiBaseUrl,
      rateLimiter,
    );

    const payload = buildMatchPayload(match);
    const result = await upsertMatch(supabase, payload);

    if (!result.success) {
      throw new Error(result.error);
    }

    console.log("Upserted match:", result.data);

    return new Response(
      JSON.stringify({
        success: true,
        data: result.data,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
