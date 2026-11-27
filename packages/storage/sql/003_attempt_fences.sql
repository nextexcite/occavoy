-- OCA-6: structured supplier-side fences for terminal nonexecution evidence.
-- Kept as JSONB evidence because fence metadata is audited as part of the action,
-- not used as a relational authorization source.

ALTER TABLE case_external_actions
  ADD COLUMN attempt_fences jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT case_external_actions_attempt_fences_array
    CHECK (jsonb_typeof(attempt_fences) = 'array');
