"use client";

import { ChevronLeft, Folder, FolderOpen, Loader2 } from "lucide-react";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { browseFolders, type FolderListing } from "./actions";

export type PickedFolder = { driveId: string; folderId: string; folderPath: string };

export function FolderPicker({
  accountId,
  value,
  onChange,
  disabled,
}: {
  accountId: number | null;
  value: PickedFolder | null;
  onChange: (folder: PickedFolder) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const load = (driveId: string | null, folderId: string | null) => {
    if (!accountId) return;
    setError(null);
    startTransition(async () => {
      const result = await browseFolders(accountId, driveId, folderId);
      if (result.ok && result.data) setListing(result.data);
      else if (!result.ok) setError(result.error);
    });
  };

  const openPicker = () => {
    setOpen(true);
    setListing(null);
    load(value?.driveId ?? null, value?.folderId ?? null);
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" onClick={openPicker} disabled={disabled || !accountId}>
          <FolderOpen className="size-4" />
          {value ? "Cambiar carpeta" : "Elegir carpeta"}
        </Button>
        <span className="truncate text-sm text-muted-foreground">{value?.folderPath ?? "Ninguna carpeta elegida"}</span>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Elegir carpeta de OneDrive</DialogTitle>
            <DialogDescription className="truncate">{listing?.folder.path ?? "Cargando…"}</DialogDescription>
          </DialogHeader>
          <div className="h-80 overflow-y-auto rounded-md border">
            {error && <p className="p-3 text-sm text-destructive">{error}</p>}
            {pending && !listing && (
              <div className="flex h-full items-center justify-center">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            )}
            {listing && (
              <ul className={pending ? "opacity-50" : undefined}>
                {listing.folder.parentId && (
                  <li>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
                      onClick={() => load(listing.driveId, listing.folder.parentId)}
                    >
                      <ChevronLeft className="size-4" /> Subir un nivel
                    </button>
                  </li>
                )}
                {listing.folders.map((folder) => (
                  <li key={folder.id}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
                      onClick={() => load(listing.driveId, folder.id)}
                    >
                      <Folder className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{folder.name}</span>
                      <span className="ml-auto text-xs text-muted-foreground">{folder.childCount}</span>
                    </button>
                  </li>
                ))}
                {listing.folders.length === 0 && (
                  <li className="px-3 py-2 text-sm text-muted-foreground">Sin subcarpetas.</li>
                )}
              </ul>
            )}
          </div>
          <DialogFooter className="items-center sm:justify-between">
            <span className="text-sm text-muted-foreground">
              {listing ? `${listing.videoCount} video(s) en esta carpeta` : ""}
            </span>
            <Button
              type="button"
              disabled={!listing || pending}
              onClick={() => {
                if (!listing) return;
                onChange({ driveId: listing.driveId, folderId: listing.folder.id, folderPath: listing.folder.path });
                setOpen(false);
              }}
            >
              Usar esta carpeta
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
