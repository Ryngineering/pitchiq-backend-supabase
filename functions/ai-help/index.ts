import "@supabase/functions-js/edge-runtime.d.ts";
import { createAiHelpHandler } from "./handler.ts";

Deno.serve(createAiHelpHandler());
