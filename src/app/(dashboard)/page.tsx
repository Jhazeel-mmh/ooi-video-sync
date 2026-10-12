import { TZDate } from "@date-fns/tz";
import { startOfDay } from "date-fns";
import { and, count, desc, eq, gte } from "drizzle-orm";
import { AlertCircle, CheckCircle2, CircleDashed, Clock, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { AutoRefresh } from "@/components/auto-refresh";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTime, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { getDb } from "@/server/db/client";
import { accounts, events, videos, workflows, type VideoStatus } from "@/server/db/schema";
import { getTodayQuota, nextQuotaReset } from "@/server/quota";
import { requireAdmin } from "@/server/session";
import { getSettings, lastWorkerHeartbeat } from "@/server/settings";

/** The worker records a heartbeat every 30 s. */
const WORKER_SILENT_AFTER_MS = 2 * 60_000;

export default function HomePage() {
  return (
    <>
      <PageHeader title="Inicio" description="Resumen de la sincronización de OneDrive a YouTube." />
      <Suspense fallback={<Skeleton className="h-96 w-full" />}>
        <Overview />
      </Suspense>
    </>
  );
}

/** Plain function (not a component): reads the clock and the database. */
function loadOverview() {
  const db = getDb();
  const settings = getSettings();
  const byStatus = new Map<VideoStatus, number>(
    db
      .select({ status: videos.status, total: count() })
      .from(videos)
      .groupBy(videos.status)
      .all()
      .map((r) => [r.status, r.total]),
  );
  const todayStart = startOfDay(new TZDate(Date.now(), settings.timeZone));
  const publishedToday = db
    .select({ total: count() })
    .from(videos)
    .where(and(eq(videos.status, "published"), gte(videos.publishedAt, new Date(todayStart.getTime()))))
    .get()!.total;
  const allAccounts = db.select().from(accounts).all();
  const heartbeat = lastWorkerHeartbeat();
  return {
    settings,
    byStatus,
    publishedToday,
    allAccounts,
    disconnected: allAccounts.filter((a) => a.status === "needs_reauth"),
    workflowCount: db.select({ total: count() }).from(workflows).get()!.total,
    heartbeat,
    workerAlive: heartbeat !== null && Date.now() - heartbeat.getTime() < WORKER_SILENT_AFTER_MS,
    quota: getTodayQuota(),
    recent: db
      .select({ event: events, videoName: videos.name, videoTitle: videos.title })
      .from(events)
      .leftJoin(videos, eq(events.videoId, videos.id))
      .orderBy(desc(events.createdAt), desc(events.id))
      .limit(20)
      .all(),
  };
}

async function Overview() {
  await requireAdmin();
  const { settings, byStatus, publishedToday, allAccounts, disconnected, workflowCount, heartbeat, workerAlive, quota, recent } =
    loadOverview();
  const sum = (...statuses: VideoStatus[]) => statuses.reduce((n, s) => n + (byStatus.get(s) ?? 0), 0);
  const inProgress = sum("queued", "downloading", "uploading", "processing");

  return (
    <div className="space-y-6">
      {!workerAlive && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>El worker no está corriendo</AlertTitle>
          <AlertDescription>
            Sin el worker no se detectan ni se suben videos. Inícialo con <code>pnpm worker</code> (desarrollo) o{" "}
            <code>pnpm worker:start</code>. Última señal: {timeAgo(heartbeat)}.
          </AlertDescription>
        </Alert>
      )}
      {disconnected.length > 0 && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Hay cuentas que necesitan reconectarse</AlertTitle>
          <AlertDescription>
            {disconnected.map((a) => a.displayName).join(", ")}. Sus workflows están en pausa.{" "}
            <Link href="/accounts" className="underline">
              Ir a Cuentas
            </Link>
          </AlertDescription>
        </Alert>
      )}
      {(allAccounts.length === 0 || workflowCount === 0) && <GettingStarted hasAccounts={allAccounts.length > 0} />}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat href="/videos?status=review" label="Por revisar" value={sum("pending_review")} icon={<Clock />} />
        <Stat href="/videos?status=active" label="En proceso" value={inProgress + sum("discovered", "waiting_quota")} icon={<CircleDashed />} />
        <Stat href="/videos?status=published" label="Publicados hoy" value={publishedToday} icon={<CheckCircle2 />} />
        <Stat
          href="/videos?status=failed"
          label="Con error"
          value={sum("failed")}
          icon={<TriangleAlert />}
          tone={sum("failed") > 0 ? "danger" : undefined}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Cuota de YouTube hoy</CardTitle>
            <CardDescription>Se reinicia el {formatDateTime(nextQuotaReset(), settings.timeZone)}.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Progress value={settings.dailyQuotaUnits ? Math.min(100, (quota.units / settings.dailyQuotaUnits) * 100) : 0} />
            <div className="flex justify-between">
              <span>
                {quota.units.toLocaleString("es")} / {settings.dailyQuotaUnits.toLocaleString("es")} unidades
              </span>
              <span>{quota.uploads} subida(s)</span>
            </div>
            <p className="text-muted-foreground">
              Caben {Math.max(0, Math.floor((settings.dailyQuotaUnits - quota.units) / Math.max(settings.uploadCostUnits, 1)))}{" "}
              subida(s) más hoy.{" "}
              <Link href="/settings" className="underline">
                Ajustar
              </Link>
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Actividad reciente</CardTitle>
          </CardHeader>
          <CardContent>
            {recent.length === 0 ? (
              <p className="text-sm text-muted-foreground">Todavía no hay actividad.</p>
            ) : (
              <ol className="divide-y">
                {recent.map(({ event, videoName, videoTitle }) => (
                  <li key={event.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 text-sm">
                    <div className="min-w-0">
                      {event.videoId && (
                        <Link href={`/videos/${event.videoId}`} className="mr-2 font-medium hover:underline">
                          {videoTitle ?? videoName}
                        </Link>
                      )}
                      <span
                        className={cn(
                          event.level === "error" && "text-destructive",
                          event.level === "warn" && "text-amber-700 dark:text-amber-400",
                        )}
                      >
                        {event.message}
                      </span>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(event.createdAt)}</span>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      </div>
      <AutoRefresh active={inProgress > 0} intervalMs={10_000} />
    </div>
  );
}

function Stat({
  href,
  label,
  value,
  icon,
  tone,
}: {
  href: string;
  label: string;
  value: number;
  icon: ReactNode;
  tone?: "danger";
}) {
  return (
    <Link href={href}>
      <Card className="transition-colors hover:bg-accent/40">
        <CardContent className="flex items-center justify-between">
          <div>
            <div className="text-sm text-muted-foreground">{label}</div>
            <div className={cn("text-3xl font-semibold tabular-nums", tone === "danger" && "text-destructive")}>{value}</div>
          </div>
          <div className="text-muted-foreground [&>svg]:size-6">{icon}</div>
        </CardContent>
      </Card>
    </Link>
  );
}

function GettingStarted({ hasAccounts }: { hasAccounts: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Primeros pasos</CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          <li className={cn(hasAccounts && "text-muted-foreground line-through")}>
            <Link href="/accounts" className="underline">
              Vincula
            </Link>{" "}
            una cuenta de OneDrive y un canal de YouTube.
          </li>
          <li>
            <Link href="/workflows/new" className="underline">
              Crea un workflow
            </Link>{" "}
            eligiendo la carpeta a vigilar, el canal y la plantilla del título.
          </li>
          <li>Deja corriendo el worker; los videos nuevos aparecerán en la sección Videos.</li>
        </ol>
      </CardContent>
    </Card>
  );
}
