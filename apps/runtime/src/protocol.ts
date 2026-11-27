/** Runtime qualification fixture. This is not the production ServiceCase model. */
export type DemoCommand =
  | { commandId: string; kind: "pause" | "resume" }
  | { commandId: string; kind: "submit_input"; text: string };

export type DemoPhase = "pending" | "awaiting_input" | "ready";
export type DemoWaitReason = "client_input" | "paused" | null;

export interface DemoSnapshot {
  phase: DemoPhase;
  waitReason: DemoWaitReason;
  revision: number;
  input: string | null;
}

export class DemoInputError extends Error {}
export class DemoConflictError extends Error {}

export function parseDemoCommand(value: unknown): DemoCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DemoInputError("A command object is required.");
  }
  const v = value as Record<string, unknown>;
  if (typeof v.commandId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(v.commandId)) {
    throw new DemoInputError("commandId must contain 1–80 letters, numbers, _ or -.");
  }
  if (v.kind === "pause" || v.kind === "resume") {
    return { commandId: v.commandId, kind: v.kind };
  }
  if (v.kind === "submit_input" && typeof v.text === "string") {
    const text = v.text.trim();
    if (text.length > 0 && Buffer.byteLength(text, "utf8") <= 2048) {
      return { commandId: v.commandId, kind: v.kind, text };
    }
  }
  throw new DemoInputError("Use pause, resume, or submit_input with 1–2048 UTF-8 bytes.");
}

export function readRuntimeConfig(env: NodeJS.ProcessEnv) {
  const mode = env.OCCAVOY_RUNTIME_MODE ?? "local";
  if (mode !== "local" && mode !== "cloud") {
    throw new Error("OCCAVOY_RUNTIME_MODE must be local or cloud.");
  }
  if (env.NODE_ENV === "production" && mode !== "cloud") {
    throw new Error("Production must explicitly set OCCAVOY_RUNTIME_MODE=cloud.");
  }
  const demoToken = env.OCCAVOY_RUNTIME_DEMO_TOKEN;
  if (!demoToken || demoToken.length < 32) {
    throw new Error("Set OCCAVOY_RUNTIME_DEMO_TOKEN to a private value of at least 32 characters.");
  }
  const port = Number(env.PORT ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer from 1 to 65535.");
  }
  const metricsPort = Number(env.RIVETKIT_METRICS_PORT ?? "9464");
  if (!Number.isInteger(metricsPort) || metricsPort < 1 || metricsPort > 65535) {
    throw new Error("RIVETKIT_METRICS_PORT must be an integer from 1 to 65535.");
  }
  const probeHold = env.OCCAVOY_PROBE_HOLD;
  if (
    probeHold !== undefined &&
    (env.NODE_ENV !== "test" || mode !== "local" || !["safe", "unsafe"].includes(probeHold))
  ) {
    throw new Error("OCCAVOY_PROBE_HOLD is only a local test fault injection.");
  }
  return {
    mode,
    demoToken,
    port,
    metricsPort,
    probeHold: probeHold as "safe" | "unsafe" | undefined,
    databaseUrl: env.DATABASE_URL,
  } as const;
}
