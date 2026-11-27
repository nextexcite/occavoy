ALTER TABLE object_reservation
  ADD COLUMN expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  ADD COLUMN actual_bytes bigint CHECK (actual_bytes > 0),
  ADD COLUMN reconciliation_note text,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX object_reservation_pending_expiry ON object_reservation (expires_at)
  WHERE state IN ('reserved', 'unknown');
