import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyMigrations,
  R2_CAPACITY_BYTES as CAP,
  CapacityExceeded,
  GuardedObjectStore,
  PostgresQuotaLedger,
  ReservationSizeMismatchError,
} from "../src/index";

const databaseUrl = process.env.DATABASE_URL;
const request = (id: string, bytes: number) => ({ id, key: `objects/${id}`, bytes });

describe.skipIf(databaseUrl === undefined)("Postgres R2 quota ledger", () => {
  let admin: pg.Pool;
  let pool: pg.Pool;
  let schema: string;
  let ledger: PostgresQuotaLedger;

  beforeEach(async () => {
    // Isolate all connections, including racing admissions, without weakening the singleton CHECK
    // or temporarily changing the real budget. Never fall back to the public schema.
    schema = `test_quota_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: databaseUrl });
    await admin.query("CREATE SCHEMA " + pg.escapeIdentifier(schema));
    const scopedUrl = new URL(databaseUrl ?? "");
    scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
    pool = new pg.Pool({ connectionString: scopedUrl.href });
    expect((await pool.query("SELECT current_schema() AS schema")).rows[0]?.schema).toBe(schema);
    await applyMigrations(pool);
    ledger = new PostgresQuotaLedger(pool);
  });

  afterEach(async () => {
    try {
      await pool?.end();
      await admin.query("DROP SCHEMA IF EXISTS " + pg.escapeIdentifier(schema) + " CASCADE");
    } finally {
      await admin.end();
    }
  });

  async function prefill(bytes: number) {
    expect(await ledger.reserve(request("existing", bytes))).toBe(true);
    await ledger.commit("existing", bytes);
  }
  async function reservation(id: string) {
    return (await pool.query("SELECT * FROM object_reservation WHERE id = $1", [id])).rows[0];
  }

  it("admits only one racing upload at the hard cap and rolls back the loser", async () => {
    await prefill(CAP - 4);
    const put = vi.fn(async () => ({ size: 4 }));
    const store = new GuardedObjectStore({ put }, ledger);
    const results = await Promise.allSettled([
      store.putNew("racing-01", new Uint8Array(4)),
      store.putNew("racing-02", new Uint8Array(4)),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")?.reason).toBeInstanceOf(CapacityExceeded);
    expect(put).toHaveBeenCalledTimes(1);
    expect((await pool.query("SELECT id FROM object_reservation")).rowCount).toBe(2);
    expect(await ledger.getBudgetReport()).toMatchObject({
      committedBytes: CAP,
      reservedBytes: 0,
      availableBytes: 0,
      discrepancyBytes: 0,
    });
  });

  it("rejects before bucket.put and cannot raise the hard cap or partition the budget", async () => {
    await prefill(CAP - 1);
    const put = vi.fn(async () => {});
    await expect(
      new GuardedObjectStore({ put }, ledger).putNew("over-cap", new Uint8Array(2)),
    ).rejects.toBeInstanceOf(CapacityExceeded);
    expect(put).not.toHaveBeenCalled();
    expect(await ledger.reserve(request("over-cap", 2), CAP + 1)).toBe(false);
    expect(await reservation("over-cap")).toBeUndefined();
    expect(() => new PostgresQuotaLedger(pool, { budgetId: "other" })).toThrow();
    expect(await ledger.reserve(request("over-cap", 1))).toBe(true);
    expect(await ledger.reserve(request("over-cap", 1))).toBe(false);
  });

  it("persists the observed mismatch before throwing, and requires verified size to recover", async () => {
    const store = new GuardedObjectStore({ put: async () => ({ size: 5 }) }, ledger);
    await expect(store.putNew("mismatch", new Uint8Array(4))).rejects.toBeInstanceOf(
      ReservationSizeMismatchError,
    );
    expect(await reservation("mismatch")).toMatchObject({
      state: "unknown",
      actual_bytes: "5",
      reconciliation_note: "actual_bytes_mismatch",
    });
    expect(await ledger.reserve(request("while-mismatched", 1))).toBe(false);
    await expect(ledger.commit("mismatch")).rejects.toThrow("Verify object size");
    expect(await ledger.getBudgetReport()).toMatchObject({
      committedBytes: 0,
      reservedBytes: 4,
      unknownReservations: 1,
    });
    await Promise.all([ledger.commit("mismatch", 4), ledger.commit("mismatch", 4)]);
    expect(await reservation("mismatch")).toMatchObject({ state: "committed", actual_bytes: "4" });
    await expect(
      ledger.releaseVerifiedAbsent("mismatch", "conflicting observation"),
    ).rejects.toThrow("committed");
    expect(await ledger.getBudgetReport()).toMatchObject({
      committedBytes: 4,
      reservedBytes: 0,
      discrepancyBytes: 0,
    });
  });

  it("holds a timed-out write until verified absent, and cannot settle or release it twice", async () => {
    const store = new GuardedObjectStore(
      {
        put: async () => {
          throw new Error("put timed out");
        },
      },
      ledger,
    );
    await expect(store.putNew("timed-out", new Uint8Array(4))).rejects.toThrow("put timed out");
    await ledger.markUnknown("timed-out");
    expect(await ledger.getBudgetReport()).toMatchObject({
      reservedBytes: 4,
      unknownReservations: 1,
      discrepancyBytes: 0,
    });
    await expect(ledger.releaseVerifiedAbsent("timed-out", " ")).rejects.toThrow(
      "verification note",
    );
    expect(await ledger.reserve(request("new", 1), 4)).toBe(false);
    await Promise.all([
      ledger.releaseVerifiedAbsent("timed-out", "verified absent"),
      ledger.releaseVerifiedAbsent("timed-out", "verified absent"),
    ]);
    await ledger.markUnknown("timed-out");
    await expect(ledger.commit("timed-out", 4)).rejects.toThrow("released");
    expect(await reservation("timed-out")).toMatchObject({
      state: "released",
      reconciliation_note: "verified absent",
    });
    expect(await ledger.getBudgetReport()).toMatchObject({
      committedBytes: 0,
      reservedBytes: 0,
      unknownReservations: 0,
      discrepancyBytes: 0,
    });
    expect(await ledger.reserve(request("new", 4), 4)).toBe(true);
  });

  it("expires only due reservations, holds the bytes, and detects counter drift in one report", async () => {
    await prefill(7);
    await ledger.reserve(request("fresh", 3));
    const shortLedger = new PostgresQuotaLedger(pool, { defaultTtlMs: 1000 });
    await shortLedger.reserve(request("stale", 2));
    // PG timestamps have microseconds; use an exact deterministic cutoff to test <=.
    const cutoff = new Date("2000-01-01T00:00:00.000Z");
    expect(
      (
        await pool.query(
          "SELECT expires_at - created_at = interval '1 second' AS ttl_ok FROM object_reservation WHERE id = 'stale'",
        )
      ).rows[0]?.ttl_ok,
    ).toBe(true);
    await pool.query("UPDATE object_reservation SET expires_at = $1 WHERE id = 'stale'", [cutoff]);
    expect(await ledger.reconcileExpiredReservations(cutoff)).toEqual([
      { ...request("stale", 2), expiresAt: cutoff },
    ]);
    expect(await ledger.reconcileExpiredReservations(cutoff)).toEqual([]);
    expect(await reservation("stale")).toMatchObject({
      state: "unknown",
      reconciliation_note: "reservation_ttl_expired",
    });
    expect(await ledger.getBudgetReport()).toEqual({
      capBytes: CAP,
      committedBytes: 7,
      reservedBytes: 5,
      availableBytes: CAP - 12,
      activeReservations: 1,
      unknownReservations: 1,
      discrepancyBytes: 0,
    });
    await pool.query(
      "UPDATE object_budget SET committed_bytes = 6, reserved_bytes = 6 WHERE id = 'occavoy'",
    );
    expect((await ledger.getBudgetReport()).discrepancyBytes).toBe(2);
  });
});
