import { describe, expect, it } from "vitest";
import {
  CapacityExceeded,
  type DurableQuotaLedger,
  GuardedObjectStore,
  R2_CAPACITY_BYTES,
  type Reservation,
} from "../src/index";

// Test double only; SQL integration and crash reconciliation are separate acceptance gates.
class TestLedger implements DurableQuotaLedger {
  used: number;
  reserved = 0;
  reservations = new Map<string, Reservation>();
  unknown = new Set<string>();
  committed = new Set<string>();
  constructor(used: number) {
    this.used = used;
  }
  async reserve(request: Reservation, cap: number) {
    if (this.reservations.has(request.id) || this.used + this.reserved + request.bytes > cap)
      return false;
    this.reservations.set(request.id, request);
    this.reserved += request.bytes;
    return true;
  }
  async commit(id: string) {
    const request = this.reservations.get(id);
    if (!request) throw new Error("Unknown reservation");
    if (this.committed.has(id)) return;
    this.committed.add(id);
    this.used += request.bytes;
    this.reserved -= request.bytes;
  }
  async markUnknown(id: string) {
    this.unknown.add(id);
  }
}

describe("R2 admission policy", () => {
  it("uses decimal 8 GB and rejects before an external write", async () => {
    expect(R2_CAPACITY_BYTES).toBe(8_000_000_000);
    let writes = 0;
    const store = new GuardedObjectStore(
      {
        put: async () => {
          writes += 1;
        },
      },
      new TestLedger(R2_CAPACITY_BYTES - 1),
    );
    await expect(store.putNew("reject-01", new Uint8Array(2))).rejects.toBeInstanceOf(
      CapacityExceeded,
    );
    expect(writes).toBe(0);
  });
  it("admits only one racing upload when the ledger has room for one", async () => {
    const ledger = new TestLedger(R2_CAPACITY_BYTES - 3);
    const store = new GuardedObjectStore({ put: async () => {} }, ledger);
    const results = await Promise.allSettled([
      store.putNew("racing-01", new Uint8Array(3)),
      store.putNew("racing-02", new Uint8Array(3)),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(ledger.used + ledger.reserved).toBe(R2_CAPACITY_BYTES);
  });
  it("keeps capacity reserved for an uncertain external result", async () => {
    const ledger = new TestLedger(0);
    const store = new GuardedObjectStore(
      {
        put: async () => {
          throw new Error("response lost");
        },
      },
      ledger,
    );
    await expect(store.putNew("unknown-01", new Uint8Array(3))).rejects.toThrow("response lost");
    expect(ledger.reserved).toBe(3);
    expect(ledger.unknown.has("unknown-01")).toBe(true);
  });
});
