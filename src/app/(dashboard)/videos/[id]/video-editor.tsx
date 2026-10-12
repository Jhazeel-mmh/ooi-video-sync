"use client";

import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";
import { Sparkles } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { PrivacyStatus, VideoStatus } from "@/server/db/schema";
import {
  DESCRIPTION_MAX_BYTES,
  parseTags,
  TAGS_MAX_CHARS,
  tagsLength,
  TITLE_MAX_CHARS,
  utf8Length,
} from "@/server/naming/sanitize";
import { saveVideo, suggestMetadata } from "../actions";

export type EditableVideo = {
  id: number;
  status: VideoStatus;
  uploaded: boolean;
  title: string;
  description: string;
  tags: string[];
  privacyStatus: PrivacyStatus;
  publishAt: string | null;
};

const LOCAL_FORMAT = "yyyy-MM-dd'T'HH:mm";

function toLocalInput(iso: string | null, timeZone: string): string {
  return iso ? format(new TZDate(new Date(iso).getTime(), timeZone), LOCAL_FORMAT) : "";
}

function fromLocalInput(value: string, timeZone: string): string {
  if (!value) return "";
  const [date, time] = value.split("T");
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  return new TZDate(y, m - 1, d, hh, mm, 0, timeZone).toISOString();
}

export function VideoEditor({
  video,
  aiAvailable,
  timeZone,
}: {
  video: EditableVideo;
  aiAvailable: boolean;
  timeZone: string;
}) {
  const [title, setTitle] = useState(video.title);
  const [description, setDescription] = useState(video.description);
  const [tags, setTags] = useState(video.tags.join(", "));
  const [privacy, setPrivacy] = useState<PrivacyStatus>(video.privacyStatus);
  const [publishAt, setPublishAt] = useState(toLocalInput(video.publishAt, timeZone));
  const [pending, startTransition] = useTransition();

  const canApprove = !video.uploaded && (video.status === "pending_review" || video.status === "failed");
  const titleLength = Array.from(title.trim()).length;
  const descriptionBytes = utf8Length(description.trim());
  const tagsChars = tagsLength(parseTags(tags));

  const save = (approve: boolean) =>
    startTransition(async () => {
      const result = await saveVideo(
        video.id,
        { title, description, tags, privacyStatus: privacy, publishAt: fromLocalInput(publishAt, timeZone) },
        { approve },
      );
      if (result.ok) toast.success(result.message);
      else toast.error(result.error);
    });

  const suggest = (useAi: boolean) =>
    startTransition(async () => {
      const result = await suggestMetadata(video.id, useAi);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      if (result.data) {
        setTitle(result.data.title);
        setDescription(result.data.description);
        setTags(result.data.tags.join(", "));
      }
      toast.info(result.message);
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Datos para YouTube</CardTitle>
        <CardDescription>
          {video.uploaded
            ? "El video ya está en YouTube: al guardar se actualiza allí también."
            : "Se usarán al subir el video."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <div className="flex justify-between">
            <Label htmlFor="title">Título</Label>
            <Counter value={titleLength} max={TITLE_MAX_CHARS} />
          </div>
          <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="space-y-2">
          <div className="flex justify-between">
            <Label htmlFor="description">Descripción</Label>
            <Counter value={descriptionBytes} max={DESCRIPTION_MAX_BYTES} unit="bytes" />
          </div>
          <Textarea id="description" rows={8} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="space-y-2">
          <div className="flex justify-between">
            <Label htmlFor="tags">Etiquetas (separadas por coma)</Label>
            <Counter value={tagsChars} max={TAGS_MAX_CHARS} />
          </div>
          <Input id="tags" value={tags} onChange={(e) => setTags(e.target.value)} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Privacidad</Label>
            <Select value={privacy} onValueChange={(v) => setPrivacy(v as PrivacyStatus)} disabled={Boolean(publishAt)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="private">Privado</SelectItem>
                <SelectItem value="unlisted">No listado</SelectItem>
                <SelectItem value="public">Público</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="publishAt">Programar publicación ({timeZone})</Label>
            <Input id="publishAt" type="datetime-local" value={publishAt} onChange={(e) => setPublishAt(e.target.value)} />
            <p className="text-xs text-muted-foreground">
              Opcional. El video queda privado y YouTube lo hace público a esa hora.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 pt-2">
          {canApprove && (
            <Button onClick={() => save(true)} disabled={pending}>
              Aprobar y subir
            </Button>
          )}
          <Button variant={canApprove ? "outline" : "default"} onClick={() => save(false)} disabled={pending}>
            {video.uploaded ? "Guardar y actualizar en YouTube" : "Guardar"}
          </Button>
          <Button variant="ghost" onClick={() => suggest(false)} disabled={pending}>
            Usar plantilla
          </Button>
          {aiAvailable && (
            <Button variant="ghost" onClick={() => suggest(true)} disabled={pending}>
              <Sparkles className="size-4" /> Proponer con IA
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function Counter({ value, max, unit = "caracteres" }: { value: number; max: number; unit?: string }) {
  return (
    <span className={cn("text-xs tabular-nums", value > max ? "text-destructive" : "text-muted-foreground")}>
      {value}/{max} {unit}
    </span>
  );
}
