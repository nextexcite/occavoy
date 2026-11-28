import {
  type CaseAuthority,
  type CasePermission,
  casePermissionValues,
} from "@occavoy/domain/case-lifecycle";

export const CASE_PERMISSION_READ = "case.read" as const;

export type CaseAccessPermission = CasePermission;

export type CaseAccessGrantPayload = CaseAuthority & {
  version: 1;
};

export type CaseGrantVerification =
  | { ok: true; grant: CaseAccessGrantPayload }
  | {
      ok: false;
      reason:
        | "malformed"
        | "invalid_signature"
        | "expired"
        | "case_mismatch"
        | "permission_missing";
    };

const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const tokenPartPattern = /^[A-Za-z0-9_-]+$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> | null {
  if (!tokenPartPattern.test(value)) return null;
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

function validId(value: unknown): value is string {
  return typeof value === "string" && idPattern.test(value);
}

function isCasePermission(value: unknown): value is CasePermission {
  return typeof value === "string" && (casePermissionValues as readonly string[]).includes(value);
}

function validatePayload(value: unknown): CaseAccessGrantPayload | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const validUntil = candidate.validUntil;
  const permissions = candidate.permissions;
  if (candidate.version !== 1) return null;
  if (!validId(candidate.grantId)) return null;
  if (!validId(candidate.tenantId)) return null;
  if (!validId(candidate.caseId)) return null;
  if (!validId(candidate.actorId)) return null;
  if (typeof validUntil !== "string" || !Number.isFinite(Date.parse(validUntil))) return null;
  if (
    !Array.isArray(permissions) ||
    permissions.length === 0 ||
    !permissions.every(isCasePermission)
  ) {
    return null;
  }
  return {
    version: 1,
    grantId: candidate.grantId,
    tenantId: candidate.tenantId,
    caseId: candidate.caseId,
    actorId: candidate.actorId,
    permissions: [...permissions],
    validUntil,
  };
}

function signingKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 32)
    throw new Error("Case grant signing secret must be at least 32 characters");
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signCaseAccessGrant(
  payload: CaseAccessGrantPayload,
  secret: string,
): Promise<string> {
  const valid = validatePayload(payload);
  if (!valid) throw new Error("Invalid case access grant payload");
  const body = bytesToBase64Url(encoder.encode(JSON.stringify(valid)));
  const key = await signingKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return `${body}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

export async function verifyCaseAccessGrant(
  token: string,
  secret: string,
  input: { caseId: string; permission: CaseAccessPermission; now?: Date },
): Promise<CaseGrantVerification> {
  const [body, signatureText, extra] = token.split(".");
  if (!body || !signatureText || extra !== undefined) return { ok: false, reason: "malformed" };
  const signature = base64UrlToBytes(signatureText);
  if (!signature) return { ok: false, reason: "malformed" };
  const payloadBytes = base64UrlToBytes(body);
  if (!payloadBytes) return { ok: false, reason: "malformed" };

  const key = await signingKey(secret);
  const signatureValid = await crypto.subtle.verify("HMAC", key, signature, encoder.encode(body));
  if (!signatureValid) return { ok: false, reason: "invalid_signature" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(payloadBytes));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const grant = validatePayload(parsed);
  if (!grant) return { ok: false, reason: "malformed" };
  if (Date.parse(grant.validUntil) <= (input.now ?? new Date()).getTime()) {
    return { ok: false, reason: "expired" };
  }
  if (grant.caseId !== input.caseId) return { ok: false, reason: "case_mismatch" };
  if (!grant.permissions.includes(input.permission))
    return { ok: false, reason: "permission_missing" };
  return { ok: true, grant };
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(header.trim());
  return match?.[1] ?? null;
}
