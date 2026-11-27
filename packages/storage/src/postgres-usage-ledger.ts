import type { Pool, PoolClient, QueryResultRow } from "pg";
import { canonicalJson } from "./postgres-case-store";

export type UsageKind = "model_call" | "tool_call" | "reconciliation_lookup";
export type UsageCostCategory =
  | "dev_subscription"
  | "production_api"
  | "rivet_runtime"
  | "human_operator";
export type CaseAllowanceStatus = "active" | "paused_budget" | "closed";

export interface CaseAllowanceSpec {
  tenantId: string;
  caseId: string;
  maxModelCalls: number;
  maxToolCalls: number;
  /** Null disables the monetary cap while call-count caps remain enforced. */
  maxCostMinor?: number | null;
  currency?: string | null;
}

export interface CaseAllowance {
  tenantId: string;
  caseId: string;
  maxModelCalls: number;
  maxToolCalls: number;
  maxCostMinor: number | null;
  currency: string | null;
  usedModelCalls: number;
  usedToolCalls: number;
  usedCostMinor: number;
  status: CaseAllowanceStatus;
  pauseReason: string | null;
  updatedAt: Date;
}

export interface UsageReservationInput {
  tenantId: string;
  relationshipId: string;
  caseId: string;
  taskId?: string | null;
  kind: UsageKind;
  quantity: number;
  costMinor?: number;
  currency?: string;
  metadata?: Record<string, unknown> & { costCategory?: UsageCostCategory };
}

export type UsageReservationResult =
  | { admitted: true; allowance: CaseAllowance }
  | {
      admitted: false;
      reason: "budget_exhausted" | "allowance_closed";
      allowance: CaseAllowance;
    };

type UsageRejection = "budget_exhausted" | "allowance_closed";

export interface CaseUsageRow {
  id: string;
  tenantId: string;
  relationshipId: string;
  caseId: string | null;
  taskId: string | null;
  kind: string;
  quantity: number;
  costMinor: number | null;
  currency: string | null;
  metadata: Record<string, unknown> | null;
  costCategory: UsageCostCategory | null;
  admitted: boolean | null;
  createdAt: Date;
}

export class UsageAllowanceError extends Error {
  constructor(
    readonly code: "allowance_not_initialized" | "invalid_usage_reservation",
    message: string,
  ) {
    super(message);
    this.name = "UsageAllowanceError";
  }
}

function validCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function optionalNumber(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

function allowanceRow(row: QueryResultRow): CaseAllowance {
  return {
    tenantId: row.tenant_id,
    caseId: row.case_id,
    maxModelCalls: Number(row.max_model_calls),
    maxToolCalls: Number(row.max_tool_calls),
    maxCostMinor: optionalNumber(row.max_cost_minor),
    currency: row.currency,
    usedModelCalls: Number(row.used_model_calls),
    usedToolCalls: Number(row.used_tool_calls),
    usedCostMinor: Number(row.used_cost_minor),
    status: row.status,
    pauseReason: row.pause_reason,
    updatedAt: row.updated_at,
  };
}

function usageRow(row: QueryResultRow): CaseUsageRow {
  const metadata = (row.metadata ?? null) as Record<string, unknown> | null;
  const category = metadata?.costCategory;
  return {
    id: String(row.id),
    tenantId: row.tenant_id,
    relationshipId: row.relationship_id,
    caseId: row.case_id,
    taskId: row.task_id,
    kind: row.kind,
    quantity: Number(row.quantity),
    costMinor: optionalNumber(row.cost_minor),
    currency: row.currency,
    metadata,
    costCategory:
      category === "dev_subscription" ||
      category === "production_api" ||
      category === "rivet_runtime" ||
      category === "human_operator"
        ? category
        : null,
    admitted: typeof metadata?.admitted === "boolean" ? metadata.admitted : null,
    createdAt: row.created_at,
  };
}

function validateSpec(spec: CaseAllowanceSpec): void {
  if (
    !spec.tenantId.trim() ||
    !spec.caseId.trim() ||
    !validCount(spec.maxModelCalls) ||
    !validCount(spec.maxToolCalls) ||
    (spec.maxCostMinor != null && !validCount(spec.maxCostMinor)) ||
    (spec.maxCostMinor == null) !== (spec.currency == null) ||
    (spec.currency != null && !/^[A-Z]{3}$/.test(spec.currency))
  ) {
    throw new UsageAllowanceError(
      "invalid_usage_reservation",
      "Allowance requires valid tenant, case, non-negative limits, and a paired cost limit/currency.",
    );
  }
}

function validateReservation(input: UsageReservationInput): void {
  const costMinor = input.costMinor ?? 0;
  if (
    !input.tenantId.trim() ||
    !input.relationshipId.trim() ||
    !input.caseId.trim() ||
    !validCount(input.quantity) ||
    !validCount(costMinor) ||
    (costMinor > 0 && !/^[A-Z]{3}$/.test(input.currency ?? ""))
  ) {
    throw new UsageAllowanceError(
      "invalid_usage_reservation",
      "Usage requires valid tenant, relationship, case, non-negative quantity/cost, and ISO currency for cost.",
    );
  }
}

/**
 * Durable per-case budget gate. The ledger row is attribution and audit, while
 * the allowance row is the atomic admission counter. Denied paid attempts are
 * attributed but do not consume the counters; reconciliation lookups remain
 * admissible after a budget pause so existing UNKNOWN external obligations can
 * be resolved without opening new discretionary paid work.
 */
export class PostgresUsageLedger {
  constructor(private readonly pool: Pool) {}

  async initializeAllowance(spec: CaseAllowanceSpec): Promise<CaseAllowance> {
    validateSpec(spec);
    const result = await this.pool.query(
      `INSERT INTO case_allowances
        (tenant_id, case_id, max_model_calls, max_tool_calls, max_cost_minor, currency)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, case_id) DO UPDATE SET
         max_model_calls = EXCLUDED.max_model_calls,
         max_tool_calls = EXCLUDED.max_tool_calls,
         max_cost_minor = EXCLUDED.max_cost_minor,
         currency = EXCLUDED.currency,
         updated_at = now()
       RETURNING *`,
      [
        spec.tenantId,
        spec.caseId,
        spec.maxModelCalls,
        spec.maxToolCalls,
        spec.maxCostMinor ?? null,
        spec.currency ?? null,
      ],
    );
    return allowanceRow(result.rows[0]);
  }

  async reserveUsage(input: UsageReservationInput): Promise<UsageReservationResult> {
    validateReservation(input);
    const costMinor = input.costMinor ?? 0;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query(
        `SELECT * FROM case_allowances
         WHERE tenant_id = $1 AND case_id = $2
         FOR UPDATE`,
        [input.tenantId, input.caseId],
      );
      if (locked.rowCount === 0) {
        throw new UsageAllowanceError(
          "allowance_not_initialized",
          `No usage allowance exists for case ${input.caseId}`,
        );
      }
      const before = allowanceRow(locked.rows[0]);
      if (
        costMinor > 0 &&
        before.currency !== null &&
        input.currency !== undefined &&
        input.currency !== before.currency
      ) {
        throw new UsageAllowanceError(
          "invalid_usage_reservation",
          `Usage currency ${input.currency} does not match allowance currency ${before.currency}`,
        );
      }
      let admitted = false;
      let rejection: UsageRejection | null = null;
      let taskRejection: "task_authority_inactive" | "task_limit_exceeded" | null = null;
      const taskId = input.taskId ?? null;
      const taskBound = typeof taskId === "string" && taskId.trim().length > 0;
      if (input.kind === "reconciliation_lookup") {
        admitted = before.status !== "closed";
        if (!admitted) rejection = "allowance_closed";
      } else if (before.status === "closed") {
        rejection = "allowance_closed";
      } else if (before.status === "paused_budget") {
        rejection = "budget_exhausted";
      } else {
        let taskLimit: number | null = null;
        let taskUsed = 0;
        if (taskBound) {
          const job = await client.query(
            `SELECT max_model_calls, max_tool_calls
             FROM case_agent_jobs
             WHERE tenant_id = $1 AND case_id = $2 AND task_id = $3 AND status = 'running'
             FOR UPDATE`,
            [input.tenantId, input.caseId, taskId],
          );
          if (job.rowCount === 0) {
            taskRejection = "task_authority_inactive";
          } else {
            taskLimit = Number(
              input.kind === "model_call"
                ? job.rows[0].max_model_calls
                : job.rows[0].max_tool_calls,
            );
            const usage = await client.query(
              `SELECT COALESCE(SUM(quantity), 0)::bigint AS used
               FROM case_usage_ledger
               WHERE tenant_id = $1 AND case_id = $2 AND task_id = $3 AND kind = $4
                 AND metadata ->> 'admitted' = 'true'`,
              [input.tenantId, input.caseId, taskId, input.kind],
            );
            taskUsed = Number(usage.rows[0].used);
            if (taskUsed + input.quantity > taskLimit) {
              taskRejection = "task_limit_exceeded";
            }
          }
        }

        const countExceeded =
          input.kind === "model_call"
            ? before.usedModelCalls + input.quantity > before.maxModelCalls
            : before.usedToolCalls + input.quantity > before.maxToolCalls;
        const costExceeded =
          before.maxCostMinor !== null && before.usedCostMinor + costMinor > before.maxCostMinor;
        const caseExceeded = countExceeded || costExceeded;
        if (caseExceeded) {
          rejection = "budget_exhausted";
          await client.query(
            `UPDATE case_allowances
             SET status = 'paused_budget', pause_reason = 'budget_exhausted', updated_at = now()
             WHERE tenant_id = $1 AND case_id = $2`,
            [input.tenantId, input.caseId],
          );
        } else if (taskRejection) {
          rejection = "budget_exhausted";
        } else {
          admitted = true;
        }
      }

      if (admitted) {
        await client.query(
          `UPDATE case_allowances
           SET used_model_calls = used_model_calls + $3,
               used_tool_calls = used_tool_calls + $4,
               used_cost_minor = used_cost_minor + $5,
               updated_at = now()
           WHERE tenant_id = $1 AND case_id = $2`,
          [
            input.tenantId,
            input.caseId,
            input.kind === "model_call" ? input.quantity : 0,
            input.kind === "tool_call" ? input.quantity : 0,
            costMinor,
          ],
        );
      }

      const metadata = {
        ...(input.metadata ?? {}),
        admitted,
        rejectionReason: rejection,
        rejectionDetail: taskRejection,
      };
      await client.query(
        `INSERT INTO case_usage_ledger
          (tenant_id, relationship_id, case_id, task_id, kind, quantity,
           cost_minor, currency, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          input.tenantId,
          input.relationshipId,
          input.caseId,
          input.taskId ?? null,
          input.kind,
          input.quantity,
          costMinor,
          input.currency ?? null,
          canonicalJson(metadata),
        ],
      );
      const after = await this.getAllowanceOn(client, input.tenantId, input.caseId);
      await client.query("COMMIT");
      if (!after) throw new Error("usage_allowance_lost_in_transaction");
      return admitted
        ? { admitted: true, allowance: after }
        : { admitted: false, reason: rejection ?? "budget_exhausted", allowance: after };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getAllowance(tenantId: string, caseId: string): Promise<CaseAllowance | null> {
    const result = await this.pool.query(
      "SELECT * FROM case_allowances WHERE tenant_id = $1 AND case_id = $2",
      [tenantId, caseId],
    );
    return result.rowCount === 0 ? null : allowanceRow(result.rows[0]);
  }

  private async getAllowanceOn(
    client: PoolClient,
    tenantId: string,
    caseId: string,
  ): Promise<CaseAllowance | null> {
    const result = await client.query(
      "SELECT * FROM case_allowances WHERE tenant_id = $1 AND case_id = $2",
      [tenantId, caseId],
    );
    return result.rowCount === 0 ? null : allowanceRow(result.rows[0]);
  }

  async listUsage(tenantId: string, caseId: string): Promise<CaseUsageRow[]> {
    const result = await this.pool.query(
      `SELECT id, tenant_id, relationship_id, case_id, task_id, kind, quantity,
              cost_minor, currency, metadata, created_at
       FROM case_usage_ledger
       WHERE tenant_id = $1 AND case_id = $2
       ORDER BY id`,
      [tenantId, caseId],
    );
    return result.rows.map(usageRow);
  }

  /** Idempotently closes the case gate. Existing attribution remains for audit. */
  async closeAllowance(tenantId: string, caseId: string): Promise<CaseAllowance | null> {
    const result = await this.pool.query(
      `UPDATE case_allowances
       SET status = 'closed', pause_reason = NULL, updated_at = now()
       WHERE tenant_id = $1 AND case_id = $2
       RETURNING *`,
      [tenantId, caseId],
    );
    return result.rowCount === 0 ? null : allowanceRow(result.rows[0]);
  }
}
