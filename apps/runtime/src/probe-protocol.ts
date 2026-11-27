import { createHmac, timingSafeEqual } from "node:crypto";

export const PROBE_LIMITS = {
  modelAttempts: 4,
  toolExecutions: 4,
  toolRounds: 3,
  deadlineMs: 60_000,
  inputBytes: 2_048,
  outputBytes: 4_096,
} as const;

export type ProbeScenario =
  | "summary"
  | "safe_interrupt"
  | "unsafe_interrupt"
  | "turn_limit"
  | "deadline";
export type ProbeRequest = { requestId: string; baseRevision: number; scenario: ProbeScenario };
export type ProbeEnvelope = ProbeRequest & { scope: string; deadlineAt: number };

export function probeScope(key: readonly string[]): string {
  if (key.length !== 3 || key.some((part) => !/^[A-Za-z0-9_-]{1,80}$/.test(part))) {
    throw new Error(
      "The reasoning probe key must be [tenant, case, job], with bounded identifiers.",
    );
  }
  return JSON.stringify(key);
}

function sign(secret: string, purpose: string, value: string): string {
  return createHmac("sha256", secret).update(`${purpose}\0${value}`).digest("hex");
}

function equal(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string") return false;
  const bytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return bytes.length === expectedBytes.length && timingSafeEqual(bytes, expectedBytes);
}

/** Backend/test helper. Never give the signing secret to a browser. */
export function createProbeCredential(secret: string, key: readonly string[]): string {
  return sign(secret, "occavoy-probe-access-v1", probeScope(key));
}

export function authorizeProbe(secret: string, key: readonly string[], credential: unknown): void {
  if (!equal(credential, createProbeCredential(secret, key)))
    throw new Error("Forbidden probe scope.");
}

export function parseProbeRequest(input: unknown): ProbeRequest {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("A probe request is required.");
  const value = input as Record<string, unknown>;
  if (typeof value.requestId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(value.requestId))
    throw new Error("Invalid requestId.");
  if (!Number.isSafeInteger(value.baseRevision) || Number(value.baseRevision) < 1)
    throw new Error("Invalid baseRevision.");
  if (
    !["summary", "safe_interrupt", "unsafe_interrupt", "turn_limit", "deadline"].includes(
      String(value.scenario),
    )
  )
    throw new Error("Invalid fixture scenario.");
  return {
    requestId: value.requestId,
    baseRevision: Number(value.baseRevision),
    scenario: value.scenario as ProbeScenario,
  };
}

export function encodeProbePrompt(secret: string, envelope: ProbeEnvelope): string {
  const payload = JSON.stringify(envelope);
  return JSON.stringify({ payload, signature: sign(secret, "occavoy-probe-input-v1", payload) });
}

export function decodeProbePrompt(secret: string, input: string): ProbeEnvelope {
  if (Buffer.byteLength(input, "utf8") > PROBE_LIMITS.inputBytes)
    throw new Error("Probe input exceeds its byte limit.");
  const signed = JSON.parse(input) as Record<string, unknown>;
  if (
    typeof signed.payload !== "string" ||
    !equal(signed.signature, sign(secret, "occavoy-probe-input-v1", signed.payload))
  )
    throw new Error("Only admitted probe input is accepted.");
  const value = JSON.parse(signed.payload) as Record<string, unknown>;
  const request = parseProbeRequest(value);
  if (typeof value.scope !== "string" || !Number.isSafeInteger(value.deadlineAt))
    throw new Error("Invalid admitted probe input.");
  probeScope(JSON.parse(value.scope));
  return { ...request, scope: value.scope, deadlineAt: Number(value.deadlineAt) };
}
