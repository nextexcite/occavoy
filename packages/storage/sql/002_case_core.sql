-- OCA-4: Postgres business truth for service cases (ADR 0002).
-- Standard PostgreSQL only: no extensions, no vendor-specific types.
-- Money is bigint minor units with ISO 4217 currency text; times are timestamptz.

CREATE TABLE customer_relationships (
  tenant_id text NOT NULL,
  id text NOT NULL,
  customer_id text NOT NULL,
  channel_id text,
  preference_reuse_allowed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE service_cases (
  tenant_id text NOT NULL,
  id text NOT NULL,
  relationship_id text NOT NULL,
  customer_id text NOT NULL,
  channel_id text,
  payer_id text,
  seller_id text,
  fulfiller_id text,
  revision bigint NOT NULL CHECK (revision >= 0),
  phase text NOT NULL CHECK (
    phase IN (
      'draft', 'clarifying', 'sourcing', 'proposal_ready',
      'awaiting_approval', 'fulfilling', 'closed'
    )
  ),
  wait_reason text CHECK (
    wait_reason IN (
      'agent_task', 'supplier_quote', 'approval',
      'supplier_confirmation', 'reconciliation'
    )
  ),
  deadline timestamptz NOT NULL,
  brief_id text NOT NULL,
  brief_version bigint NOT NULL CHECK (brief_version >= 1),
  outcome text CHECK (outcome IN ('fulfilled', 'declined', 'unavailable', 'cancelled')),
  cancel_requested boolean NOT NULL DEFAULT false,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, relationship_id)
    REFERENCES customer_relationships (tenant_id, id)
);
CREATE INDEX service_cases_phase_deadline_idx
  ON service_cases (tenant_id, phase, deadline);

CREATE TABLE case_commands (
  tenant_id text NOT NULL,
  command_id text NOT NULL,
  case_id text NOT NULL,
  command_kind text NOT NULL,
  expected_revision bigint NOT NULL,
  payload_hash text NOT NULL,
  command_json jsonb NOT NULL,
  actor_id text,
  grant_id text,
  status text NOT NULL CHECK (status IN ('received', 'completed')),
  outcome text CHECK (outcome IN ('applied', 'ignored', 'rejected')),
  reason text,
  resulting_revision bigint,
  decision_json jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, command_id)
);
CREATE INDEX case_commands_case_idx
  ON case_commands (tenant_id, case_id, received_at);

CREATE TABLE case_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id text NOT NULL,
  case_id text NOT NULL,
  command_id text NOT NULL,
  case_revision bigint NOT NULL,
  intent_kind text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'dispatched', 'completed', 'failed')
  ),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, command_id) REFERENCES case_commands (tenant_id, command_id)
);
CREATE INDEX case_outbox_pending_idx
  ON case_outbox (available_at, id) WHERE status = 'pending';
CREATE INDEX case_outbox_case_idx ON case_outbox (tenant_id, case_id, id);

CREATE TABLE case_domain_events (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id text NOT NULL,
  case_id text NOT NULL,
  command_id text,
  case_revision bigint NOT NULL,
  event_kind text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX case_domain_events_case_idx
  ON case_domain_events (tenant_id, case_id, seq);

-- Immutable commercial records: written in the same transaction as the case
-- revision that introduced them and never overwritten afterwards.
CREATE TABLE case_quotes (
  tenant_id text NOT NULL,
  case_id text NOT NULL,
  id text NOT NULL,
  version bigint NOT NULL CHECK (version >= 1),
  rfq_id text NOT NULL,
  brief_version bigint NOT NULL,
  supplier_id text NOT NULL,
  seller_id text NOT NULL,
  fulfiller_id text NOT NULL,
  payee_id text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  valid_until timestamptz NOT NULL,
  availability text NOT NULL CHECK (availability IN ('observed', 'quoted', 'held')),
  evidence_ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, case_id, id, version)
);

CREATE TABLE case_proposals (
  tenant_id text NOT NULL,
  case_id text NOT NULL,
  id text NOT NULL,
  version bigint NOT NULL CHECK (version >= 1),
  brief_version bigint NOT NULL,
  quote_id text NOT NULL,
  quote_version bigint NOT NULL,
  terms_hash text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  valid_until timestamptz NOT NULL,
  approver_actor_id text NOT NULL,
  scope_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, case_id, id, version)
);

CREATE TABLE case_approvals (
  tenant_id text NOT NULL,
  id text NOT NULL,
  case_id text NOT NULL,
  proposal_id text NOT NULL,
  proposal_version bigint NOT NULL,
  terms_hash text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  valid_until timestamptz NOT NULL,
  scope_json jsonb NOT NULL,
  approved_by text NOT NULL,
  authority_grant_id text NOT NULL,
  approved_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX case_approvals_case_idx ON case_approvals (tenant_id, case_id, id);

CREATE TABLE case_external_actions (
  tenant_id text NOT NULL,
  id text NOT NULL,
  case_id text NOT NULL,
  client_reference text NOT NULL,
  request_hash text NOT NULL,
  proposal_id text NOT NULL,
  proposal_version bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('dispatching', 'unknown', 'confirmed', 'not_executed')),
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts >= 0),
  provider_reference text,
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  reconciliation_evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, client_reference)
);
CREATE INDEX case_external_actions_case_idx
  ON case_external_actions (tenant_id, case_id, id);

CREATE TABLE case_agent_jobs (
  tenant_id text NOT NULL,
  case_id text NOT NULL,
  task_id text NOT NULL,
  request_id text NOT NULL,
  brief_version bigint NOT NULL,
  case_revision bigint NOT NULL,
  max_model_calls integer NOT NULL CHECK (max_model_calls >= 1),
  max_tool_calls integer NOT NULL CHECK (max_tool_calls >= 0),
  deadline timestamptz NOT NULL,
  status text NOT NULL CHECK (
    status IN ('queued', 'running', 'completed', 'cancelled', 'expired', 'failed')
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, case_id, task_id),
  UNIQUE (tenant_id, request_id)
);

CREATE TABLE case_usage_ledger (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id text NOT NULL,
  relationship_id text NOT NULL,
  case_id text,
  task_id text,
  kind text NOT NULL,
  quantity bigint NOT NULL CHECK (quantity >= 0),
  cost_minor bigint CHECK (cost_minor >= 0),
  currency text CHECK (currency ~ '^[A-Z]{3}$'),
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX case_usage_ledger_relationship_idx
  ON case_usage_ledger (tenant_id, relationship_id, id);
CREATE INDEX case_usage_ledger_case_idx
  ON case_usage_ledger (tenant_id, case_id, id);
