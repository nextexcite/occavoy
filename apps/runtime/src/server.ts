import { createServer } from "node:http";
import { readRuntimeConfig } from "./protocol.js";
import { createRuntimeRegistry } from "./registry.js";

const config = readRuntimeConfig(process.env);
const registry = createRuntimeRegistry(config);
registry.start();

// Liveness only: an HTTP 200 does not establish Rivet connectivity or recovery.
const server = createServer((request, response) => {
  if (request.method !== "GET" || request.url !== "/healthz") {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify({ service: "occavoy-runtime", scope: "process", demoOnly: true }));
});
server.listen(config.port, config.mode === "local" ? "127.0.0.1" : "0.0.0.0");

// Rivet installs its own signal-driven drain; close our auxiliary listener too.
process.once("SIGTERM", () => server.close());
process.once("SIGINT", () => server.close());
