import { describe, expect, it } from "vitest";
import {
  type CaseAuthority,
  type CaseCommand,
  type CaseCommandBody,
  type CaseDecision,
  type CaseSnapshot,
  checkProposalApproval,
  createFollowupCase,
  createServiceCase,
  decideCase,
  runCaseJourneyFixture,
} from "../src/case-lifecycle";
import { demoEvents } from "../src/index";

const now = new Date("2027-01-01T12:00:00Z");

function fixture() {
  const journey = runCaseJourneyFixture();
  const closed = journey.closedCase;
  const state = createServiceCase({
    relationship: journey.relationship,
    caseId: closed.scope.caseId,
    sourceEvent: closed.sourceEvent,
    brief: closed.brief,
    deadline: closed.deadline,
  });
  const authority: CaseAuthority = {
    tenantId: state.scope.tenantId,
    caseId: state.scope.caseId,
    actorId: "payer-fixture",
    grantId: "fixture-grant",
    permissions: [
      "case.edit",
      "agent.result",
      "supply.request",
      "supply.record",
      "proposal.write",
      "proposal.approve",
      "handoff.dispatch",
      "action.reconcile",
      "fulfillment.record",
      "case.close",
    ],
    validUntil: "2027-01-10T12:00:00Z",
  };
  return { journey, state, authority };
}

function command(state: CaseSnapshot, body: CaseCommandBody): CaseCommand {
  return {
    commandId: `command-${state.revision + 1}`,
    tenantId: state.scope.tenantId,
    caseId: state.scope.caseId,
    expectedRevision: state.revision,
    ...body,
  };
}

function apply(state: CaseSnapshot, body: CaseCommandBody, authority: CaseAuthority): CaseDecision {
  return decideCase(state, command(state, body), { now, authority });
}

function atApprovedCase() {
  const result = fixture();
  const state = structuredClone(result.journey.closedCase);
  state.phase = "fulfilling";
  state.waitReason = null;
  state.action = null;
  state.booking = "not_submitted";
  state.payment = "unobserved";
  state.fulfillment = "pending";
  state.paymentEvidence = null;
  state.fulfillmentEvidence = null;
  state.outcome = null;
  return { ...result, state };
}

describe("finite cases and bounded candidate work", () => {
  it("requires activation; rejecting a cross-tenant command produces no work", () => {
    const { state, authority } = fixture();
    expect(state.phase).toBe("draft");
    expect(state.activeTask).toBeNull();
    const result = apply(
      state,
      { kind: "activate", taskId: "t1", maxModelCalls: 2, maxToolCalls: 3 },
      {
        ...authority,
        tenantId: "other-tenant",
      },
    );
    expect(result.reason).toBe("authority_or_scope_mismatch");
    expect(result.state).toBe(state);
    expect(result.intents).toEqual([]);
  });

  it("ignores an old AI result after a newer brief, even with a fresh command envelope", () => {
    const { state, authority } = fixture();
    const activated = apply(
      state,
      { kind: "activate", taskId: "t1", maxModelCalls: 2, maxToolCalls: 3 },
      authority,
    );
    expect(activated.outcome).toBe("applied");
    expect(activated.intents[0]?.kind).toBe("run_agent_task");
    const oldTask = activated.state.activeTask;
    expect(oldTask).not.toBeNull();
    if (!oldTask) throw new Error("Missing fixture task");
    const revised = apply(
      activated.state,
      {
        kind: "revise_brief",
        brief: { ...state.brief, version: 2, budget: { amountMinor: 90000, currency: "GBP" } },
      },
      authority,
    );
    const late = apply(
      revised.state,
      {
        kind: "agent_candidate",
        candidate: {
          task: oldTask,
          requirements: [
            { id: "hotel", category: "accommodation", description: "Late suggestion" },
          ],
        },
      },
      authority,
    );
    expect(late).toMatchObject({
      outcome: "ignored",
      reason: "stale_agent_candidate",
      intents: [],
    });
    expect(late.state.brief.version).toBe(2);
    expect(late.state.requirements).toEqual([]);
  });

  it("records a stopped task as intervention evidence, fenced by permission and task identity", () => {
    const { state, authority } = fixture();
    const started = apply(
      state,
      { kind: "activate", taskId: "t1", maxModelCalls: 2, maxToolCalls: 3 },
      authority,
    );
    const task = started.state.activeTask;
    if (!task) throw new Error("Missing fixture task");
    const stopAuthority = { ...authority, permissions: ["agent.stop" as const] };

    // The candidate/result grant does not subsume stop authority and vice versa.
    const unauthorized = apply(
      started.state,
      { kind: "agent_task_stopped", task, reason: "budget_exhausted" },
      authority,
    );
    expect(unauthorized).toMatchObject({
      outcome: "rejected",
      reason: "authority_or_scope_mismatch",
    });
    expect(unauthorized.state.activeTask).toEqual(task);

    const wrongTask = apply(
      started.state,
      {
        kind: "agent_task_stopped",
        task: { ...task, taskId: "someone-elses-task" },
        reason: "budget_exhausted",
      },
      stopAuthority,
    );
    expect(wrongTask).toMatchObject({ outcome: "ignored", reason: "stale_agent_task" });
    expect(wrongTask.state.activeTask).toEqual(task);

    // An unexpired deadline cannot be recorded as expired.
    const premature = apply(
      started.state,
      { kind: "agent_task_stopped", task, reason: "deadline_exceeded" },
      stopAuthority,
    );
    expect(premature).toMatchObject({ outcome: "rejected", reason: "agent_task_not_expired" });

    const stopped = apply(
      started.state,
      { kind: "agent_task_stopped", task, reason: "budget_exhausted" },
      stopAuthority,
    );
    expect(stopped.outcome).toBe("applied");
    expect(stopped.state.phase).toBe("clarifying");
    expect(stopped.state.waitReason).toBe("agent_intervention");
    expect(stopped.state.activeTask).toBeNull();
    expect(stopped.state.lastAgentTaskStop).toEqual({
      taskId: "t1",
      reason: "budget_exhausted",
    });
    // Commercial state is untouched: no outcome, no approval, no causal rewrite.
    expect(stopped.state.outcome).toBeNull();
    expect(stopped.intents).toEqual([]);

    // A repeated stop for the same task is evidence-free noise, not a failure.
    const repeated = apply(
      stopped.state,
      { kind: "agent_task_stopped", task, reason: "budget_exhausted" },
      stopAuthority,
    );
    expect(repeated).toMatchObject({ outcome: "ignored", reason: "stale_agent_task" });

    // Intervention does not grant the candidate permission any new power.
    const lateCandidate = apply(
      stopped.state,
      {
        kind: "agent_candidate",
        candidate: {
          task,
          requirements: [{ id: "hotel", category: "accommodation", description: "Late result" }],
        },
      },
      authority,
    );
    expect(lateCandidate).toMatchObject({ outcome: "ignored", reason: "stale_agent_candidate" });
  });

  it("a candidate-only runtime grant cannot approve a purchase", () => {
    const { state, authority } = atApprovedCase();
    state.phase = "awaiting_approval";
    const approval = state.approval;
    if (!approval) throw new Error("Missing fixture approval");
    state.approval = null;
    const result = apply(
      state,
      { kind: "approve_proposal", approval },
      {
        ...authority,
        permissions: ["agent.result"],
      },
    );
    expect(result.reason).toBe("authority_or_scope_mismatch");
    expect(result.intents).toEqual([]);
  });

  it.each(["taskId", "tenantId", "caseId"] as const)(
    "does not accept an agent candidate with a different %s",
    (field) => {
      const { state, authority } = fixture();
      const started = apply(
        state,
        { kind: "activate", taskId: "t1", maxModelCalls: 2, maxToolCalls: 3 },
        authority,
      );
      const task = started.state.activeTask;
      if (!task) throw new Error("Missing fixture task");
      const result = apply(
        started.state,
        {
          kind: "agent_candidate",
          candidate: {
            task: { ...task, [field]: "different" },
            requirements: [
              { id: "hotel", category: "accommodation", description: "Unscoped candidate" },
            ],
          },
        },
        authority,
      );
      expect(result).toMatchObject({
        outcome: "ignored",
        reason: "stale_agent_candidate",
        intents: [],
      });
      expect(result.state).toBe(started.state);
    },
  );
});

describe("asynchronous quote observations", () => {
  it("does not let a duplicate or conflicting quote rewrite immutable terms", () => {
    const { state, authority } = atApprovedCase();
    const quote = state.quotes[0];
    if (!quote) throw new Error("Missing fixture quote");
    expect(apply(state, { kind: "record_quote", quote }, authority)).toMatchObject({
      outcome: "ignored",
      reason: "duplicate_quote",
      intents: [],
    });
    const reordered = Object.fromEntries(Object.entries(quote).reverse()) as typeof quote;
    expect(apply(state, { kind: "record_quote", quote: reordered }, authority).reason).toBe(
      "duplicate_quote",
    );
    expect(
      apply(
        state,
        { kind: "record_quote", quote: { ...quote, total: { ...quote.total, amountMinor: 1 } } },
        authority,
      ),
    ).toMatchObject({
      outcome: "rejected",
      reason: "immutable_quote_conflict",
      intents: [],
    });
  });

  it("ignores a reply against a different brief revision", () => {
    const { state, authority } = atApprovedCase();
    const quote = state.quotes[0];
    if (!quote) throw new Error("Missing fixture quote");
    const result = apply(
      state,
      { kind: "record_quote", quote: { ...quote, briefVersion: 2 } },
      authority,
    );
    expect(result).toMatchObject({
      outcome: "ignored",
      reason: "stale_or_unscoped_quote",
      intents: [],
    });
    expect(result.state).toBe(state);
  });

  it("a late quote cannot remove an UNKNOWN reconciliation wait", () => {
    const { state, authority } = atApprovedCase();
    const quote = state.quotes[0];
    if (!quote) throw new Error("Missing fixture quote");
    const sent = apply(
      state,
      { kind: "dispatch_handoff", actionId: "a", clientReference: "ref", requestHash: "hash" },
      authority,
    );
    const unknown = apply(
      sent.state,
      { kind: "handoff_unknown", actionId: "a", evidenceRef: "synthetic:timeout" },
      authority,
    );
    const result = apply(
      unknown.state,
      { kind: "record_quote", quote: { ...quote, version: 2 } },
      authority,
    );
    expect(result).toMatchObject({
      outcome: "ignored",
      reason: "quote_after_handoff",
      intents: [],
    });
    expect(result.state.waitReason).toBe("reconciliation");
  });
});

describe("immutable proposal and exact approval", () => {
  it.each([
    { total: { amountMinor: 30001, currency: "GBP" } },
    { total: { amountMinor: 30000, currency: "USD" } },
    { termsHash: "different-terms" },
    { proposalVersion: 2 },
    { validUntil: "2027-01-03T12:00:00Z" },
    {
      scope: { kind: "supplier_handoff" as const, supplierId: "other", lineIds: ["quote-fixture"] },
    },
  ])("rejects altered approved terms: %j", (changes) => {
    const { state } = atApprovedCase();
    const proposal = state.proposals[0];
    const approval = state.approval;
    expect(proposal).toBeDefined();
    expect(approval).not.toBeNull();
    if (!proposal || !approval) throw new Error("Missing fixture approval");
    expect(checkProposalApproval(proposal, { ...approval, ...changes }, now)).toEqual({
      ok: false,
      reason: "approval_terms_mismatch",
    });
  });

  it("requires the authenticated approving actor and grant, not a supplied name", () => {
    const { state, authority } = atApprovedCase();
    state.phase = "awaiting_approval";
    const approval = state.approval;
    if (!approval) throw new Error("Missing fixture approval");
    state.approval = null;
    const wrongActor = apply(
      state,
      { kind: "approve_proposal", approval },
      { ...authority, actorId: "operator" },
    );
    expect(wrongActor.reason).toBe("approval_authority_mismatch");
    const wrongGrant = apply(
      state,
      { kind: "approve_proposal", approval },
      { ...authority, grantId: "other-grant" },
    );
    expect(wrongGrant.reason).toBe("approval_authority_mismatch");
  });

  it("preserves old terms when staging v2, and does not inherit approval", () => {
    const { state, authority } = atApprovedCase();
    const original = structuredClone(state);
    const previous = state.proposals[0];
    if (!previous) throw new Error("Missing fixture proposal");
    const result = apply(
      state,
      {
        kind: "stage_proposal",
        proposal: { ...previous, version: 2, termsHash: "synthetic:terms-v2" },
      },
      authority,
    );
    expect(result.outcome).toBe("applied");
    expect(result.state.proposals.map((p) => p.version)).toEqual([1, 2]);
    expect(result.state.proposals[0]).toEqual(previous);
    expect(result.state.approval).toBeNull();
    expect(state).toEqual(original);
  });

  it("rechecks expiry at dispatch, even after an earlier valid approval", () => {
    const { state, authority } = atApprovedCase();
    const result = decideCase(
      state,
      command(state, {
        kind: "dispatch_handoff",
        actionId: "a",
        clientReference: "ref",
        requestHash: "hash",
      }),
      { now: new Date("2027-01-02T12:00:00Z"), authority },
    );
    expect(result.reason).toBe("approval_expired_or_invalid");
    expect(result.intents).toEqual([]);
    expect(result.state.action).toBeNull();
  });
});

describe("uncertain external action and independent commercial observations", () => {
  it("a late UNKNOWN or unresolved lookup cannot regress a confirmed action", () => {
    const { journey, authority } = fixture();
    const state = structuredClone(journey.closedCase);
    state.phase = "fulfilling";
    state.outcome = null;
    const unknown = apply(
      state,
      {
        kind: "handoff_unknown",
        actionId: "action-fixture",
        evidenceRef: "synthetic:late-timeout",
      },
      authority,
    );
    expect(unknown).toMatchObject({
      outcome: "rejected",
      reason: "action_not_dispatching",
      intents: [],
    });
    const unresolved = apply(
      state,
      {
        kind: "reconcile_handoff",
        actionId: "action-fixture",
        result: "unresolved",
        source: "operator_verified",
        evidenceRef: "synthetic:late-review",
        providerReference: null,
      },
      authority,
    );
    expect(unresolved).toMatchObject({
      outcome: "rejected",
      reason: "action_not_reconcilable",
      intents: [],
    });
    expect(state.action?.status).toBe("confirmed");
  });

  it("UNKNOWN and an unresolved operator review never enable resubmission", () => {
    const journey = runCaseJourneyFixture();
    const unknown = journey.trace.find((step) => step.command === "handoff_unknown");
    const retry = journey.trace.find((step) => step.command === "retry_handoff");
    expect(unknown).toMatchObject({ waitReason: "reconciliation", booking: "pending" });
    expect(retry).toMatchObject({
      outcome: "rejected",
      reason: "reconciliation_required",
      intents: [],
    });
    const operatorReview = journey.trace.find((step) => step.command === "reconcile_handoff");
    expect(operatorReview).toMatchObject({ waitReason: "reconciliation", booking: "pending" });
    expect(journey.trace.filter((step) => step.intents.includes("supplier_handoff"))).toHaveLength(
      1,
    );
    expect(journey.closedCase.action).toMatchObject({
      id: "action-fixture",
      attempts: 1,
      status: "confirmed",
    });
  });

  it("a payment observation neither confirms a booking nor fulfills the service", () => {
    const journey = runCaseJourneyFixture();
    expect(journey.trace.find((step) => step.command === "record_payment")).toMatchObject({
      payment: "paid",
      booking: "pending",
      fulfillment: "pending",
      waitReason: "reconciliation",
    });
    expect(
      journey.trace.filter((step) => step.command === "reconcile_handoff").at(-1),
    ).toMatchObject({
      booking: "confirmed",
      fulfillment: "pending",
    });
  });

  it("only verified nonexecution permits retry with the original reference", () => {
    const { state, authority } = atApprovedCase();
    const sent = apply(
      state,
      {
        kind: "dispatch_handoff",
        actionId: "a",
        clientReference: "stable-ref",
        requestHash: "stable-hash",
      },
      authority,
    );
    const unknown = apply(
      sent.state,
      { kind: "handoff_unknown", actionId: "a", evidenceRef: "synthetic:timeout" },
      authority,
    );
    const resolved = apply(
      unknown.state,
      {
        kind: "reconcile_handoff",
        actionId: "a",
        result: "not_executed",
        source: "provider_lookup",
        evidenceRef: "synthetic:definitive-nonexecution",
        providerReference: null,
      },
      authority,
    );
    const retry = apply(resolved.state, { kind: "retry_handoff", actionId: "a" }, authority);
    expect(retry.outcome).toBe("applied");
    expect(retry.state.action).toMatchObject({
      id: "a",
      clientReference: "stable-ref",
      requestHash: "stable-hash",
      attempts: 2,
    });
    expect(retry.intents).toHaveLength(1);
    expect(apply(unknown.state, { kind: "close", outcome: "unavailable" }, authority).reason).toBe(
      "external_obligation_unresolved",
    );
  });
});

describe("cancellation is a fence, not an external rollback", () => {
  it("cancels a running candidate task and refuses its late result", () => {
    const { state, authority } = fixture();
    const started = apply(
      state,
      { kind: "activate", taskId: "t1", maxModelCalls: 2, maxToolCalls: 3 },
      authority,
    );
    const task = started.state.activeTask;
    if (!task) throw new Error("Missing fixture task");
    const cancelled = apply(
      started.state,
      { kind: "cancel", reason: "Customer changed plans" },
      authority,
    );
    expect(cancelled.state).toMatchObject({
      phase: "closed",
      outcome: "cancelled",
      activeTask: null,
    });
    expect(cancelled.intents).toEqual([{ kind: "cancel_agent_task", task }]);
    const late = apply(
      cancelled.state,
      {
        kind: "agent_candidate",
        candidate: {
          task,
          requirements: [{ id: "hotel", category: "accommodation", description: "Late result" }],
        },
      },
      authority,
    );
    expect(late).toMatchObject({ outcome: "ignored", reason: "case_closed", intents: [] });
  });

  it("after dispatch, cancels future work while preserving the uncertain obligation", () => {
    const { state, authority } = atApprovedCase();
    const sent = apply(
      state,
      { kind: "dispatch_handoff", actionId: "a", clientReference: "ref", requestHash: "hash" },
      authority,
    );
    const cancelled = apply(
      sent.state,
      { kind: "cancel", reason: "Customer requested cancellation" },
      authority,
    );
    expect(cancelled.state).toMatchObject({
      phase: "fulfilling",
      cancelRequested: true,
      waitReason: "reconciliation",
      action: { status: "dispatching" },
    });
    expect(cancelled.intents).toEqual([]);
    expect(
      apply(cancelled.state, { kind: "retry_handoff", actionId: "a" }, authority),
    ).toMatchObject({ outcome: "rejected", reason: "cancellation_requested", intents: [] });
    const confirmed = apply(
      cancelled.state,
      {
        kind: "reconcile_handoff",
        actionId: "a",
        result: "confirmed",
        source: "provider_lookup",
        evidenceRef: "synthetic:already-booked",
        providerReference: "provider-booking",
      },
      authority,
    );
    expect(confirmed.state).toMatchObject({
      booking: "confirmed",
      cancelRequested: true,
      waitReason: "reconciliation",
    });
    expect(
      apply(confirmed.state, { kind: "close", outcome: "unavailable" }, authority).reason,
    ).toBe("supplier_cancellation_resolution_required");
  });
});

describe("global journey and continuing customer relationship", () => {
  it.each([
    ["Tokyo", "JPY"],
    ["London", "GBP"],
    ["Singapore", "SGD"],
  ])("runs the same lifecycle for %s without a destination code path", (city, currency) => {
    const event = demoEvents.find((item) => item.destination.city === city);
    if (!event) throw new Error("Missing synthetic event");
    const journey = runCaseJourneyFixture(event, currency);
    expect(journey.evidenceLevel).toBe("synthetic-domain-fixture");
    expect(journey.actualModelCalls).toBe(0);
    expect(journey.actualSupplierCalls).toBe(0);
    expect(journey.closedCase).toMatchObject({ phase: "closed", outcome: "fulfilled" });
    expect(journey.closedCase.brief.destination).toEqual(event.destination);
    expect(journey.followup.scope.relationshipId).toBe(journey.closedCase.scope.relationshipId);
    expect(journey.followup.scope.customerId).toBe(journey.closedCase.scope.customerId);
    expect(journey.followup.scope.caseId).not.toBe(journey.closedCase.scope.caseId);
    expect(journey.followup).toMatchObject({
      phase: "draft",
      activeTask: null,
      approval: null,
      action: null,
      proposals: [],
    });
  });

  it("cannot reuse a completed case identity or silently switch relationships", () => {
    const journey = runCaseJourneyFixture();
    const input = {
      relationship: journey.relationship,
      caseId: journey.closedCase.scope.caseId,
      sourceEvent: journey.closedCase.sourceEvent,
      brief: journey.closedCase.brief,
      deadline: journey.closedCase.deadline,
    };
    expect(() => createFollowupCase(journey.closedCase, input)).toThrow("new case identity");
    expect(() =>
      createFollowupCase(journey.closedCase, {
        ...input,
        caseId: "new-case",
        relationship: { ...journey.relationship, id: "other-relationship" },
      }),
    ).toThrow("same relationship");
  });
});
