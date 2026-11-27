-- Contract migration for the future Postgres adapter; not applied by bootstrap.
-- One shared row covers all Occavoy prefixes, including dev/staging if they use R2.
CREATE TABLE object_budget (
  id text PRIMARY KEY CHECK (id = 'occavoy'),
  committed_bytes bigint NOT NULL DEFAULT 0 CHECK (committed_bytes >= 0),
  reserved_bytes bigint NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
  CHECK (committed_bytes + reserved_bytes <= 8000000000)
);
INSERT INTO object_budget (id) VALUES ('occavoy') ON CONFLICT DO NOTHING;

CREATE TABLE object_reservation (
  id text PRIMARY KEY,
  object_key text UNIQUE NOT NULL,
  bytes bigint NOT NULL CHECK (bytes > 0 AND bytes <= 8000000000),
  state text NOT NULL CHECK (state IN ('reserved', 'committed', 'unknown', 'released')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Adapter must use one transaction: insert a UNIQUE reservation and perform:
-- UPDATE object_budget SET reserved_bytes = reserved_bytes + $1
-- WHERE id = 'occavoy' AND committed_bytes + reserved_bytes + $1 <= 8000000000
-- RETURNING id;
-- No row returned => ROLLBACK and reject. The UPDATE serializes concurrent admissions.
-- Commit/release must compare reservation state in the same transaction as budget mutation.
-- A failed R2 request stays reserved/unknown. Release only after absence is established.
-- Account for multipart uploads, orphan objects and deletes before enabling any upload API.
