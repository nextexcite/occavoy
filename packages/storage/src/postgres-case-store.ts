import { createHash } from "node:crypto";
import {
  type CaseAuthority,
  type CaseCommand,
  type CaseDecision,
  type CaseSnapshot,
  type CustomerRelationship,
  createServiceCase,
  decideCase,
  hasCaseCommandAuthority,
} from "@occavoy/domain/case-lifecycle";
import type { Pool, PoolClient, QueryResultRow } from "pg";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return Object.fromEntries(entries.map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/**
 * Semantic command identity, excluding commandId, so a transport retry with a
 * reordered payload does not produce a false conflict while a changed payload
 * under the same ID is always detected.
 */
export function hashCommandPayload(command: CaseCommand): string {
  const { commandId: _commandId, ...semantic } = command;
  return createHash("sha256").update(canonicalJson(semantic)).digest("hex");
}

function isServiceCasesPkConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "23505" &&
    (error as { constraint?: string }).constraint === "service_cases_pkey"
  );
}

/** Default lease for a claimed outbox intent before it can be reclaimed. */
export const DEFAULT_OUTBOX_LEASE_MS = 60_000;

export class CommandConflictError extends Error {
  readonly code = "command_payload_conflict";
  constructor(commandId: string) {
    super(`Command ${commandId} was already received with a different payload`);
    this.name = "CommandConflictError";
  }
}

export class CaseActivationError extends Error {
  readonly code = "case_activation_rejected";
  constructor(readonly reason: string) {
    super(reason);
    this.name = "CaseActivationError";
  }
}

export type CreateCaseInput = Parameters<typeof createServiceCase>[0] & {
  channelId?: string;
  payerId?: string;
};
export type ActivateInput = Extract<CaseCommand, { kind: "activate" }>;

export interface CaseCommandRow {
  tenantId: string;
  commandId: string;
  caseId: string;
  commandKind: string;
  expectedRevision: string;
  payloadHash: string;
  command: CaseCommand;
  actorId: string | null;
  grantId: string | null;
  status: "received" | "completed";
  outcome: "applied" | "ignored" | "rejected" | null;
  reason: string | null;
  resultingRevision: string | null;
  decision: CaseDecision | null;
  receivedAt: Date;
  completedAt: Date | null;
}

export interface CaseOutboxRow {
  id: string;
  tenantId: string;
  caseId: string;
  commandId: string;
  caseRevision: string;
  intentKind: string;
  payload: unknown;
  status: "pending" | "dispatched" | "completed" | "failed";
  attempts: number;
  availableAt: Date;
  dispatchedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}

export interface CaseDomainEventRow {
  seq: string;
  tenantId: string;
  caseId: string;
  commandId: string | null;
  caseRevision: string;
  eventKind: string;
  payload: unknown;
  createdAt: Date;
}

export interface ReceivedCommandResult {
  status: "received" | "completed";
  deduplicated: boolean;
  decision?: CaseDecision;
}

export interface StoredCommandResult {
  deduplicated: boolean;
  decision: CaseDecision;
  outboxIds: string[];
}

const COMMAND_COLUMNS = `
  tenant_id, command_id, case_id, command_kind, expected_revision, payload_hash,
  command_json, actor_id, grant_id, status, outcome, reason, resulting_revision,
  decision_json, received_at, completed_at`;

const OUTBOX_COLUMNS = `
  id::text AS id, tenant_id, case_id, command_id, case_revision::text AS case_revision,
  intent_kind, payload, status, attempts, available_at, dispatched_at, completed_at, created_at`;

const EVENT_COLUMNS = `
  seq::text AS seq, tenant_id, case_id, command_id, case_revision::text AS case_revision,
  event_kind, payload, created_at`;

function commandRow(row: QueryResultRow): CaseCommandRow {
  return {
    tenantId: row.tenant_id,
    commandId: row.command_id,
    caseId: row.case_id,
    commandKind: row.command_kind,
    expectedRevision: String(row.expected_revision),
    payloadHash: row.payload_hash,
    command: row.command_json as CaseCommand,
    actorId: row.actor_id,
    grantId: row.grant_id,
    status: row.status,
    outcome: row.outcome,
    reason: row.reason,
    resultingRevision: row.resulting_revision === null ? null : String(row.resulting_revision),
    decision: row.decision_json,
    receivedAt: row.received_at,
    completedAt: row.completed_at,
  };
}

function outboxRow(row: QueryResultRow): CaseOutboxRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    caseId: row.case_id,
    commandId: row.command_id,
    caseRevision: row.case_revision,
    intentKind: row.intent_kind,
    payload: row.payload,
    status: row.status,
    attempts: row.attempts,
    availableAt: row.available_at,
    dispatchedAt: row.dispatched_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
  };
}

function eventRow(row: QueryResultRow): CaseDomainEventRow {
  return {
    seq: row.seq,
    tenantId: row.tenant_id,
    caseId: row.case_id,
    commandId: row.command_id,
    caseRevision: row.case_revision,
    eventKind: row.event_kind,
    payload: row.payload,
    createdAt: row.created_at,
  };
}

/**
 * Postgres business-truth adapter for the case lifecycle (ADR 0002). All
 * mutations go through one transaction that also records the command ledger
 * entry, domain events and outbox intents; no actor checkpoint is an authority.
 */
export class PostgresCaseStore {
  constructor(
    private readonly pool: Pool,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async createRelationship(
    relationship: CustomerRelationship,
    opts?: { channelId?: string },
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO customer_relationships
         (tenant_id, id, customer_id, channel_id, preference_reuse_allowed)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, id) DO NOTHING`,
      [
        relationship.tenantId,
        relationship.id,
        relationship.customerId,
        opts?.channelId ?? null,
        relationship.preferenceReuseAllowed,
      ],
    );
  }

  /** Creates the relationship if absent, then the case and its `case_created` event in one tx. */
  async createCase(input: CreateCaseInput): Promise<CaseSnapshot> {
    const snapshot = createServiceCase(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.insertCaseOn(client, input, snapshot);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return snapshot;
  }

  private async insertCaseOn(
    client: PoolClient,
    input: CreateCaseInput,
    snapshot: CaseSnapshot,
  ): Promise<void> {
    await client.query(
      `INSERT INTO customer_relationships
         (tenant_id, id, customer_id, channel_id, preference_reuse_allowed)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, id) DO NOTHING`,
      [
        input.relationship.tenantId,
        input.relationship.id,
        input.relationship.customerId,
        input.channelId ?? null,
        input.relationship.preferenceReuseAllowed,
      ],
    );
    const relationship = await client.query(
      `SELECT customer_id FROM customer_relationships
       WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [input.relationship.tenantId, input.relationship.id],
    );
    if (relationship.rows[0].customer_id !== input.relationship.customerId) {
      throw new Error("Relationship already exists for a different customer");
    }
    await client.query(
      `INSERT INTO service_cases
         (tenant_id, id, relationship_id, customer_id, channel_id, payer_id,
          revision, phase, wait_reason, deadline, brief_id, brief_version,
          outcome, cancel_requested, snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        snapshot.scope.tenantId,
        snapshot.scope.caseId,
        snapshot.scope.relationshipId,
        snapshot.scope.customerId,
        input.channelId ?? null,
        input.payerId ?? snapshot.brief.approverActorId,
        snapshot.revision,
        snapshot.phase,
        snapshot.waitReason,
        snapshot.deadline,
        snapshot.brief.id,
        snapshot.brief.version,
        snapshot.outcome,
        snapshot.cancelRequested,
        JSON.stringify(snapshot),
      ],
    );
    await client.query(
      `INSERT INTO case_domain_events
         (tenant_id, case_id, command_id, case_revision, event_kind, payload)
       VALUES ($1, $2, NULL, $3, 'case_created', $4)`,
      [
        snapshot.scope.tenantId,
        snapshot.scope.caseId,
        snapshot.revision,
        JSON.stringify({
          relationshipId: snapshot.scope.relationshipId,
          customerId: snapshot.scope.customerId,
          briefId: snapshot.brief.id,
          eventId: snapshot.sourceEvent.id,
        }),
      ],
    );
  }

  /**
   * Atomic create + activate: the case rows and the activation command receipt,
   * decision, events and intents commit in one transaction. An identical retry
   * returns the original result without reinserting the case; a changed payload
   * under the same command ID conflicts through the composite hash.
   */
  async createAndActivateCase(
    input: CreateCaseInput,
    command: ActivateInput,
    context: { now: Date; authority: CaseAuthority },
  ): Promise<StoredCommandResult> {
    const snapshot = createServiceCase(input);
    if (!hasCaseCommandAuthority(snapshot.scope, command, context)) {
      throw new CaseActivationError("authority_or_scope_mismatch");
    }
    const hash = createHash("sha256")
      .update(
        canonicalJson({
          operation: "create_and_activate_v1",
          input,
          command,
          actorId: context.authority.actorId,
          grantId: context.authority.grantId,
        }),
      )
      .digest("hex");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const fresh = await this.insertReceiptOn(client, command, context.authority, hash);
      if (fresh) await this.insertCaseOn(client, input, snapshot);
      const result = await this.completeLocked(
        client,
        command.tenantId,
        command.commandId,
        context,
        hash,
      );
      if (result.decision.outcome !== "applied") {
        throw new CaseActivationError(result.decision.reason);
      }
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      if (isServiceCasesPkConflict(error)) {
        throw new CaseActivationError("case_already_exists");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async getCase(tenantId: string, caseId: string): Promise<CaseSnapshot | null> {
    const result = await this.pool.query(
      "SELECT snapshot FROM service_cases WHERE tenant_id = $1 AND id = $2",
      [tenantId, caseId],
    );
    if (result.rowCount === 0) return null;
    return result.rows[0].snapshot as CaseSnapshot;
  }

  async getTimeline(
    tenantId: string,
    caseId: string,
    afterSeq?: string,
  ): Promise<CaseDomainEventRow[]> {
    const result = await this.pool.query(
      `SELECT ${EVENT_COLUMNS} FROM case_domain_events
       WHERE tenant_id = $1 AND case_id = $2 AND seq > $3
       ORDER BY case_domain_events.seq`,
      [tenantId, caseId, afterSeq ?? "0"],
    );
    return result.rows.map(eventRow);
  }

  async getCommand(tenantId: string, commandId: string): Promise<CaseCommandRow | null> {
    const result = await this.pool.query(
      `SELECT ${COMMAND_COLUMNS} FROM case_commands
       WHERE tenant_id = $1 AND command_id = $2`,
      [tenantId, commandId],
    );
    if (result.rowCount === 0) return null;
    return commandRow(result.rows[0]);
  }

  /**
   * Commits the 'received' ledger row (with the full command payload so a later
   * recovery can complete it by ID alone) and returns immediately. A repeat with
   * the same payload deduplicates; a different payload conflicts.
   */
  async receiveCommand(
    command: CaseCommand,
    authority: CaseAuthority,
  ): Promise<ReceivedCommandResult> {
    const payloadHash = hashCommandPayload(command);
    const inserted = await this.pool.query(
      `INSERT INTO case_commands
         (tenant_id, command_id, case_id, command_kind, expected_revision,
          payload_hash, command_json, actor_id, grant_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'received')
       ON CONFLICT (tenant_id, command_id) DO NOTHING`,
      [
        command.tenantId,
        command.commandId,
        command.caseId,
        command.kind,
        command.expectedRevision,
        payloadHash,
        canonicalJson(command),
        authority.actorId,
        authority.grantId,
      ],
    );
    if (inserted.rowCount && inserted.rowCount > 0) {
      return { status: "received", deduplicated: false };
    }
    const existing = await this.getCommand(command.tenantId, command.commandId);
    if (!existing) throw new Error("command_receipt_lost");
    if (existing.payloadHash !== payloadHash) throw new CommandConflictError(command.commandId);
    const result: ReceivedCommandResult = { status: existing.status, deduplicated: true };
    if (existing.decision) result.decision = existing.decision;
    return result;
  }

  /**
   * Completes a previously received command in one Postgres transaction: ledger
   * deduplication, case-row lock, pure decision, conditional revision CAS,
   * immutable child records, domain events and outbox intents all commit or all
   * roll back.
   */
  async completeReceivedCommand(
    tenantId: string,
    commandId: string,
    context: { now: Date; authority: CaseAuthority },
  ): Promise<StoredCommandResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await this.completeLocked(client, tenantId, commandId, context, null);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Atomic receive + complete: one transaction for a fresh submission or a locked retry. */
  async submitCommand(
    command: CaseCommand,
    context: { now: Date; authority: CaseAuthority },
  ): Promise<StoredCommandResult> {
    const payloadHash = hashCommandPayload(command);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.insertReceiptOn(client, command, context.authority, payloadHash);
      const result = await this.completeLocked(
        client,
        command.tenantId,
        command.commandId,
        context,
        payloadHash,
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async insertReceiptOn(
    client: PoolClient,
    command: CaseCommand,
    authority: CaseAuthority,
    payloadHash: string,
  ): Promise<boolean> {
    const result = await client.query(
      `INSERT INTO case_commands
         (tenant_id, command_id, case_id, command_kind, expected_revision,
          payload_hash, command_json, actor_id, grant_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'received')
       ON CONFLICT (tenant_id, command_id) DO NOTHING`,
      [
        command.tenantId,
        command.commandId,
        command.caseId,
        command.kind,
        command.expectedRevision,
        payloadHash,
        canonicalJson(command),
        authority.actorId,
        authority.grantId,
      ],
    );
    return result.rowCount === 1;
  }

  /** Core of completeReceivedCommand/submitCommand. Caller owns the transaction. */
  private async completeLocked(
    client: PoolClient,
    tenantId: string,
    commandId: string,
    context: { now: Date; authority: CaseAuthority },
    payloadHash: string | null,
  ): Promise<StoredCommandResult> {
    const locked = await client.query(
      `SELECT ${COMMAND_COLUMNS} FROM case_commands
       WHERE tenant_id = $1 AND command_id = $2 FOR UPDATE`,
      [tenantId, commandId],
    );
    if (locked.rowCount === 0) throw new Error("command_not_received");
    const row = commandRow(locked.rows[0]);
    if (payloadHash !== null && row.payloadHash !== payloadHash) {
      throw new CommandConflictError(commandId);
    }
    if (row.status === "completed") {
      if (!row.decision) throw new Error("completed_command_missing_decision");
      const outbox = await this.listOutboxForCaseOn(client, tenantId, row.caseId, row.commandId);
      return { deduplicated: true, decision: row.decision, outboxIds: outbox };
    }
    const command = row.command;
    const caseResult = await client.query(
      `SELECT revision, snapshot FROM service_cases
       WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, row.caseId],
    );
    if (caseResult.rowCount === 0) {
      const rejected = {
        outcome: "rejected",
        reason: "case_not_found",
        state: null,
        intents: [],
      } as unknown as CaseDecision;
      await client.query(
        `UPDATE case_commands
         SET status = 'completed', outcome = 'rejected', reason = 'case_not_found',
             decision_json = $3, completed_at = now()
         WHERE tenant_id = $1 AND command_id = $2`,
        [tenantId, commandId, canonicalJson(rejected)],
      );
      return { deduplicated: false, decision: rejected, outboxIds: [] };
    }
    const before = caseResult.rows[0].snapshot as CaseSnapshot;
    const atHandoff = command.kind === "dispatch_handoff" || command.kind === "retry_handoff";
    const decision = decideCase(
      before,
      command,
      atHandoff ? { ...context, now: this.clock() } : context,
    );
    const outboxIds: string[] = [];
    if (decision.outcome === "applied") {
      const next = decision.state;
      // Commercial parties track the selected proposal's quote and the current
      // brief. Records from an older briefVersion are ignored so a revision
      // clears stale parties until new records for the revised brief arrive.
      const selectedProposal = next.proposals
        .filter((proposal) => proposal.briefVersion === next.brief.version)
        .at(-1);
      const selectedQuote = selectedProposal
        ? next.quotes.find(
            (quote) =>
              quote.id === selectedProposal.quoteId &&
              quote.version === selectedProposal.quoteVersion &&
              quote.briefVersion === next.brief.version,
          )
        : next.quotes.filter((quote) => quote.briefVersion === next.brief.version).at(-1);
      const cas = await client.query(
        `UPDATE service_cases
         SET revision = $3, phase = $4, wait_reason = $5, brief_id = $6, brief_version = $7,
             outcome = $8, cancel_requested = $9, snapshot = $10,
             seller_id = $12, fulfiller_id = $13, payer_id = $14, updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND revision = $11
         RETURNING revision`,
        [
          tenantId,
          row.caseId,
          next.revision,
          next.phase,
          next.waitReason,
          next.brief.id,
          next.brief.version,
          next.outcome,
          next.cancelRequested,
          JSON.stringify(next),
          command.expectedRevision,
          selectedQuote?.sellerId ?? null,
          selectedQuote?.fulfillerId ?? null,
          next.brief.approverActorId,
        ],
      );
      if (cas.rowCount === 0) {
        throw new Error("concurrent_case_revision_conflict");
      }
      if (next.phase === "closed") {
        await client.query(
          `UPDATE case_allowances
           SET status = 'closed', pause_reason = NULL, updated_at = now()
           WHERE tenant_id = $1 AND case_id = $2`,
          [tenantId, row.caseId],
        );
      }
      await this.persistImmutableRecords(client, before, next, command);
      await client.query(
        `INSERT INTO case_domain_events
           (tenant_id, case_id, command_id, case_revision, event_kind, payload)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          tenantId,
          row.caseId,
          commandId,
          next.revision,
          `command.${command.kind}`,
          canonicalJson({ reason: decision.reason, command }),
        ],
      );
      for (const intent of decision.intents) {
        await client.query(
          `INSERT INTO case_domain_events
             (tenant_id, case_id, command_id, case_revision, event_kind, payload)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            tenantId,
            row.caseId,
            commandId,
            next.revision,
            `intent.${intent.kind}`,
            canonicalJson(intent),
          ],
        );
        const outbox = await client.query(
          `INSERT INTO case_outbox
             (tenant_id, case_id, command_id, case_revision, intent_kind, payload, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'pending')
           RETURNING id::text AS id`,
          [tenantId, row.caseId, commandId, next.revision, intent.kind, canonicalJson(intent)],
        );
        outboxIds.push(outbox.rows[0].id);
      }
    }
    await client.query(
      `UPDATE case_commands
       SET status = 'completed', outcome = $3, reason = $4, resulting_revision = $5,
           decision_json = $6, completed_at = now()
       WHERE tenant_id = $1 AND command_id = $2`,
      [
        tenantId,
        commandId,
        decision.outcome,
        decision.reason,
        decision.outcome === "applied" ? decision.state.revision : null,
        canonicalJson({
          outcome: decision.outcome,
          reason: decision.reason,
          state: decision.state,
          intents: decision.intents,
        }),
      ],
    );
    return { deduplicated: false, decision, outboxIds };
  }

  /**
   * Persists the immutable side records implied by the state transition. A
   * duplicate key here is a bug or a conflicting write, not something to
   * silently deduplicate, so conflicts propagate and roll the transaction back.
   */
  private async persistImmutableRecords(
    client: PoolClient,
    before: CaseSnapshot,
    next: CaseSnapshot,
    command: CaseCommand,
  ): Promise<void> {
    const tenantId = next.scope.tenantId;
    const caseId = next.scope.caseId;
    const previousTask = before.activeTask?.taskId ?? null;
    const currentTask = next.activeTask?.taskId ?? null;
    if (next.activeTask && currentTask !== previousTask) {
      const task = next.activeTask;
      await client.query(
        `INSERT INTO case_agent_jobs
           (tenant_id, case_id, task_id, request_id, brief_version, case_revision,
            max_model_calls, max_tool_calls, deadline, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'running')`,
        [
          tenantId,
          caseId,
          task.taskId,
          task.taskId,
          task.briefVersion,
          task.caseRevision,
          task.maxModelCalls,
          task.maxToolCalls,
          task.deadline,
        ],
      );
    }
    if (previousTask && currentTask !== previousTask) {
      let status: string;
      if (command.kind === "agent_task_stopped") {
        if (command.reason === "deadline_exceeded") status = "expired";
        else if (command.reason === "cancelled") status = "cancelled";
        else status = "failed";
      } else {
        status = command.kind === "agent_candidate" ? "completed" : "cancelled";
      }
      await client.query(
        `UPDATE case_agent_jobs SET status = $4, updated_at = now()
         WHERE tenant_id = $1 AND case_id = $2 AND task_id = $3`,
        [tenantId, caseId, previousTask, status],
      );
    }
    for (const quote of next.quotes.slice(before.quotes.length)) {
      await client.query(
        `INSERT INTO case_quotes
           (tenant_id, case_id, id, version, rfq_id, brief_version, supplier_id,
            seller_id, fulfiller_id, payee_id, amount_minor, currency, valid_until,
            availability, evidence_ref)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          tenantId,
          caseId,
          quote.id,
          quote.version,
          quote.rfqId,
          quote.briefVersion,
          quote.supplierId,
          quote.sellerId,
          quote.fulfillerId,
          quote.payeeId,
          quote.total.amountMinor,
          quote.total.currency,
          quote.validUntil,
          quote.availability,
          quote.evidenceRef,
        ],
      );
    }
    for (const proposal of next.proposals.slice(before.proposals.length)) {
      await client.query(
        `INSERT INTO case_proposals
           (tenant_id, case_id, id, version, brief_version, quote_id, quote_version,
            terms_hash, amount_minor, currency, valid_until, approver_actor_id, scope_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          tenantId,
          caseId,
          proposal.id,
          proposal.version,
          proposal.briefVersion,
          proposal.quoteId,
          proposal.quoteVersion,
          proposal.termsHash,
          proposal.total.amountMinor,
          proposal.total.currency,
          proposal.validUntil,
          proposal.approverActorId,
          canonicalJson(proposal.scope),
        ],
      );
    }
    if (next.approval && next.approval.id !== before.approval?.id) {
      const approval = next.approval;
      await client.query(
        `INSERT INTO case_approvals
           (tenant_id, id, case_id, proposal_id, proposal_version, terms_hash,
            amount_minor, currency, valid_until, scope_json, approved_by,
            authority_grant_id, approved_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          tenantId,
          approval.id,
          approval.caseId,
          approval.proposalId,
          approval.proposalVersion,
          approval.termsHash,
          approval.total.amountMinor,
          approval.total.currency,
          approval.validUntil,
          canonicalJson(approval.scope),
          approval.approvedBy,
          approval.authorityGrantId,
          approval.approvedAt,
        ],
      );
    }
    if (next.action && before.action === null) {
      const action = next.action;
      await client.query(
        `INSERT INTO case_external_actions
           (tenant_id, id, case_id, client_reference, request_hash, proposal_id,
            proposal_version, status, attempts, provider_reference,
            evidence_refs, attempt_fences, reconciliation_evidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          tenantId,
          action.id,
          caseId,
          action.clientReference,
          action.requestHash,
          action.proposalId,
          action.proposalVersion,
          action.status,
          action.attempts,
          action.providerReference,
          canonicalJson(action.evidenceRefs),
          canonicalJson(action.attemptFences ?? []),
          canonicalJson(action.reconciliationEvidence),
        ],
      );
    } else if (
      next.action &&
      before.action !== null &&
      canonicalJson(next.action) !== canonicalJson(before.action)
    ) {
      const action = next.action;
      await client.query(
        `UPDATE case_external_actions
         SET status = $4, attempts = $5, provider_reference = $6,
             evidence_refs = $7, attempt_fences = $8, reconciliation_evidence = $9,
             updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND case_id = $3`,
        [
          tenantId,
          action.id,
          caseId,
          action.status,
          action.attempts,
          action.providerReference,
          canonicalJson(action.evidenceRefs),
          canonicalJson(action.attemptFences ?? []),
          canonicalJson(action.reconciliationEvidence),
        ],
      );
    }
  }

  /**
   * Claims due pending intents and expired dispatched leases, so a worker that
   * crashed after claiming is recoverable after `leaseTimeoutMs`.
   * FOR UPDATE SKIP LOCKED makes concurrent claims race-safe.
   */
  async claimPendingOutbox(
    limit: number,
    options?: {
      tenantId?: string;
      caseId?: string;
      now?: Date;
      leaseTimeoutMs?: number;
      intentKinds?: readonly string[];
    },
  ): Promise<CaseOutboxRow[]> {
    const now = options?.now ?? new Date();
    const leaseTimeoutMs = options?.leaseTimeoutMs ?? DEFAULT_OUTBOX_LEASE_MS;
    const staleBefore = new Date(now.getTime() - leaseTimeoutMs);
    const result = await this.pool.query(
      `UPDATE case_outbox
       SET status = 'dispatched', attempts = attempts + 1, dispatched_at = $3
       WHERE id IN (
         SELECT id FROM case_outbox
         WHERE (
           (status = 'pending' AND available_at <= $3)
           OR (status = 'dispatched' AND dispatched_at <= $4)
         )
         AND ($2::text IS NULL OR tenant_id = $2)
         AND ($5::text IS NULL OR case_id = $5)
         AND ($6::text[] IS NULL OR intent_kind = ANY($6::text[]))
         ORDER BY COALESCE(dispatched_at, available_at), id
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING ${OUTBOX_COLUMNS}`,
      [
        limit,
        options?.tenantId ?? null,
        now,
        staleBefore,
        options?.caseId ?? null,
        options?.intentKinds ?? null,
      ],
    );
    return result.rows.map(outboxRow);
  }

  /**
   * Explicitly resets expired 'dispatched' leases back to 'pending' so they are
   * eligible for the next claimPendingOutbox. Returns the reset rows.
   */
  async reclaimStaleOutbox(options?: {
    tenantId?: string;
    caseId?: string;
    now?: Date;
    leaseTimeoutMs?: number;
  }): Promise<CaseOutboxRow[]> {
    const now = options?.now ?? new Date();
    const leaseTimeoutMs = options?.leaseTimeoutMs ?? DEFAULT_OUTBOX_LEASE_MS;
    const staleBefore = new Date(now.getTime() - leaseTimeoutMs);
    const result = await this.pool.query(
      `UPDATE case_outbox
       SET status = 'pending', available_at = $2
       WHERE id IN (
         SELECT id FROM case_outbox
         WHERE status = 'dispatched' AND dispatched_at <= $3
           AND ($1::text IS NULL OR tenant_id = $1)
           AND ($4::text IS NULL OR case_id = $4)
         FOR UPDATE SKIP LOCKED
       )
       RETURNING ${OUTBOX_COLUMNS}`,
      [options?.tenantId ?? null, now, staleBefore, options?.caseId ?? null],
    );
    return result.rows.map(outboxRow);
  }

  async completeOutbox(outboxId: string): Promise<void> {
    await this.pool.query(
      `UPDATE case_outbox
       SET status = 'completed', completed_at = now()
       WHERE id = $1`,
      [outboxId],
    );
  }

  async requeueOutbox(outboxId: string, availableAt?: Date): Promise<void> {
    await this.pool.query(
      `UPDATE case_outbox
       SET status = 'pending', available_at = $2
       WHERE id = $1`,
      [outboxId, availableAt ?? new Date()],
    );
  }

  async listOutboxForCase(tenantId: string, caseId: string): Promise<CaseOutboxRow[]> {
    const result = await this.pool.query(
      `SELECT ${OUTBOX_COLUMNS} FROM case_outbox
       WHERE tenant_id = $1 AND case_id = $2 ORDER BY case_outbox.id`,
      [tenantId, caseId],
    );
    return result.rows.map(outboxRow);
  }

  private async listOutboxForCaseOn(
    client: PoolClient,
    tenantId: string,
    caseId: string,
    commandId: string,
  ): Promise<string[]> {
    const result = await client.query(
      `SELECT id::text AS id FROM case_outbox
       WHERE tenant_id = $1 AND case_id = $2 AND command_id = $3 ORDER BY case_outbox.id`,
      [tenantId, caseId, commandId],
    );
    return result.rows.map((row) => row.id);
  }
}
