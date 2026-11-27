import { runCaseJourneyFixture } from "../packages/domain/src/case-lifecycle";

const result = runCaseJourneyFixture();
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log("Occavoy synthetic customer-case lifecycle");
  console.log("No model, supplier, booking or payment API is called by this scenario.");
  console.table(result.trace);
  console.log(
    JSON.stringify({
      evidenceLevel: result.evidenceLevel,
      closedCase: result.closedCase.scope.caseId,
      outcome: result.closedCase.outcome,
      nextCase: result.followup.scope.caseId,
      sameRelationship:
        result.closedCase.scope.relationshipId === result.followup.scope.relationshipId,
      approvalInherited: result.followup.approval !== null,
    }),
  );
}
