import { caseIntakeSchema, type EventRecord } from "@occavoy/domain";
import type {
  CaseAuthority,
  CaseCommand,
  CaseDecision,
  CustomerRelationship,
  createServiceCase,
} from "@occavoy/domain/case-lifecycle";

/**
 * Trusted server context for one activated case. The case identity, actors and
 * deadline come only from this server-resolved grant, never from the request
 * body; the finite step limits are set by the intake policy. A stable grant
 * must return the same case ID and deadline on replay, and the event lookup a
 * stable immutable catalog revision, so a retried request reproduces the
 * identical transaction.
 */
export interface IntakeGrant {
  authority: CaseAuthority;
  relationship: CustomerRelationship;
  approverActorId: string;
  deadline: string;
}

const MAX_BODY_BYTES = 4096;

function respond(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

/** Reads at most `limit` bytes regardless of any Content-Length claim. Null means overflow. */
async function readBounded(request: Request, limit: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Portable intake for the atomic create+activate transaction. This is not a
 * public route registration and provides no production authentication or
 * listener: the host supplies grant resolution, event lookup and the store.
 */
export function createCaseIntakeHandler(deps: {
  resolveGrant(authorization: string | null): Promise<IntakeGrant | null>;
  findEvent(id: string): EventRecord | undefined;
  store: {
    createAndActivateCase(
      input: Parameters<typeof createServiceCase>[0],
      command: Extract<CaseCommand, { kind: "activate" }>,
      context: { authority: CaseAuthority; now: Date },
    ): Promise<{ decision: CaseDecision; deduplicated: boolean }>;
  };
  now?: () => Date;
}): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    if (new URL(request.url).pathname !== "/api/cases") {
      return respond(404, { error: "not_found" });
    }
    if (request.method !== "POST") {
      return Response.json(
        { error: "method_not_allowed" },
        { status: 405, headers: { "cache-control": "no-store", allow: "POST" } },
      );
    }
    const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      return respond(415, { error: "unsupported_media_type" });
    }
    try {
      const authorization = request.headers.get("authorization");
      const grant = await deps.resolveGrant(authorization);
      if (!grant) return respond(401, { error: "unauthenticated" });

      const text = await readBounded(request, MAX_BODY_BYTES);
      if (text === null) return respond(413, { error: "payload_too_large" });
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return respond(400, { error: "invalid_json" });
      }
      const body = caseIntakeSchema.safeParse(parsed);
      if (!body.success) return respond(400, { error: "invalid_body" });
      const { commandId, eventId, budget } = body.data;

      const event = deps.findEvent(eventId);
      if (!event || event.id !== eventId) {
        return respond(422, { error: "unknown_event" });
      }

      const { authority, relationship, deadline, approverActorId } = grant;
      const { tenantId, caseId } = authority;
      const input = {
        caseId,
        relationship,
        sourceEvent: event,
        deadline,
        brief: {
          id: `brief-${caseId}`,
          version: 1,
          eventId: event.id,
          destination: event.destination,
          budget,
          approverActorId,
        },
      };
      const command: Extract<CaseCommand, { kind: "activate" }> = {
        kind: "activate",
        commandId,
        tenantId,
        caseId,
        expectedRevision: 0,
        taskId: `intake-${commandId}`,
        maxModelCalls: 1,
        maxToolCalls: 0,
      };
      const result = await deps.store.createAndActivateCase(input, command, {
        now: deps.now?.() ?? new Date(),
        authority,
      });
      if (result.decision.outcome !== "applied") {
        return respond(500, { error: "internal_error" });
      }
      return respond(202, {
        commandId,
        caseId,
        revision: result.decision.state.revision,
        briefVersion: result.decision.state.brief.version,
        deduplicated: result.deduplicated,
      });
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      const reason = (error as { reason?: unknown })?.reason;
      if (code === "command_payload_conflict") return respond(409, { error: "conflict" });
      if (code === "case_activation_rejected") {
        if (reason === "case_already_exists") return respond(409, { error: "conflict" });
        if (reason === "authority_or_scope_mismatch") return respond(403, { error: "forbidden" });
        return respond(422, { error: "activation_rejected" });
      }
      return respond(500, { error: "internal_error" });
    }
  };
}
