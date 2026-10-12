import "./load-env";
import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import type { Job } from "../server/db/schema";
import { getDb } from "../server/db/client";
import { errorMessage } from "../server/errors";
import { claimNext, heartbeat, pruneJobs, releaseStaleJobs, resetRunningJobs } from "../server/jobs/queue";
import { runJob } from "../server/jobs/runner";
import { enqueueDueScans } from "../server/jobs/scheduler";
import { getSettings } from "../server/settings";

const WORKER_ID = `${hostname()}:${process.pid}`;
const IDLE_POLL_MS = 2_000;
const SCHEDULER_EVERY_MS = 30_000;
const HEARTBEAT_EVERY_MS = 60_000;
const STALE_AFTER_MS = 10 * 60_000;
/** Non-transfer jobs (scans, metadata, status checks) that can run next to transfers. */
const EXTRA_CONCURRENCY = 2;

const shutdown = new AbortController();
const active = new Map<number, { job: Job; done: Promise<void> }>();

function log(message: string) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function startJob(job: Job) {
  log(`→ ${job.type} #${job.id} ${JSON.stringify(job.payload)} (intento ${job.attempts})`);
  const beat = setInterval(() => heartbeat(job.id), HEARTBEAT_EVERY_MS);
  const started = Date.now();
  const done = runJob(job, { signal: shutdown.signal })
    .catch((error) => log(`✗ ${job.type} #${job.id}: ${errorMessage(error)}`))
    .finally(() => {
      clearInterval(beat);
      active.delete(job.id);
      log(`← ${job.type} #${job.id} (${Math.round((Date.now() - started) / 1000)}s)`);
    });
  active.set(job.id, { job, done });
}

function fillSlots() {
  const { maxParallelTransfers } = getSettings();
  while (active.size < maxParallelTransfers + EXTRA_CONCURRENCY) {
    const running = [...active.values()];
    const transfers = running.filter((a) => a.job.type === "transfer_video").length;
    const others = running.length - transfers;
    const exclude: Job["type"][] = [];
    if (transfers >= maxParallelTransfers) exclude.push("transfer_video");
    if (others >= EXTRA_CONCURRENCY) {
      exclude.push("scan_workflow", "generate_metadata", "check_processing", "sync_metadata");
    }
    const job = claimNext(WORKER_ID, exclude);
    if (!job) return;
    startJob(job);
  }
}

function schedulerTick() {
  try {
    enqueueDueScans();
    const released = releaseStaleJobs(STALE_AFTER_MS);
    if (released > 0) log(`${released} job(s) sin latido devueltos a la cola`);
    pruneJobs();
  } catch (error) {
    log(`Error en el planificador: ${errorMessage(error)}`);
  }
}

async function main() {
  getDb(); // Opens the database and applies pending migrations.
  const reset = resetRunningJobs();
  log(`Worker ${WORKER_ID} iniciado${reset > 0 ? `; ${reset} job(s) interrumpido(s) vuelven a la cola` : ""}`);

  schedulerTick();
  const scheduler = setInterval(schedulerTick, SCHEDULER_EVERY_MS);

  while (!shutdown.signal.aborted) {
    try {
      fillSlots();
    } catch (error) {
      log(`Error al tomar jobs: ${errorMessage(error)}`);
    }
    await sleep(IDLE_POLL_MS, undefined, { signal: shutdown.signal }).catch(() => {});
  }

  clearInterval(scheduler);
  log(`Deteniendo; esperando ${active.size} job(s)…`);
  await Promise.race([Promise.allSettled([...active.values()].map((a) => a.done)), sleep(30_000)]);
  log("Worker detenido");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shutdown.signal.aborted) process.exit(1);
    shutdown.abort();
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
