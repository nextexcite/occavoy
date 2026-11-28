import handler from "@tanstack/react-start/server-entry";

declare module "@tanstack/react-start" {
  interface Register {
    server: {
      requestContext: {
        cloudflare: {
          env: Env;
          executionContext: ExecutionContext;
        };
      };
    };
  }
}

export default {
  async fetch(request, env, executionContext) {
    return handler.fetch(request, {
      context: { cloudflare: { env, executionContext } },
    });
  },
} satisfies ExportedHandler<Env>;
