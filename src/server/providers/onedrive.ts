import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { PermanentError, RetryableError, errorMessage, retryAfterMs } from "../errors";
import { authedFetch } from "./authed-fetch";

const GRAPH = "https://graph.microsoft.com/v1.0";

export type DriveItem = {
  id: string;
  name: string;
  size?: number;
  eTag?: string;
  createdDateTime: string;
  lastModifiedDateTime: string;
  file?: { mimeType?: string; hashes?: { quickXorHash?: string; sha1Hash?: string; sha256Hash?: string } };
  folder?: { childCount: number };
  video?: { duration?: number };
  fileSystemInfo?: { createdDateTime?: string; lastModifiedDateTime?: string };
  parentReference?: { driveId?: string; id?: string; path?: string };
};

const ITEM_FIELDS =
  "id,name,size,eTag,createdDateTime,lastModifiedDateTime,file,folder,video,fileSystemInfo,parentReference";

const VIDEO_EXTENSIONS = new Set([
  "mp4", "mov", "m4v", "avi", "wmv", "mkv", "webm", "flv", "3gp", "3g2", "mpg", "mpeg", "mts", "m2ts", "ts", "ogv",
]);

/** Hash that identifies the file content (for duplicate detection). */
export function contentHashOf(item: DriveItem): string | null {
  const hashes = item.file?.hashes;
  return hashes?.quickXorHash ?? hashes?.sha1Hash ?? hashes?.sha256Hash ?? null;
}

export function isVideoItem(item: DriveItem): boolean {
  if (!item.file) return false;
  if (item.file.mimeType?.startsWith("video/")) return true;
  const ext = item.name.split(".").pop()?.toLowerCase();
  return ext ? VIDEO_EXTENSIONS.has(ext) : false;
}

/** `/drive/root:/Videos/2026` → `/Videos/2026`. */
export function parentPathOf(item: DriveItem): string {
  const raw = item.parentReference?.path;
  if (!raw) return "/";
  const idx = raw.indexOf("root:");
  const path = decodeURIComponent(idx >= 0 ? raw.slice(idx + 5) : raw);
  return path || "/";
}

export function itemPath(item: DriveItem): string {
  if (!item.parentReference?.path) return "/";
  const parent = parentPathOf(item);
  return parent === "/" ? `/${item.name}` : `${parent}/${item.name}`;
}

async function graphError(res: Response, what: string): Promise<Error> {
  let detail = res.statusText;
  try {
    const json = (await res.json()) as { error?: { code?: string; message?: string } };
    detail = json.error?.message ?? json.error?.code ?? detail;
  } catch {
    // Body wasn't JSON; keep the status text.
  }
  const message = `OneDrive (${what}): ${res.status} ${detail}`;
  if (res.status === 404) return new PermanentError(`No se encontró en OneDrive (${what})`);
  if (res.status === 429 || res.status >= 500) return new RetryableError(message, retryAfterMs(res));
  return new PermanentError(message);
}

async function graphJson<T>(accountId: number, pathOrUrl: string, what: string, init: RequestInit = {}): Promise<T> {
  const url = pathOrUrl.startsWith("https://") ? pathOrUrl : `${GRAPH}${pathOrUrl}`;
  const res = await authedFetch(accountId, url, init);
  if (!res.ok) throw await graphError(res, what);
  return (await res.json()) as T;
}

export async function fetchMicrosoftProfile(accessToken: string) {
  const res = await fetch(`${GRAPH}/me?$select=id,displayName,mail,userPrincipalName`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`No se pudo leer el perfil de Microsoft: ${res.status}`);
  const me = (await res.json()) as { id: string; displayName?: string; mail?: string; userPrincipalName?: string };
  const email = me.mail ?? me.userPrincipalName ?? null;
  return { id: me.id, displayName: me.displayName || email || "Cuenta de Microsoft", email };
}

export async function getDefaultDriveId(accountId: number): Promise<string> {
  const drive = await graphJson<{ id: string }>(accountId, "/me/drive?$select=id", "unidad");
  return drive.id;
}

export function getItem(accountId: number, driveId: string, itemId: string): Promise<DriveItem> {
  const path = itemId === "root" ? `/drives/${driveId}/root` : `/drives/${driveId}/items/${itemId}`;
  return graphJson<DriveItem>(accountId, `${path}?$select=${ITEM_FIELDS}`, "elemento");
}

export async function listChildren(accountId: number, driveId: string, itemId: string): Promise<DriveItem[]> {
  const base = itemId === "root" ? `/drives/${driveId}/root` : `/drives/${driveId}/items/${itemId}`;
  let next: string | undefined = `${base}/children?$top=200&$select=${ITEM_FIELDS}`;
  const items: DriveItem[] = [];
  while (next) {
    const page: { value: DriveItem[]; "@odata.nextLink"?: string } = await graphJson(accountId, next, "listar carpeta");
    items.push(...page.value);
    next = page["@odata.nextLink"];
  }
  return items;
}

/** Lists files under a folder, optionally walking subfolders. */
export async function listFiles(
  accountId: number,
  driveId: string,
  folderId: string,
  recursive: boolean,
): Promise<DriveItem[]> {
  const files: DriveItem[] = [];
  const pending = [folderId];
  while (pending.length > 0) {
    const children = await listChildren(accountId, driveId, pending.shift()!);
    for (const child of children) {
      if (child.folder && recursive) pending.push(child.id);
      else if (child.file) files.push(child);
    }
  }
  return files;
}

export async function fetchThumbnail(accountId: number, driveId: string, itemId: string): Promise<Response> {
  return authedFetch(accountId, `${GRAPH}/drives/${driveId}/items/${itemId}/thumbnails/0/medium/content`);
}

export async function moveItem(accountId: number, driveId: string, itemId: string, folderId: string): Promise<void> {
  await graphJson(accountId, `/drives/${driveId}/items/${itemId}`, "mover archivo", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parentReference: { id: folderId }, "@microsoft.graph.conflictBehavior": "rename" }),
  });
}

/**
 * Short-lived pre-authenticated URL of the file's content (about an hour).
 * Graph answers with a 302; we follow it ourselves so the bearer token isn't
 * forwarded to the storage host. Also usable directly by ffmpeg.
 */
export async function getDownloadUrl(accountId: number, driveId: string, itemId: string, signal?: AbortSignal): Promise<string> {
  const redirect = await authedFetch(accountId, `${GRAPH}/drives/${driveId}/items/${itemId}/content`, {
    redirect: "manual",
    signal,
  });
  const location = redirect.headers.get("location");
  if (!location) {
    if (!redirect.ok) throw await graphError(redirect, "descargar");
    throw new RetryableError("OneDrive no devolvió la URL de descarga");
  }
  return location;
}

/**
 * Downloads an item into `destPath`, resuming from `offset` when the server
 * honours the Range header. Returns the final size on disk.
 */
export async function downloadItem(
  accountId: number,
  driveId: string,
  itemId: string,
  destPath: string,
  options: { offset: number; signal?: AbortSignal; onProgress?: (bytesOnDisk: number) => void },
): Promise<number> {
  const location = await getDownloadUrl(accountId, driveId, itemId, options.signal);
  let offset = options.offset;
  let res: Response;
  try {
    res = await fetch(location, {
      headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new RetryableError(`Error de red al descargar: ${errorMessage(error)}`);
  }

  if (res.status === 416) return offset; // Already complete.
  if (res.status === 200) offset = 0; // Range ignored: start over.
  else if (res.status !== 206) {
    throw res.status === 404
      ? new PermanentError("El archivo ya no existe en OneDrive")
      : new RetryableError(`Descarga falló: ${res.status} ${res.statusText}`, retryAfterMs(res));
  }
  if (!res.body) throw new RetryableError("Descarga sin contenido");

  let written = offset;
  const progress = new Transform({
    transform(chunk: Buffer, _enc, done) {
      written += chunk.length;
      options.onProgress?.(written);
      done(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(res.body as WebReadableStream<Uint8Array>),
      progress,
      createWriteStream(destPath, { flags: offset > 0 ? "a" : "w" }),
      { signal: options.signal },
    );
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new RetryableError(`Descarga interrumpida en ${written} bytes: ${errorMessage(error)}`);
  }
  return written;
}
