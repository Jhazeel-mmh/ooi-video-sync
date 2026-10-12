import { asc, count } from "drizzle-orm";
import { Plus } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { ActionButton } from "@/components/action-button";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDate, timeAgo } from "@/lib/format";
import { getDb } from "@/server/db/client";
import { accounts, videos, workflows } from "@/server/db/schema";
import { requireAdmin } from "@/server/session";
import { getSettings } from "@/server/settings";
import { deleteWorkflow, scanWorkflowNow, setWorkflowEnabled } from "./actions";

export default function WorkflowsPage() {
  return (
    <>
      <PageHeader
        title="Workflows"
        description="Cada workflow vigila una carpeta de OneDrive y sube sus videos a un canal de YouTube."
        actions={
          <Button asChild>
            <Link href="/workflows/new">
              <Plus className="size-4" /> Nuevo workflow
            </Link>
          </Button>
        }
      />
      <Suspense fallback={<Skeleton className="h-48 w-full" />}>
        <WorkflowList />
      </Suspense>
    </>
  );
}

async function WorkflowList() {
  await requireAdmin();
  const db = getDb();
  const rows = db.select().from(workflows).orderBy(asc(workflows.name)).all();
  const { timeZone } = getSettings();
  const accountNames = new Map(db.select().from(accounts).all().map((a) => [a.id, a]));
  const counts = db
    .select({ workflowId: videos.workflowId, status: videos.status, total: count() })
    .from(videos)
    .groupBy(videos.workflowId, videos.status)
    .all();
  const countFor = (workflowId: number, statuses: string[]) =>
    counts.filter((c) => c.workflowId === workflowId && statuses.includes(c.status)).reduce((s, c) => s + c.total, 0);

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        Todavía no hay workflows.{" "}
        <Link href="/workflows/new" className="underline">
          Crea el primero
        </Link>
        .
      </div>
    );
  }

  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Nombre</TableHead>
            <TableHead>Origen</TableHead>
            <TableHead>Destino</TableHead>
            <TableHead>Modo</TableHead>
            <TableHead>Videos</TableHead>
            <TableHead>Último escaneo</TableHead>
            <TableHead className="text-right">Acciones</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((wf) => {
            const onedrive = accountNames.get(wf.onedriveAccountId);
            const youtube = accountNames.get(wf.youtubeAccountId);
            const paused = onedrive?.status === "needs_reauth" || youtube?.status === "needs_reauth";
            return (
              <TableRow key={wf.id}>
                <TableCell>
                  <Link href={`/workflows/${wf.id}`} className="font-medium hover:underline">
                    {wf.name}
                  </Link>
                  <div className="mt-1 flex gap-1">
                    {!wf.enabled && <Badge variant="outline">En pausa</Badge>}
                    {paused && <Badge variant="destructive">Cuenta desconectada</Badge>}
                  </div>
                </TableCell>
                <TableCell className="max-w-56">
                  <div className="truncate">{wf.folderPath}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {onedrive?.displayName}
                    {wf.sinceDate && ` · grabados desde ${formatDate(wf.sinceDate, timeZone)}`}
                  </div>
                </TableCell>
                <TableCell className="max-w-48 truncate">{youtube?.displayName}</TableCell>
                <TableCell>
                  <Badge variant="secondary">{wf.mode === "auto" ? "Automático" : "Revisión"}</Badge>
                </TableCell>
                <TableCell className="text-sm">
                  <Link href={`/videos?workflow=${wf.id}`} className="hover:underline">
                    {countFor(wf.id, ["pending_review"])} por revisar · {countFor(wf.id, ["published", "processing"])} subidos
                  </Link>
                </TableCell>
                <TableCell className="text-sm">
                  {timeAgo(wf.lastScannedAt)}
                  {wf.lastScanError && <div className="max-w-56 truncate text-xs text-destructive">{wf.lastScanError}</div>}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <ActionButton
                      size="sm"
                      variant="ghost"
                      disabled={!wf.enabled || paused}
                      action={scanWorkflowNow.bind(null, wf.id)}
                    >
                      Revisar ahora
                    </ActionButton>
                    <ActionButton size="sm" variant="ghost" action={setWorkflowEnabled.bind(null, wf.id, !wf.enabled)}>
                      {wf.enabled ? "Pausar" : "Activar"}
                    </ActionButton>
                    <Button asChild size="sm" variant="ghost">
                      <Link href={`/workflows/${wf.id}`}>Editar</Link>
                    </Button>
                    <ActionButton
                      size="sm"
                      variant="ghost"
                      className="text-destructive"
                      action={deleteWorkflow.bind(null, wf.id)}
                      confirm={{
                        title: `¿Eliminar "${wf.name}"?`,
                        description:
                          "Se borra el workflow junto con su historial de videos. Los archivos de OneDrive y los videos ya subidos a YouTube no se tocan.",
                        confirmLabel: "Eliminar",
                      }}
                    >
                      Eliminar
                    </ActionButton>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
