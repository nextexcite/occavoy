# Twelve-week delivery roadmap

Targets are measured from the initial development baseline. Dates are planning checkpoints; a failed exit gate changes the next stage's scope or date. No hosted deployment, customer, supplier relationship, or sale is implied by this plan.

## Outcomes and gates

| Target checkpoint   | Outcome                                  | Evidence required to continue                                                                                                                                                          |
| ------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-12-04, week 1  | Cloud runtime proof                      | Pinned web and runtime builds; a case survives a process replacement while waiting; actual setup and debugging work recorded                                                           |
| 2026-12-11, week 2  | Narrow end-to-end PoC                    | Brief, event, requirement, manual or sandbox quote, proposal approval, and one unknown-result reconciliation path; simulated boundaries visible                                        |
| 2026-12-25, week 4  | Partner-outreach demonstration           | Coherent three-area web experience, operator path, global destination contract tests, redacted proof, and an accurate capability statement                                             |
| 2027-01-22, week 8  | Assisted usable service                  | Authorized real supply and confirmation route, identified transaction/fulfillment roles, consent and access control, operator handling, restore exercise, and measured delivery effort |
| 2027-02-19, week 12 | Bounded commercial experiment and review | Real service outcomes, fee evidence or reasons for refusal, channel attribution, complete non-converting costs, and a decision on the next scope                                       |

The week-2 PoC is deliberately narrower than the assisted release. Runtime and harness proofs use a scripted model provider and synthetic supply; they require no paid inference, sandbox service, production booking credentials, or polished interface. The narrow integrated scenario is specified in the [engineering handoff](implementation-handoff.md). Its minimum brief/RFQ/proposal path must be pulled forward from the later business tasks so that week 2 proves one case, while broader coverage and customer interaction remain later work.

## Sequence

### Weeks 1–2: prove the execution and commercial boundaries

Bootstrap the shared workspace and exact dependencies. Qualify Rivet Cloud. Implement one case command path and controlled supply response. Demonstrate waiting, resumption, duplicate delivery, quote expiry, and the specific provider-success/local-response-loss boundary. Begin with a small seed catalog; expand the sourced sample toward 20 records as the demo takes shape.

### Weeks 3–4: make the proof understandable to a partner

Connect the brief, discovery, proposal, and operator views. Add a second destination fixture outside Japan, currency/time-zone tests, and visible source and quote freshness. Show exactly which supplier actions are simulated. Prepare a short demonstration that explains what the customer does, what the partner supplies, what remains manual, and what outcome can be purchased.

### Weeks 5–8: turn the path into an assisted service

Use one real authorized supply route before adding more adapters. Establish the seller, payer, fulfiller, confirmation evidence, and change process. Complete authentication, tenant isolation, necessary notifications, cost metering, and recovery procedures. Run invited cases with a named operator and measure all intervention time.

### Weeks 9–12: test delivery and commercial value

Run limited channel and service experiments. Add a second supply or channel configuration only if it resolves an observed need. Review fees or refusal reasons, confirmed outcomes, human work, failed work, and repeat interest. A longer partner sales cycle changes the commercial hypothesis or experiment; it does not justify uncontrolled platform expansion.

## Workload measurement

Calendar compression is a target, not evidence of productivity. For each work item record:

| Field                        | Meaning                                                                                                              |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Estimate low / likely / high | Engineering effort for the stated acceptance criteria, including review and relevant tests                           |
| Actual active time           | Human engineering, review, and debugging time                                                                        |
| Blocked elapsed time         | Credentials, vendor issue, partner response, or another dependency                                                   |
| Tool usage                   | Relevant model, browser, runtime, and storage quantities; private monetary values stay in private operations records |
| Result                       | Acceptance evidence, remaining failure, or scope change                                                              |

Estimate a small item before starting it and update remaining work after the first proof. Compare remaining high-case effort with the **available engineering capacity**, not total hours that also cover partner outreach and service delivery. Agent parallelism does not remove integration and review work.

If the plan does not fit, defer an additional supplier, sophisticated matching, map/voice features, or bespoke partner integration. Do not remove quote evidence, approval binding, idempotency, unknown-result reconciliation, or tenant boundaries to keep a calendar date.

## Distinct denominators

Keep these counts separate: synthetic evaluation runs, sourced event records, valid customer briefs, activated cases, cases with an outcome, confirmed purchases, and paid partner projects. A failed or declined case is still an outcome and still has a cost. A technical replay is not another customer and a checkout click is not a sale.

## Weekly review

Use the issue tracker's native two-week cycles for work cadence and these outcome milestones for release decisions. Review acceptance evidence, remaining effort, stale or blocked cases, provider availability, and required human intervention each week. Update the issue tracker and ADRs only when a decision changes. Publish redacted proof in the repository; retain customer information, commercial terms, credentials, and private financial plans in their appropriate private systems.
