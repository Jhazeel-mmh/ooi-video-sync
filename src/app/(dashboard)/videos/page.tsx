import { and, asc, count, desc, eq, inArray, like, ne, or, type SQL } from "drizzle-orm";
import Link from "next/link";
import { Suspense } from "react";
import { AutoRefresh } from "@/components/auto-refresh";
import { PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { ACTIVE_STATUSES } from "@/components/video-status";
import { timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { getDb } from "@/server/db/client";
import { videos, workflows, type VideoStatus } from "@/server/db/schema";
import { requireAdmin } from "@/server/session";
import { isVideoFilter, statusesFor, VIDEO_FILTERS, type VideoFilter } from "./filters";
import { VideoSearch } from "./video-search";
import { VideoTable, type VideoRow } from "./video-table";

const PAGE_SIZE = 200;

export default function VideosPage(props: PageProps<"/videos">) {
  return (
    <>
      <PageHeader title="Videos" description="Todo lo que se detectó en OneDrive y su estado en YouTube." />
      <Suspense fallback={<Skeleton className="h-96 w-full" />}>
        <VideosContent searchParams={props.searchParams} />
      </Suspense>
    </>
  );
}

function statusCondition(filter: VideoFilter): SQL {
  const statuses = statusesFor(filter);
  return statuses === "all-but-ignored" ? ne(videos.status, "ignored") : inArray(videos.status, [...statuses]);
}

async function VideosContent({ searchParams }: { searchParams: PageProps<"/videos">["searchParams"] }) {
  await requireAdmin();
  const params = await searchParams;
  const filter: VideoFilter = isVideoFilter(params.status) ? params.status : "all";
  const workflowId = Number(params.workflow) || null;
  const query = typeof params.q === "string" ? params.q.trim() : "";

  const db = getDb();
  const scope = and(
    workflowId ? eq(videos.workflowId, workflowId) : undefined,
    query ? or(like(videos.name, `%${query}%`), like(videos.title, `%${query}%`)) : undefined,
  );
  const rows = db
    .select({ video: videos, workflowName: workflows.name })
    .from(videos)
    .innerJoin(workflows, eq(videos.workflowId, workflows.id))
    .where(and(scope, statusCondition(filter)))
    .orderBy(desc(videos.createdAt))
    .limit(PAGE_SIZE)
    .all();

  const statusCounts = new Map<VideoStatus, number>(
    db
      .select({ status: videos.status, total: count() })
      .from(videos)
      .where(scope)
      .groupBy(videos.status)
      .all()
      .map((r) => [r.status, r.total]),
  );
  const countFor = (f: VideoFilter) => {
    const statuses = statusesFor(f);
    return [...statusCounts.entries()]
      .filter(([s]) => (statuses === "all-but-ignored" ? s !== "ignored" : statuses.includes(s)))
      .reduce((sum, [, n]) => sum + n, 0);
  };

  const tableRows: VideoRow[] = rows.map(({ video, workflowName }) => ({
    id: video.id,
    name: video.name,
    path: video.path,
    size: video.size,
    status: video.status,
    title: video.title,
    titleSource: video.titleSource,
    workflowName,
    youtubeVideoId: video.youtubeVideoId,
    error: video.error,
    bytesDownloaded: video.bytesDownloaded,
    bytesUploaded: video.bytesUploaded,
    detectedAgo: timeAgo(video.createdAt),
  }));

  const hrefFor = (f: VideoFilter) => {
    const next = new URLSearchParams();
    if (f !== "all") next.set("status", f);
    if (workflowId) next.set("workflow", String(workflowId));
    if (query) next.set("q", query);
    const qs = next.toString();
    return qs ? `/videos?${qs}` : "/videos";
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav className="flex flex-wrap gap-1">
          {(Object.keys(VIDEO_FILTERS) as VideoFilter[]).map((f) => (
            <Link
              key={f}
              href={hrefFor(f)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm",
                f === filter ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-accent/60",
              )}
            >
              {VIDEO_FILTERS[f].label} <span className="tabular-nums opacity-70">{countFor(f)}</span>
            </Link>
          ))}
        </nav>
        <VideoSearch workflows={db.select({ id: workflows.id, name: workflows.name }).from(workflows).orderBy(asc(workflows.name)).all()} />
      </div>
      <VideoTable rows={tableRows} />
      {rows.length === PAGE_SIZE && (
        <p className="text-sm text-muted-foreground">Se muestran los {PAGE_SIZE} más recientes; usa los filtros para acotar.</p>
      )}
      <AutoRefresh active={tableRows.some((r) => ACTIVE_STATUSES.includes(r.status))} />
    </div>
  );
}
