import { createFileRoute } from "@tanstack/react-router";
import { evidenceStorageStatus, getCloudflareContext } from "../../server/cloudflare-context";

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async ({ context }) => {
        const cloudflare = getCloudflareContext(context);
        const env = cloudflare?.env;
        return Response.json(
          {
            ok: true,
            service: "occavoy-web",
            customerMarket: env?.CUSTOMER_MARKET ?? null,
            destinationScope: env?.DESTINATION_SCOPE ?? null,
            accessBoundary: {
              runtimeClientAccess: "server-signed-permissions-only",
              caseGrantSecretConfigured: Boolean(env?.OCCAVOY_WEB_CASE_GRANT_SIGNING_SECRET),
            },
            evidenceStorage: evidenceStorageStatus(env),
          },
          { headers: { "cache-control": "no-store" } },
        );
      },
      ANY: () =>
        Response.json(
          { error: "method_not_allowed" },
          { status: 405, headers: { allow: "GET", "cache-control": "no-store" } },
        ),
    },
  },
});
