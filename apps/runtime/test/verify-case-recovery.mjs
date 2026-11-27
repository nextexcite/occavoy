import test from "node:test";
import { runCaseRecovery } from "./case-recovery-fixture.mjs";

test("HTTP-activated case recovers the same Pi submission during a scoped read", {
  timeout: 240_000,
}, async (t) => {
  await runCaseRecovery(t);
});
