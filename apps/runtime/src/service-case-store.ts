import type { RawAccess } from "rivetkit/db";

export interface ServiceCaseDrainState {
  drainScheduledAt: number;
  drainScheduleId: string | null;
  lastDrainAt: string | null;
}

type DrainRow = {
  drain_scheduled_at: number;
  drain_schedule_id: string | null;
  last_drain_at: string | null;
};

export async function initializeServiceCaseDatabase(database: RawAccess): Promise<void> {
  await database.execute(`CREATE TABLE IF NOT EXISTS service_case_drain (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    drain_scheduled_at INTEGER NOT NULL DEFAULT 0,
    drain_schedule_id TEXT,
    last_drain_at TEXT
  )`);
  await database.execute("INSERT OR IGNORE INTO service_case_drain (id) VALUES (1)");
}

export async function readServiceCaseDrainState(
  database: RawAccess,
): Promise<ServiceCaseDrainState> {
  const [row] = await database.execute<DrainRow>(
    "SELECT drain_scheduled_at, drain_schedule_id, last_drain_at FROM service_case_drain WHERE id = 1",
  );
  if (!row) throw new Error("service_case_drain_not_initialized");
  return {
    drainScheduledAt: row.drain_scheduled_at,
    drainScheduleId: row.drain_schedule_id,
    lastDrainAt: row.last_drain_at,
  };
}

export async function writeServiceCaseDrainState(
  database: RawAccess,
  state: ServiceCaseDrainState,
): Promise<void> {
  await database.execute(
    `UPDATE service_case_drain
     SET drain_scheduled_at = ?, drain_schedule_id = ?, last_drain_at = ?
     WHERE id = 1`,
    state.drainScheduledAt,
    state.drainScheduleId,
    state.lastDrainAt,
  );
}
