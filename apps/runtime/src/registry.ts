import { setup } from "rivetkit";
import { createDemoCaseActor } from "./demo-case.js";
import type { readRuntimeConfig } from "./protocol.js";

export function createRuntimeRegistry(config: ReturnType<typeof readRuntimeConfig>) {
  return setup({
    runtime: "native",
    startEngine: config.mode === "local",
    startServices: false,
    use: { demoCase: createDemoCaseActor(config.demoToken) },
  });
}

export type RuntimeRegistry = ReturnType<typeof createRuntimeRegistry>;
