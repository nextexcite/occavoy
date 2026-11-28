import { createFileRoute } from "@tanstack/react-router";
import { getCloudflareContext } from "../../../server/cloudflare-context";
import {
  bearerToken,
  CASE_PERMISSION_READ,
  verifyCaseAccessGrant,
} from "../../../server/runtime-access";

function json(status: number, body: Record<string, unknown>, headers?: HeadersInit): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
}

export const Route = createFileRoute("/api/cases/$caseId")({
  server: {
    handlers: {
      GET: async ({ context, params, request }) => {
        const cloudflare = getCloudflareContext(context);
        const secret = cloudflare?.env.OCCAVOY_WEB_CASE_GRANT_SIGNING_SECRET;
        if (!secret) return json(503, { error: "case_access_not_configured" });

        const token = bearerToken(request);
        if (!token) {
          return json(
            401,
            { error: "missing_case_grant" },
            { "www-authenticate": 'Bearer realm="occavoy-case"' },
          );
        }

        const verification = await verifyCaseAccessGrant(token, secret, {
          caseId: params.caseId,
          permission: CASE_PERMISSION_READ,
        });
        if (!verification.ok) {
          const status =
            verification.reason === "invalid_signature" || verification.reason === "malformed"
              ? 401
              : 403;
          return json(status, { error: "case_grant_rejected", reason: verification.reason });
        }

        return json(503, {
          error: "case_runtime_not_connected",
          access: "authorized",
          caseId: params.caseId,
          boundary:
            "The signed permission was accepted server-side; no runtime or business-store credential is exposed to the client.",
        });
      },
      ANY: () => json(405, { error: "method_not_allowed" }, { allow: "GET" }),
    },
  },
});
