import {
  type AssistantMessage,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Model,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { decodeProbePrompt, PROBE_LIMITS, type ProbeEnvelope } from "./probe-protocol.js";

export type ModelAdmission = (envelope: ProbeEnvelope) => Promise<void>;

function userText(context: TranscriptContext): string {
  const message = context.messages.findLast((item) => item.role === "user");
  if (message?.role !== "user") throw new Error("Missing probe input.");
  return typeof message.content === "string"
    ? message.content
    : message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** Scripted model provider, not a scripted replacement for the agent runtime. */
export function createProbeModels(secret: string) {
  const owners = new Map<string, { scope: string; admit: ModelAdmission; model: Model<string> }>();
  const faux = fauxProvider({
    provider: "occavoy-fixture",
    api: "occavoy-fixture",
    models: [
      {
        id: "reasoning-probe",
        input: ["text"],
        reasoning: false,
        contextWindow: 32_768,
        maxTokens: 256,
      },
    ],
    tokensPerSecond: 0,
  });
  const answer = async (
    context: TranscriptContext,
    _options: unknown,
    _state: unknown,
    model: Model<string>,
  ): Promise<AssistantMessage> => {
    try {
      const envelope = decodeProbePrompt(secret, userText(context));
      const owner = owners.get(model.id);
      if (!owner || owner.scope !== envelope.scope)
        throw new Error("Model input belongs to another actor scope.");
      // Persistent reservation is at the provider boundary; hook errors cannot bypass it.
      await owner.admit(envelope);
      const lastUser = context.messages.findLastIndex((item) => item.role === "user");
      const results = context.messages
        .slice(lastUser + 1)
        .filter((item) => item.role === "toolResult");
      const error = results.find((item) => item.isError);
      let response: AssistantMessage;
      if (error) {
        response = fauxAssistantMessage(
          "Synthetic result requires review: a tool was interrupted or refused. No external action was taken.",
        );
      } else if (results.length === 0 || envelope.scenario === "turn_limit") {
        response = fauxAssistantMessage(fauxToolCall("read_case_context", {}), {
          stopReason: "toolUse",
        });
      } else if (!results.some((item) => item.toolName === "record_case_summary")) {
        response = fauxAssistantMessage(
          fauxToolCall("record_case_summary", { baseRevision: envelope.baseRevision }),
          { stopReason: "toolUse" },
        );
      } else {
        response = fauxAssistantMessage(
          "Synthetic Hong Kong case reviewed; global destination context retained. Supplier quotes and customer approval are still required.",
        );
      }
      if (Buffer.byteLength(JSON.stringify(response.content), "utf8") > PROBE_LIMITS.outputBytes)
        throw new Error("Probe output exceeds its byte limit.");
      return response;
    } catch (error) {
      return fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: error instanceof Error ? error.message : "Probe model admission failed.",
      });
    }
  };
  const provider = {
    ...faux.provider,
    getModels: () => [...owners.values()].map((owner) => owner.model),
    getAllModels: () => [...owners.values()].map((owner) => owner.model),
    stream: (...args: Parameters<typeof faux.provider.stream>) => {
      faux.appendResponses([answer]);
      return faux.provider.stream(...args);
    },
    streamSimple: (...args: Parameters<typeof faux.provider.streamSimple>) => {
      faux.appendResponses([answer]);
      return faux.provider.streamSimple(...args);
    },
  };
  const models = createModels();
  models.setProvider(provider);
  return {
    models,
    bindActor: (actorId: string, scope: string, admit: ModelAdmission) => {
      owners.set(actorId, { scope, admit, model: { ...faux.getModel(), id: actorId } });
    },
    releaseActorAfterClose: (actorId: string) => {
      const owner = owners.get(actorId);
      return () => {
        if (owners.get(actorId) === owner) owners.delete(actorId);
      };
    },
  };
}
