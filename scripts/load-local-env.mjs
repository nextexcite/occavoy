/**
 * Narrow local-development preload: materializes only explicitly local names
 * from the repo-root `.env.local`. Inherited environment always wins; a missing
 * file is not an error, but any other read failure is. Never treats the file
 * as shell code and never spreads unknown keys into the process environment.
 */
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const path = new URL("../.env.local", import.meta.url);
let values = {};
try {
  values = parseEnv(readFileSync(path, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
for (const key of ["DATABASE_URL", "OCCAVOY_RUNTIME_MODE", "OCCAVOY_RUNTIME_DEMO_TOKEN"]) {
  if (process.env[key] !== undefined || values[key] === undefined) continue;
  if (key === "OCCAVOY_RUNTIME_MODE" && values[key] !== "local") {
    throw new Error("Expected local OCCAVOY_RUNTIME_MODE in .env.local");
  }
  process.env[key] = values[key];
}
