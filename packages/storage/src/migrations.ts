import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

const SQL_DIRECTORY = fileURLToPath(new URL("../sql", import.meta.url));

/**
 * Applies every unapplied `sql/*.sql` file in filename order, each inside one
 * transaction guarded by a transaction-scoped advisory lock so concurrent
 * starters cannot double-apply a version. Returns the newly applied versions.
 */
export async function applyMigrations(pool: Pool): Promise<string[]> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`,
  );
  const applied = await pool.query<{ version: string }>(
    "SELECT version FROM schema_migrations ORDER BY version",
  );
  const seen = new Set(applied.rows.map((row) => row.version));
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
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        "occavoy_schema_migrations",
      ]);
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
