import { timingSafeEqual } from "node:crypto";
import type {
  AgentTaskReference,
  CaseAuthority,
  CaseCommand,
  CaseDecision,
  CaseIntent,
  CaseRfq,
  CaseSnapshot,
} from "@occavoy/domain/case-lifecycle";
import {
  type CaseAllowanceSpec,
  type CaseOutboxRow,
  PostgresCaseStore,
  PostgresUsageLedger,
  type ReceivedCommandResult,
  type StoredCommandResult,
} from "@occavoy/storage";
import pg from "pg";
import { actor, UserError } from "rivetkit";
import { db, type RawAccess } from "rivetkit/db";
import {
  type AgentJobSpec,
  CaseJobAdapter,
  PiJobAdapter,
  type PiJobInvoker,
} from "./case-job-adapter.js";
import {
  initializeServiceCaseDatabase,
  readServiceCaseDrainState,
  writeServiceCaseDrainState,
} from "./service-case-store.js";

export interface SupplierQuoteRequestContext {
  tenantId: string;
  caseId: string;
  outboxId: string;
}

export interface CaseJobCancellationContext {
  tenantId: string;
  caseId: string;
  outboxId: string;
}

export interface ServiceCaseDrainSummary {
  claimed: number;
  completed: number;
  requeued: number;
  errors: Array<{ outboxId: string; intentKind: string; message: string }>;
}

export interface ServiceCaseRecoverySnapshot {
  state: CaseSnapshot | null;
  outbox: CaseOutboxRow[];
  drain: ServiceCaseDrainSummary;
}

type RunnableJobAdapter = Pick<CaseJobAdapter, "run">;

export interface ServiceCaseCoordinatorDeps {
  store: PostgresCaseStore;
  usageLedger: PostgresUsageLedger;
  createJobAdapter(spec: AgentJobSpec): RunnableJobAdapter;
  /** The requester must deduplicate externally by rfq.id; dispatch is at least once. */
  requestSupplierQuote?(rfq: CaseRfq, context: SupplierQuoteRequestContext): Promise<void>;
  /** Hook for the Pi conversation abort; it must be idempotent by taskId/requestId. */
  cancelAgentTask?(task: AgentTaskReference, context: CaseJobCancellationContext): Promise<void>;
  allowanceForTask?(task: AgentTaskReference): Omit<CaseAllowanceSpec, "tenantId" | "caseId">;
  authorityForJob?(spec: AgentJobSpec): CaseAuthority;
  now?: () => Date;
  staleDispatchMs?: number;
}

function keyOf(tenantId: string, caseId: string, taskId?: string): string {
  return [tenantId, caseId, taskId ?? ""].join("\u0000");
}

function intentFromRow(row: CaseOutboxRow): CaseIntent {
  const payload = row.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("outbox_payload_invalid");
  }
  const kind = (payload as { kind?: unknown }).kind;
  if (
    kind !== "run_agent_task" &&
    kind !== "cancel_agent_task" &&
    kind !== "request_supplier_quote" &&
    kind !== "supplier_handoff"
  ) {
    throw new Error("outbox_intent_invalid");
  }
  return payload as CaseIntent;
}

function defaultAuthority(spec: AgentJobSpec): CaseAuthority {
  return {
    tenantId: spec.tenantId,
    caseId: spec.caseId,
    actorId: "service-case-runtime",
    grantId: `runtime-grant-${spec.tenantId}`,
    permissions: ["agent.result"],
    validUntil: spec.deadlineAt,
  };
}

function validateTaskScope(row: CaseOutboxRow, task: AgentTaskReference): void {
  if (task.tenantId !== row.tenantId || task.caseId !== row.caseId || !task.taskId.trim()) {
    throw new Error("outbox_task_scope_mismatch");
  }
}

function sameTask(
  active: AgentTaskReference | null | undefined,
  task: AgentTaskReference,
): boolean {
  return (
    !!active &&
    active.taskId === task.taskId &&
    active.caseRevision === task.caseRevision &&
    active.briefVersion === task.briefVersion &&
    active.tenantId === task.tenantId &&
    active.caseId === task.caseId
  );
}

function sameRfq(left: CaseRfq, right: CaseRfq): boolean {
  return (
    left.id === right.id &&
    left.supplierId === right.supplierId &&
    left.briefVersion === right.briefVersion &&
    left.requirementIds.length === right.requirementIds.length &&
    left.requirementIds.every((id, index) => id === right.requirementIds[index])
  );
}

/**
 * Deterministic per-case coordinator. Postgres remains the authority; this
 * class only claims committed outbox intents, starts bounded job adapters,
 * cancels in-memory work promptly, and hands supplier intents to an idempotent
 * dispatcher. It does not keep a model loop open while waiting for suppliers.
 */
export class ServiceCaseCoordinator {
  private readonly drains = new Map<string, Promise<ServiceCaseDrainSummary>>();
  private readonly jobs = new Map<string, { controller: AbortController; spec: AgentJobSpec }>();
  private readonly deps: ServiceCaseCoordinatorDeps;

  constructor(deps: ServiceCaseCoordinatorDeps) {
    this.deps = deps;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private outboxLeaseMs(): number {
    return this.deps.staleDispatchMs ?? 120_000;
  }

  async submitCommand(
    command: CaseCommand,
    authority: CaseAuthority,
  ): Promise<StoredCommandResult> {
    const result = await this.deps.store.submitCommand(command, {
      now: this.now(),
      authority,
    });
    if (!result.deduplicated && result.decision.outcome === "applied") {
      await this.afterDecision(command.tenantId, command.caseId, result.decision);
    }
    return result;
  }

  async receiveCommand(
    command: CaseCommand,
    authority: CaseAuthority,
  ): Promise<ReceivedCommandResult> {
    return this.deps.store.receiveCommand(command, authority);
  }

  async completeReceivedCommand(
    tenantId: string,
    commandId: string,
    authority: CaseAuthority,
    expectedCaseId?: string,
  ): Promise<StoredCommandResult> {
    const receipt = await this.deps.store.getCommand(tenantId, commandId);
    if (!receipt) throw new Error("command_not_received");
    if (expectedCaseId !== undefined && receipt.caseId !== expectedCaseId) {
      throw new Error("command_case_scope_mismatch");
    }
    const result = await this.deps.store.completeReceivedCommand(tenantId, commandId, {
      now: this.now(),
      authority,
    });
    if (!result.deduplicated && result.decision.outcome === "applied") {
      await this.afterDecision(tenantId, receipt.caseId, result.decision);
    }
    return result;
  }

  /** Promptly fences/aborts in-process work superseded by a committed business revision. */
  private async afterDecision(
    tenantId: string,
    caseId: string,
    decision: CaseDecision,
  ): Promise<void> {
    const activeTaskId = decision.state?.activeTask?.taskId ?? null;
    const prefix = keyOf(tenantId, caseId);
    for (const [key, job] of this.jobs) {
      if (key.startsWith(prefix) && job.spec.taskId !== activeTaskId) {
        job.controller.abort();
      }
    }
  }

  /**
   * Drains due outbox rows for one case. Concurrent calls for the same case
   * share one in-process drain; competing processes are fenced by the database
   * SKIP LOCKED claim and by idempotent receivers/request IDs.
   */
  async drainCase(tenantId: string, caseId: string): Promise<ServiceCaseDrainSummary> {
    const key = keyOf(tenantId, caseId);
    const existing = this.drains.get(key);
    if (existing) return existing;
    const drain = this.drainLoop(tenantId, caseId).finally(() => {
      this.drains.delete(key);
    });
    this.drains.set(key, drain);
    return drain;
  }

  async getStatus(tenantId: string, caseId: string) {
    return {
      state: await this.deps.store.getCase(tenantId, caseId),
      outbox: await this.deps.store.listOutboxForCase(tenantId, caseId),
      allowance: await this.deps.usageLedger.getAllowance(tenantId, caseId),
    };
  }

  /** Next time unfinished outbox work can become claimable, or null when the case is idle. */
  async nextDrainAt(tenantId: string, caseId: string): Promise<Date | null> {
    const rows = await this.deps.store.listOutboxForCase(tenantId, caseId);
    const leaseMs = this.outboxLeaseMs();
    let next: Date | null = null;
    for (const row of rows) {
      let candidate: Date | null = null;
      if (row.status === "pending") candidate = row.availableAt;
      if (row.status === "dispatched" && row.dispatchedAt) {
        candidate = new Date(row.dispatchedAt.getTime() + leaseMs);
      }
      if (candidate && (!next || candidate < next)) next = candidate;
    }
    return next;
  }

  async recoverCase(tenantId: string, caseId: string): Promise<ServiceCaseRecoverySnapshot> {
    const drain = await this.drainCase(tenantId, caseId);
    const state = await this.deps.store.getCase(tenantId, caseId);
    const after = await this.deps.store.listOutboxForCase(tenantId, caseId);
    return { state, outbox: after, drain };
  }

  private async drainLoop(tenantId: string, caseId: string): Promise<ServiceCaseDrainSummary> {
    const staleMs = this.outboxLeaseMs();
    const summary: ServiceCaseDrainSummary = {
      claimed: 0,
      completed: 0,
      requeued: 0,
      errors: [],
    };
    for (;;) {
      const rows = await this.deps.store.claimPendingOutbox(10, {
        tenantId,
        caseId,
        now: this.now(),
        leaseTimeoutMs: staleMs,
      });
      if (rows.length === 0) break;
      summary.claimed += rows.length;
      for (const row of rows) {
        try {
          await this.dispatchRow(row);
          await this.deps.store.completeOutbox(row.id);
          summary.completed += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          summary.errors.push({ outboxId: row.id, intentKind: row.intentKind, message });
          const delay = Math.min(30_000, 250 * 2 ** Math.min(row.attempts, 7));
          await this.deps.store.requeueOutbox(row.id, new Date(this.now().getTime() + delay));
          summary.requeued += 1;
        }
      }
    }
    return summary;
  }

  private async dispatchRow(row: CaseOutboxRow): Promise<void> {
    const intent = intentFromRow(row);
    switch (intent.kind) {
      case "run_agent_task":
        await this.runAgentTask(row, intent.task);
        return;
      case "cancel_agent_task":
        await this.cancelAgentTask(row, intent.task);
        return;
      case "request_supplier_quote":
        await this.requestSupplierQuote(row, intent.rfq);
        return;
      case "supplier_handoff":
        throw new Error("supplier_handoff_requires_oca6_effect_dispatcher");
    }
  }

  private async runAgentTask(row: CaseOutboxRow, task: AgentTaskReference): Promise<void> {
    validateTaskScope(row, task);
    const snapshot = await this.deps.store.getCase(row.tenantId, row.caseId);
    if (!snapshot) throw new Error("case_not_found_for_agent_task");
    if (!sameTask(snapshot.activeTask, task)) {
      return;
    }
    const spec: AgentJobSpec = {
      tenantId: row.tenantId,
      caseId: row.caseId,
      taskId: task.taskId,
      requestId: task.taskId,
      baseRevision: task.caseRevision,
      briefVersion: task.briefVersion,
      purpose: "derive_requirements",
      toolProfile: "case_readonly_v1",
      deadlineAt: task.deadline,
      maxModelCalls: task.maxModelCalls,
      maxToolCalls: task.maxToolCalls,
    };
    const key = keyOf(row.tenantId, row.caseId, task.taskId);
    const existing = this.jobs.get(key);
    if (existing) return;
    const controller = new AbortController();
    this.jobs.set(key, { controller, spec });
    try {
      const allowance = this.deps.allowanceForTask?.(task) ?? {
        maxModelCalls: task.maxModelCalls,
        maxToolCalls: task.maxToolCalls,
        maxCostMinor: null,
        currency: null,
      };
      const existingAllowance = await this.deps.usageLedger.getAllowance(row.tenantId, row.caseId);
      if (!existingAllowance) {
        await this.deps.usageLedger.initializeAllowance({
          tenantId: row.tenantId,
          caseId: row.caseId,
          ...allowance,
        });
      }
      const current = await this.deps.store.getCase(row.tenantId, row.caseId);
      if (controller.signal.aborted || !sameTask(current?.activeTask, task)) {
        return;
      }
      const adapter = this.deps.createJobAdapter(spec);
      const completion = await adapter.run(spec, { signal: controller.signal });
      if (completion.status === "submitted" && completion.decision.outcome === "applied") return;
      await this.recordAgentTaskStop(row, task, completion);
    } finally {
      this.jobs.delete(key);
    }
  }

  /**
   * Records why a bounded job ended without an accepted candidate, using a
   * short-lived internal receipt authority scoped to agent.stop only. This
   * evidence never extends a job/candidate grant and never restarts work.
   */
  private async recordAgentTaskStop(
    row: CaseOutboxRow,
    task: AgentTaskReference,
    completion: Awaited<ReturnType<RunnableJobAdapter["run"]>>,
  ): Promise<void> {
    const now = this.now();
    const current = await this.deps.store.getCase(row.tenantId, row.caseId);
    if (!current) throw new Error("case_not_found_for_agent_task");
    // A committed newer/revised/closed state already accounts for this run.
    if (!sameTask(current.activeTask, task)) return;
    const reason =
      completion.status === "submitted"
        ? Date.parse(task.deadline) <= now.getTime()
          ? "deadline_exceeded"
          : "candidate_rejected"
        : completion.reason;
    const result = await this.deps.store.submitCommand(
      {
        kind: "agent_task_stopped",
        task,
        reason,
        tenantId: row.tenantId,
        caseId: row.caseId,
        expectedRevision: current.revision,
        commandId: `agent-stop:${row.id}:${current.revision}:${reason}`,
      },
      {
        now,
        authority: {
          tenantId: row.tenantId,
          caseId: row.caseId,
          actorId: "service-case-runtime",
          grantId: `outbox-stop:${row.id}`,
          permissions: ["agent.stop"],
          validUntil: new Date(now.getTime() + 60_000).toISOString(),
        },
      },
    );
    if (
      result.decision.outcome !== "applied" &&
      sameTask((await this.deps.store.getCase(row.tenantId, row.caseId))?.activeTask, task)
    ) {
      throw new Error("agent_task_stop_not_persisted");
    }
  }

  private async cancelAgentTask(row: CaseOutboxRow, task: AgentTaskReference): Promise<void> {
    validateTaskScope(row, task);
    this.jobs.get(keyOf(row.tenantId, row.caseId, task.taskId))?.controller.abort();
    await this.deps.cancelAgentTask?.(task, {
      tenantId: row.tenantId,
      caseId: row.caseId,
      outboxId: row.id,
    });
  }

  private async requestSupplierQuote(row: CaseOutboxRow, rfq: CaseRfq): Promise<void> {
    if (!this.deps.requestSupplierQuote) {
      throw new Error("supplier_quote_requester_not_configured");
    }
    const snapshot = await this.deps.store.getCase(row.tenantId, row.caseId);
    const currentRfq = snapshot?.rfq ?? null;
    const current =
      snapshot &&
      snapshot.phase === "sourcing" &&
      snapshot.waitReason === "supplier_quote" &&
      !snapshot.cancelRequested &&
      snapshot.outcome === null &&
      Date.parse(snapshot.deadline) > this.now().getTime() &&
      currentRfq !== null &&
      currentRfq.briefVersion === snapshot.brief.version &&
      sameRfq(currentRfq, rfq);
    if (!current) return;
    await this.deps.requestSupplierQuote(rfq, {
      tenantId: row.tenantId,
      caseId: row.caseId,
      outboxId: row.id,
    });
  }
}

export interface ServiceCaseCommandEnvelope {
  command: CaseCommand;
  authority: CaseAuthority;
}

export interface CreateServiceCaseActorOptions {
  databaseUrl?: string;
  createCoordinator?: (scope: { tenantId: string; caseId: string }) => ServiceCaseCoordinator;
  piJobInvoker?: PiJobInvoker;
  cancelAgentTask?: ServiceCaseCoordinatorDeps["cancelAgentTask"];
  requestSupplierQuote?: ServiceCaseCoordinatorDeps["requestSupplierQuote"];
}

function authorize(expected: string, supplied: unknown): void {
  if (typeof supplied !== "string") throw new UserError("Forbidden", { code: "forbidden" });
  const actualBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new UserError("Forbidden", { code: "forbidden" });
  }
}

function actorScope(key: string[]): { tenantId: string; caseId: string } {
  const [tenantId, caseId] = key;
  if (!tenantId?.trim() || !caseId?.trim() || key.length !== 2) {
    throw new UserError("Service case actor key must be [tenantId, caseId].", {
      code: "invalid_actor_key",
    });
  }
  return { tenantId, caseId };
}

function requireCommandScope(
  scope: { tenantId: string; caseId: string },
  envelope: ServiceCaseCommandEnvelope,
): void {
  if (
    envelope.command.tenantId !== scope.tenantId ||
    envelope.command.caseId !== scope.caseId ||
    envelope.authority.tenantId !== scope.tenantId ||
    envelope.authority.caseId !== scope.caseId
  ) {
    throw new UserError("Command does not match the service case actor scope.", {
      code: "case_scope_mismatch",
    });
  }
}

function commandEnvelope(value: unknown): ServiceCaseCommandEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UserError("A command envelope is required.", { code: "invalid_command" });
  }
  const envelope = value as Partial<ServiceCaseCommandEnvelope>;
  if (!envelope.command || !envelope.authority) {
    throw new UserError("Command and server-derived authority are required.", {
      code: "invalid_command",
    });
  }
  return envelope as ServiceCaseCommandEnvelope;
}

function defaultPiInvoker(): never {
  throw new Error("pi_job_invoker_not_configured");
}

/**
 * Rivet 3.1.1 supported-action wrapper. Actor SQLite storage is only a drain
 * schedule receipt/cursor; all business state and usage authority remain in Postgres.
 */
export function createServiceCaseActor(
  secret: string,
  options: CreateServiceCaseActorOptions = {},
) {
  const shared = options.databaseUrl
    ? (() => {
        const pool = new pg.Pool({ connectionString: options.databaseUrl });
        const store = new PostgresCaseStore(pool);
        const usageLedger = new PostgresUsageLedger(pool);
        return { pool, store, usageLedger };
      })()
    : null;
  const coordinators = new Map<string, ServiceCaseCoordinator>();
  const coordinatorFor = (scope: { tenantId: string; caseId: string }) => {
    const key = keyOf(scope.tenantId, scope.caseId);
    const existing = coordinators.get(key);
    if (existing) return existing;
    if (options.createCoordinator) {
      const created = options.createCoordinator(scope);
      coordinators.set(key, created);
      return created;
    }
    if (!shared)
      throw new UserError("DATABASE_URL is required for serviceCase.", {
        code: "storage_unconfigured",
      });
    const created = new ServiceCaseCoordinator({
      store: shared.store,
      usageLedger: shared.usageLedger,
      createJobAdapter: (spec) =>
        new PiJobAdapter(
          {
            store: shared.store,
            usageLedger: shared.usageLedger,
            relationshipIdForJob: async (jobSpec) => {
              const snapshot = await shared.store.getCase(jobSpec.tenantId, jobSpec.caseId);
              if (!snapshot) throw new Error("case_not_found_for_agent_task");
              return snapshot.scope.relationshipId;
            },
            authorityForJob: defaultAuthority,
          },
          options.piJobInvoker ?? defaultPiInvoker,
        ),
      ...(options.cancelAgentTask ? { cancelAgentTask: options.cancelAgentTask } : {}),
      ...(options.requestSupplierQuote
        ? { requestSupplierQuote: options.requestSupplierQuote }
        : {}),
    });
    coordinators.set(key, created);
    return created;
  };

  async function scheduleDrain(
    c: {
      db: RawAccess;
      schedule: { after(duration: number, action: string, ...args: unknown[]): Promise<string> };
    },
    delayMs = 10,
  ): Promise<void> {
    const now = Date.now();
    const id = await c.schedule.after(delayMs, "drainScheduled");
    const state = await readServiceCaseDrainState(c.db);
    await writeServiceCaseDrainState(c.db, {
      ...state,
      drainScheduleId: id,
      drainScheduledAt: now + delayMs,
    });
  }

  async function scheduleNextDrain(
    c: {
      db: RawAccess;
      schedule: { after(duration: number, action: string, ...args: unknown[]): Promise<string> };
    },
    scope: { tenantId: string; caseId: string },
  ): Promise<void> {
    const next = await coordinatorFor(scope).nextDrainAt(scope.tenantId, scope.caseId);
    if (!next) return;
    await scheduleDrain(c, Math.max(10, next.getTime() - Date.now()));
  }

  return actor({
    db: db({ onMigrate: initializeServiceCaseDatabase }),
    onBeforeConnect: (_c, params: { authToken?: string } | undefined) => {
      authorize(secret, params?.authToken);
    },
    onWake: async (c) => {
      await scheduleDrain(c);
    },
    actions: {
      submit: async (c, value: unknown) => {
        const scope = actorScope(c.key);
        const input = commandEnvelope(value);
        requireCommandScope(scope, input);
        const result = await coordinatorFor(scope).submitCommand(input.command, input.authority);
        await scheduleDrain(c);
        return result;
      },
      receive: async (c, value: unknown) => {
        const scope = actorScope(c.key);
        const input = commandEnvelope(value);
        requireCommandScope(scope, input);
        return coordinatorFor(scope).receiveCommand(input.command, input.authority);
      },
      completeReceived: async (c, value: { commandId?: string; authority?: CaseAuthority }) => {
        const scope = actorScope(c.key);
        if (!value?.commandId || !value.authority) {
          throw new UserError("commandId and authority are required.", { code: "invalid_command" });
        }
        if (
          value.authority.tenantId !== scope.tenantId ||
          value.authority.caseId !== scope.caseId
        ) {
          throw new UserError("Authority does not match the service case actor scope.", {
            code: "case_scope_mismatch",
          });
        }
        const result = await coordinatorFor(scope).completeReceivedCommand(
          scope.tenantId,
          value.commandId,
          value.authority,
          scope.caseId,
        );
        await scheduleDrain(c);
        return result;
      },
      drain: async (c) => {
        const scope = actorScope(c.key);
        const result = await coordinatorFor(scope).drainCase(scope.tenantId, scope.caseId);
        await scheduleNextDrain(c, scope);
        return result;
      },
      drainScheduled: async (c) => {
        const scope = actorScope(c.key);
        const before = await readServiceCaseDrainState(c.db);
        await writeServiceCaseDrainState(c.db, {
          ...before,
          drainScheduledAt: 0,
          drainScheduleId: null,
        });
        try {
          const result = await coordinatorFor(scope).drainCase(scope.tenantId, scope.caseId);
          await scheduleNextDrain(c, scope);
          const current = await readServiceCaseDrainState(c.db);
          await writeServiceCaseDrainState(c.db, {
            ...current,
            lastDrainAt: new Date().toISOString(),
          });
          return result;
        } catch (error) {
          await scheduleDrain(c, 1_000);
          throw error;
        }
      },
      status: async (c) => {
        const scope = actorScope(c.key);
        return {
          ...(await coordinatorFor(scope).getStatus(scope.tenantId, scope.caseId)),
          actorDrain: await readServiceCaseDrainState(c.db),
        };
      },
    },
  });
}
