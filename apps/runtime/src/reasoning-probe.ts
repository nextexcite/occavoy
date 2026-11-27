import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, defineDoc, type Harness } from "@earendil-works/pi-durable";
import { int, obj } from "@earendil-works/pi-schema";
import { pi } from "@rivet-dev/pi";
import { UserError } from "rivetkit";
import { createProbeModels } from "./probe-model.js";
import {
  authorizeProbe,
  encodeProbePrompt,
  PROBE_LIMITS,
  type ProbeEnvelope,
  parseProbeRequest,
  probeScope,
} from "./probe-protocol.js";

type ProbeLedger = {
  admission: ProbeEnvelope | null;
  modelAttempts: number;
  toolExecutions: number;
  readStarts: number;
  summaryStarts: number;
  summaryWrites: number;
  summaryTaskId: string | null;
  summary: {
    baseRevision: number;
    origin: string;
    destinations: string[];
    requiresPartnerQuote: boolean;
  } | null;
};

export const ProbeDoc = defineDoc<ProbeLedger>({
  kind: "occavoy.reasoning-probe",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({
    admission: null,
    modelAttempts: 0,
    toolExecutions: 0,
    readStarts: 0,
    summaryStarts: 0,
    summaryWrites: 0,
    summaryTaskId: null,
    summary: null,
  }),
  checkpointWhen: () => true,
});

type ProbeContext = { pi: Harness; key: string[] };

async function root(c: ProbeContext) {
  return c.pi.root(BACKGROUND_CONTEXT);
}

async function takeTool(c: ProbeContext, kind: "read" | "summary") {
  const conversation = await root(c);
  return c.pi.commit(async (tx) => {
    const ledger = await tx.doc(ProbeDoc, conversation.id);
    const admission = ledger.admission;
    if (!admission || admission.scope !== probeScope(c.key))
      throw new Error("No matching job admission.");
    if (Date.now() >= admission.deadlineAt) throw new Error("probe_deadline_exceeded");
    if (ledger.toolExecutions >= PROBE_LIMITS.toolExecutions)
      throw new Error("probe_tool_budget_exhausted");
    ledger.toolExecutions += 1;
    if (kind === "read") ledger.readStarts += 1;
    else ledger.summaryStarts += 1;
    return {
      scenario: admission.scenario,
      deadlineAt: admission.deadlineAt,
      baseRevision: admission.baseRevision,
    };
  }, BACKGROUND_CONTEXT);
}

async function interruptedWait(signal: AbortSignal, deadlineAt: number): Promise<never> {
  const bounded = AbortSignal.any([
    signal,
    AbortSignal.timeout(Math.max(1, deadlineAt - Date.now())),
  ]);
  if (bounded.aborted) throw new Error("probe_interrupted_or_expired");
  return new Promise((_resolve, reject) =>
    bounded.addEventListener("abort", () => reject(new Error("probe_interrupted_or_expired")), {
      once: true,
    }),
  );
}

/** One synthetic AgentTask per [tenant, case, job]. Commercial state remains outside this fixture. */
export function createReasoningProbeActor(secret: string, holdAt?: "safe" | "unsafe") {
  const { models, bindActor, releaseActorAfterClose } = createProbeModels(secret);
  return pi({
    models,
    settings: {
      retry: { enabled: false, maxRetries: 0 },
      stream: { maxRetries: 0, timeoutMs: 5_000 },
      restartLimit: 2,
      compaction: { enabled: false },
      toolExecution: "sequential",
      afterFailedRun: "withdraw",
    },
    options: { actionTimeout: 20_000, sleepGracePeriod: 1_000 },
    documents: [ProbeDoc],
    onBeforeConnect: (c, params: unknown) => {
      const credential =
        params && typeof params === "object"
          ? (params as Record<string, unknown>).credential
          : undefined;
      try {
        authorizeProbe(secret, c.key, credential);
      } catch {
        throw new UserError("Forbidden probe scope.", { code: "forbidden" });
      }
    },
    conversationCreated: async (tx, conversation) => {
      (await tx.doc(AgentDoc, conversation.id)).maxTurns = PROBE_LIMITS.toolRounds;
      await tx.doc(ProbeDoc, conversation.id);
    },
    onWake: async (c) => {
      const conversation = await root(c);
      bindActor(c.actorId, probeScope(c.key), async (envelope) => {
        await c.pi.commit(async (tx) => {
          const ledger = await tx.doc(ProbeDoc, conversation.id);
          if (JSON.stringify(ledger.admission) !== JSON.stringify(envelope))
            throw new Error("Probe model input does not match durable admission.");
          if (Date.now() >= envelope.deadlineAt) throw new Error("probe_deadline_exceeded");
          if (ledger.modelAttempts >= PROBE_LIMITS.modelAttempts)
            throw new Error("probe_model_budget_exhausted");
          ledger.modelAttempts += 1;
        }, BACKGROUND_CONTEXT);
      });
      // The provider route is selected by this actor, never by text in a prompt.
      await conversation.configure(
        { model: { provider: "occavoy-fixture", modelId: c.actorId } },
        BACKGROUND_CONTEXT,
      );
    },
    onSleep: (c) => {
      c.pi.subscribeClose(releaseActorAfterClose(c.actorId));
    },
    onDestroy: (c) => {
      c.pi.subscribeClose(releaseActorAfterClose(c.actorId));
    },
    tools: {
      read_case_context: {
        description: "Read synthetic case context; no external source or supply request.",
        parameters: obj({}),
        replay: "safe",
        execute: async (c, _args, _api, context) => {
          const admission = await takeTool(c, "read");
          if (
            (holdAt === "safe" && admission.scenario === "safe_interrupt") ||
            admission.scenario === "deadline"
          )
            await interruptedWait(context.abortSignal, admission.deadlineAt);
          return {
            output: [
              {
                type: "text",
                text: JSON.stringify({
                  synthetic: true,
                  baseRevision: admission.baseRevision,
                  origin: "Hong Kong",
                  destinations: ["Tokyo", "Paris"],
                  eventCount: 20,
                  supplierQuotes: [],
                }),
              },
            ],
          };
        },
      },
      record_case_summary: {
        description:
          "Record a synthetic structured result receipt. Never contacts a customer or supplier.",
        parameters: obj({ baseRevision: int({ minimum: 1 }) }),
        replay: "unsafe",
        execute: async (c, args, api, context) => {
          const admission = await takeTool(c, "summary");
          if (args.baseRevision !== admission.baseRevision)
            throw new Error("Stale synthetic result revision.");
          const conversation = await root(c);
          await c.pi.commit(async (tx) => {
            const ledger = await tx.doc(ProbeDoc, conversation.id);
            const taskId = JSON.stringify(api.taskId);
            if (ledger.summaryTaskId && ledger.summaryTaskId !== taskId)
              throw new Error("This job already has a result receipt.");
            if (!ledger.summaryTaskId) {
              ledger.summaryTaskId = taskId;
              ledger.summaryWrites += 1;
              ledger.summary = {
                baseRevision: admission.baseRevision,
                origin: "Hong Kong",
                destinations: ["Tokyo", "Paris"],
                requiresPartnerQuote: true,
              };
            }
          }, BACKGROUND_CONTEXT);
          if (holdAt === "unsafe" && admission.scenario === "unsafe_interrupt")
            await interruptedWait(context.abortSignal, admission.deadlineAt);
          return {
            output: [
              { type: "text", text: "Synthetic structured result recorded; no commercial action." },
            ],
          };
        },
      },
    },
    actions: {
      admit: async (c, value: unknown) => {
        const request = parseProbeRequest(value);
        const scope = probeScope(c.key);
        const conversation = await root(c);
        await c.pi.commit(async (tx) => {
          const ledger = await tx.doc(ProbeDoc, conversation.id);
          if (ledger.admission) {
            const { scope: _scope, deadlineAt: _deadline, ...existing } = ledger.admission;
            if (JSON.stringify(existing) !== JSON.stringify(request))
              throw new UserError("The job is already bound to a different request.", {
                code: "command_conflict",
              });
            return;
          }
          ledger.admission = {
            ...request,
            scope,
            deadlineAt:
              Date.now() + (request.scenario === "deadline" ? 1_000 : PROBE_LIMITS.deadlineMs),
          };
        }, BACKGROUND_CONTEXT);
        const ledger = await c.pi.snapshot(ProbeDoc, conversation.id, BACKGROUND_CONTEXT);
        if (!ledger?.admission) throw new Error("Admission was not committed.");
        return {
          requestId: request.requestId,
          prompt: encodeProbePrompt(secret, ledger.admission),
          baseRevision: request.baseRevision,
        };
      },
      probeStatus: async (c) => {
        const conversation = await root(c);
        return {
          demoOnly: true,
          provider: "scripted-faux",
          limits: PROBE_LIMITS,
          ledger: await c.pi.snapshot(ProbeDoc, conversation.id, BACKGROUND_CONTEXT),
        };
      },
    },
  });
}
