-- Earlier installations already recorded 002 before it included the lease-recovery index.
CREATE INDEX IF NOT EXISTS case_outbox_dispatched_idx
  ON case_outbox (dispatched_at, id) WHERE status = 'dispatched';
