import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type AdminConfigPayload = {
  action?: "get" | "update";
  enabled?: boolean;
  windowStart?: string | null;
  windowEnd?: string | null;
  inviteCode?: string | null;
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
    },
  });
}

async function sha256(input: string) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const arr = Array.from(new Uint8Array(digest));
  return arr.map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function assertAdmin(
  supabaseUrl: string,
  anonKey: string,
  accessToken: string,
) {
  const userClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });

  const [
    { data: adminStatus, error: isAdminError },
    { data: userData, error: userError },
  ] = await Promise.all([
    userClient.rpc("is_admin"),
    userClient.auth.getUser(),
  ]);

  if (isAdminError || userError || !adminStatus || !userData.user?.id) {
    return { ok: false, userId: null };
  }

  return { ok: true, userId: userData.user.id };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey =
    Deno.env.get("SUPABASE_ANON_KEY") ??
    Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const inviteCodePepper = Deno.env.get("PHONE_REGISTRATION_CODE_PEPPER") ?? "";

  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return jsonResponse({ error: "Server configuration is incomplete" }, 500);
  }

  const authHeader = req.headers.get("authorization") ?? "";
  const accessToken = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : "";

  if (!accessToken) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const adminCheck = await assertAdmin(supabaseUrl, anonKey, accessToken);

  if (!adminCheck.ok || !adminCheck.userId) {
    return jsonResponse({ error: "Forbidden" }, 403);
  }

  let payload: AdminConfigPayload;

  try {
    payload = (await req.json()) as AdminConfigPayload;
  } catch {
    return jsonResponse({ error: "Invalid request payload" }, 400);
  }

  const action = payload.action ?? "get";

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  if (action === "get") {
    const { data, error } = await adminClient
      .from("phone_registration_control")
      .select(
        "enabled, window_start, window_end, max_attempts_per_ip_per_hour, max_attempts_per_phone_per_hour, updated_at",
      )
      .eq("id", 1)
      .maybeSingle();

    if (error || !data) {
      return jsonResponse({ error: "Unable to load registration config" }, 500);
    }

    return jsonResponse({
      enabled: Boolean(data.enabled),
      windowStart: data.window_start,
      windowEnd: data.window_end,
      maxAttemptsPerIpPerHour: data.max_attempts_per_ip_per_hour,
      maxAttemptsPerPhonePerHour: data.max_attempts_per_phone_per_hour,
      updatedAt: data.updated_at,
    });
  }

  if (action !== "update") {
    return jsonResponse({ error: "Unknown action" }, 400);
  }

  const nowIso = new Date().toISOString();
  const updatePayload: Record<string, unknown> = {
    id: 1,
    enabled: Boolean(payload.enabled),
    window_start: payload.windowStart || null,
    window_end: payload.windowEnd || null,
    updated_by: adminCheck.userId,
    updated_at: nowIso,
  };

  if (payload.inviteCode && payload.inviteCode.trim().length > 0) {
    updatePayload.invite_code_hash = await sha256(
      `${inviteCodePepper}:${payload.inviteCode.trim()}`,
    );
  }

  const { data, error } = await adminClient
    .from("phone_registration_control")
    .upsert(updatePayload, { onConflict: "id" })
    .select(
      "enabled, window_start, window_end, max_attempts_per_ip_per_hour, max_attempts_per_phone_per_hour, updated_at",
    )
    .single();

  if (error || !data) {
    return jsonResponse({ error: "Unable to update registration config" }, 500);
  }

  return jsonResponse({
    enabled: Boolean(data.enabled),
    windowStart: data.window_start,
    windowEnd: data.window_end,
    maxAttemptsPerIpPerHour: data.max_attempts_per_ip_per_hour,
    maxAttemptsPerPhonePerHour: data.max_attempts_per_phone_per_hour,
    updatedAt: data.updated_at,
  });
});
