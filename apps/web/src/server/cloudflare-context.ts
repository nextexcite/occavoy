export type WebRuntimeEnv = Env & {
  OCCAVOY_WEB_CASE_GRANT_SIGNING_SECRET?: string;
};

export type WebCloudflareContext = {
  env: WebRuntimeEnv;
  executionContext?: ExecutionContext | undefined;
};

export function getCloudflareContext(context: unknown): WebCloudflareContext | null {
  if (typeof context !== "object" || context === null) return null;
  const cloudflare = (context as { cloudflare?: unknown }).cloudflare;
  if (typeof cloudflare !== "object" || cloudflare === null) return null;
  const env = (cloudflare as { env?: unknown }).env;
  if (typeof env !== "object" || env === null) return null;
  return {
    env: env as WebRuntimeEnv,
    executionContext: (cloudflare as { executionContext?: ExecutionContext }).executionContext,
  };
}

export function booleanVar(value: string | undefined): boolean {
  return value?.toLowerCase() === "true";
}

export function evidenceStorageStatus(env: WebRuntimeEnv | undefined) {
  const capacity = Number(env?.R2_CAPACITY_BYTES ?? "8000000000");
  return {
    role: "evidence-only" as const,
    bindingConfigured: Boolean(env?.OCCAVOY_EVIDENCE),
    uploadsEnabled: booleanVar(env?.UPLOADS_ENABLED),
    capacityBytes: Number.isSafeInteger(capacity) ? capacity : null,
  };
}
