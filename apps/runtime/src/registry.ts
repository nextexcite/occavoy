import { setup } from "rivetkit";
import { createDemoCaseActor } from "./demo-case.js";
import type { readRuntimeConfig } from "./protocol.js";
import { createReasoningProbeActor } from "./reasoning-probe.js";
import {
  type CreateServiceCaseActorOptions,
  createServiceCaseActor,
  type ServiceCaseCoordinator,
} from "./service-case.js";

export function createRuntimeRegistry(
  config: ReturnType<typeof readRuntimeConfig>,
  options?: {
    createServiceCaseCoordinator?: (scope: {
      tenantId: string;
      caseId: string;
    }) => ServiceCaseCoordinator;
  } & Pick<
    CreateServiceCaseActorOptions,
    "piJobInvoker" | "cancelAgentTask" | "requestSupplierQuote" | "staleDispatchMs"
  >,
  additionalActors: NonNullable<Parameters<typeof setup>[0]>["use"] = {},
) {
  const serviceCaseOptions: CreateServiceCaseActorOptions = {};
  if (config.databaseUrl) serviceCaseOptions.databaseUrl = config.databaseUrl;
  if (options?.createServiceCaseCoordinator) {
    serviceCaseOptions.createCoordinator = options.createServiceCaseCoordinator;
  }
  if (options?.piJobInvoker) serviceCaseOptions.piJobInvoker = options.piJobInvoker;
  if (options?.cancelAgentTask) serviceCaseOptions.cancelAgentTask = options.cancelAgentTask;
  if (options?.requestSupplierQuote) {
    serviceCaseOptions.requestSupplierQuote = options.requestSupplierQuote;
  }
  if (options?.staleDispatchMs !== undefined) {
    serviceCaseOptions.staleDispatchMs = options.staleDispatchMs;
  }
  return setup({
    runtime: "native",
    startEngine: config.mode === "local",
    startServices: false,
    use: {
      ...additionalActors,
      demoCase: createDemoCaseActor(config.demoToken),
      reasoningProbe: createReasoningProbeActor(config.demoToken, config.probeHold),
      serviceCase: createServiceCaseActor(config.demoToken, serviceCaseOptions),
    },
  });
}

export type RuntimeRegistry = ReturnType<typeof createRuntimeRegistry>;
