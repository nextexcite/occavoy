import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const INHERITED_ENV_NAMES = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
];

const CONTROLLED_ENV_NAMES = [
  "RIVET_ENDPOINT",
  "RIVET_TOKEN",
  "RIVET_POOL",
  "RIVETKIT_RUNTIME_MODE",
  "OCCAVOY_PROBE_HOLD",
];

export async function poll(read, predicate, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (predicate(last)) return last;
    await delay(100);
  }
  throw new Error(`${label} timed out: ${JSON.stringify(last)}`);
}

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

function inheritedEnvironment() {
  const inherited = {};
  for (const name of INHERITED_ENV_NAMES) {
    const value = process.env[name];
    if (value !== undefined) inherited[name] = value;
  }
  return inherited;
}

function redactLogs(logs, childEnv) {
  let redacted = logs;
  for (const [name, value] of Object.entries(childEnv)) {
    const sensitive = /token|secret|password|credential/i.test(name);
    if (typeof value === "string" && value.length >= 8 && sensitive) {
      redacted = redacted.replaceAll(value, "[REDACTED]");
    }
  }
  return redacted;
}

/**
 * Starts one POSIX native-runtime host and its Rivet local engine for a test.
 * The caller owns `cwd`; this helper never removes it.
 */
export async function createNativeHost({ entry, args = [], env = {}, cwd }) {
  if (process.platform === "win32") {
    throw new Error("Native host process control requires POSIX process signals.");
  }
  if (!isAbsolute(entry)) throw new Error("entry must be an absolute file path.");
  if (!isAbsolute(cwd)) throw new Error("cwd must be an absolute caller-owned path.");

  const port = await unusedPort();
  const enginePort = await unusedPort();
  const endpoint = `http://127.0.0.1:${enginePort}`;
  const baseEnv = {
    ...inheritedEnvironment(),
    ...env,
    NODE_ENV: "test",
    OCCAVOY_RUNTIME_MODE: "local",
    RIVET_RUN_ENGINE_HOST: "127.0.0.1",
    RIVET_RUN_ENGINE_PORT: String(enginePort),
    PORT: String(port),
    NO_COLOR: "1",
  };
  for (const name of CONTROLLED_ENV_NAMES) delete baseEnv[name];

  let running;
  let output = "";
  let latestEnv = { ...baseEnv };

  async function stop(crash = false) {
    const active = running;
    if (!active) return;
    const { child, exited } = active;
    if (child.exitCode !== null || child.signalCode !== null) {
      running = undefined;
      return;
    }
    if (crash) {
      // Only children of the process this test owns. Rivet's local engine uses its own group.
      const children = spawnSync("pgrep", ["-P", String(child.pid)], { encoding: "utf8" });
      if (children.error) throw children.error;
      const enginePids = children.stdout.trim().split("\n").filter(Boolean).map(Number);
      process.kill(-child.pid, "SIGKILL");
      for (const pid of enginePids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
      const [, signal] = await exited;
      assert.equal(signal, "SIGKILL");
      await poll(
        async () => {
          try {
            await fetch(endpoint, { signal: AbortSignal.timeout(500) });
            return false;
          } catch {
            return true;
          }
        },
        Boolean,
        "Killed local engine release",
        5_000,
      );
    } else {
      child.kill("SIGTERM");
      const deadline = setTimeout(() => child.kill("SIGKILL"), 15_000);
      const [, signal] = await exited;
      clearTimeout(deadline);
      if (signal === "SIGKILL") throw new Error("Runtime did not drain before cleanup deadline.");
      await poll(
        async () => {
          try {
            await fetch(endpoint, { signal: AbortSignal.timeout(500) });
            return false;
          } catch {
            return true;
          }
        },
        Boolean,
        "Stopped local engine release",
        10_000,
      );
    }
    running = undefined;
  }

  async function start(extraEnv = {}) {
    if (running) throw new Error("Native host is already running.");
    latestEnv = { ...baseEnv, ...extraEnv };
    const child = spawn(process.execPath, [...args, entry], {
      cwd,
      env: latestEnv,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = once(child, "exit");
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (data) => {
        output = (output + data).slice(-30_000);
      });
    }
    running = { child, exited };
    try {
      await poll(
        async () => {
          if (child.exitCode !== null || child.signalCode !== null) {
            throw new Error("Runtime exited before liveness.");
          }
          try {
            return (
              await fetch(`http://127.0.0.1:${port}/healthz`, {
                signal: AbortSignal.timeout(1000),
              })
            ).ok;
          } catch {
            return false;
          }
        },
        Boolean,
        "Runtime liveness",
        30_000,
      );
      await poll(
        async () => {
          try {
            const response = await fetch(`${endpoint}/metadata`, {
              signal: AbortSignal.timeout(1000),
            });
            return response.ok;
          } catch {
            return false;
          }
        },
        Boolean,
        "Rivet gateway readiness",
        30_000,
      );
    } catch (error) {
      await stop(true);
      throw error;
    }
  }

  return {
    endpoint,
    start,
    stop,
    logs() {
      return redactLogs(output, latestEnv);
    },
  };
}
