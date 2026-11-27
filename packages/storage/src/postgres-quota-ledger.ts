import type { Pool, PoolClient } from "pg";
import {
  CapacityExceeded,
  type DurableQuotaLedger,
  R2_CAPACITY_BYTES,
  type Reservation,
} from "./object-store";

export class ReservationSizeMismatchError extends Error {
  constructor(id: string, expected: number, actual: number) {
    super(`Reservation ${id} is for ${expected} bytes, observed ${actual}`);
  }
}

async function budgetTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    // Serialize admission and quarantine on the same row. The next statement gets
    // a fresh snapshot even when acquiring this lock had to wait.
    const budget = await client.query(
      "SELECT id FROM object_budget WHERE id = 'occavoy' FOR UPDATE",
    );
    if (!budget.rowCount) throw new Error("Missing quota budget");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function lockReservation(client: PoolClient, id: string) {
  const { rows } = await client.query<{ state: string; bytes: string }>(
    "SELECT state, bytes FROM object_reservation WHERE id = $1 FOR UPDATE",
    [id],
  );
  if (!rows[0]) throw new Error(`Missing reservation: ${id}`);
  return rows[0];
}

export class PostgresQuotaLedger implements DurableQuotaLedger {
  private readonly ttlMs: number;

  constructor(
    private readonly pool: Pool,
    opts: { defaultTtlMs?: number; budgetId?: string } = {},
  ) {
    if (opts.budgetId !== undefined && opts.budgetId !== "occavoy") {
      throw new Error("All Occavoy writers share the 'occavoy' budget");
    }
    this.ttlMs = opts.defaultTtlMs ?? 15 * 60 * 1000;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0)
      throw new Error("Invalid reservation TTL");
  }

  async reserve(request: Reservation, cap = R2_CAPACITY_BYTES): Promise<boolean> {
    if (!Number.isSafeInteger(cap) || cap < 0) throw new Error("Invalid capacity");
    if (!Number.isSafeInteger(request.bytes) || request.bytes <= 0)
      throw new Error("Invalid reservation size");
    const limit = Math.min(cap, R2_CAPACITY_BYTES);
    if (request.bytes > limit) return false;
    try {
      return await budgetTransaction(this.pool, async (client) => {
        const inserted = await client.query(
          `INSERT INTO object_reservation (id, object_key, bytes, state, expires_at)
           VALUES ($1, $2, $3, 'reserved', now() + $4 * interval '1 millisecond') ON CONFLICT DO NOTHING`,
          [request.id, request.key, request.bytes, this.ttlMs],
        );
        if (!inserted.rowCount) return false;
        const admitted = await client.query(
          `UPDATE object_budget SET reserved_bytes = reserved_bytes + $1
           WHERE id = 'occavoy' AND committed_bytes + reserved_bytes + $1 <= $2
             AND NOT EXISTS (SELECT 1 FROM object_reservation WHERE state = 'unknown'
               AND reconciliation_note = 'actual_bytes_mismatch' AND (actual_bytes IS NULL OR actual_bytes > bytes))
           RETURNING id`,
          [request.bytes, limit],
        );
        if (!admitted.rowCount) throw new CapacityExceeded(); // Roll back the insert too.
        return true;
      });
    } catch (error) {
      if (error instanceof CapacityExceeded) return false;
      throw error;
    }
  }

  async commit(id: string, actualBytes?: number): Promise<void> {
    const mismatch = await budgetTransaction(this.pool, async (client) => {
      const row = await lockReservation(client, id);
      if (row.state === "committed") return;
      if (row.state === "released") throw new Error("Cannot commit a released reservation");
      if (row.state === "unknown" && actualBytes === undefined)
        throw new Error("Verify object size before settling an unknown reservation");
      if (actualBytes !== undefined && actualBytes !== Number(row.bytes)) {
        // The schema accepts only positive lengths. Invalid/zero observations still quarantine the reservation.
        const recordable = Number.isSafeInteger(actualBytes) && actualBytes > 0;
        await client.query(
          `UPDATE object_reservation SET state = 'unknown', actual_bytes = $2,
           reconciliation_note = 'actual_bytes_mismatch', updated_at = now() WHERE id = $1`,
          [id, recordable ? actualBytes : null],
        );
        return new ReservationSizeMismatchError(id, Number(row.bytes), actualBytes);
      }
      const budget = await client.query(
        `UPDATE object_budget SET reserved_bytes = reserved_bytes - $1,
        committed_bytes = committed_bytes + $1 WHERE id = 'occavoy'`,
        [row.bytes],
      );
      if (!budget.rowCount) throw new Error("Missing quota budget");
      await client.query(
        `UPDATE object_reservation SET state = 'committed', actual_bytes = bytes,
        reconciliation_note = NULL, updated_at = now() WHERE id = $1`,
        [id],
      );
    });
    // Throw only after the unknown state is durable.
    if (mismatch) throw mismatch;
  }

  async markUnknown(id: string, note?: string): Promise<void> {
    await budgetTransaction(this.pool, async (client) => {
      await client.query(
        `UPDATE object_reservation SET state = 'unknown', reconciliation_note = $2,
        updated_at = now() WHERE id = $1 AND state = 'reserved'`,
        [id, note ?? null],
      );
    });
  }

  /** Caller has independently established absence and that no in-flight write can still land. */
  async releaseVerifiedAbsent(id: string, note: string): Promise<void> {
    if (!note.trim()) throw new Error("Absence verification note required");
    await budgetTransaction(this.pool, async (client) => {
      const row = await lockReservation(client, id);
      if (row.state === "released") return;
      if (row.state === "committed") throw new Error("Cannot release a committed reservation");
      const budget = await client.query(
        `UPDATE object_budget SET reserved_bytes = reserved_bytes - $1
        WHERE id = 'occavoy'`,
        [row.bytes],
      );
      if (!budget.rowCount) throw new Error("Missing quota budget");
      await client.query(
        `UPDATE object_reservation SET state = 'released', reconciliation_note = $2,
        updated_at = now() WHERE id = $1`,
        [id, note],
      );
    });
  }

  async reconcileExpiredReservations(now: Date) {
    const { rows } = await this.pool.query<{
      id: string;
      key: string;
      bytes: string;
      expiresAt: Date;
    }>(
      `UPDATE object_reservation SET state = 'unknown', reconciliation_note = 'reservation_ttl_expired',
       updated_at = now() WHERE state = 'reserved' AND expires_at <= $1
       RETURNING id, object_key AS key, bytes, expires_at AS "expiresAt"`,
      [now],
    );
    return rows.map((row) => ({ ...row, bytes: Number(row.bytes) }));
  }

  /** One snapshot. Active = reserved (unknown is separate). Drift is the sum of the
   * absolute differences for the two counters; opposite errors cannot cancel out.
   * It compares ledger records, not live R2 inventory. */
  async getBudgetReport() {
    const { rows } =
      await this.pool.query(`SELECT committed_bytes, reserved_bytes, r.* FROM object_budget
      CROSS JOIN (SELECT
        count(*) FILTER (WHERE state = 'reserved') AS active,
        count(*) FILTER (WHERE state = 'unknown') AS unknown,
        coalesce(sum(bytes) FILTER (WHERE state = 'committed'), 0) AS committed_sum,
        coalesce(sum(bytes) FILTER (WHERE state IN ('reserved','unknown')), 0) AS held_sum
        FROM object_reservation) r WHERE id = 'occavoy'`);
    const row = rows[0];
    if (!row) throw new Error("Missing quota budget");
    const committedBytes = Number(row.committed_bytes);
    const reservedBytes = Number(row.reserved_bytes);
    return {
      capBytes: R2_CAPACITY_BYTES,
      committedBytes,
      reservedBytes,
      availableBytes: R2_CAPACITY_BYTES - committedBytes - reservedBytes,
      activeReservations: Number(row.active),
      unknownReservations: Number(row.unknown),
      discrepancyBytes:
        Math.abs(committedBytes - Number(row.committed_sum)) +
        Math.abs(reservedBytes - Number(row.held_sum)),
    };
  }
}
