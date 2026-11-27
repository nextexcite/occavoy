import type {
  CaseAuthority,
  CaseProposal,
  CaseSnapshot,
  ProposalApproval,
} from "@occavoy/domain/case-lifecycle";
import React, { type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

export type Viewer = { role: "customer" | "operator"; authority: CaseAuthority };

export type ApprovalMutationInput = {
  viewer: Viewer;
  snapshot: CaseSnapshot;
  proposal: CaseProposal;
  approval: ProposalApproval;
  expectedRevision: number;
};

export type LookupMutationInput = {
  viewer: Viewer;
  snapshot: CaseSnapshot;
  actionId: string;
};

export type MutationResult = { status: "applied" } | { status: "stale" } | { status: "rejected" };

type Store = {
  getCase(tenantId: string, caseId: string): Promise<CaseSnapshot | null>;
};

function response(status: number, body: Record<string, string>, extra?: HeadersInit): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...extra },
  });
}

function html(markup: ReactElement, status = 200): Response {
  return new Response(`<!doctype html>${renderToStaticMarkup(markup)}`, {
    status,
    headers: { "cache-control": "no-store", "content-type": "text/html; charset=utf-8" },
  });
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: { "cache-control": "no-store", location },
  });
}

function formatMoney(money: { amountMinor: number; currency: string }): string {
  const digits =
    new Intl.NumberFormat("en-HK", {
      style: "currency",
      currency: money.currency,
      currencyDisplay: "code",
    }).resolvedOptions().maximumFractionDigits ?? 2;
  return `${(money.amountMinor / 10 ** digits).toFixed(digits)} ${money.currency}`;
}

function eventWhen(snapshot: CaseSnapshot): string {
  const event = snapshot.sourceEvent;
  const timeZone = event.destination.timeZone;
  const date = new Intl.DateTimeFormat("en-HK", {
    dateStyle: "full",
    timeZone,
  }).format(new Date(event.startsAt));
  const start = new Intl.DateTimeFormat("en-HK", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(new Date(event.startsAt));
  const end = new Intl.DateTimeFormat("en-HK", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(new Date(event.endsAt));
  return `${date}, ${start}–${end} (${timeZone})`;
}

function expiryWhen(value: string): string {
  return `${new Intl.DateTimeFormat("en-HK", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value))} UTC`;
}

function currentProposal(snapshot: CaseSnapshot): CaseProposal | null {
  return snapshot.proposals.at(-1) ?? null;
}

function isPublished(snapshot: CaseSnapshot, proposal: CaseProposal | null): boolean {
  if (!proposal) return false;
  if (snapshot.phase === "awaiting_approval") return true;
  return (
    snapshot.approval?.proposalId === proposal.id &&
    snapshot.approval.proposalVersion === proposal.version
  );
}

type CustomerView = {
  caseId: string;
  revision: number;
  title: string;
  when: string;
  city: string;
  budget: string;
  status: string;
  next: string;
  canApprove: boolean;
  proposal: null | {
    version: number;
    scope: string;
    supplier: string;
    seller: string;
    fulfiller: string;
    payee: string;
    total: string;
    validUntil: string;
  };
  approvedAmount: string | null;
  payment: string | null;
  fulfillment: string | null;
};

const requirementCategoryLabels: Record<string, string> = {
  event_access: "Event access for this performance",
  accommodation: "Accommodation",
  transport: "Transport",
};

function proposalServiceScope(
  snapshot: CaseSnapshot,
  proposal: CaseProposal | null,
  offeredQuote: CaseSnapshot["quotes"][number] | null,
): string {
  const rfq = snapshot.rfq;
  if (!proposal || !offeredQuote || !rfq || offeredQuote.rfqId !== rfq.id) {
    return "Requested services";
  }
  const requirements = new Map(
    snapshot.requirements.map((requirement) => [requirement.id, requirement]),
  );
  const labels: string[] = [];
  for (const requirementId of rfq.requirementIds) {
    const category = requirements.get(requirementId)?.category;
    const label = (category ? requirementCategoryLabels[category] : null) ?? "Requested services";
    if (!labels.includes(label)) labels.push(label);
  }
  return labels.length > 0 ? labels.join("; ") : "Requested services";
}

function customerView(snapshot: CaseSnapshot, viewer: Viewer, now: Date): CustomerView {
  const proposal = currentProposal(snapshot);
  const published = isPublished(snapshot, proposal);
  const approved = Boolean(snapshot.approval);
  const proposalExpired = proposal ? Date.parse(proposal.validUntil) <= now.getTime() : false;
  let status = "Request saved";
  let next =
    "Your request is saved. The service team is checking the original brief; reading this page does not submit anything again.";
  if (snapshot.waitReason === "supplier_quote") {
    status = "Awaiting quote";
    next = "The service team is waiting for a supplier reply for the original request.";
  }
  if (
    (snapshot.phase === "sourcing" && snapshot.quotes.length > 0) ||
    snapshot.phase === "proposal_ready"
  ) {
    status = "Quote being checked";
    next = "A supplier reply is being checked before any offer is shown.";
  }
  if (snapshot.phase === "awaiting_approval" && published && proposalExpired) {
    status = "Offer expired";
    next = "The published offer has expired. No approval action is available for this fixture.";
  } else if (snapshot.phase === "awaiting_approval" && published) {
    status = "Awaiting payer approval";
    next =
      "Review the exact published offer. Approving it is optional and no payment or booking is made by this fixture.";
  }
  if (approved && !snapshot.action) {
    status = "Approved";
    next = "The exact offer has been approved. Supplier handoff has not yet been submitted.";
  }
  if (snapshot.action?.status === "dispatching") {
    status = "Supplier handoff in progress";
    next =
      "The original approved request is being sent to the supplier. The booking is not yet confirmed; there is no need to resubmit.";
  }
  if (snapshot.action?.status === "unknown") {
    status = "Supplier reply unavailable";
    next =
      "The supplier reply is unavailable, so the booking is not yet confirmed. The service team is checking the original request; there is no need to resubmit.";
  }
  if (snapshot.action?.status === "not_executed") {
    status = "Booking not completed";
    next =
      "The original supplier request was not completed, so no booking is confirmed. The service team will review the saved request; there is no need to resubmit.";
  }
  if (snapshot.booking === "confirmed") {
    status = "Booking confirmed";
    next = "The supplier booking is confirmed for the original approved request.";
  }
  if (snapshot.cancelRequested || snapshot.phase === "closed") {
    status = snapshot.outcome === "fulfilled" ? "Completed" : "No further action";
    next = "This request is no longer open for a new approval.";
  }
  const offeredQuote = proposal
    ? snapshot.quotes.find(
        (quote) => quote.id === proposal.quoteId && quote.version === proposal.quoteVersion,
      )
    : null;
  return {
    caseId: snapshot.scope.caseId,
    revision: snapshot.revision,
    title: snapshot.sourceEvent.title,
    when: eventWhen(snapshot),
    city: `${snapshot.sourceEvent.destination.city}, ${snapshot.sourceEvent.destination.countryCode}`,
    budget: formatMoney(snapshot.brief.budget),
    status,
    next,
    canApprove:
      snapshot.phase === "awaiting_approval" &&
      published &&
      proposal !== null &&
      !proposalExpired &&
      viewer.authority.permissions.includes("proposal.approve") &&
      viewer.authority.actorId === proposal.approverActorId,
    proposal:
      published && proposal
        ? {
            version: proposal.version,
            scope: proposalServiceScope(snapshot, proposal, offeredQuote ?? null),
            supplier: proposal.scope.supplierId,
            seller: offeredQuote?.sellerId ?? "",
            fulfiller: offeredQuote?.fulfillerId ?? "",
            payee: offeredQuote?.payeeId ?? "",
            total: formatMoney(proposal.total),
            validUntil: expiryWhen(proposal.validUntil),
          }
        : null,
    approvedAmount: snapshot.approval ? formatMoney(snapshot.approval.total) : null,
    payment: approved ? snapshot.payment : null,
    fulfillment: approved ? snapshot.fulfillment : null,
  };
}

function Document({
  children,
  title = "Occavoy · Saved request",
}: {
  children: ReactNode;
  title?: string;
}) {
  return (
    <html lang="en-HK">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <link rel="stylesheet" href="/styles.css" />
      </head>
      <body>{children}</body>
    </html>
  );
}

function Header() {
  return (
    <header className="site-header">
      <a className="wordmark" href="/">
        occavoy<span>↗</span>
      </a>
      <span className="market">Synthetic local fixture</span>
    </header>
  );
}

function CustomerPage({ view }: { view: CustomerView }) {
  const canApprove = view.canApprove && view.proposal !== null;
  return (
    <Document>
      <Header />
      <main>
        <section className="page-section">
          <p className="eyebrow">Saved request · synthetic fixture</p>
          <h1>{view.title}</h1>
          <p className="lede">
            Fixture demonstration only: no real purchase, inventory hold, payment or delivery is
            available.
          </p>
          <div className="split">
            <section className="panel">
              <h2>Your saved request</h2>
              <p>
                <strong>Status:</strong> {view.status}
              </p>
              <p>
                <strong>Your next step:</strong>{" "}
                {view.canApprove
                  ? "Review and approve the offer if you want to proceed."
                  : "No action needed from you."}
              </p>
              <p>{view.next}</p>
              <p>
                <strong>Event:</strong> {view.title}
              </p>
              <p>
                <strong>Local event time:</strong> {view.when}
              </p>
              <p>
                <strong>Destination:</strong> {view.city}
              </p>
              <p>
                <strong>Your brief budget:</strong> {view.budget}
              </p>
              {view.approvedAmount ? (
                <p>
                  <strong>Authorized amount:</strong> {view.approvedAmount}
                </p>
              ) : null}
              {view.payment ? (
                <p>
                  <strong>Payment:</strong>{" "}
                  {view.payment === "unobserved" ? "not yet observed" : view.payment}
                </p>
              ) : null}
              {view.fulfillment ? (
                <p>
                  <strong>Fulfilment:</strong>{" "}
                  {view.fulfillment === "pending" ? "pending" : view.fulfillment}
                </p>
              ) : null}
              <form method="get" action={`/cases/${view.caseId}`}>
                <button className="button" type="submit">
                  Refresh status
                </button>
              </form>
              <p className="note">
                Refreshing or reopening this page only reads the saved request. It does not submit
                the brief, approval or supplier request again.
              </p>
            </section>
            <section className="panel">
              <h2>Published offer</h2>
              {view.proposal ? (
                <>
                  <p>
                    <strong>Scope:</strong> {view.proposal.scope}
                  </p>
                  <p>
                    <strong>Supplier:</strong> {view.proposal.supplier}
                  </p>
                  <p>
                    <strong>Seller:</strong> {view.proposal.seller}
                  </p>
                  <p>
                    <strong>Fulfiller:</strong> {view.proposal.fulfiller}
                  </p>
                  <p>
                    <strong>Payee:</strong> {view.proposal.payee}
                  </p>
                  <p>
                    <strong>Offer total:</strong> {view.proposal.total}
                  </p>
                  <p>
                    <strong>Offer expiry:</strong> {view.proposal.validUntil}
                  </p>
                  <p>
                    <strong>Offer version:</strong> {view.proposal.version}
                  </p>
                  {canApprove ? (
                    <form
                      method="post"
                      action={`/cases/${view.caseId}/approve/${view.revision}/${view.proposal.version}`}
                    >
                      <button className="button" type="submit">
                        Approve this exact offer
                      </button>
                    </form>
                  ) : (
                    <p className="note">
                      Approval is not available for the current state or expiry.
                    </p>
                  )}
                </>
              ) : (
                <p>
                  No published offer is available yet. Any supplier reply still being checked is not
                  shown as an offer.
                </p>
              )}
              <p className="note">
                The brief budget, any published offer and any authorized amount are separate facts.
              </p>
            </section>
          </div>
        </section>
      </main>
    </Document>
  );
}

function OperatorPage({ snapshot }: { snapshot: CaseSnapshot }) {
  const unknown = snapshot.action?.status === "unknown";
  return (
    <Document>
      <Header />
      <main>
        <section className="page-section">
          <p className="eyebrow">Operator fixture</p>
          <h1>Original supplier request</h1>
          <div className="split">
            <section className="panel">
              <h2>Case status</h2>
              <p>
                <strong>Phase:</strong> {snapshot.phase}
              </p>
              <p>
                <strong>Waiting on:</strong> {snapshot.waitReason ?? "nothing"}
              </p>
              <p>
                <strong>Booking:</strong> {snapshot.booking}
              </p>
              <p>
                <strong>Payment:</strong> {snapshot.payment}
              </p>
              <p>
                <strong>Fulfilment:</strong> {snapshot.fulfillment}
              </p>
            </section>
            <section className="panel">
              <h2>Reconciliation</h2>
              <p>
                <strong>Original action status:</strong> {snapshot.action?.status ?? "none"}
              </p>
              {unknown ? (
                <form method="post" action={`/operator/cases/${snapshot.scope.caseId}/lookup`}>
                  <button className="button" type="submit">
                    Look up original supplier status
                  </button>
                </form>
              ) : (
                <p className="note">No original unknown supplier result is awaiting lookup.</p>
              )}
              <p className="note">
                This fixture permits only lookup of the original request. It has no dispatch or
                retry control.
              </p>
            </section>
          </div>
        </section>
      </main>
    </Document>
  );
}

function CustomerSignInRequiredPage() {
  return (
    <Document title="Occavoy fixture sign-in required">
      <main>
        <section className="page-section">
          <div className="panel">
            <p>
              <a href="/">Sign in to return to your saved request</a>
            </p>
          </div>
        </section>
      </main>
    </Document>
  );
}

function FixtureSignInPage() {
  return (
    <Document title="Occavoy fixture sign-in">
      <main>
        <section className="page-section">
          <p className="eyebrow">Synthetic local fixture</p>
          <h1>Saved-case demo sign-in</h1>
          <div className="panel">
            <p>
              This button creates a local demonstration session for one fixed synthetic customer and
              payer only.
            </p>
            <form method="post" action="/session">
              <button className="button" type="submit">
                Continue as the fixture customer
              </button>
            </form>
            <p className="note">
              No real account, supplier, purchase, inventory hold, payment or delivery is involved.
            </p>
          </div>
        </section>
      </main>
    </Document>
  );
}

export function fixtureSignInPage(): Response {
  return html(<FixtureSignInPage />);
}

function authenticViewer(viewer: Viewer | null, now: Date): viewer is Viewer {
  if (!viewer) return false;
  const authority = viewer.authority;
  return (
    Boolean(authority.tenantId.trim()) &&
    Boolean(authority.actorId.trim()) &&
    Boolean(authority.grantId.trim()) &&
    Date.parse(authority.validUntil) > now.getTime()
  );
}

async function readCase(store: Store, viewer: Viewer, caseId: string) {
  try {
    const snapshot = await store.getCase(viewer.authority.tenantId, caseId);
    if (!snapshot) return { kind: "missing" as const };
    if (snapshot.scope.tenantId !== viewer.authority.tenantId) {
      return { kind: "foreign" as const };
    }
    return { kind: "found" as const, snapshot };
  } catch {
    return { kind: "error" as const };
  }
}

function parsePositiveInteger(value: string): number | null {
  if (!/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function pathCaseId(match: RegExpMatchArray): string | null {
  try {
    const value = decodeURIComponent(match[1] ?? "");
    return value.trim() ? value : null;
  } catch {
    return null;
  }
}

/**
 * Portable read/approval boundary for one saved case. It is deliberately not
 * registered in the production router; a host supplies authentication, the
 * store and the two fixture mutation seams.
 */
export function createCaseReturnHandler(deps: {
  resolveViewer(request: Request): Promise<Viewer | null>;
  store: Store;
  approve?(input: ApprovalMutationInput): Promise<MutationResult>;
  lookup?(input: LookupMutationInput): Promise<MutationResult>;
  now?: () => Date;
}): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/$/, "") || "/";
    const now = deps.now?.() ?? new Date();
    const customerRead = pathname.match(/^\/cases\/([^/]+)$/);
    const operatorRead = pathname.match(/^\/operator\/cases\/([^/]+)$/);
    const customerApprove = pathname.match(/^\/cases\/([^/]+)\/approve\/([^/]+)\/([^/]+)$/);
    const operatorLookup = pathname.match(/^\/operator\/cases\/([^/]+)\/lookup$/);
    const matched = customerRead ?? operatorRead ?? customerApprove ?? operatorLookup;
    if (!matched) return response(404, { error: "not_found" });
    const caseId = pathCaseId(matched);
    if (!caseId) return response(404, { error: "not_found" });

    const isWrite = Boolean(customerApprove ?? operatorLookup);
    if (isWrite && request.method !== "POST") {
      return response(405, { error: "method_not_allowed" }, { allow: "POST" });
    }
    if (!isWrite && request.method !== "GET" && request.method !== "HEAD") {
      return response(405, { error: "method_not_allowed" }, { allow: "GET" });
    }

    let viewer: Viewer | null = null;
    try {
      viewer = await deps.resolveViewer(request);
    } catch {
      viewer = null;
    }
    if (!authenticViewer(viewer, now)) {
      if (customerRead) return html(<CustomerSignInRequiredPage />, 401);
      return response(401, { error: "unauthenticated" });
    }
    if (viewer.authority.caseId !== caseId) return response(403, { error: "forbidden" });

    const requiredRole = customerRead || customerApprove ? "customer" : "operator";
    if (viewer.role !== requiredRole) return response(403, { error: "forbidden" });
    if (
      (operatorRead || operatorLookup) &&
      !viewer.authority.permissions.includes("action.reconcile")
    ) {
      return response(403, { error: "forbidden" });
    }

    const found = await readCase(deps.store, viewer, caseId);
    if (found.kind === "missing") return response(404, { error: "not_found" });
    if (found.kind === "foreign") return response(403, { error: "forbidden" });
    if (found.kind === "error") return response(500, { error: "internal_error" });
    const snapshot = found.snapshot;

    if (viewer.role === "customer" && viewer.authority.actorId !== snapshot.scope.customerId) {
      return response(403, { error: "forbidden" });
    }

    if (customerRead) {
      return html(<CustomerPage view={customerView(snapshot, viewer, now)} />);
    }
    if (operatorRead) {
      return html(<OperatorPage snapshot={snapshot} />);
    }

    if (customerApprove) {
      if (!deps.approve) return response(503, { error: "unavailable" });
      const revision = parsePositiveInteger(customerApprove[2] ?? "");
      const proposalVersion = parsePositiveInteger(customerApprove[3] ?? "");
      const proposal = currentProposal(snapshot);
      const exact =
        revision !== null &&
        proposalVersion !== null &&
        revision === snapshot.revision &&
        proposal?.version === proposalVersion &&
        snapshot.phase === "awaiting_approval" &&
        isPublished(snapshot, proposal) &&
        !snapshot.cancelRequested &&
        Date.parse(proposal.validUntil) > now.getTime();
      if (!exact || !proposal) return response(409, { error: "stale_form" });
      if (
        !viewer.authority.permissions.includes("proposal.approve") ||
        viewer.authority.actorId !== proposal.approverActorId
      ) {
        return response(403, { error: "forbidden" });
      }
      const approval: ProposalApproval = {
        id: `approval-${proposal.id}-v${proposal.version}`,
        tenantId: snapshot.scope.tenantId,
        caseId: snapshot.scope.caseId,
        proposalId: proposal.id,
        proposalVersion: proposal.version,
        termsHash: proposal.termsHash,
        total: structuredClone(proposal.total),
        validUntil: proposal.validUntil,
        scope: structuredClone(proposal.scope),
        approvedBy: viewer.authority.actorId,
        authorityGrantId: viewer.authority.grantId,
        approvedAt: now.toISOString(),
      };
      try {
        const result = await deps.approve({
          viewer,
          snapshot,
          proposal,
          approval,
          expectedRevision: revision,
        });
        if (result.status === "applied") return redirect(`/cases/${encodeURIComponent(caseId)}`);
        if (result.status === "stale") return response(409, { error: "stale_form" });
        return response(422, { error: "approval_rejected" });
      } catch {
        return response(500, { error: "internal_error" });
      }
    }

    if (!deps.lookup) return response(503, { error: "unavailable" });
    const action = snapshot.action;
    if (!action || action.status !== "unknown") return response(409, { error: "not_reconcilable" });
    try {
      const result = await deps.lookup({ viewer, snapshot, actionId: action.id });
      if (result.status === "applied") {
        return redirect(`/operator/cases/${encodeURIComponent(caseId)}`);
      }
      if (result.status === "stale") return response(409, { error: "stale_form" });
      return response(422, { error: "lookup_rejected" });
    } catch {
      return response(500, { error: "internal_error" });
    }
  };
}
