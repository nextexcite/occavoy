# Return to a saved London request

**Local demonstration, synthetic event access only.** Close the customer's tab during a service interruption. Sign in again and the London performance, date, budget and progress are still there. Later, when the supplier's reply goes missing, the customer sees a reason to wait, not another purchase button. An operator checks the **original submission**.

## Run it

Use Linux with `pgrep` and the repository's [pinned tools](development.md). From the repository root:

```sh
mise install
mise exec -- pnpm install --frozen-lockfile
# Only if the repository's disposable Compose Postgres isn't already running:
docker compose up --detach --wait postgres

# Present from a terminal, with a browser on the same machine:
MISE_ACTIVATE_AGGRESSIVE=1 mise exec -- pnpm demo:london
# Or run the same journey unattended, with HTTP clients playing both roles:
MISE_ACTIVATE_AGGRESSIVE=1 mise exec -- pnpm verify:london
```

Open the **loopback URL printed by the demo**, not the ordinary web preview on port 3000. Do not start a runtime or set provider keys. Each run creates its own schema in the fixture database on `127.0.0.1:54329` and its own native runtime and engine. Normal completion removes the demo's data and listeners, not Postgres. Return-to-case works **within a run**; starting the command again intentionally creates a new fixture.

**If Refresh status keeps showing no offer:** keep the demo terminal beside the browser. The presenter guide above the saved case repeats the current terminal instruction. At **Awaiting quote**, press Enter in the terminal to supply the scripted quote; once the terminal asks for approval, refresh the browser to see the offer. Refresh alone never creates a quote. If a two-minute prompt timed out and the process exited, restart the demo and open the newly printed URL.

## Walkthrough

1. **Request saved.** The driver has sent one explicit HTTP activation. Choose **Continue as the fixture customer**. Note the London performance and **731.00 GBP brief budget**. Close the tab and advance the terminal prompt.
2. **Return after interruption.** The runtime and engine have been killed during the safe case read. Open the printed URL in a fresh/private session and sign in as the same fixture customer. No new activation or brief is needed. Let the terminal restart the runtime. Refresh the case page: **Awaiting quote**. The service is waiting for the supplier, not for the customer.
3. **One offer.** Advance the fixture to enter the supplier's event-access reply. Refresh and review scope, seller, price, version and expiry. This is a **186.00 GBP quote**, not an inventory hold or permission to spend the budget. The customer is also the designated payer in this fixture. Click **Approve this exact offer**. The authorized amount is now **186.00 GBP**; approval alone has not submitted a booking.
4. **Reply unavailable.** Advance the terminal to submit the approved handoff. The **synthetic supplier** accepted it but dropped the reply. Refresh: the customer does not know it was accepted and sees **booking not yet confirmed**. No action is needed from the customer. A second submission is blocked while the result is unknown.
5. **Check, don't rebook.** Advance the terminal to act as the fixture operator. Its separately authorized action looks up the original reference. Refresh the customer's page: **Booking confirmed**, **payment not yet observed**, **fulfilment pending**. End the demo at the terminal.

## What the proof measures

The [recovery fixture](../apps/runtime/test/case-recovery-fixture.mjs) and [London continuation](../apps/runtime/test/london-presentation.mjs) run on **one tenant, relationship, customer/payer, case and brief**. The [return view](../apps/web/src/server/case-return.tsx) reads the current Postgres snapshot per request; it doesn't replay a scripted timeline or ask an actor what the customer bought.

| Boundary           | Observed in the local run                                                                                                                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reopen             | Two distinct fixture session cookies opened the same saved case, including while the runtime was down. Reading didn't change the case revision or timeline length. Unauthenticated, wrong-case and cross-role requests were rejected.                   |
| Recover and source | One Pi submission, two intent deliveries, two faux model turns and two safe-read starts. One accepted `event_access` requirement, one RFQ delivery. No model work while waiting for quote, approval or reconciliation.                                  |
| Authorize          | One quote on that RFQ, one published proposal and one payer approval binding version, terms hash, amount, currency, line scope and expiry. A wrong-version form and an operator approval were rejected. The dispatcher refused to send before approval. |
| Resolve            | One supplier submission, one synthetic order. Blind retry in `unknown` was rejected. One lookup under the original client reference changed the booking from pending to confirmed. No payment or fulfilment observation was submitted.                  |

**Scripted:** customer identity and permissions, catalog, intake, faux model output, RFQ recipient, supplier reply, proposal preparation, operator and supplier fault. The walkthrough takes the approval from the browser; the unattended test posts the same rendered form. **Real locally:** HTTP, session checks, Postgres transactions, native Rivet/Pi, process replacement, dispatcher and enforced business decisions. Zero paid inference calls, external messages, real purchases or deployments.

The sign-in button selects **one fixed local fixture identity**, not a production account. The browser cannot select an operator role. The page server and Postgres remain up during the native runtime crash; the fake supplier retains its own in-memory order during dispatcher replacement. This does not prove identity recovery, disk-loss recovery, live inventory, supplier durability, production handoff recovery or deployed behaviour.

The [earlier hotel/closure and RFQ-only proofs](local-case-trace.md) remain separate regressions. This is local evidence related to [OCA-34](https://linear.app/tianjis/issue/OCA-34), not a change to its tracker status. No manual baseline or service-time saving was measured. A later paired trial could count customer status enquiries and time an operator from first seeing an unknown result to obtaining original-reference evidence, with the same brief and fault in both arms.

Measured locally on 2026-11-27 (Node 26.13.1, RivetKit 3.1.1, Pi adapter 0.5.7, Pi Durable 1.5.2): the unattended London test passed in 69.0 s (102 s including build/command overhead). The presenter path was exercised through a terminal and loopback HTTP form submissions in 195.5 s, including intentional pauses; no graphical-browser or usability trial was run. From first worktree inspection to review of the passing integrated journey and its fixes was about 63 minutes elapsed; active human effort and blocked time were not separately instrumented.

The standalone RFQ recovery regression also passed during development. The Postgres-backed repository suites ran 79 Vitest and 22 runtime tests, including the separate hotel trace. During London verification a coordinator drain was forced between the handoff commit and the supplier call: it claimed zero effect rows. The dispatcher, not a replayed outbox notification, made the only synthetic submission.
