import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "rivetkit/client";

const required = [
  "RIVET_ENDPOINT",
  "RIVET_ADMIN_TOKEN",
  "OCCAVOY_RUNTIME_DEMO_TOKEN",
  "OCCAVOY_VERIFY_POOL",
  "OCCAVOY_HOSTED_ACTOR_RECORD",
];
for (const name of required) assert.ok(process.env[name], `${name} required`);
const endpoint = new URL(process.env.RIVET_ENDPOINT);
assert.equal(endpoint.protocol, "https:");
assert.equal(endpoint.username, "");
assert.equal(endpoint.password, "");
assert.equal(endpoint.search, "");
assert.equal(endpoint.hash, "");
assert.ok(["/", ""].includes(endpoint.pathname));
const namespace = process.env.OCCAVOY_VERIFY_NAMESPACE ?? "default";
const pool = process.env.OCCAVOY_VERIFY_POOL;
if (pool === "default") assert.equal(process.env.OCCAVOY_VERIFY_ALLOW_DEFAULT, "1");
assert.match(pool, /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/);
const appToken = process.env.OCCAVOY_RUNTIME_DEMO_TOKEN;
assert.ok(appToken.length >= 32);
const adminToken = process.env.RIVET_ADMIN_TOKEN;
const baseEndpoint = endpoint.origin;
const common = { endpoint: baseEndpoint, namespace, poolName: pool, disableMetadataLookup: false };
const admin = createClient({ ...common, token: adminToken });
const key = ["oca2", "checkpoint", randomUUID()];
const actorId = await admin.demoCase.getOrCreate(key, { poolName: pool }).resolve();
assert.match(actorId, /^[A-Za-z0-9_-]+$/);
writeFileSync(
  process.env.OCCAVOY_HOSTED_ACTOR_RECORD,
  JSON.stringify({ actorId, key, namespace, pool }),
  { mode: 0o600 },
);
const issued = await admin.auth.issueToken({
  subject: "oca2-hosted-checkpoint",
  expiresIn: 900,
  grants: [{ resource: "actor_gateway", target: { id: actorId }, operations: ["read"] }],
});
const scoped = createClient({ ...common, token: issued.token });
const handle = scoped.demoCase.getForId(actorId, { params: { authToken: appToken } });
async function waitFor(predicate, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await handle.status();
      if (predicate(last)) return last;
    } catch (error) {
      last = { transientError: error?.code ?? error?.name ?? "unknown" };
    }
    await delay(500);
  }
  throw new Error(`condition not reached: ${JSON.stringify(last)}`);
}
function errorShape(error) {
  return { group: error?.group ?? null, code: error?.code ?? null, status: error?.status ?? null };
}
async function expectReject(promise, expected) {
  const error = await promise.then(
    () => null,
    (error) => error,
  );
  assert.ok(error, `expected rejection ${expected.group}/${expected.code}`);
  assert.equal(error.group, expected.group);
  assert.equal(error.code, expected.code);
  return errorShape(error);
}
const actorLookup = await fetch(
  `${baseEndpoint}/actors?actor_ids=${encodeURIComponent(actorId)}&namespace=${encodeURIComponent(namespace)}`,
  {
    headers: { authorization: `Bearer ${adminToken}` },
  },
);
assert.ok(actorLookup.ok, `actor lookup failed with HTTP ${actorLookup.status}`);
const actorRows = await actorLookup.json();
const actorRow = actorRows.actors?.[0];
assert.equal(
  actorRow?.actor?.pool ?? actorRow?.pool ?? actorRow?.actor?.pool_name ?? actorRow?.pool_name,
  pool,
);
if ((actorRow?.actor?.namespace ?? actorRow?.namespace) !== undefined)
  assert.equal(actorRow?.actor?.namespace ?? actorRow?.namespace, namespace);
const result = { actorCreatedInApprovedPool: true, actorPoolConfirmed: true, checks: [] };
await waitFor((s) => s.snapshot.phase === "awaiting_input");
await handle.pause("pause");
await waitFor((s) => s.snapshot.waitReason === "paused" && s.snapshot.revision === 1);
result.pausedRevision = 1;
const noToken = createClient({ ...common, token: undefined, disableMetadataLookup: true });
await expectReject(
  noToken.demoCase.getForId(actorId, { params: { authToken: appToken } }).status(),
  { group: "auth", code: "invalid_token" },
);
result.checks.push("missing gateway token rejected");
const badGateway = createClient({ ...common, token: "invalid-token", disableMetadataLookup: true });
await expectReject(
  badGateway.demoCase.getForId(actorId, { params: { authToken: appToken } }).status(),
  { group: "auth", code: "invalid_token" },
);
result.checks.push("invalid gateway token rejected");
const wrongApp = scoped.demoCase.getForId(actorId, { params: { authToken: "wrong-token" } });
await expectReject(wrongApp.status(), { group: "user", code: "forbidden" });
result.checks.push("valid gateway token plus wrong actor token rejected");
const before = await handle.status();
assert.equal(before.snapshot.revision, 1);
const reschedule = await fetch(
  `${baseEndpoint}/actors/${encodeURIComponent(actorId)}/reschedule?namespace=${encodeURIComponent(namespace)}`,
  {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}` },
  },
);
assert.ok(reschedule.ok, `reschedule failed with HTTP ${reschedule.status}`);
await reschedule.arrayBuffer();
result.platformReplacementRequested = true;
await waitFor((s) => s.snapshot.waitReason === "paused" && s.snapshot.revision === 1, 120_000);
result.sameActorPausedAfterReplacement = true;
await handle.resume("resume");
await waitFor(
  (s) => s.snapshot.waitReason === "client_input" && s.snapshot.revision === 2,
  120_000,
);
const input = {
  commandId: "input",
  kind: "submit_input",
  text: "Synthetic qualification: Hong Kong customer, global destination.",
};
await handle.command(input);
await waitFor((s) => s.snapshot.phase === "ready" && s.snapshot.revision === 3, 120_000);
const duplicate = await handle.command(input);
assert.equal(duplicate.duplicate, true);
assert.equal((await handle.status()).snapshot.revision, 3);
await expectReject(handle.command({ ...input, text: "Conflicting replacement" }), {
  group: "user",
  code: "command_conflict",
});
assert.equal((await handle.status()).snapshot.revision, 3);
result.checks.push("resume input duplicate conflict and authorized read verified");
result.finalRevision = 3;
console.log(JSON.stringify(result));
