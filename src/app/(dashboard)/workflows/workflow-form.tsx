"use client";

import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { PrivacyStatus } from "@/server/db/schema";
import { parseTags, sanitizeDescription, sanitizeTags, sanitizeTitle } from "@/server/naming/sanitize";
import { dateFromFilename, renderTemplate, TEMPLATE_VARIABLES } from "@/server/naming/template";
import { loadYoutubeOptions, saveWorkflow, type WorkflowFormState, type YoutubeOptions } from "./actions";
import { FolderPicker, type PickedFolder } from "./folder-picker";

export type AccountOption = { id: number; name: string; needsReauth: boolean };

export type WorkflowFormValues = {
  name: string;
  enabled: boolean;
  onedriveAccountId: number | null;
  driveId: string;
  folderId: string;
  folderPath: string;
  recursive: boolean;
  includeExisting: boolean;
  youtubeAccountId: number | null;
  mode: "auto" | "review";
  titleTemplate: string;
  descriptionTemplate: string;
  tagsTemplate: string;
  useAi: boolean;
  aiContext: string;
  privacyStatus: PrivacyStatus;
  categoryId: string;
  playlistId: string | null;
  playlistTitle: string | null;
  madeForKids: boolean;
  postUploadAction: "none" | "move";
  postUploadFolderId: string | null;
  postUploadFolderPath: string | null;
  pollIntervalMin: number;
  stableMinutes: number;
  counter: number;
};

const PRIVACY_LABELS: Record<PrivacyStatus, string> = {
  private: "Privado",
  unlisted: "No listado",
  public: "Público",
};

export function WorkflowForm({
  workflowId,
  initial,
  onedriveAccounts,
  youtubeAccounts,
  aiAvailable,
  timeZone,
}: {
  workflowId: number | null;
  initial: WorkflowFormValues;
  onedriveAccounts: AccountOption[];
  youtubeAccounts: AccountOption[];
  aiAvailable: boolean;
  timeZone: string;
}) {
  const [values, setValues] = useState(initial);
  const [state, setState] = useState<WorkflowFormState>({});
  const [pending, startTransition] = useTransition();
  const [sampleName, setSampleName] = useState("VID_20260512_101500.mp4");
  const [ytOptions, setYtOptions] = useState<YoutubeOptions | null>(null);
  const [ytError, setYtError] = useState<string | null>(null);
  const [ytLoading, startYtTransition] = useTransition();

  const set = <K extends keyof WorkflowFormValues>(key: K, value: WorkflowFormValues[K]) =>
    setValues((v) => ({ ...v, [key]: value }));

  useEffect(() => {
    const accountId = values.youtubeAccountId;
    if (!accountId) return;
    startYtTransition(async () => {
      const result = await loadYoutubeOptions(accountId);
      if (result.ok && result.data) {
        setYtOptions(result.data);
        setYtError(null);
      } else if (!result.ok) {
        setYtOptions(null);
        setYtError(result.error);
      }
    });
  }, [values.youtubeAccountId]);

  const preview = useMemo(() => {
    const vars = {
      originalName: sampleName || "video.mp4",
      folderPath: values.folderPath || "/Videos",
      date: dateFromFilename(sampleName, timeZone) ?? new Date(),
      sequence: values.counter + 1,
      durationMs: 3_725_000,
    };
    return {
      title: sanitizeTitle(renderTemplate(values.titleTemplate, vars, timeZone)),
      description: sanitizeDescription(renderTemplate(values.descriptionTemplate, vars, timeZone)),
      tags: sanitizeTags(parseTags(renderTemplate(values.tagsTemplate, vars, timeZone))),
    };
  }, [sampleName, values.folderPath, values.counter, values.titleTemplate, values.descriptionTemplate, values.tagsTemplate, timeZone]);

  const folder: PickedFolder | null = values.folderId
    ? { driveId: values.driveId, folderId: values.folderId, folderPath: values.folderPath }
    : null;
  const postFolder: PickedFolder | null = values.postUploadFolderId
    ? { driveId: values.driveId, folderId: values.postUploadFolderId, folderPath: values.postUploadFolderPath ?? "" }
    : null;

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(async () => {
      // On success the action redirects; we only get here on validation errors.
      const result = await saveWorkflow(workflowId, formData);
      setState(result ?? {});
    });
  };

  const errors = state.fieldErrors ?? {};
  const playlists = ytOptions?.playlists ?? (values.playlistId ? [{ id: values.playlistId, title: values.playlistTitle ?? values.playlistId }] : []);
  const categories = ytOptions?.categories ?? [{ id: values.categoryId, title: `Categoría ${values.categoryId}` }];

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      {/* Controlled widgets (Radix Select/Switch, pickers) are submitted through hidden inputs. */}
      {(
        [
          "onedriveAccountId",
          "driveId",
          "folderId",
          "folderPath",
          "youtubeAccountId",
          "mode",
          "privacyStatus",
          "categoryId",
          "playlistId",
          "playlistTitle",
          "postUploadAction",
          "postUploadFolderId",
          "postUploadFolderPath",
          "enabled",
          "recursive",
          "includeExisting",
          "madeForKids",
          "useAi",
        ] as const
      ).map((key) => (
        <input key={key} type="hidden" name={key} value={String(values[key] ?? "")} />
      ))}

      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>General</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field label="Nombre" htmlFor="name" errors={errors.name}>
            <Input id="name" name="name" value={values.name} onChange={(e) => set("name", e.target.value)} required />
          </Field>
          <Field label="Modo" errors={errors.mode} hint="En revisión, cada video espera tu aprobación antes de subirse.">
            <Select value={values.mode} onValueChange={(v) => set("mode", v as WorkflowFormValues["mode"])}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="review">Revisión manual</SelectItem>
                <SelectItem value="auto">Automático</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <SwitchField
            label="Activo"
            checked={values.enabled}
            onChange={(v) => set("enabled", v)}
            hint="Si está en pausa no se buscan videos nuevos."
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Origen: OneDrive</CardTitle>
          <CardDescription>Carpeta que se vigila para detectar videos nuevos.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field label="Cuenta" errors={errors.onedriveAccountId}>
            <AccountSelect
              accounts={onedriveAccounts}
              value={values.onedriveAccountId}
              placeholder="Elige una cuenta"
              onChange={(id) =>
                setValues((v) => ({
                  ...v,
                  onedriveAccountId: id,
                  driveId: "",
                  folderId: "",
                  folderPath: "",
                  postUploadFolderId: null,
                  postUploadFolderPath: null,
                }))
              }
            />
          </Field>
          <Field label="Carpeta" errors={errors.folderId}>
            <FolderPicker
              accountId={values.onedriveAccountId}
              value={folder}
              onChange={(f) => setValues((v) => ({ ...v, driveId: f.driveId, folderId: f.folderId, folderPath: f.folderPath }))}
            />
          </Field>
          <SwitchField label="Incluir subcarpetas" checked={values.recursive} onChange={(v) => set("recursive", v)} />
          {workflowId === null && (
            <SwitchField
              label="Procesar los videos que ya están en la carpeta"
              checked={values.includeExisting}
              onChange={(v) => set("includeExisting", v)}
              hint="Si está apagado, solo se procesan los videos que lleguen después de crear el workflow."
            />
          )}
          <Field
            label="Revisar cada (minutos)"
            htmlFor="pollIntervalMin"
            errors={errors.pollIntervalMin}
          >
            <Input
              id="pollIntervalMin"
              name="pollIntervalMin"
              type="number"
              min={1}
              value={values.pollIntervalMin}
              onChange={(e) => set("pollIntervalMin", Number(e.target.value))}
            />
          </Field>
          <Field
            label="Esperar sin cambios (minutos)"
            htmlFor="stableMinutes"
            errors={errors.stableMinutes}
            hint="Evita subir un video que todavía se está sincronizando a OneDrive."
          >
            <Input
              id="stableMinutes"
              name="stableMinutes"
              type="number"
              min={0}
              value={values.stableMinutes}
              onChange={(e) => set("stableMinutes", Number(e.target.value))}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Destino: YouTube</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field label="Canal" errors={errors.youtubeAccountId}>
            <AccountSelect
              accounts={youtubeAccounts}
              value={values.youtubeAccountId}
              placeholder="Elige un canal"
              onChange={(id) => setValues((v) => ({ ...v, youtubeAccountId: id, playlistId: null, playlistTitle: null }))}
            />
          </Field>
          <Field label="Privacidad" errors={errors.privacyStatus}>
            <Select value={values.privacyStatus} onValueChange={(v) => set("privacyStatus", v as PrivacyStatus)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(PRIVACY_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Categoría" errors={errors.categoryId}>
            <Select value={values.categoryId} onValueChange={(v) => set("categoryId", v)} disabled={ytLoading}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {categories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Playlist" errors={errors.playlistId}>
            <Select
              value={values.playlistId ?? "none"}
              disabled={ytLoading}
              onValueChange={(v) =>
                setValues((s) => ({
                  ...s,
                  playlistId: v === "none" ? null : v,
                  playlistTitle: v === "none" ? null : (playlists.find((p) => p.id === v)?.title ?? null),
                }))
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Ninguna</SelectItem>
                {playlists.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <SwitchField
            label="Contenido para niños"
            checked={values.madeForKids}
            onChange={(v) => set("madeForKids", v)}
            hint="Declaración obligatoria de YouTube (COPPA)."
          />
          {ytLoading && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Cargando categorías y playlists…
            </p>
          )}
          {ytError && <p className="text-sm text-destructive md:col-span-2">{ytError}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Título y descripción</CardTitle>
          <CardDescription>
            Variables disponibles:{" "}
            {TEMPLATE_VARIABLES.map((v) => (
              <code key={v.token} title={v.description} className="mr-2 rounded bg-muted px-1">
                {v.token}
              </code>
            ))}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-4">
            <Field label="Plantilla de título" htmlFor="titleTemplate" errors={errors.titleTemplate}>
              <Input
                id="titleTemplate"
                name="titleTemplate"
                value={values.titleTemplate}
                onChange={(e) => set("titleTemplate", e.target.value)}
              />
            </Field>
            <Field label="Plantilla de descripción" htmlFor="descriptionTemplate" errors={errors.descriptionTemplate}>
              <Textarea
                id="descriptionTemplate"
                name="descriptionTemplate"
                rows={5}
                value={values.descriptionTemplate}
                onChange={(e) => set("descriptionTemplate", e.target.value)}
              />
            </Field>
            <Field label="Etiquetas (separadas por coma)" htmlFor="tagsTemplate" errors={errors.tagsTemplate}>
              <Input
                id="tagsTemplate"
                name="tagsTemplate"
                value={values.tagsTemplate}
                onChange={(e) => set("tagsTemplate", e.target.value)}
              />
            </Field>
            <SwitchField
              label="Generar con IA (Claude)"
              checked={values.useAi}
              onChange={(v) => set("useAi", v)}
              disabled={!aiAvailable}
              hint={
                aiAvailable
                  ? "Claude propone título, descripción y etiquetas usando la plantilla como base. Si falla, se usa la plantilla."
                  : "Define ANTHROPIC_API_KEY en .env para activar esta opción."
              }
            />
            {values.useAi && (
              <Field
                label="Contexto del canal para la IA"
                htmlFor="aiContext"
                errors={errors.aiContext}
                hint="Describe el canal, el tono, el idioma y lo que siempre debe incluir la descripción."
              >
                <Textarea
                  id="aiContext"
                  name="aiContext"
                  rows={4}
                  value={values.aiContext}
                  onChange={(e) => set("aiContext", e.target.value)}
                />
              </Field>
            )}
            {!values.useAi && <input type="hidden" name="aiContext" value={values.aiContext} />}
          </div>
          <div className="space-y-3 rounded-lg border bg-muted/40 p-4">
            <Field label="Archivo de ejemplo" htmlFor="sampleName">
              <Input id="sampleName" value={sampleName} onChange={(e) => setSampleName(e.target.value)} />
            </Field>
            <div>
              <div className="text-xs font-medium uppercase text-muted-foreground">Título</div>
              <div className="font-medium">{preview.title}</div>
            </div>
            <div>
              <div className="text-xs font-medium uppercase text-muted-foreground">Descripción</div>
              <div className="text-sm whitespace-pre-wrap">{preview.description || "—"}</div>
            </div>
            <div>
              <div className="text-xs font-medium uppercase text-muted-foreground">Etiquetas</div>
              <div className="text-sm">{preview.tags.join(", ") || "—"}</div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Después de subir</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field label="Archivo en OneDrive" errors={errors.postUploadAction}>
            <Select
              value={values.postUploadAction}
              onValueChange={(v) => set("postUploadAction", v as WorkflowFormValues["postUploadAction"])}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Dejarlo donde está</SelectItem>
                <SelectItem value="move">Moverlo a otra carpeta</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {values.postUploadAction === "move" && (
            <Field label="Mover a" errors={errors.postUploadFolderId}>
              <FolderPicker
                accountId={values.onedriveAccountId}
                value={postFolder}
                onChange={(f) => setValues((v) => ({ ...v, postUploadFolderId: f.folderId, postUploadFolderPath: f.folderPath }))}
              />
            </Field>
          )}
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Guardando…" : "Guardar workflow"}
        </Button>
        <Button asChild variant="ghost">
          <Link href="/workflows">Cancelar</Link>
        </Button>
      </div>
    </form>
  );
}

function Field({
  label,
  htmlFor,
  errors,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  errors?: string[];
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {errors?.map((e) => (
        <p key={e} className="text-sm text-destructive">
          {e}
        </p>
      ))}
    </div>
  );
}

function SwitchField({
  label,
  checked,
  onChange,
  hint,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start gap-3">
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} className="mt-0.5" aria-label={label} />
      <div className="space-y-1">
        <div className="text-sm font-medium">{label}</div>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
    </div>
  );
}

function AccountSelect({
  accounts,
  value,
  placeholder,
  onChange,
}: {
  accounts: AccountOption[];
  value: number | null;
  placeholder: string;
  onChange: (id: number) => void;
}) {
  if (accounts.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No hay cuentas.{" "}
        <Link href="/accounts" className="underline">
          Vincula una
        </Link>
        .
      </p>
    );
  }
  return (
    <Select value={value ? String(value) : undefined} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger className="w-full">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {accounts.map((a) => (
          <SelectItem key={a.id} value={String(a.id)}>
            {a.name}
            {a.needsReauth ? " (requiere reconexión)" : ""}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
