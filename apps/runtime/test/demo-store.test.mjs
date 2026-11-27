import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  acceptDemoCommand,
  applyDemoCommand,
  initializeDemoDatabase,
  markAwaitingInput,
  pendingDemoCommands,
  readDemoStatus,
} from "../dist/demo-store.js";
import { parseDemoCommand, readRuntimeConfig } from "../dist/protocol.js";

function sqliteAccess(file) {
  const native = new DatabaseSync(file);
  let previous = Promise.resolve();
  const execute = async (sql, ...args) =>
    native
      .prepare(sql)
      .all(...args)
      .map((row) => ({ ...row }));
  const access = {
    execute,
    transaction(callback) {
      const result = previous.then(async () => {
        native.exec("BEGIN IMMEDIATE");
        try {
          const value = await callback(access);
          native.exec("COMMIT");
          return value;
        } catch (error) {
          native.exec("ROLLBACK");
          throw error;
        }
      });
      previous = result.catch(() => {});
      return result;
    },
    close: async () => native.close(),
  };
  return access;
}

test("accepted input survives database reopen; duplicate application has one effect", async () => {
  const directory = await mkdtemp(join(tmpdir(), "occavoy-runtime-"));
  let database = sqliteAccess(join(directory, "case.sqlite"));
  try {
    await initializeDemoDatabase(database);
    const command = parseDemoCommand({
      commandId: "input-1",
      kind: "submit_input",
      text: "Hong Kong to São Paulo: synthetic input",
    });
    await acceptDemoCommand(database, command);
    await database.close();
    database = sqliteAccess(join(directory, "case.sqlite"));
    assert.deepEqual(await pendingDemoCommands(database), [{ command_id: "input-1" }]);
    assert.equal(
      (await acceptDemoCommand(database, command)).pending,
      true,
      "duplicate pending receipt must still be notified",
    );
    await markAwaitingInput(database);
    await applyDemoCommand(database, command.commandId);
    await applyDemoCommand(database, command.commandId);
    const status = await readDemoStatus(database);
    assert.equal(status.snapshot.revision, 1);
    assert.equal(status.snapshot.phase, "ready");
    assert.equal(status.commands.length, 1);
    assert.equal((await acceptDemoCommand(database, command)).pending, false);
    await assert.rejects(
      acceptDemoCommand(database, { ...command, text: "changed" }),
      /different content/,
    );
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("SQL failure between state and command-result writes rolls back; retry applies once", async () => {
  const database = sqliteAccess(":memory:");
  try {
    await initializeDemoDatabase(database);
    await markAwaitingInput(database);
    await acceptDemoCommand(database, { commandId: "pause-1", kind: "pause" });
    const faulty = {
      ...database,
      transaction: (callback, options) =>
        database.transaction(
          (tx) =>
            callback({
              ...tx,
              execute: async (sql, ...args) => {
                if (sql.startsWith("UPDATE demo_commands SET applied_at"))
                  throw new Error("injected database failure");
                return tx.execute(sql, ...args);
              },
            }),
          options,
        ),
    };
    await assert.rejects(applyDemoCommand(faulty, "pause-1"), /injected database failure/);
    assert.equal((await readDemoStatus(database)).snapshot.revision, 0);
    assert.equal((await pendingDemoCommands(database)).length, 1);
    await applyDemoCommand(database, "pause-1");
    assert.equal((await readDemoStatus(database)).snapshot.waitReason, "paused");
    assert.equal((await readDemoStatus(database)).snapshot.revision, 1);
  } finally {
    await database.close();
  }
});

test("pause rejects new input explicitly; resume enables a new input command", async () => {
  const database = sqliteAccess(":memory:");
  try {
    await initializeDemoDatabase(database);
    await markAwaitingInput(database);
    for (const command of [
      { commandId: "pause", kind: "pause" },
      { commandId: "blocked-input", kind: "submit_input", text: "synthetic" },
      { commandId: "resume", kind: "resume" },
      { commandId: "new-input", kind: "submit_input", text: "synthetic" },
    ]) {
      await acceptDemoCommand(database, command);
      await applyDemoCommand(database, command.commandId);
    }
    const status = await readDemoStatus(database);
    assert.equal(status.snapshot.revision, 3);
    assert.equal(status.snapshot.phase, "ready");
    const blocked = status.commands.find((command) => command.command_id === "blocked-input");
    assert.equal(JSON.parse(blocked.result).outcome, "rejected");
  } finally {
    await database.close();
  }
});

test("parallel duplicate receipts are unique; invalid and oversized input are rejected", async () => {
  const database = sqliteAccess(":memory:");
  try {
    await initializeDemoDatabase(database);
    const command = { commandId: "same", kind: "pause" };
    const receipts = await Promise.all(
      Array.from({ length: 10 }, () => acceptDemoCommand(database, command)),
    );
    assert.equal(receipts.filter((receipt) => !receipt.duplicate).length, 1);
    assert.equal((await pendingDemoCommands(database)).length, 1);
    assert.throws(
      () => parseDemoCommand({ commandId: "valid", kind: "submit_input", text: "界".repeat(700) }),
      /2048/,
    );
    assert.throws(() => parseDemoCommand({ commandId: "../invalid", kind: "pause" }), /commandId/);
  } finally {
    await database.close();
  }
});

test("production cannot silently launch a local engine or accept a default token", () => {
  const token = randomBytes(24).toString("hex");
  assert.throws(
    () => readRuntimeConfig({ NODE_ENV: "production", OCCAVOY_RUNTIME_DEMO_TOKEN: token }),
    /explicitly/,
  );
  assert.throws(() => readRuntimeConfig({ OCCAVOY_RUNTIME_MODE: "cloud" }), /private value/);
  assert.equal(
    readRuntimeConfig({ OCCAVOY_RUNTIME_MODE: "cloud", OCCAVOY_RUNTIME_DEMO_TOKEN: token }).mode,
    "cloud",
  );
});
