/**
 * Run one command with the repo-root `.env.local` snapshot overlaid onto the
 * inherited environment, then replace this process image with the command.
 * Supervisors may signal the resulting process directly by PID; there is no
 * wrapper left in between. Never prints or interpolates secret values.
 */
import process from "node:process";
import "./load-local-env.mjs";

const args = process.argv.slice(2);
// `/usr/bin/env` with no command prints the environment; NAME=value prefixes and a
// lone dash are env syntax, never a command. Refuse all three before exec.
if (!args[0] || args[0].includes("=") || args[0] === "-") {
  console.error("Usage: pnpm local:exec <command> [args...]");
  process.exitCode = 2;
} else {
  process.execve("/usr/bin/env", ["env", "--", ...args], process.env);
}
