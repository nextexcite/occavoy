import { createHmac, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { AgentDoc, defineDoc } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { canonicalJson } from "@occavoy/storage";
import { pi } from "@rivet-dev/pi";

// Execution policy only. No case result, supplier intent or allowance is committed here.
const Admission = defineDoc({
  kind: "occavoy.fixture-case-admission",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ binding: null, budgetDenied: false }),
  checkpointWhen: () => true,
});

function signature(secret, purpose, value) {
  return createHmac("sha256", secret).update(`${purpose}\0${value}`).digest("hex");
}

export function jobCredential(secret, key) {
  return signature(secret, "fixture-case-access", JSON.stringify(key));
}

function admittedPrompt(secret, binding) {
  return JSON.stringify({ binding, signature: signature(secret, "fixture-case-job", binding) });
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (content?.length !== 1 || content[0].type !== "text")
    throw new Error("Expected one text part");
  return content[0].text;
}

function specFor(task) {
  return {
    tenantId: task.tenantId,
    caseId: task.caseId,
    taskId: task.taskId,
    requestId: task.taskId,
    baseRevision: task.caseRevision,
    briefVersion: task.briefVersion,
    deadlineAt: task.deadline,
    maxModelCalls: task.maxModelCalls,
    maxToolCalls: task.maxToolCalls,
    purpose: "derive_requirements",
    toolProfile: "case_readonly_v1",
  };
}

export function createFixtureCaseJob({ secret, store, ledger, onRead }) {
  const models = createModels();
  const routes = new Map();
  const faux = fauxProvider({
    provider: "occavoy-case-fixture",
    api: "occavoy-case-fixture",
    models: [
      { id: "case-job", input: ["text"], reasoning: false, contextWindow: 8192, maxTokens: 1024 },
    ],
    tokensPerSecond: 0,
  });

  async function current(key) {
    const [tenantId, caseId, taskId] = key;
    const state = await store.getCase(tenantId, caseId);
    const task = state?.activeTask;
    if (
      !task ||
      key.length !== 3 ||
      task.tenantId !== tenantId ||
      task.caseId !== caseId ||
      task.taskId !== taskId ||
      task.caseRevision !== state.revision ||
      task.briefVersion !== state.brief.version ||
      state.cancelRequested ||
      Date.now() >= Date.parse(task.deadline)
    )
      throw new Error("Inactive fixture job");
    return state;
  }

  const root = (c) => c.pi.root(BACKGROUND_CONTEXT);
  async function admission(c) {
    return c.pi.snapshot(Admission, (await root(c)).id, BACKGROUND_CONTEXT);
  }

  // A replay may start before a replacement invoker attaches. Never rely on a
  // callback or counter left in the original coordinator's address space.
  async function reserve(c, kind, prompt) {
    const state = await current(c.key);
    const spec = specFor(state.activeTask);
    const binding = canonicalJson(spec);
    if (
      (await admission(c))?.binding !== binding ||
      (kind === "model_call" && prompt !== admittedPrompt(secret, binding))
    ) {
      throw new Error("Unadmitted fixture input");
    }
    const reservation = await ledger.reserveUsage({
      tenantId: spec.tenantId,
      relationshipId: state.scope.relationshipId,
      caseId: spec.caseId,
      taskId: spec.taskId,
      kind,
      quantity: 1,
      metadata: {
        provider: "scripted-faux",
        requestId: spec.requestId,
        purpose: spec.purpose,
        toolProfile: spec.toolProfile,
      },
    });
    if (!reservation.admitted) {
      const { id } = await root(c);
      await c.pi.commit(async (tx) => {
        (await tx.doc(Admission, id)).budgetDenied = true;
      }, BACKGROUND_CONTEXT);
      throw new Error("Fixture allowance exhausted");
    }
    return current(c.key);
  }

  async function answer(context, options, _state, model) {
    try {
      const c = routes.get(model.id);
      if (!c) throw new Error("Unknown fixture model route");
      const input = context.messages.findLastIndex((m) => m.role === "user");
      const state = await reserve(c, "model_call", textOf(context.messages[input]?.content));
      options?.signal?.throwIfAborted();
      const result = context.messages.slice(input + 1).findLast((m) => m.role === "toolResult");
      if (!result) {
        return fauxAssistantMessage(fauxToolCall("read_case_context", {}), {
          stopReason: "toolUse",
        });
      }
      if (result.isError || result.toolName !== "read_case_context") throw new Error("Read failed");
      const { eventId, city, budget } = JSON.parse(textOf(result.content));
      return fauxAssistantMessage(
        JSON.stringify({
          task: state.activeTask,
          requirements: [
            {
              id: `access-${eventId}`,
              category: "event_access",
              description: `Request access options for ${eventId} in ${city}; brief budget ${budget.amountMinor} minor units ${budget.currency}.`,
            },
          ],
        }),
      );
    } catch {
      return fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "Fixture model refused the turn",
      });
    }
  }

  const routedModels = () => [...routes.keys()].map((id) => ({ ...faux.getModel(), id }));
  models.setProvider({
    ...faux.provider,
    getModels: routedModels,
    getAllModels: routedModels,
    stream: (...args) => {
      faux.appendResponses([answer]);
      return faux.provider.stream(...args);
    },
    streamSimple: (...args) => {
      faux.appendResponses([answer]);
      return faux.provider.streamSimple(...args);
    },
  });
  const release = (c) =>
    c.pi.subscribeClose(() => {
      if (routes.get(c.actorId) === c) routes.delete(c.actorId);
    });

  return pi({
    models,
    documents: [Admission],
    settings: {
      retry: { enabled: false, maxRetries: 0 },
      stream: { maxRetries: 0, timeoutMs: 5000 },
      restartLimit: 2,
      compaction: { enabled: false },
      toolExecution: "sequential",
      afterFailedRun: "withdraw",
    },
    onBeforeConnect(c, params) {
      const actual = Buffer.from(typeof params?.credential === "string" ? params.credential : "");
      const expected = Buffer.from(jobCredential(secret, c.key));
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
        throw new Error("Forbidden");
    },
    conversationCreated: async (tx, conversation) => {
      (await tx.doc(AgentDoc, conversation.id)).maxTurns = 2;
      await tx.doc(Admission, conversation.id);
    },
    onWake: async (c) => {
      routes.set(c.actorId, c);
      await (await root(c)).configure(
        { model: { provider: "occavoy-case-fixture", modelId: c.actorId } },
        BACKGROUND_CONTEXT,
      );
    },
    onSleep: release,
    onDestroy: release,
    actions: {
      admit: async (c, spec) => {
        const binding = canonicalJson(specFor((await current(c.key)).activeTask));
        if (canonicalJson(spec) !== binding)
          throw new Error("Job does not match authorized case task");
        const { id } = await root(c);
        await c.pi.commit(async (tx) => {
          const record = await tx.doc(Admission, id);
          if (record.binding !== null && record.binding !== binding)
            throw new Error("Job admission conflict");
          record.binding = binding;
        }, BACKGROUND_CONTEXT);
        return admittedPrompt(secret, binding);
      },
      budgetDenied: async (c) => (await admission(c))?.budgetDenied === true,
    },
    tools: {
      read_case_context: {
        description:
          "Read this active case's event, destination and budget; never contact a supplier.",
        parameters: obj({}),
        replay: "safe",
        execute: async (c, _args, _api, context) => {
          context.abortSignal.throwIfAborted();
          const { brief, activeTask } = await reserve(c, "tool_call");
          const data = {
            eventId: brief.eventId,
            city: brief.destination.city,
            budget: brief.budget,
          };
          context.abortSignal.throwIfAborted();
          if (await onRead(c.key)) {
            await delay(Math.max(1, Date.parse(activeTask.deadline) - Date.now()), undefined, {
              signal: context.abortSignal,
            });
            throw new Error("Original task deadline reached during read");
          }
          return { output: [{ type: "text", text: JSON.stringify(data) }] };
        },
      },
    },
  });
}
