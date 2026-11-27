import type { RawAccess } from "rivetkit/db";
import {
  type DemoCommand,
  DemoConflictError,
  DemoInputError,
  type DemoPhase,
  type DemoSnapshot,
  type DemoWaitReason,
  parseDemoCommand,
} from "./protocol.js";

type CaseRow = {
  phase: DemoPhase;
  wait_reason: DemoWaitReason;
  revision: number;
  input: string | null;
};
type CommandRow = {
  sequence: number;
  command_id: string;
  payload: string;
  accepted_at: number;
  applied_at: number | null;
  result: string | null;
};

export async function initializeDemoDatabase(database: RawAccess): Promise<void> {
  await database.execute(`CREATE TABLE IF NOT EXISTS demo_case (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    phase TEXT NOT NULL,
    wait_reason TEXT,
    revision INTEGER NOT NULL DEFAULT 0,
    input TEXT
  )`);
  await database.execute(`INSERT OR IGNORE INTO demo_case
    (id, phase, wait_reason, revision, input) VALUES (1, 'pending', 'client_input', 0, NULL)`);
  await database.execute(`CREATE TABLE IF NOT EXISTS demo_commands (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    command_id TEXT NOT NULL UNIQUE,
    payload TEXT NOT NULL,
    accepted_at INTEGER NOT NULL,
    applied_at INTEGER,
    result TEXT
  )`);
}

export async function markAwaitingInput(database: RawAccess): Promise<void> {
  await database.execute(
    "UPDATE demo_case SET phase = 'awaiting_input' WHERE id = 1 AND phase = 'pending'",
  );
}

export async function readDemoSnapshot(database: RawAccess): Promise<DemoSnapshot> {
  const [row] = await database.execute<CaseRow>(
    "SELECT phase, wait_reason, revision, input FROM demo_case WHERE id = 1",
  );
  if (!row) throw new Error("Demo database has not been initialized.");
  return {
    phase: row.phase,
    waitReason: row.wait_reason,
    revision: row.revision,
    input: row.input,
  };
}

/** Durable receipt precedes transport notification. Same ID with new content fails. */
export async function acceptDemoCommand(database: RawAccess, command: DemoCommand) {
  return database.transaction(
    async (tx) => {
      const payload = JSON.stringify(command);
      const [existing] = await tx.execute<CommandRow>(
        "SELECT * FROM demo_commands WHERE command_id = ?",
        command.commandId,
      );
      if (existing) {
        if (existing.payload !== payload)
          throw new DemoConflictError("commandId is already bound to different content.");
        return {
          commandId: command.commandId,
          duplicate: true,
          pending: existing.applied_at === null,
        };
      }
      const [count] = await tx.execute<{ total: number }>(
        "SELECT COUNT(*) AS total FROM demo_commands",
      );
      if ((count?.total ?? 0) >= 100)
        throw new DemoInputError(
          "This qualification fixture accepts at most 100 commands per actor.",
        );
      await tx.execute(
        "INSERT INTO demo_commands (command_id, payload, accepted_at) VALUES (?, ?, ?)",
        command.commandId,
        payload,
        Date.now(),
      );
      return { commandId: command.commandId, duplicate: false, pending: true };
    },
    { name: "accept-demo-command" },
  );
}

export async function pendingDemoCommands(database: RawAccess) {
  return database.execute<{ command_id: string }>(
    "SELECT command_id FROM demo_commands WHERE applied_at IS NULL ORDER BY sequence LIMIT 100",
  );
}

/** State and command result commit together. Replayed/duplicate work is a no-op. */
export async function applyDemoCommand(database: RawAccess, commandId: string): Promise<void> {
  await database.transaction(
    async (tx) => {
      const [row] = await tx.execute<CommandRow>(
        "SELECT * FROM demo_commands WHERE command_id = ?",
        commandId,
      );
      if (!row || row.applied_at !== null) return;
      const command = parseDemoCommand(JSON.parse(row.payload));
      const current = await readDemoSnapshot(tx);
      let next: DemoSnapshot = { ...current, revision: current.revision + 1 };
      let outcome: "applied" | "rejected" = "applied";
      let reason: string | null = null;
      switch (command.kind) {
        case "pause":
          next.waitReason = "paused";
          break;
        case "resume":
          next.phase = current.input === null ? "awaiting_input" : "ready";
          next.waitReason = current.input === null ? "client_input" : null;
          break;
        case "submit_input":
          if (current.waitReason === "paused") {
            next = current;
            outcome = "rejected";
            reason = "paused: resume, then submit a new command ID";
          } else {
            next = {
              phase: "ready",
              waitReason: null,
              revision: current.revision + 1,
              input: command.text,
            };
          }
          break;
      }
      await tx.execute(
        "UPDATE demo_case SET phase = ?, wait_reason = ?, revision = ?, input = ? WHERE id = 1",
        next.phase,
        next.waitReason,
        next.revision,
        next.input,
      );
      await tx.execute(
        "UPDATE demo_commands SET applied_at = ?, result = ? WHERE command_id = ? AND applied_at IS NULL",
        Date.now(),
        JSON.stringify({ outcome, reason, revision: next.revision }),
        commandId,
      );
    },
    { name: "apply-demo-command" },
  );
}

export async function readDemoStatus(database: RawAccess) {
  return database.transaction(
    async (tx) => ({
      demoOnly: true as const,
      snapshot: await readDemoSnapshot(tx),
      commands: await tx.execute<{
        command_id: string;
        accepted_at: number;
        applied_at: number | null;
        result: string | null;
      }>(
        "SELECT command_id, accepted_at, applied_at, result FROM demo_commands ORDER BY sequence DESC LIMIT 20",
      ),
    }),
    { name: "read-demo-status" },
  );
}
