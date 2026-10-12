import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import type { VideoStatus } from "@/server/db/schema";

export const STATUS_LABELS: Record<VideoStatus, string> = {
  discovered: "Detectado",
  pending_review: "Por revisar",
  queued: "En cola",
  downloading: "Descargando",
  uploading: "Subiendo",
  processing: "Procesando en YouTube",
  published: "Publicado",
  failed: "Error",
  ignored: "Ignorado",
  waiting_quota: "Esperando cuota",
};

const STATUS_STYLES: Record<VideoStatus, string> = {
  discovered: "bg-muted text-muted-foreground",
  pending_review: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  queued: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
  downloading: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
  uploading: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
  processing: "bg-violet-500/15 text-violet-700 dark:text-violet-400",
  published: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  failed: "bg-destructive/10 text-destructive",
  ignored: "bg-muted text-muted-foreground line-through",
  waiting_quota: "bg-orange-500/15 text-orange-700 dark:text-orange-400",
};

/** Statuses that change on their own; pages showing them refresh periodically. */
export const ACTIVE_STATUSES: VideoStatus[] = ["discovered", "queued", "downloading", "uploading", "processing"];

export function VideoStatusBadge({ status }: { status: VideoStatus }) {
  return <Badge className={cn("border-transparent", STATUS_STYLES[status])}>{STATUS_LABELS[status]}</Badge>;
}

export function TransferProgress({
  status,
  size,
  bytesDownloaded,
  bytesUploaded,
}: {
  status: VideoStatus;
  size: number;
  bytesDownloaded: number;
  bytesUploaded: number;
}) {
  if (status !== "downloading" && status !== "uploading") return null;
  const bytes = status === "downloading" ? bytesDownloaded : bytesUploaded;
  const percent = size > 0 ? Math.min(100, Math.round((bytes / size) * 100)) : 0;
  return (
    <div className="mt-1 flex items-center gap-2">
      <Progress value={percent} className="h-1.5 w-24" />
      <span className="text-xs text-muted-foreground tabular-nums">{percent}%</span>
    </div>
  );
}
