/**
 * Request-scoped database access.
 *
 * Every query the application runs goes through `withUser` or
 * `withAnonymous`. Both open a transaction, drop to the `clausepilot_app`
 * role (which row-level security applies to), and, for `withUser`, record who
 * is asking in the transaction-local `app.user_id` setting the policies read.
 * Nothing in the application queries as the table owner, so a forgotten
 * `WHERE` clause can only ever return rows the caller was allowed to see.
 *
 * See netlify/database/migrations/*_row_level_security.sql for the policies.
 */

import type { QueryResultRow } from "pg";

export const APP_DB_ROLE = "clausepilot_app";

/** The part of a pg client the services need. Keeps them testable against any pool. */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export interface Database {
  /** Runs `work` as `userId`, with every policy applied. Commits on success, rolls back on any error. */
  withUser<T>(userId: string, work: (db: Queryable) => Promise<T>): Promise<T>;
  /** Runs `work` as nobody: policies see no user, so ordinary tables return nothing. For session bootstrap only. */
  withAnonymous<T>(work: (db: Queryable) => Promise<T>): Promise<T>;
}

/**
 * A pool that hands out pg-compatible clients. Netlify Database returns either
 * a `pg.Pool` or the Neon serverless driver's pool depending on the runtime;
 * both satisfy this.
 */
export interface ConnectionPool {
  connect(): Promise<Queryable & { release(): void }>;
}

export function createDatabase(pool: ConnectionPool): Database {
  async function scoped<T>(userId: string | null, work: (db: Queryable) => Promise<T>): Promise<T> {
    if (userId !== null && !isUuid(userId)) {
      throw new Error("A request scope needs an application user id.");
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE ${APP_DB_ROLE}`);
      if (userId !== null) {
        await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
      }
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    withUser: (userId, work) => scoped(userId, work),
    withAnonymous: (work) => scoped(null, work),
  };
}

let defaultDatabase: Database | undefined;

/** The Netlify Database for this deploy context, created on first use. */
export async function getDefaultDatabase(): Promise<Database> {
  if (!defaultDatabase) {
    const { getDatabase } = await import("@netlify/database");
    defaultDatabase = createDatabase(getDatabase().pool as unknown as ConnectionPool);
  }
  return defaultDatabase;
}
