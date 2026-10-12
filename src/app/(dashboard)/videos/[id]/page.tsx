import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { AlertCircle, ExternalLink } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { ActionButton } from "@/components/action-button";
import { AutoRefresh } from "@/components/auto-refresh";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ACTIVE_STATUSES, TransferProgress, VideoStatusBadge } from "@/components/video-status";
import { formatBytes, formatDateTime, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { getDb } from "@/server/db/client";
import { events, jobs } from "@/server/db/schema";
import { isAiConfigured } from "@/server/naming/ai";
import { transcriptionUnavailableReason } from "@/server/naming/transcript";
import { formatDuration, recordingDate } from "@/server/naming/template";
import { requireAdmin } from "@/server/session";
import { getSettings } from "@/server/settings";
import { loadVideo } from "@/server/videos";
import { transcribeVideoNow } from "../actions";
import { VideoEditor } from "./video-editor";

export default function VideoPage({ params }: PageProps<"/videos/[id]">) {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <VideoDetail params={params} />
    </Suspense>
  );
}

async function VideoDetail({ params }: { params: PageProps<"/videos/[id]">["params"] }) {
  await requireAdmin();
  const { id } = await params;
  const loaded = loadVideo(Number(id));
  if (!loaded) notFound();
  const { video, workflow } = loaded;
  const { timeZone } = getSettings();
  const history = getDb()
    .select()
    .from(events)
    .where(eq(events.videoId, video.id))
    .orderBy(desc(events.createdAt), desc(events.id))
    .limit(100)
    .all();
  const editable = !["discovered", "ignored"].includes(video.status) && video.title !== null;
  const transcribing = Boolean(
    getDb()
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.type, "transcribe_video"),
          inArray(jobs.status, ["queued", "running"]),
          sql`json_extract(${jobs.payload}, '$.videoId') = ${video.id}`,
        ),
      )
      .get(),
  );

  return (
    <>
      <PageHeader
        title={video.title ?? video.name}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <VideoStatusBadge status={video.status} />
            <span>{video.name}</span>
          </span>
        }
        actions={
          video.youtubeVideoId && (
            <Button asChild variant="outline">
              <a href={`https://studio.youtube.com/video/${video.youtubeVideoId}/edit`} target="_blank" rel="noreferrer">
                Abrir en YouTube Studio <ExternalLink className="size-4" />
              </a>
            </Button>
          )
        }
      />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-6">
          {video.error && (
            <Alert variant={video.status === "failed" ? "destructive" : "default"}>
              <AlertCircle />
              <AlertTitle>{video.status === "failed" ? "Error" : "Aviso"}</AlertTitle>
              <AlertDescription>{video.error}</AlertDescription>
            </Alert>
          )}
          <TransferProgress
            status={video.status}
            size={video.size}
            bytesDownloaded={video.bytesDownloaded}
            bytesUploaded={video.bytesUploaded}
          />
          {editable ? (
            <VideoEditor
              video={{
                id: video.id,
                status: video.status,
                uploaded: Boolean(video.youtubeVideoId),
                title: video.title ?? "",
                description: video.description ?? "",
                tags: video.tags ?? [],
                privacyStatus: video.privacyStatus ?? workflow.privacyStatus,
                publishAt: video.publishAt?.toISOString() ?? null,
              }}
              aiAvailable={isAiConfigured()}
              timeZone={timeZone}
            />
          ) : (
            <Card>
              <CardContent className="text-sm text-muted-foreground">
                {video.status === "ignored"
                  ? "Este video está ignorado. Restáuralo desde la lista de videos para procesarlo."
                  : "El título se genera cuando el archivo termina de sincronizarse en OneDrive."}
              </CardContent>
            </Card>
          )}
          <TranscriptCard
            videoId={video.id}
            transcript={video.transcript}
            transcribing={transcribing}
            unavailable={transcriptionUnavailableReason()}
          />
        </div>
        <aside className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Archivo</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {/* eslint-disable-next-line @next/next/no-img-element -- proxied OneDrive thumbnail */}
              <img src={`/api/videos/${video.id}/thumbnail`} alt="" className="aspect-video w-full rounded-md bg-muted object-cover" />
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
                <Info label="Carpeta">{video.path}</Info>
                <Info label="Tamaño">{formatBytes(video.size)}</Info>
                <Info label="Duración">{formatDuration(video.durationMs) || "—"}</Info>
                <Info label="Grabado">{formatDateTime(recordingDate(video, timeZone), timeZone)}</Info>
                <Info label="Detectado">{timeAgo(video.createdAt)}</Info>
                <Info label="Número">{video.sequence ?? "—"}</Info>
                <Info label="Workflow">
                  <Link href={`/workflows/${workflow.id}`} className="hover:underline">
                    {workflow.name}
                  </Link>
                </Info>
                {video.youtubeVideoId && (
                  <Info label="YouTube">
                    <a href={`https://youtu.be/${video.youtubeVideoId}`} target="_blank" rel="noreferrer" className="hover:underline">
                      youtu.be/{video.youtubeVideoId}
                    </a>
                  </Info>
                )}
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Actividad</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="space-y-3">
                {history.map((event) => (
                  <li key={event.id} className="text-sm">
                    <div
                      className={cn(
                        event.level === "error" && "text-destructive",
                        event.level === "warn" && "text-amber-700 dark:text-amber-400",
                      )}
                    >
                      {event.message}
                    </div>
                    <div className="text-xs text-muted-foreground">{formatDateTime(event.createdAt, timeZone)}</div>
                  </li>
                ))}
                {history.length === 0 && <li className="text-sm text-muted-foreground">Sin actividad todavía.</li>}
              </ol>
            </CardContent>
          </Card>
        </aside>
      </div>
      <AutoRefresh active={ACTIVE_STATUSES.includes(video.status) || transcribing} />
    </>
  );
}

function TranscriptCard({
  videoId,
  transcript,
  transcribing,
  unavailable,
}: {
  videoId: number;
  transcript: string | null;
  transcribing: boolean;
  unavailable: string | null;
}) {
  const words = transcript ? transcript.split(/\s+/).filter(Boolean).length : 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Transcripción</CardTitle>
        <CardDescription>
          La hace Gemini a partir del audio. Si existe, «Proponer con IA» la usa para el título, la descripción y los
          capítulos.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {transcript ? (
          <details>
            <summary className="cursor-pointer">Ver transcripción ({words} palabras)</summary>
            <div className="mt-2 max-h-96 overflow-y-auto rounded-md bg-muted/40 p-3 whitespace-pre-wrap">{transcript}</div>
          </details>
        ) : transcript === "" ? (
          <p className="text-muted-foreground">El audio no tiene habla para transcribir.</p>
        ) : (
          <p className="text-muted-foreground">Todavía no hay transcripción.</p>
        )}
        {transcribing ? (
          <p className="text-muted-foreground">Transcribiendo… puede tardar unos minutos.</p>
        ) : unavailable ? (
          <p className="text-muted-foreground">{unavailable}</p>
        ) : (
          <ActionButton size="sm" variant="outline" action={transcribeVideoNow.bind(null, videoId)}>
            {transcript === null ? "Transcribir" : "Volver a transcribir"}
          </ActionButton>
        )}
      </CardContent>
    </Card>
  );
}

function Info({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate">{children}</dd>
    </>
  );
}
