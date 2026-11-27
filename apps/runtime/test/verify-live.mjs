import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "rivetkit/client";

const token = process.env.OCCAVOY_RUNTIME_DEMO_TOKEN;
if (!token || token.length < 32)
  throw new Error("Set the private OCCAVOY_RUNTIME_DEMO_TOKEN in this shell.");
const endpoint = process.env.OCCAVOY_RUNTIME_VERIFY_ENDPOINT ?? "http://localhost:6420";
const hostname = new URL(endpoint).hostname;
if (
  !["localhost", "127.0.0.1", "[::1]"].includes(hostname) &&
  process.env.OCCAVOY_VERIFY_REMOTE !== "1"
) {
  throw new Error(
    "Remote verification requires explicit OCCAVOY_VERIFY_REMOTE=1; use an isolated demo namespace.",
  );
}
const mode = process.argv[2] ?? "--run";
if (!["--run", "--prepare", "--resume"].includes(mode))
  throw new Error("Use --run, --prepare, or --resume.");
const checkpointPath = process.env.OCCAVOY_RUNTIME_CHECKPOINT ?? ".runtime-verification.json";
const saved = mode === "--resume" ? JSON.parse(await readFile(checkpointPath, "utf8")) : null;
const key = saved?.key ?? ["qualification", randomUUID()];
const client = createClient(endpoint);
const handle = client.demoCase.getOrCreate(key, { params: { authToken: token } });

async function waitFor(predicate) {
  const deadline = Date.now() + 60_000;
  let last;
  while (Date.now() < deadline) {
    last = await handle.status();
    if (predicate(last)) return last;
    await delay(200);
  }
  throw new Error(`Runtime condition not reached: ${JSON.stringify(last)}`);
}

if (mode !== "--resume") {
  await waitFor((status) => status.snapshot.phase === "awaiting_input");
  await handle.pause("pause");
  await waitFor(
    (status) => status.snapshot.waitReason === "paused" && status.snapshot.revision === 1,
  );
  if (mode === "--prepare") {
    await writeFile(checkpointPath, JSON.stringify({ key, expectedRevision: 1 }, null, 2), {
      mode: 0o600,
    });
    console.log(
      "Prepared a persisted paused case. Restart the runtime, then run verify:live --resume with the same token.",
    );
    process.exit(0);
  }
} else {
  const recovered = await handle.status();
  assert.equal(recovered.snapshot.waitReason, "paused");
  assert.equal(recovered.snapshot.revision, saved.expectedRevision);
}

await handle.resume("resume");
await waitFor(
  (status) => status.snapshot.waitReason === "client_input" && status.snapshot.revision === 2,
);
const input = {
  commandId: "input",
  kind: "submit_input",
  text: "Synthetic qualification: Hong Kong customer, global destination.",
};
await handle.command(input);
await waitFor((status) => status.snapshot.phase === "ready" && status.snapshot.revision === 3);
const duplicate = await handle.command(input);
assert.equal(duplicate.duplicate, true);
assert.equal((await handle.status()).snapshot.revision, 3);
await assert.rejects(handle.command({ ...input, text: "Conflicting replacement" }));
const unauthorized = client.demoCase.getOrCreate(key, { params: { authToken: "wrong-token" } });
await assert.rejects(unauthorized.status());
console.log(
  JSON.stringify({
    passed: true,
    demoOnly: true,
    restartChecked: mode === "--resume",
    assertions: [
      "workflow wait",
      "pause/resume",
      "input applied once",
      "conflicting duplicate rejected",
      "unauthorized request rejected",
    ],
  }),
);
