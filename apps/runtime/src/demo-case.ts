import { timingSafeEqual } from "node:crypto";
import { actor, queue, UserError } from "rivetkit";
import { db, type RawAccess } from "rivetkit/db";
import { workflow } from "rivetkit/workflow";
import {
  acceptDemoCommand,
  applyDemoCommand,
  initializeDemoDatabase,
  markAwaitingInput,
  pendingDemoCommands,
  readDemoStatus,
} from "./demo-store.js";
import { DemoConflictError, DemoInputError, parseDemoCommand } from "./protocol.js";

function authorize(expected: string, supplied: unknown): void {
  if (typeof supplied !== "string") throw new UserError("Forbidden", { code: "forbidden" });
  const actualBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new UserError("Forbidden", { code: "forbidden" });
  }
}

async function receiveCommand(
  database: RawAccess,
  notify: (commandId: string) => Promise<void>,
  value: unknown,
) {
  try {
    const command = parseDemoCommand(value);
    const receipt = await acceptDemoCommand(database, command);
    // A duplicate pending command MUST still wake processing.
    if (receipt.pending) await notify(command.commandId);
    return { accepted: true as const, ...receipt };
  } catch (error) {
    if (error instanceof DemoInputError || error instanceof DemoConflictError) {
      throw new UserError(error.message, {
        code: error instanceof DemoConflictError ? "command_conflict" : "invalid_command",
      });
    }
    throw error;
  }
}

/**
 * Isolated runtime probe, never the production business-state authority.
 * Use only synthetic text. No booking, payment, model, supplier or sandbox call.
 */
export function createDemoCaseActor(demoToken: string) {
  return actor({
    db: db({ onMigrate: initializeDemoDatabase }),
    onBeforeConnect: (_c, params: { authToken?: string } | undefined) => {
      authorize(demoToken, params?.authToken);
    },
    queues: { commands: queue<{ commandId: string }>() },
    onWake: async (c) => {
      // Repair acceptance -> notification gaps on every restart/wake.
      for (const row of await pendingDemoCommands(c.db)) {
        await c.queue.send("commands", { commandId: row.command_id });
      }
    },
    run: workflow(async (ctx) => {
      await ctx.step("initialize-wait", async (step) => markAwaitingInput(step.db));
      await ctx.loop("demo-command-loop", async (loop) => {
        await loop.queue.next("wait-for-client-command", { names: ["commands"] });
        await loop.step("apply-client-command", async (step) => {
          // Notifications can arrive out of order. SQLite receipt order is authoritative.
          for (const row of await pendingDemoCommands(step.db)) {
            await applyDemoCommand(step.db, row.command_id);
          }
        });
      });
    }),
    actions: {
      status: async (c) => readDemoStatus(c.db),
      command: async (c, value: unknown) =>
        receiveCommand(c.db, (commandId) => c.queue.send("commands", { commandId }), value),
      pause: async (c, commandId: string) =>
        receiveCommand(c.db, (id) => c.queue.send("commands", { commandId: id }), {
          commandId,
          kind: "pause",
        }),
      resume: async (c, commandId: string) =>
        receiveCommand(c.db, (id) => c.queue.send("commands", { commandId: id }), {
          commandId,
          kind: "resume",
        }),
      submitInput: async (c, commandId: string, text: string) =>
        receiveCommand(c.db, (id) => c.queue.send("commands", { commandId: id }), {
          commandId,
          kind: "submit_input",
          text,
        }),
    },
  });
}
