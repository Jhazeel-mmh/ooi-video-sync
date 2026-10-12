import "../src/worker/load-env";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const KEEP = Number(process.env.BACKUP_KEEP ?? 14);

async function main() {
  const dataDir = path.resolve(process.env.DATA_DIR ?? "./data");
  const backupDir = path.join(dataDir, "backups");
  mkdirSync(backupDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const target = path.join(backupDir, `app-${stamp}.db`);
  // Online backup: safe while the web app and the worker are running.
  const db = new Database(path.join(dataDir, "app.db"), { readonly: true, fileMustExist: true });
  await db.backup(target);
  db.close();
  console.log(`Respaldo creado: ${target}`);

  const old = readdirSync(backupDir)
    .filter((f) => /^app-.*\.db$/.test(f))
    .sort()
    .reverse()
    .slice(KEEP);
  for (const file of old) rmSync(path.join(backupDir, file));
  if (old.length > 0) console.log(`${old.length} respaldo(s) antiguo(s) eliminado(s)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
