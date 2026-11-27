import { randomUUID } from "node:crypto";
import type { CaseProposal, HandoffAttemptFence } from "@occavoy/domain/case-lifecycle";

export interface SupplierCapabilityDeclaration {
  supplierId: string;
  /** ISO country codes served by this fixture. */
  destinations: readonly string[];
  currencies: readonly string[];
  supportsLookup: boolean;
  supportsIdempotency: boolean;
  supportsCancel: boolean;
}

export interface HandoffAttempt {
  clientReference: string;
  attempt: number;
}

export interface HandoffRequest extends HandoffAttempt {
  actionId: string;
  requestHash: string;
  proposalId: string;
  proposalVersion: number;
  total: CaseProposal["total"];
  validUntil: string;
}

export type SupplierLookup = { found: true; providerReference: string } | { found: false };

/** One tenant's supplier account. Lookup absence must be authoritative, not a timeout. */
export interface SupplierAdapter {
  readonly tenantId: string;
  readonly capabilities: SupplierCapabilityDeclaration;
  submitHandoff(request: HandoffRequest): Promise<{ providerReference: string }>;
  lookupByClientReference(clientReference: string): Promise<SupplierLookup>;
  /** Optional supplier-side fence. On success no send through this attempt (including
   * an in-flight request) can subsequently create an order. Already accepted orders
   * remain visible to reconciliation. `fenceId` must be unique to this successful
   * fence and not predictable beforehand; it is a freshness challenge, not a string
   * to parse. A local lease timeout is not such a fence. */
  fenceHandoffAttempt?(target: HandoffAttempt): Promise<HandoffAttemptFence>;
}

export class UnsupportedCapabilityError extends Error {}
export type SupplierFault = "none" | "dropResponseAfterAccept" | "rejectBeforeAccept";

/** Synthetic provider state, independent of Postgres and of the dispatcher's lifetime. */
export class FakeSupplierAdapter implements SupplierAdapter {
  private readonly orders = new Map<
    string,
    { request: HandoffRequest; providerReference: string }[]
  >();
  private readonly fencedThrough = new Map<string, number>();
  private created = 0;
  submitCalls = 0;

  constructor(
    readonly tenantId: string,
    readonly capabilities: SupplierCapabilityDeclaration,
    private readonly fault: SupplierFault = "none",
  ) {}

  get orderCount() {
    return this.created;
  }

  async fenceHandoffAttempt({ clientReference, attempt }: HandoffAttempt) {
    const previous = this.fencedThrough.get(clientReference) ?? 0;
    this.fencedThrough.set(clientReference, Math.max(previous, attempt));
    const fenceId = `synthetic:fence:${randomUUID()}`;
    return {
      fenceId,
      clientReference,
      attempt,
      evidenceRef: `synthetic:sender-fenced:${fenceId}`,
    };
  }

  async submitHandoff(request: HandoffRequest) {
    this.submitCalls++;
    if (request.attempt <= (this.fencedThrough.get(request.clientReference) ?? 0))
      throw new Error("synthetic:attempt-fenced");
    if (this.fault === "rejectBeforeAccept") throw new Error("synthetic:connection-refused");
    const orders = this.orders.get(request.clientReference) ?? [];
    const existing = orders[0];
    if (this.capabilities.supportsIdempotency && existing) {
      if (
        existing.request.requestHash !== request.requestHash ||
        existing.request.actionId !== request.actionId
      ) {
        throw new Error("synthetic:client-reference-conflict");
      }
      return { providerReference: existing.providerReference };
    }
    // A non-idempotent fixture really creates another order on duplicate submission.
    const providerReference = `synthetic:order:${++this.created}`;
    orders.push({ request: structuredClone(request), providerReference });
    this.orders.set(request.clientReference, orders);
    if (this.fault === "dropResponseAfterAccept") throw new Error("synthetic:response-lost");
    return { providerReference };
  }

  async lookupByClientReference(clientReference: string): Promise<SupplierLookup> {
    if (!this.capabilities.supportsLookup)
      throw new UnsupportedCapabilityError("lookup unsupported");
    const orders = this.orders.get(clientReference);
    if (!orders?.length) return { found: false };
    if (orders.length !== 1) throw new Error("synthetic:ambiguous-reference");
    return { found: true, providerReference: orders[0]!.providerReference };
  }
}
