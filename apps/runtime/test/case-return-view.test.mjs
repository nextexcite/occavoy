import assert from "node:assert/strict";
import test from "node:test";
import { runCaseJourneyFixture } from "@occavoy/domain/case-lifecycle";
import { createCaseReturnHandler } from "../../web/src/server/case-return.tsx";

function render(snapshot) {
  const viewer = {
    role: "customer",
    authority: {
      tenantId: snapshot.scope.tenantId,
      caseId: snapshot.scope.caseId,
      actorId: snapshot.scope.customerId,
      grantId: "fixture-customer-viewer",
      permissions: ["proposal.approve"],
      validUntil: "2027-01-10T12:00:00Z",
    },
  };
  const handler = createCaseReturnHandler({
    resolveViewer: async () => viewer,
    store: { getCase: async () => snapshot },
    now: () => new Date("2027-01-01T12:00:00Z"),
  });
  return handler(new Request(`http://fixture.local/cases/${snapshot.scope.caseId}`));
}

test("customer view keeps cancellation and unresolved supplier state distinct", async () => {
  const { closedCase } = runCaseJourneyFixture();

  const unknownCancel = structuredClone(closedCase);
  Object.assign(unknownCancel, {
    phase: "fulfilling",
    outcome: null,
    cancelRequested: true,
    booking: "pending",
    payment: "unobserved",
    fulfillment: "pending",
  });
  unknownCancel.action = { ...unknownCancel.action, status: "unknown" };
  const unknownResponse = await render(unknownCancel);
  assert.equal(unknownResponse.status, 200);
  const unknownHtml = await unknownResponse.text();
  assert.ok(unknownHtml.includes("Cancellation requested"));
  assert.ok(unknownHtml.includes("checking the original supplier request"));
  assert.ok(unknownHtml.includes("not confirmed; do not resubmit"));
  assert.ok(unknownHtml.includes("not yet observed"));
  assert.ok(unknownHtml.includes("Fulfilment:"));
  assert.ok(!unknownHtml.includes('method="post"'));
  assert.ok(!unknownHtml.includes("Approve this exact offer"));

  const confirmedCancel = structuredClone(unknownCancel);
  confirmedCancel.booking = "confirmed";
  confirmedCancel.action = { ...confirmedCancel.action, status: "confirmed" };
  const confirmedResponse = await render(confirmedCancel);
  assert.equal(confirmedResponse.status, 200);
  const confirmedHtml = await confirmedResponse.text();
  assert.ok(confirmedHtml.includes("Cancellation requested"));
  assert.ok(confirmedHtml.includes("The original booking is confirmed"));
  assert.ok(confirmedHtml.includes("no cancellation or refund has been confirmed"));
  assert.ok(confirmedHtml.includes("not yet observed"));
  assert.ok(confirmedHtml.includes("Fulfilment:"));
  assert.ok(!confirmedHtml.includes('method="post"'));

  const closedWithoutAction = structuredClone(unknownCancel);
  Object.assign(closedWithoutAction, {
    action: null,
    approval: null,
    phase: "closed",
    outcome: "cancelled",
    booking: "not_submitted",
  });
  const closedResponse = await render(closedWithoutAction);
  assert.equal(closedResponse.status, 200);
  const closedHtml = await closedResponse.text();
  assert.ok(closedHtml.includes("No further action"));
  assert.ok(closedHtml.includes("no longer open for a new approval"));
  assert.ok(!closedHtml.includes("Cancellation requested"));
  assert.ok(!closedHtml.includes('method="post"'));
});
