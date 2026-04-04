import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type RegistrationPayload = {
  phone?: string;
  password?: string;
  firstName?: string;
  lastName?: string;
  inviteCode?: string;
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

function normalizePhone(phone: string | undefined) {
  return String(phone ?? "")
    .replace(/[^\d+]/g, "")
    .trim();
}

async function sha256(input: string) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const arr = Array.from(new Uint8Array(digest));
  return arr.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function parseIpAddress(req: Request) {
  const forwarded = req.headers.get("x-forwarded-for") ?? "";
  const first = forwarded.split(",")[0]?.trim();
  return first || req.headers.get("x-real-ip") || "unknown";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const inviteCodePepper = Deno.env.get("PHONE_REGISTRATION_CODE_PEPPER") ?? "";

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Server configuration is incomplete" }, 500);
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  let payload: RegistrationPayload;

  try {
    payload = (await req.json()) as RegistrationPayload;
  } catch {
    return jsonResponse({ error: "Invalid request payload" }, 400);
  }

  const phone = normalizePhone(payload.phone);
  const password = String(payload.password ?? "").trim();
  const firstName = String(payload.firstName ?? "").trim();
  const lastName = String(payload.lastName ?? "").trim();
  const inviteCode = String(payload.inviteCode ?? "").trim();
  const fullName = `${firstName} ${lastName}`.trim();
  const ipAddress = parseIpAddress(req);

  if (!phone || !password || !firstName || !lastName || !inviteCode) {
    return jsonResponse({ error: "Missing required registration fields" }, 400);
  }

  const nowIso = new Date().toISOString();

  const { data: control, error: controlError } = await adminClient
    .from("phone_registration_control")
    .select(
      "enabled, window_start, window_end, invite_code_hash, max_attempts_per_ip_per_hour, max_attempts_per_phone_per_hour",
    )
    .eq("id", 1)
    .maybeSingle();

  if (controlError || !control) {
    await adminClient.from("phone_registration_attempts").insert({
      phone_number: phone,
      ip_address: ipAddress,
      success: false,
      failure_reason: "configuration_missing",
    });

    return jsonResponse(
      { error: "Registration is currently unavailable" },
      503,
    );
  }

  const windowStart = control.window_start
    ? new Date(control.window_start)
    : null;
  const windowEnd = control.window_end ? new Date(control.window_end) : null;
  const now = new Date(nowIso);

  const isWindowOpen =
    control.enabled &&
    (!windowStart || now >= windowStart) &&
    (!windowEnd || now <= windowEnd);

  if (!isWindowOpen) {
    await adminClient.from("phone_registration_attempts").insert({
      phone_number: phone,
      ip_address: ipAddress,
      success: false,
      failure_reason: "registration_closed",
    });

    return jsonResponse({ error: "Registration is currently closed" }, 403);
  }

  const oneHourAgoIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const [ipCountRes, phoneCountRes] = await Promise.all([
    adminClient
      .from("phone_registration_attempts")
      .select("id", { count: "exact", head: true })
      .eq("ip_address", ipAddress)
      .gte("created_at", oneHourAgoIso),
    adminClient
      .from("phone_registration_attempts")
      .select("id", { count: "exact", head: true })
      .eq("phone_number", phone)
      .gte("created_at", oneHourAgoIso),
  ]);

  const ipCount = ipCountRes.count ?? 0;
  const phoneCount = phoneCountRes.count ?? 0;

  if (
    ipCount >= (control.max_attempts_per_ip_per_hour ?? 20) ||
    phoneCount >= (control.max_attempts_per_phone_per_hour ?? 10)
  ) {
    await adminClient.from("phone_registration_attempts").insert({
      phone_number: phone,
      ip_address: ipAddress,
      success: false,
      failure_reason: "rate_limited",
    });

    return jsonResponse({ error: "Too many attempts. Try again later." }, 429);
  }

  const providedHash = await sha256(`${inviteCodePepper}:${inviteCode}`);

  if (!control.invite_code_hash || providedHash !== control.invite_code_hash) {
    await adminClient.from("phone_registration_attempts").insert({
      phone_number: phone,
      ip_address: ipAddress,
      success: false,
      failure_reason: "invalid_code",
    });

    return jsonResponse({ error: "Invalid invite code" }, 403);
  }

  const { data: created, error: createError } =
    await adminClient.auth.admin.createUser({
      phone,
      password,
      phone_confirm: true,
      user_metadata: {
        first_name: firstName,
        last_name: lastName,
        name: fullName,
        full_name: fullName,
        phone,
      },
    });

  if (createError || !created?.user?.id) {
    await adminClient.from("phone_registration_attempts").insert({
      phone_number: phone,
      ip_address: ipAddress,
      success: false,
      failure_reason: "create_user_failed",
    });

    const status = String(createError?.message ?? "")
      .toLowerCase()
      .includes("already")
      ? 409
      : 400;
    return jsonResponse(
      { error: createError?.message ?? "Registration failed" },
      status,
    );
  }

  const { error: profileError } = await adminClient
    .from("user_profile")
    .update({
      display_name: fullName,
      phone_number: phone,
      updated_at: nowIso,
    })
    .eq("id", created.user.id);

  if (profileError) {
    await adminClient.from("phone_registration_attempts").insert({
      phone_number: phone,
      ip_address: ipAddress,
      success: false,
      failure_reason: "profile_update_failed",
    });

    return jsonResponse(
      { error: "Registration completed, but profile setup failed" },
      500,
    );
  }

  await adminClient.from("phone_registration_attempts").insert({
    phone_number: phone,
    ip_address: ipAddress,
    success: true,
    failure_reason: null,
  });

  return jsonResponse({
    success: true,
    message: "Registration submitted successfully",
  });
});
