# Occavoy PRD v0.2

Status: implementation baseline. Targets describe intended outcomes, not deployed capabilities or existing commercial relationships.

## Product goal

Occavoy turns an occasion or event into an actionable travel and experience service. It combines a customer's constraints, relevant activities, and partner supply into a versioned proposal, obtains explicit approval, follows the purchase and delivery process, and maintains the customer relationship after the case closes.

The initial audience is Hong Kong consumers and the partners serving them. **Destinations are global from day one.** The catalog, interfaces, matching rules, and supplier capabilities must accept destinations outside Japan without adding country-specific application branches. A Tokyo example is a test fixture and demonstration choice. Global support does not imply inventory or fulfillment rights in every destination.

The first commercial hypothesis is that channel partners can bring recurring, purposeful demand and value the coordination service. Direct consumers use the same core flow. Airline loyalty, sports, arts, insurance-client events, and other themes remain configurations and later capabilities, rather than separate products.

## Delivery targets

| Target                   | Usable outcome                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Within one month         | A coherent, hosted demonstration that can support partner outreach and accurately explains what is simulated                         |
| Within one to two months | An assisted service path with real authorized supply, a clear transaction owner, and an operator who can handle exceptions           |
| Before three months      | A bounded commercial experiment that measures demand, actual delivery work, fees or reasons for refusal, and operational reliability |

Dates and release gates are in the [roadmap](../roadmap.md). Defer features when they threaten these outcomes; preserve approval, commercial truth, and recovery requirements.

## Roles and service unit

The central object is a **ServiceCase** with a customer, brief, scope, deadline, execution allowance, responsible parties, and an explicit result. A customer relationship can span several cases. Saving an interesting event does not itself create a running case.

| Role                            | Job                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Customer                        | State preferences and constraints, choose an opportunity, review conditions, approve a proposal, receive service updates |
| Channel partner                 | Invite an authorized audience, define project terms, and view permitted progress and outcomes                            |
| Payer                           | Approve the costs they are responsible for; paying does not automatically grant access to all traveler details           |
| Supplier or fulfillment partner | Quote, confirm, collect payment where agreed, fulfill, and handle applicable changes                                     |
| Operator                        | Review uncertain information, request missing details, reconcile unknown results, and manage exceptions                  |

A single organization may perform several roles, but record its authority separately for each role.

## First usable flow

1. Capture a short brief: origin, destination or destination openness, date window, travelers, budget currency, essential preferences, and channel context.
2. Discover and save activities from a small sourced catalog. Show local dates, location, participation constraints, source, and freshness.
3. Explicitly activate a case. Derive event access, arrival/departure, accommodation, and other service requirements from hard constraints.
4. Request partner supply using a structured manual response path or a capability-declared API. Show what is waiting and allow the customer to leave the page.
5. Build a proposal with referenced quotes, estimates clearly labelled as estimates, separate payment recipients, terms, and unresolved conditions.
6. Bind approval to the proposal version, amount, currency, action scope, and expiry. Material changes require another approval.
7. Hand off to the actual seller or authorized fulfillment path. Reconcile the result and retain evidence. A click or a successful payment is not proof that every component is booked.
8. Record completion, cancellation, expiry, or non-fulfillment. Preserve authorized stable preferences for the next independent case.

## Requirements and acceptance

| ID  | Requirement                       | Minimum evidence                                                                                                         |
| --- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| P01 | Global destination representation | A non-Japan destination enters the same catalog, brief, requirements, and proposal path without country-specific code    |
| P02 | Honest discovery                  | Every displayed real event has provenance and observation time; fixtures and unknown fields are labelled                 |
| P03 | Progressive profile               | The customer can start with only relevant fields; profile reuse respects consent and source                              |
| P04 | Explicit case activation          | A save action and a paid-work authorization are distinct; every active case has a deadline and allowance                 |
| P05 | Hard constraints before ranking   | Impossible dates, traveler counts, or required event access cannot become an executable recommendation                   |
| P06 | Asynchronous supply               | Manual and API responses share versioned contracts; duplicate or late replies cannot replace newer requirements          |
| P07 | Proposal and approval binding     | Expired, revoked, or superseded approval cannot authorize a new amount or condition                                      |
| P08 | Correct transaction states        | Partial success and unknown results remain explicit; an ambiguous provider response cannot cause blind resubmission      |
| P09 | Persistent service progress       | A case resumes after browser closure and runtime interruption; the timeline agrees with commercial records               |
| P10 | Human intervention                | An operator can see, assign, pause, and resolve blocked work with a recorded reason                                      |
| P11 | Relationship and channel scope    | A later case can reuse permitted preferences; another channel cannot read unrelated customer or supplier information     |
| P12 | Accountable operations            | Calls, retries, failed work, human time, fees, and settlement state can be attributed to a case or project               |
| P13 | Controlled resource use           | Execution and storage limits reject new work explicitly; existing external obligations remain visible for reconciliation |

## Interaction scope

Use three simple web areas: **brief and preferences**, **discovery and saved interests**, and **proposal with service progress**. An operator view supplies structured quotes, exception handling, and result confirmation. Chat can help clarify the brief, but a conversational acknowledgement does not replace a specific purchase approval.

Start with clear forms, lists, status, and actions. A map, voice input, native applications, elaborate animation, and a large self-service partner portal are later improvements. The interface should communicate the next decision and any missing confirmation without exposing internal framework terminology.

## Global behavior

- Default presentation can use Traditional Chinese and HKD for the target audience; locale, origin, destination, and actual settlement currency remain explicit fields.
- Retain source language and source currency. Display conversion is an estimate with its own basis and timestamp, not a guaranteed settlement amount.
- Store event-local dates with an IANA time zone when a time is known, plus UTC instants where appropriate. Do not turn a date-only event into an invented midnight instant.
- Supplier destination coverage, currencies, categories, and confirmation methods are data. Unsupported supply results in a clear inquiry or unavailable state.
- Include global contract tests for multiple currencies, a daylight-saving boundary, a fractional time-zone offset, and an event with date-only precision. These are synthetic tests, not claims of active supplier coverage.

## Commercial boundaries

The initial product supports supplier checkout or authorized manual fulfillment, plus a separately agreed Occavoy service or partner-project fee. State who sells, who collects, who fulfills, who handles changes, and what evidence confirms each step. Real services require an appropriate operating arrangement; an accessible API does not establish a right to sell.

Do not count referral clicks, proposal value, gross supplier receipts, or sandbox orders as Occavoy revenue. Do not count several components of the same trip as repeat customer purchases. Partner project contribution includes delivery and non-converting work.

## Deferred work

Full OTA checkout, autonomous ticketing, automated loyalty redemption, uncontrolled browser purchasing, large enterprise SSO or bespoke deployments, broad multi-agent orchestration, custom model training, whole-city inventory coverage, and automatic guaranteed currency conversion are outside the first release. Introduce any of them only with a concrete customer requirement, supplier access, and a revised delivery estimate.

## Measurement

Separate technical scenario runs, valid customer briefs, activated cases, confirmed purchases, completed services, and paid partner projects. A **valid brief** contains enough customer-authorized constraints to attempt matching. A **case with a result** is closed with evidence, including unsuccessful outcomes; it is not necessarily a sale.

Track brief-to-proposal and proposal-to-purchase conversion, reasons for refusal, supplier response latency, failed-case cost, human minutes, per-case tool use, confirmation errors, and partner delivery effort. Keep real customer and supplier evidence outside the public repository.
