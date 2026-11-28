import { randomUUID } from "node:crypto";
import pg from "pg";
import { applyMigrations } from "../../src/migrations";

const compose = "postgresql://occavoy:occavoy@127.0.0.1:54329/occavoy";

export function testDatabaseUrl(raw = process.env.OCCAVOY_TEST_DATABASE_URL): string | undefined {
  if (raw === undefined) return undefined;
  if (raw !== compose && raw !== "postgresql://127.0.0.1:54329/occavoy") {
    throw new Error("Expected the disposable Occavoy Compose Postgres test target");
  }
  return compose;
}

export async function openTestSchema(raw = process.env.OCCAVOY_TEST_DATABASE_URL): Promise<{
  pool: pg.Pool;
  schema: string;
  close: () => Promise<void>;
}> {
  const databaseUrl = testDatabaseUrl(raw);
  if (!databaseUrl) throw new Error("OCCAVOY_TEST_DATABASE_URL is not configured");
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  let pool: pg.Pool | undefined;
  let created = false;
  let closed = false;
  async function dropCreated() {
    if (created) {
      await admin.query(`DROP SCHEMA ${pg.escapeIdentifier(schema)} CASCADE`);
      created = false;
    }
  }
  try {
    await admin.query(`CREATE SCHEMA ${pg.escapeIdentifier(schema)}`);
    created = true;
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
    pool = new pg.Pool({ connectionString: scopedUrl.href });
    const current = await pool.query("SELECT current_schema() AS schema");
    if (current.rows[0]?.schema !== schema) {
      throw new Error("Disposable test schema search_path did not apply");
    }
    await applyMigrations(pool);
  } catch (error) {
    if (pool) await pool.end().catch(() => {});
    await dropCreated().catch(() => {});
    await admin.end().catch(() => {});
    throw error;
  }
  return {
    pool,
    schema,
    close: async () => {
      if (closed) return;
      closed = true;
      let firstError: unknown;
      try {
        await pool.end();
      } catch (error) {
        firstError ??= error;
      }
      try {
        await dropCreated();
      } catch (error) {
        firstError ??= error;
      } finally {
        await admin.end().catch(() => {});
      }
      if (firstError) throw firstError;
    },
  };
}
