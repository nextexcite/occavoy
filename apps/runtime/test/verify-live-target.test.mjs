import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { inheritedEnvironment } from "./native-host.mjs";

const verifierPath = fileURLToPath(new URL("./verify-live.mjs", import.meta.url));

for (const [index, endpoint] of [
  "https://example.invalid",
  "http://synthetic:secret-marker@localhost:6420",
  "not-a-url-secret-marker",
].entries()) {
  test(`rejects unsafe verifier endpoint ${index + 1}`, () => {
    const result = spawnSync(process.execPath, [verifierPath, "--resume"], {
      env: {
        PATH: process.env.PATH,
        OCCAVOY_RUNTIME_DEMO_TOKEN: "synthetic-local-only".repeat(2),
        OCCAVOY_RUNTIME_VERIFY_ENDPOINT: endpoint,
        OCCAVOY_VERIFY_REMOTE: "1",
      },
      encoding: "utf8",
      timeout: 10_000,
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /plain loopback HTTP origin/);
    assert.doesNotMatch(result.stderr, /secret-marker/);
  });
}

test("checkpoint subprocesses inherit host paths, not project or provider credentials", () => {
  assert.deepEqual(
    inheritedEnvironment({
      PATH: "/tool/bin",
      HOME: "/fixture/home",
      TMPDIR: "/fixture/tmp",
      DOPPLER_TOKEN: "synthetic",
      OPENAI_API_KEY: "synthetic",
      OPENAI_BASE_URL: "synthetic",
      OPENAI_WIRE_API: "synthetic",
      RIVET_ENGINE: "synthetic",
      RIVET_TOKEN: "synthetic",
      DATABASE_URL: "synthetic",
      OCCAVOY_TEST_DATABASE_URL: "synthetic",
      OCCAVOY_RUNTIME_DEMO_TOKEN: "synthetic",
    }),
    { PATH: "/tool/bin", HOME: "/fixture/home", TMPDIR: "/fixture/tmp" },
  );
});
