import test from "node:test";
import { runCaseRecovery } from "./case-recovery-fixture.mjs";
import { presentLondon } from "./london-presentation.mjs";

const walkthrough = process.argv.includes("--walkthrough");

if (walkthrough && !process.stdin.isTTY) {
  console.error(
    "pnpm demo:london / --walkthrough requires an interactive terminal for bounded pauses.",
  );
  process.exit(1);
}

test("London saved-case recovery and customer continuity fixture", {
  timeout: walkthrough ? 16 * 60_000 : 300_000,
}, async (t) => {
  await runCaseRecovery(t, { present: presentLondon, walkthrough });
});
