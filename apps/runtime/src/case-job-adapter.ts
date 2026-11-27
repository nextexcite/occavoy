import type {
  AgentTaskCandidate,
  CaseAuthority,
  CaseDecision,
  ResourceRequirement,
} from "@occavoy/domain/case-lifecycle";
import type { PostgresCaseStore, PostgresUsageLedger, UsageCostCategory } from "@occavoy/storage";

export type AgentJobPurpose = "clarify_brief" | "derive_requirements" | "explain_proposal";

/** Application-owned job identity and input fence. The model cannot change these fields. */
export interface AgentJobSpec {
  tenantId: string;
  caseId: string;
  taskId: string;
  requestId: string;
  baseRevision: number;
  briefVersion: number;
  purpose: AgentJobPurpose;
  toolProfile: "case_readonly_v1";
  deadlineAt: string;
  /** Propagated from the domain task so a generated candidate retains its finite shape. */
  maxModelCalls?: number;
  maxToolCalls?: number;
}

export interface UsageCharge {
  costMinor?: number;
  currency?: string;
  metadata?: Record<string, unknown>;
}

export interface CaseJobRunControls {
  signal: AbortSignal;
  reserveModelCall(charge?: UsageCharge): Promise<void>;
  reserveToolCall(charge?: UsageCharge): Promise<void>;
}

/** Runs one bounded reasoning job and returns an unvalidated candidate-shaped value. */
export interface CaseJobRunner {
  run(spec: AgentJobSpec, controls: CaseJobRunControls): Promise<unknown>;
}

export type CaseJobCompletion =
  | { status: "submitted"; deduplicated: boolean; decision: CaseDecision }
  | { status: "aborted"; reason: "cancelled" | "deadline_exceeded" }
  | { status: "budget_exhausted"; reason: "budget_exhausted" };

export class JobAbortedError extends Error {
  constructor() {
    super("Agent job aborted");
    this.name = "JobAbortedError";
  }
}

export class BudgetExhaustedError extends Error {
  constructor() {
    super("Case usage budget exhausted");
    this.name = "BudgetExhaustedError";
  }
}

export class JobDeadlineExceededError extends Error {
  constructor() {
    super("Agent job deadline exceeded");
    this.name = "JobDeadlineExceededError";
  }
}

export class CandidateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CandidateValidationError";
  }
}

export function piActorKeyForJob(spec: AgentJobSpec): [string, string, string] {
  return [spec.tenantId, spec.caseId, spec.taskId];
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new JobAbortedError();
}

function parseRequirement(value: unknown, seen: Set<string>): ResourceRequirement | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const id = input.id;
  const rawCategory = input.category;
  const description = input.description;
  if (
    typeof id !== "string" ||
    id.trim().length === 0 ||
    seen.has(id) ||
    typeof description !== "string" ||
    description.trim().length === 0
  ) {
    return null;
  }
  let category: ResourceRequirement["category"];
  switch (rawCategory) {
    case "event_access":
    case "accommodation":
    case "transport":
      category = rawCategory;
      break;
    default:
      return null;
  }
  seen.add(id);
  return { id, category, description };
}

/** Explicit production-boundary validation; never cast a harness/probe result directly. */
export function validateAgentTaskCandidate(value: unknown): AgentTaskCandidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CandidateValidationError("Candidate must be an object");
  }
  const candidate = value as Record<string, unknown>;
  const task = candidate.task;
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    throw new CandidateValidationError("Candidate task must be an object");
  }
  const t = task as Record<string, unknown>;
  const taskId = t.taskId;
  const tenantId = t.tenantId;
  const caseId = t.caseId;
  const briefVersion = t.briefVersion;
  const caseRevision = t.caseRevision;
  const maxModelCalls = t.maxModelCalls;
  const maxToolCalls = t.maxToolCalls;
  const deadline = t.deadline;
  const validTask =
    typeof taskId === "string" &&
    taskId.trim().length > 0 &&
    typeof tenantId === "string" &&
    tenantId.trim().length > 0 &&
    typeof caseId === "string" &&
    caseId.trim().length > 0 &&
    Number.isSafeInteger(briefVersion) &&
    Number(briefVersion) >= 1 &&
    Number.isSafeInteger(caseRevision) &&
    Number(caseRevision) >= 0 &&
    Number.isSafeInteger(maxModelCalls) &&
    Number(maxModelCalls) >= 1 &&
    Number.isSafeInteger(maxToolCalls) &&
    Number(maxToolCalls) >= 0 &&
    typeof deadline === "string" &&
    Number.isFinite(Date.parse(deadline));
  if (!validTask) throw new CandidateValidationError("Candidate task fence is invalid");
  if (!Array.isArray(candidate.requirements) || candidate.requirements.length === 0) {
    throw new CandidateValidationError("Candidate requirements must be a non-empty array");
  }
  const seen = new Set<string>();
  const requirements: ResourceRequirement[] = [];
  for (const input of candidate.requirements) {
    const requirement = parseRequirement(input, seen);
    if (!requirement) {
      throw new CandidateValidationError("Candidate requirements are invalid or duplicated");
    }
    requirements.push(requirement);
  }
  return {
    task: {
      taskId,
      tenantId,
      caseId,
      briefVersion: Number(briefVersion),
      caseRevision: Number(caseRevision),
      maxModelCalls: Number(maxModelCalls),
      maxToolCalls: Number(maxToolCalls),
      deadline,
    },
    requirements,
  };
}

function validateCandidateFence(candidate: AgentTaskCandidate, spec: AgentJobSpec): void {
  const task = candidate.task;
  if (
    task.tenantId !== spec.tenantId ||
    task.caseId !== spec.caseId ||
    task.taskId !== spec.taskId ||
    task.caseRevision !== spec.baseRevision ||
    task.briefVersion !== spec.briefVersion
  ) {
    throw new CandidateValidationError("Candidate does not match the persisted job fence");
  }
}

export interface CaseJobAdapterDeps {
  store: PostgresCaseStore;
  usageLedger: PostgresUsageLedger;
  relationshipIdForJob(spec: AgentJobSpec): string | Promise<string>;
  authorityForJob(spec: AgentJobSpec): CaseAuthority;
  runner: CaseJobRunner;
  costCategory?: UsageCostCategory;
  now?: () => Date;
}

/**
 * Reserves usage before every model/tool step, then validates and submits the
 * resulting candidate through the transactional case command boundary. A
 * late abort avoids submission; the domain CAS/fence remains the final guard.
 */
export class CaseJobAdapter {
  private readonly deps: CaseJobAdapterDeps;

  constructor(deps: CaseJobAdapterDeps) {
    this.deps = deps;
  }

  async run(spec: AgentJobSpec, options?: { signal?: AbortSignal }): Promise<CaseJobCompletion> {
    const callerSignal = options?.signal ?? new AbortController().signal;
    const deadlineAt = Date.parse(spec.deadlineAt);
    if (!Number.isFinite(deadlineAt)) throw new CandidateValidationError("Job deadline is invalid");
    const nowMs = () => this.deps.now?.().getTime() ?? Date.now();
    if (nowMs() >= deadlineAt) return { status: "aborted", reason: "deadline_exceeded" };
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener("abort", abortFromCaller, { once: true });
    const deadlineTimer = setTimeout(() => controller.abort(), Math.max(1, deadlineAt - nowMs()));
    const signal = controller.signal;
    const costCategory = this.deps.costCategory ?? "dev_subscription";
    const throwIfDeadlineExceeded = () => {
      if (nowMs() >= deadlineAt) throw new JobDeadlineExceededError();
    };
    const reserve = async (kind: "model_call" | "tool_call", charge?: UsageCharge) => {
      throwIfAborted(signal);
      throwIfDeadlineExceeded();
      const reservation = await this.deps.usageLedger.reserveUsage({
        tenantId: spec.tenantId,
        relationshipId: await this.deps.relationshipIdForJob(spec),
        caseId: spec.caseId,
        taskId: spec.taskId,
        kind,
        quantity: 1,
        costMinor: charge?.costMinor ?? 0,
        ...(charge?.currency ? { currency: charge.currency } : {}),
        metadata: {
          ...(charge?.metadata ?? {}),
          costCategory,
          purpose: spec.purpose,
          toolProfile: spec.toolProfile,
        },
      });
      if (!reservation.admitted) throw new BudgetExhaustedError();
      throwIfAborted(signal);
    };
    try {
      const raw = await this.deps.runner.run(spec, {
        signal,
        reserveModelCall: (charge) => reserve("model_call", charge),
        reserveToolCall: (charge) => reserve("tool_call", charge),
      });
      throwIfAborted(signal);
      throwIfDeadlineExceeded();
      const candidate = validateAgentTaskCandidate(raw);
      validateCandidateFence(candidate, spec);
      throwIfAborted(signal);
      throwIfDeadlineExceeded();
      const submitted = await this.deps.store.submitCommand(
        {
          kind: "agent_candidate",
          candidate,
          commandId: `agent-candidate-${spec.taskId}`,
          tenantId: spec.tenantId,
          caseId: spec.caseId,
          expectedRevision: spec.baseRevision,
        },
        {
          now: this.deps.now?.() ?? new Date(),
          authority: this.deps.authorityForJob(spec),
        },
      );
      return {
        status: "submitted",
        deduplicated: submitted.deduplicated,
        decision: submitted.decision,
      };
    } catch (error) {
      if (error instanceof JobDeadlineExceededError || nowMs() >= deadlineAt) {
        return { status: "aborted", reason: "deadline_exceeded" };
      }
      if (error instanceof JobAbortedError || signal.aborted) {
        return { status: "aborted", reason: "cancelled" };
      }
      if (error instanceof BudgetExhaustedError) {
        return { status: "budget_exhausted", reason: "budget_exhausted" };
      }
      throw error;
    } finally {
      clearTimeout(deadlineTimer);
      callerSignal.removeEventListener("abort", abortFromCaller);
    }
  }
}

export type ScriptedCaseJobScript =
  | {
      modelSteps?: UsageCharge[];
      toolSteps?: UsageCharge[];
      result?: unknown | ((spec: AgentJobSpec) => unknown);
    }
  | ((spec: AgentJobSpec, controls: CaseJobRunControls) => Promise<unknown>);

export function defaultScriptedCandidate(spec: AgentJobSpec): AgentTaskCandidate {
  return {
    task: {
      taskId: spec.taskId,
      tenantId: spec.tenantId,
      caseId: spec.caseId,
      briefVersion: spec.briefVersion,
      caseRevision: spec.baseRevision,
      maxModelCalls: spec.maxModelCalls ?? 1,
      maxToolCalls: spec.maxToolCalls ?? 1,
      deadline: spec.deadlineAt,
    },
    requirements: [
      {
        id: `requirement-${spec.taskId}`,
        category: "accommodation",
        description: "Synthetic bounded accommodation requirement",
      },
    ],
  };
}

export class ScriptedCaseJobRunner implements CaseJobRunner {
  private readonly script: ScriptedCaseJobScript;

  constructor(script: ScriptedCaseJobScript = {}) {
    this.script = script;
  }

  async run(spec: AgentJobSpec, controls: CaseJobRunControls): Promise<unknown> {
    if (typeof this.script === "function") return this.script(spec, controls);
    for (const charge of this.script.modelSteps ?? [{}]) {
      await controls.reserveModelCall(charge);
    }
    for (const charge of this.script.toolSteps ?? []) {
      await controls.reserveToolCall(charge);
    }
    const result = this.script.result;
    return typeof result === "function" ? result(spec) : (result ?? defaultScriptedCandidate(spec));
  }
}

export class ScriptedCaseJobAdapter extends CaseJobAdapter {
  constructor(deps: Omit<CaseJobAdapterDeps, "runner">, script?: ScriptedCaseJobScript) {
    super({ ...deps, runner: new ScriptedCaseJobRunner(script) });
  }
}

export interface PiJobInvocation {
  /** Exact Pi actor key required by ADR 0005: [tenantId, caseId, jobId]. */
  key: [string, string, string];
  spec: AgentJobSpec;
  requestId: string;
  prompt: string;
  controls: CaseJobRunControls;
}

/**
 * Host hook for the pinned Pi integration. The invoker must obtain the Pi actor
 * by `key`, call `submit(prompt, { requestId })`, retry transport failures with
 * the same request ID, and return only the job's structured candidate payload.
 */
export type PiJobInvoker = (invocation: PiJobInvocation) => Promise<unknown>;

export class PiJobRunner implements CaseJobRunner {
  private readonly invoker: PiJobInvoker;

  constructor(invoker: PiJobInvoker) {
    this.invoker = invoker;
  }

  run(spec: AgentJobSpec, controls: CaseJobRunControls): Promise<unknown> {
    return this.invoker({
      key: piActorKeyForJob(spec),
      spec,
      requestId: spec.requestId,
      prompt: JSON.stringify({
        tenantId: spec.tenantId,
        caseId: spec.caseId,
        taskId: spec.taskId,
        baseRevision: spec.baseRevision,
        briefVersion: spec.briefVersion,
        purpose: spec.purpose,
        toolProfile: spec.toolProfile,
        deadlineAt: spec.deadlineAt,
      }),
      controls,
    });
  }
}

export class PiJobAdapter extends CaseJobAdapter {
  constructor(deps: Omit<CaseJobAdapterDeps, "runner">, invoker: PiJobInvoker) {
    super({ ...deps, runner: new PiJobRunner(invoker) });
  }
}
