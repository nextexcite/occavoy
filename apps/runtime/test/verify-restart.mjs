import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// All child processes share one host/network namespace, including isolated CI.
// This is a local, graceful replacement probe. It never deploys or calls Cloud.
const directory = await mkdtemp(join(tmpdir(), "occavoy-rivet-restart-"));
const serverPath = fileURLToPath(new URL("../dist/server.js", import.meta.url));
const verifierPath = fileURLToPath(new URL("./verify-live.mjs", import.meta.url));
const token = randomBytes(32).toString("hex");

async function unusedPort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

const port = await unusedPort();
const enginePort = await unusedPort();
const childEnv = {
  ...process.env,
  NODE_ENV: "test",
  OCCAVOY_RUNTIME_MODE: "local",
  OCCAVOY_RUNTIME_DEMO_TOKEN: token,
  OCCAVOY_RUNTIME_VERIFY_ENDPOINT: `http://127.0.0.1:${enginePort}`,
  OCCAVOY_RUNTIME_CHECKPOINT: join(directory, "checkpoint.json"),
  RIVET_RUN_ENGINE_HOST: "127.0.0.1",
  RIVET_RUN_ENGINE_PORT: String(enginePort),
  PORT: String(port),
  NO_COLOR: "1",
};
for (const name of ["RIVET_ENDPOINT", "RIVET_TOKEN", "RIVET_POOL", "RIVETKIT_RUNTIME_MODE"])
  delete childEnv[name];

let server;
let serverLog = "";
function startServer() {
  const child = spawn(process.execPath, [serverPath], {
    cwd: directory,
    env: childEnv,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (data) => {
      serverLog = (serverLog + data).slice(-24_000);
    });
  }
  return child;
}

async function waitForHealth(child) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error("Runtime exited before liveness.");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) return;
    } catch {
      /* Wait for this newly started process to bind its local port. */
    }
    await delay(100);
  }
  throw new Error("Runtime liveness did not appear within 45 seconds.");
}

async function verify(mode) {
  const child = spawn(process.execPath, [verifierPath, mode], {
    cwd: directory,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (data) => {
      output = (output + data).slice(-12_000);
    });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 75_000);
  const [code, signal] = await once(child, "exit");
  clearTimeout(deadline);
  if (code !== 0)
    throw new Error(`Real actor verification ${mode} failed (${code ?? signal}): ${output}`);
  process.stdout.write(output);
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const deadline = setTimeout(() => {
    if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  }, 30_000);
  const [code, signal] = await exited;
  clearTimeout(deadline);
  if (signal === "SIGKILL") throw new Error("Runtime did not drain within 30 seconds.");
  return code;
}

try {
  server = startServer();
  await waitForHealth(server);
  await verify("--prepare");
  await stopServer(server);
  server = startServer();
  await waitForHealth(server);
  await verify("--resume");
  console.log(
    JSON.stringify({
      passed: true,
      scope: "local-native-runtime-replacement",
      shutdown: "SIGTERM",
      cloudTested: false,
    }),
  );
} catch (error) {
  console.error(serverLog.replaceAll(token, "[REDACTED]"));
  throw error;
} finally {
  await stopServer(server);
  await rm(directory, { recursive: true, force: true });
}
