"use server";

import { eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { ActionResult } from "@/lib/action-result";
import { getDb } from "@/server/db/client";
import { accounts, POST_UPLOAD_ACTIONS, PRIVACY_STATUSES, WORKFLOW_MODES, workflows } from "@/server/db/schema";
import { errorMessage } from "@/server/errors";
import { logEvent } from "@/server/events";
import { filterFormErrors, filtersFromForm, type FilterSettings } from "@/server/filters";
import { scanNow } from "@/server/jobs/scheduler";
import { getDefaultDriveId, getItem, isVideoItem, itemPath, listChildren } from "@/server/providers/onedrive";
import { listCategories, listPlaylists } from "@/server/providers/youtube";
import { requireAdmin } from "@/server/session";
import { getSettings } from "@/server/settings";
import { reapplyVideoScope } from "@/server/video-scope";

const checkbox = z.preprocess((v) => v === "on" || v === "true" || v === true, z.boolean());
const optionalText = z.preprocess((v) => (v === "" || v === "none" || v == null ? null : v), z.string().nullable());

const workflowInput = z
  .object({
    name: z.string().trim().min(1, "Ponle un nombre").max(100),
    enabled: checkbox,
    onedriveAccountId: z.coerce.number().int().positive("Elige una cuenta de OneDrive"),
    driveId: z.string().min(1, "Elige una carpeta de OneDrive"),
    folderId: z.string().min(1, "Elige una carpeta de OneDrive"),
    folderPath: z.string().min(1),
    recursive: checkbox,
    includeExisting: checkbox,
    sinceDate: z.string(),
    untilDate: z.string(),
    minSizeMb: z.string(),
    maxSizeMb: z.string(),
    minDurationMin: z.string(),
    maxDurationMin: z.string(),
    nameInclude: z.string().max(500),
    nameExclude: z.string().max(500),
    skipDuplicates: checkbox,
    youtubeAccountId: z.coerce.number().int().positive("Elige un canal de YouTube"),
    mode: z.enum(WORKFLOW_MODES),
    titleTemplate: z.string().trim().min(1, "La plantilla de título no puede quedar vacía").max(500),
    descriptionTemplate: z.string().max(10_000),
    tagsTemplate: z.string().max(1000),
    useAi: checkbox,
    aiContext: z.string().max(4000),
    useTranscript: checkbox,
    addChapters: checkbox,
    privacyStatus: z.enum(PRIVACY_STATUSES),
    categoryId: z.string().min(1, "Elige una categoría"),
    playlistId: optionalText,
    playlistTitle: optionalText,
    madeForKids: checkbox,
    postUploadAction: z.enum(POST_UPLOAD_ACTIONS),
    postUploadFolderId: optionalText,
    postUploadFolderPath: optionalText,
    pollIntervalMin: z.coerce.number().int().min(1, "Mínimo 1 minuto").max(1440),
    stableMinutes: z.coerce.number().int().min(0).max(1440),
  })
  .superRefine((v, ctx) => {
    for (const [path, message] of Object.entries(filterFormErrors(v))) {
      ctx.addIssue({ code: "custom", path: [path], message });
    }
  })
  .refine((v) => v.postUploadAction !== "move" || v.postUploadFolderId, {
    path: ["postUploadFolderId"],
    message: "Elige la carpeta a donde mover los videos subidos",
  })
  .refine((v) => v.postUploadAction !== "move" || v.postUploadFolderId !== v.folderId, {
    path: ["postUploadFolderId"],
    message: "La carpeta destino debe ser distinta de la carpeta vigilada",
  });

export type WorkflowFormState = { error?: string; fieldErrors?: Record<string, string[] | undefined> };

export async function saveWorkflow(workflowId: number | null, formData: FormData): Promise<WorkflowFormState> {
  await requireAdmin();
  const parsed = workflowInput.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: "Revisa los campos marcados", fieldErrors: z.flattenError(parsed.error).fieldErrors };
  }
  const {
    includeExisting,
    sinceDate,
    untilDate,
    minSizeMb,
    maxSizeMb,
    minDurationMin,
    maxDurationMin,
    nameInclude,
    nameExclude,
    skipDuplicates,
    ...rest
  } = parsed.data;
  const filters = filtersFromForm(
    { includeExisting, sinceDate, untilDate, minSizeMb, maxSizeMb, minDurationMin, maxDurationMin, nameInclude, nameExclude, skipDuplicates },
    getSettings().timeZone,
  );
  const values = { ...rest, ...filters };
  const db = getDb();

  const onedrive = db.select().from(accounts).where(eq(accounts.id, values.onedriveAccountId)).get();
  const youtube = db.select().from(accounts).where(eq(accounts.id, values.youtubeAccountId)).get();
  if (onedrive?.provider !== "microsoft" || youtube?.provider !== "google") {
    return { error: "Las cuentas seleccionadas no son válidas" };
  }

  if (workflowId) {
    const previous = db.select().from(workflows).where(eq(workflows.id, workflowId)).get();
    db.update(workflows).set(values).where(eq(workflows.id, workflowId)).run();
    if (previous && filtersChanged(previous, filters)) {
      const { restored, skipped } = reapplyVideoScope(workflowId);
      if (restored || skipped) {
        logEvent({ workflowId }, `Cambiaron los filtros: ${restored} video(s) recuperado(s) y ${skipped} excluido(s)`);
      }
    }
  } else {
    db.insert(workflows).values(values).run();
  }
  redirect("/workflows");
}

function filtersChanged(previous: FilterSettings, next: FilterSettings): boolean {
  return (Object.keys(next) as (keyof FilterSettings)[]).some((key) => {
    const a = previous[key];
    const b = next[key];
    return a instanceof Date || b instanceof Date ? (a as Date | null)?.getTime() !== (b as Date | null)?.getTime() : a !== b;
  });
}

export async function deleteWorkflow(workflowId: number): Promise<ActionResult> {
  await requireAdmin();
  getDb().delete(workflows).where(eq(workflows.id, workflowId)).run();
  refresh();
  return { ok: true, message: "Workflow eliminado" };
}

export async function setWorkflowEnabled(workflowId: number, enabled: boolean): Promise<ActionResult> {
  await requireAdmin();
  getDb().update(workflows).set({ enabled }).where(eq(workflows.id, workflowId)).run();
  refresh();
  return { ok: true, message: enabled ? "Workflow activado" : "Workflow en pausa" };
}

export async function scanWorkflowNow(workflowId: number): Promise<ActionResult> {
  await requireAdmin();
  scanNow(workflowId);
  return { ok: true, message: "Revisión en cola; el worker la hará en unos segundos" };
}

export type FolderListing = {
  driveId: string;
  folder: { id: string; name: string; path: string; parentId: string | null };
  folders: { id: string; name: string; childCount: number }[];
  videoCount: number;
};

/** Folder browser for the OneDrive picker. `folderId` null means the drive root. */
export async function browseFolders(
  accountId: number,
  driveId: string | null,
  folderId: string | null,
): Promise<ActionResult<FolderListing>> {
  await requireAdmin();
  try {
    const drive = driveId ?? (await getDefaultDriveId(accountId));
    const id = folderId ?? "root";
    const [folder, children] = await Promise.all([getItem(accountId, drive, id), listChildren(accountId, drive, id)]);
    const isRoot = !folder.parentReference?.id || id === "root";
    return {
      ok: true,
      data: {
        driveId: drive,
        folder: {
          id: folder.id,
          name: isRoot ? "OneDrive" : folder.name,
          path: isRoot ? "/" : itemPath(folder),
          parentId: isRoot ? null : (folder.parentReference?.id ?? null),
        },
        folders: children
          .filter((c) => c.folder)
          .map((c) => ({ id: c.id, name: c.name, childCount: c.folder?.childCount ?? 0 }))
          .sort((a, b) => a.name.localeCompare(b.name, "es")),
        videoCount: children.filter(isVideoItem).length,
      },
    };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export type YoutubeOptions = {
  categories: { id: string; title: string }[];
  playlists: { id: string; title: string }[];
};

export async function loadYoutubeOptions(accountId: number): Promise<ActionResult<YoutubeOptions>> {
  await requireAdmin();
  try {
    const [categories, playlists] = await Promise.all([
      listCategories(accountId, getSettings().regionCode),
      listPlaylists(accountId),
    ]);
    return { ok: true, data: { categories, playlists } };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}
