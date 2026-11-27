-- OCA-7: persisted per-case usage allowances and budget pause state.
-- Detailed attribution rows remain in case_usage_ledger (002_case_core.sql).

CREATE TABLE case_allowances (
  tenant_id text NOT NULL,
  case_id text NOT NULL,
  max_model_calls bigint NOT NULL CHECK (max_model_calls >= 0),
  max_tool_calls bigint NOT NULL CHECK (max_tool_calls >= 0),
  max_cost_minor bigint CHECK (max_cost_minor >= 0),
  currency text CHECK (currency ~ '^[A-Z]{3}$'),
  used_model_calls bigint NOT NULL DEFAULT 0 CHECK (used_model_calls >= 0),
  used_tool_calls bigint NOT NULL DEFAULT 0 CHECK (used_tool_calls >= 0),
  used_cost_minor bigint NOT NULL DEFAULT 0 CHECK (used_cost_minor >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused_budget', 'closed')),
  pause_reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, case_id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES service_cases (tenant_id, id),
  CHECK ((max_cost_minor IS NULL) = (currency IS NULL)),
  CHECK ((status != 'paused_budget') OR pause_reason IS NOT NULL)
);

CREATE INDEX case_allowances_status_idx
  ON case_allowances (tenant_id, status, updated_at);
