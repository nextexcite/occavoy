import { describe, expect, it } from "vitest";
import { openTestSchema, testDatabaseUrl } from "./support/disposable-postgres";

const databaseUrl = testDatabaseUrl();

describe("disposable Postgres test target selection", () => {
  it("ignores ordinary DATABASE_URL when the explicit test target is absent", () => {
    const explicit = process.env.OCCAVOY_TEST_DATABASE_URL;
    const ordinary = process.env.DATABASE_URL;
    delete process.env.OCCAVOY_TEST_DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://example.invalid/not-the-test-target";
    try {
      expect(testDatabaseUrl()).toBeUndefined();
    } finally {
      if (explicit === undefined) delete process.env.OCCAVOY_TEST_DATABASE_URL;
      else process.env.OCCAVOY_TEST_DATABASE_URL = explicit;
      if (ordinary === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = ordinary;
    }
  });

  it.each([
    "postgresql://example.invalid/occavoy",
    "postgresql://occavoy:occavoy@127.0.0.1:54329/occavoy?options=-c%20search_path%3Dpublic",
  ])("refuses a wrong or overridden target without connecting", (raw) => {
    expect(() => testDatabaseUrl(raw)).toThrow("disposable Occavoy Compose Postgres");
  });

  it.skipIf(!databaseUrl)(
    "opens concurrent isolated schemas and cleans only the owned schema",
    async () => {
      const settled = await Promise.allSettled([openTestSchema(), openTestSchema()]);
      const opened = settled.flatMap((result) =>
        result.status === "fulfilled" ? [{ schema: result.value, closed: false }] : [],
      );
      let failure: unknown = settled.find((result) => result.status === "rejected")?.reason;
      try {
        if (failure) throw failure;
        expect(opened).toHaveLength(2);
        const first = opened[0]!.schema;
        const second = opened[1]!.schema;
        expect(first.schema).not.toBe(second.schema);
        await first.pool.query("CREATE TABLE isolation_probe (id integer PRIMARY KEY)");
        await first.pool.query("INSERT INTO isolation_probe VALUES (1)");
        await expect(second.pool.query("SELECT * FROM isolation_probe")).rejects.toThrow();
        await first.close();
        opened[0]!.closed = true;
        await second.pool.query("SELECT 1");
        await expect(
          second.pool.query(
            "SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1",
            [first.schema],
          ),
        ).resolves.toMatchObject({ rowCount: 0 });
      } catch (error) {
        failure = error;
      } finally {
        let closeFailure: unknown;
        for (const entry of opened) {
          if (entry.closed) continue;
          try {
            await entry.schema.close();
            entry.closed = true;
          } catch (error) {
            closeFailure ??= error;
          }
        }
        if (!failure && closeFailure) failure = closeFailure;
      }
      if (failure) throw failure;
    },
  );
});
