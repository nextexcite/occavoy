import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";

const SQL_DIRECTORY = fileURLToPath(new URL("../sql", import.meta.url));

// The lock is namespaced by current_schema() so isolated test schemas never
// block each other while two callers in the same schema strictly serialize.
const LOCK_KEY = "occavoy_schema_migrations:";

async function takeLock(client: PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1 || current_schema()))", [LOCK_KEY]);
}

/**
 * Applies every unapplied `sql/*.sql` file in filename order. Phase 1 creates
 * the ledger inside an advisory-locked transaction so concurrent first-time
 * initializers in the same schema serialize cleanly. Phase 2 then applies each
 * unapplied file in its own advisory-locked transaction so a failing migration
 * rolls back without undoing the ledger. Returns the newly applied versions.
 */
export async function applyMigrations(pool: Pool): Promise<string[]> {
  const seen = new Set<string>();
  {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await takeLock(client);
      await client.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
          version text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )`,
      );
      const applied = await client.query<{ version: string }>(
        "SELECT version FROM schema_migrations",
      );
      for (const row of applied.rows) seen.add(row.version);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  const files = readdirSync(SQL_DIRECTORY)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const newlyApplied: string[] = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    if (seen.has(version)) continue;
    const sql = readFileSync(new URL(`../sql/${file}`, import.meta.url), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await takeLock(client);
      const check = await client.query("SELECT 1 FROM schema_migrations WHERE version = $1", [
        version,
      ]);
      if (check.rowCount === 0) {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
        newlyApplied.push(version);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  return newlyApplied;
}
