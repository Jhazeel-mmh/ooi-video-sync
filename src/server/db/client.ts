import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { env } from "../env";
import * as schema from "./schema";

function createDb() {
  const dataDir = path.resolve(env().DATA_DIR);
  mkdirSync(dataDir, { recursive: true });
  const sqlite = new Database(path.join(dataDir, "app.db"));
  // WAL lets the web process read while the worker writes.
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema, casing: "snake_case" });
  migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  return db;
}

export type Db = ReturnType<typeof createDb>;

const globalForDb = globalThis as unknown as { __ovsDb?: Db };

/** Lazily opened (and migrated) on first use; reused across hot reloads. */
export function getDb(): Db {
  globalForDb.__ovsDb ??= createDb();
  return globalForDb.__ovsDb;
}
