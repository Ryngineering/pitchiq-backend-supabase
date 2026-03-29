import { AiMode } from "./types.ts";

const VALID_MODES = new Set<AiMode>(["safe", "value", "contrarian"]);

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function jsonResponse(
  status: number,
  payload: unknown,
  headers?: HeadersInit,
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...(headers ?? {}),
    },
  });
}

export async function parseJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new HttpError(422, "Invalid JSON body.");
  }
}

export function validateInput(body: unknown): {
  matchId: number;
  mode: AiMode;
} {
  if (!body || typeof body !== "object") {
    throw new HttpError(422, "Request body is required.");
  }

  const obj = body as Record<string, unknown>;
  const matchId = Number(obj.matchId);
  const mode = (obj.mode ?? "safe") as AiMode;

  if (!Number.isFinite(matchId) || matchId <= 0) {
    throw new HttpError(422, "matchId must be a positive number.");
  }

  if (!VALID_MODES.has(mode)) {
    throw new HttpError(422, "mode must be one of: safe, value, contrarian.");
  }

  return { matchId: Math.floor(matchId), mode };
}

export function requireBearerToken(req: Request): string {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    throw new HttpError(401, "Missing or invalid Authorization header.");
  }

  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) {
    throw new HttpError(401, "Missing bearer token.");
  }
  return token;
}

export function estimateTokens(payload: unknown): number {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return Math.ceil(text.length / 4);
}

export function guardPromptSize(payload: unknown, capTokens: number): void {
  const estimated = estimateTokens(payload);
  if (estimated > capTokens) {
    throw new HttpError(422, `Prompt too large (${estimated} est tokens).`);
  }
}
