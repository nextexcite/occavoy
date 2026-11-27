/** Decimal GB. One shared budget across all Occavoy-managed object prefixes/environments. */
export const R2_CAPACITY_BYTES = 8_000_000_000;

export interface Reservation {
  id: string;
  key: string;
  bytes: number;
}

export interface DurableQuotaLedger {
  /** Must atomically admit bytes only when committed + reserved + bytes <= cap. Unique key/id. */
  reserve(request: Reservation, cap: number): Promise<boolean>;
  /** Must be idempotent; moves reserved bytes to committed, not an additional charge. */
  commit(id: string, actualBytes?: number): Promise<void>;
  /** Retain reserved bytes until an independent reconciliation establishes the result. */
  markUnknown(id: string, note?: string): Promise<void>;
}

export interface ObjectBucket {
  /** Return the observed size, or void if success guarantees the exact supplied bytes. */
  put(key: string, body: Uint8Array): Promise<{ size: number } | void>;
}

export class CapacityExceeded extends Error {
  constructor() {
    super("Occavoy's 8 GB object capacity would be exceeded");
  }
}

/** Requires a persistent, concurrency-safe ledger. No in-memory production fallback. */
export class GuardedObjectStore {
  constructor(
    private readonly bucket: ObjectBucket,
    private readonly ledger: DurableQuotaLedger,
  ) {}

  async putNew(reservationId: string, body: Uint8Array): Promise<string> {
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(reservationId)) throw new Error("Invalid reservation id");
    if (body.byteLength === 0) throw new Error("Empty objects are not admitted");
    const request = { id: reservationId, key: `objects/${reservationId}`, bytes: body.byteLength };
    if (!(await this.ledger.reserve(request, R2_CAPACITY_BYTES))) throw new CapacityExceeded();
    try {
      const receipt = await this.bucket.put(request.key, body);
      await this.ledger.commit(request.id, receipt === undefined ? request.bytes : receipt.size);
    } catch (error) {
      // A timeout can occur after R2 accepted the bytes. Do not free the reservation here.
      try {
        await this.ledger.markUnknown(request.id);
      } catch {
        /* Existing reservation remains conservative. */
      }
      throw error;
    }
    return request.key;
  }
}
