"use client";

import { ExternalLink, Sparkles } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TransferProgress, VideoStatusBadge } from "@/components/video-status";
import { formatBytes } from "@/lib/format";
import type { VideoStatus } from "@/server/db/schema";
import { bulkVideoAction, type BulkAction } from "./actions";

export type VideoRow = {
  id: number;
  name: string;
  path: string;
  size: number;
  status: VideoStatus;
  title: string | null;
  titleSource: "template" | "ai" | "manual" | null;
  workflowName: string;
  youtubeVideoId: string | null;
  error: string | null;
  bytesDownloaded: number;
  bytesUploaded: number;
  detectedAgo: string;
};

const BULK_BUTTONS: { action: BulkAction; label: string }[] = [
  { action: "approve", label: "Aprobar y subir" },
  { action: "retry", label: "Reintentar" },
  { action: "regenerate", label: "Regenerar título" },
  { action: "ignore", label: "Ignorar" },
  { action: "restore", label: "Restaurar" },
];

export function VideoTable({ rows }: { rows: VideoRow[] }) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [pending, startTransition] = useTransition();
  const visibleSelected = rows.filter((r) => selected.has(r.id)).map((r) => r.id);
  const allSelected = rows.length > 0 && visibleSelected.length === rows.length;

  const toggle = (id: number, checked: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });

  const run = (action: BulkAction) =>
    startTransition(async () => {
      const result = await bulkVideoAction(visibleSelected, action);
      if (result.ok) {
        toast.success(result.message);
        setSelected(new Set());
      } else {
        toast.error(result.error);
      }
    });

  if (rows.length === 0) {
    return <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">No hay videos.</div>;
  }

  return (
    <div className="space-y-3">
      {visibleSelected.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 p-2">
          <span className="px-2 text-sm">{visibleSelected.length} seleccionado(s)</span>
          {BULK_BUTTONS.map((b) => (
            <Button key={b.action} size="sm" variant="outline" disabled={pending} onClick={() => run(b.action)}>
              {b.label}
            </Button>
          ))}
        </div>
      )}
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={(c) => setSelected(c ? new Set(rows.map((r) => r.id)) : new Set())}
                  aria-label="Seleccionar todos"
                />
              </TableHead>
              <TableHead className="w-28" />
              <TableHead>Video</TableHead>
              <TableHead>Título en YouTube</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead>Workflow</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id} data-state={selected.has(row.id) ? "selected" : undefined}>
                <TableCell>
                  <Checkbox
                    checked={selected.has(row.id)}
                    onCheckedChange={(c) => toggle(row.id, c === true)}
                    aria-label={`Seleccionar ${row.name}`}
                  />
                </TableCell>
                <TableCell>
                  <Thumbnail videoId={row.id} />
                </TableCell>
                <TableCell className="max-w-64">
                  <Link href={`/videos/${row.id}`} className="block truncate font-medium hover:underline">
                    {row.name}
                  </Link>
                  <div className="truncate text-xs text-muted-foreground">
                    {formatBytes(row.size)} · {row.path} · {row.detectedAgo}
                  </div>
                </TableCell>
                <TableCell className="max-w-80">
                  <div className="flex items-center gap-1">
                    {row.titleSource === "ai" && <Sparkles className="size-3.5 shrink-0 text-violet-500" aria-label="Generado con IA" />}
                    <span className="truncate">{row.title ?? <span className="text-muted-foreground">—</span>}</span>
                  </div>
                  {row.youtubeVideoId && (
                    <a
                      href={`https://youtu.be/${row.youtubeVideoId}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline"
                    >
                      Ver en YouTube <ExternalLink className="size-3" />
                    </a>
                  )}
                </TableCell>
                <TableCell>
                  <VideoStatusBadge status={row.status} />
                  <TransferProgress
                    status={row.status}
                    size={row.size}
                    bytesDownloaded={row.bytesDownloaded}
                    bytesUploaded={row.bytesUploaded}
                  />
                  {row.error && (
                    <div className="mt-1 max-w-56 truncate text-xs text-destructive" title={row.error}>
                      {row.error}
                    </div>
                  )}
                </TableCell>
                <TableCell className="max-w-40 truncate text-sm">{row.workflowName}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function Thumbnail({ videoId }: { videoId: number }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <div className="aspect-video w-24 rounded bg-muted" />;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- proxied OneDrive thumbnail
    <img
      src={`/api/videos/${videoId}/thumbnail`}
      alt=""
      loading="lazy"
      className="aspect-video w-24 rounded bg-muted object-cover"
      onError={() => setFailed(true)}
    />
  );
}
