"use client";

import { useState, useTransition, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Settings } from "@/server/settings";
import { saveSettings } from "./actions";

const PROVIDER_LABELS: Record<Settings["aiProvider"], string> = {
  auto: "Automático: Claude si hay API key, si no Gemini",
  claude: "Siempre Claude",
  gemini: "Siempre Gemini",
};

const CLAUDE_LABELS: Record<Settings["aiModel"], string> = {
  "claude-opus-5-5": "Claude Opus 5.5 (mejor calidad)",
  "claude-sonnet-5-5": "Claude Sonnet 5.5 (equilibrado)",
  "claude-haiku-5-5": "Claude Haiku 5.5 (más económico)",
};

const GEMINI_LABELS: Record<Settings["geminiModel"], string> = {
  "gemini-3.8-flash": "Gemini 3.8 Flash (gratis, mejor calidad)",
  "gemini-3.5-flash-lite": "Gemini 3.5 Flash-Lite (gratis, más rápido)",
};

export type AiStatus = { hasClaudeKey: boolean; hasGeminiKey: boolean; activeProvider: string | null };

export function SettingsForm({ initial, timeZones, ai }: { initial: Settings; timeZones: string[]; ai: AiStatus }) {
  const [provider, setProvider] = useState(initial.aiProvider);
  const [model, setModel] = useState(initial.aiModel);
  const [geminiModel, setGeminiModel] = useState(initial.geminiModel);
  const [pending, startTransition] = useTransition();

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(async () => {
      const result = await saveSettings(formData);
      if (result.ok) toast.success(result.message);
      else toast.error(result.error);
    });
  };

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <input type="hidden" name="aiProvider" value={provider} />
      <input type="hidden" name="aiModel" value={model} />
      <input type="hidden" name="geminiModel" value={geminiModel} />
      <Card>
        <CardHeader>
          <CardTitle>Cuota de YouTube</CardTitle>
          <CardDescription>
            Revisa los valores reales en Google Cloud Console → APIs → YouTube Data API v3 → Cuotas. La cuota se
            reinicia a medianoche, hora del Pacífico.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <NumberField name="dailyQuotaUnits" label="Cuota diaria (unidades)" defaultValue={initial.dailyQuotaUnits} />
          <NumberField name="uploadCostUnits" label="Costo por subida (unidades)" defaultValue={initial.uploadCostUnits} />
          <NumberField
            name="maxUploadsPerDay"
            label="Máximo de subidas por día"
            defaultValue={initial.maxUploadsPerDay}
            hint="0 = solo limitado por la cuota."
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Worker</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <NumberField
            name="maxParallelTransfers"
            label="Transferencias simultáneas"
            defaultValue={initial.maxParallelTransfers}
            min={1}
            max={4}
            hint="Cada transferencia usa disco temporal del tamaño del video."
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Inteligencia artificial</CardTitle>
          <CardDescription>
            Claude: {ai.hasClaudeKey ? "configurado" : "falta ANTHROPIC_API_KEY"} · Gemini:{" "}
            {ai.hasGeminiKey ? "configurado" : "falta GEMINI_API_KEY"} · En uso:{" "}
            <span className="font-medium text-foreground">{ai.activeProvider ?? "ninguno (solo plantillas)"}</span>.
            La capa gratuita de Gemini es gratis, pero Google usa lo que le envías para mejorar sus productos.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <OptionSelect label="Proveedor para títulos" value={provider} options={PROVIDER_LABELS} onChange={setProvider} />
          <OptionSelect label="Modelo de Claude" value={model} options={CLAUDE_LABELS} onChange={setModel} />
          <OptionSelect label="Modelo de Gemini" value={geminiModel} options={GEMINI_LABELS} onChange={setGeminiModel} />
          <NumberField
            name="transcriptMaxMinutes"
            label="Minutos de audio a transcribir"
            defaultValue={initial.transcriptMaxMinutes}
            hint="0 = todo el video. Se transcribe con Gemini en tramos de 30 minutos."
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Nombrado</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <Field label="Zona horaria" htmlFor="timeZone" hint="Para las fechas de {date} y la programación.">
            <Input id="timeZone" name="timeZone" list="time-zones" defaultValue={initial.timeZone} />
            <datalist id="time-zones">
              {timeZones.map((tz) => (
                <option key={tz} value={tz} />
              ))}
            </datalist>
          </Field>
          <Field label="País para categorías" htmlFor="regionCode" hint="Código de 2 letras, p. ej. MX, US, ES.">
            <Input id="regionCode" name="regionCode" defaultValue={initial.regionCode} maxLength={2} />
          </Field>
        </CardContent>
      </Card>

      <Button type="submit" disabled={pending}>
        {pending ? "Guardando…" : "Guardar ajustes"}
      </Button>
    </form>
  );
}

function OptionSelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Record<T, string>;
  onChange: (value: T) => void;
}) {
  return (
    <Field label={label}>
      <Select value={value} onValueChange={(v) => onChange(v as T)}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.entries(options) as [T, string][]).map(([key, text]) => (
            <SelectItem key={key} value={key}>
              {text}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor?: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function NumberField({
  name,
  label,
  defaultValue,
  hint,
  min = 0,
  max,
}: {
  name: string;
  label: string;
  defaultValue: number;
  hint?: string;
  min?: number;
  max?: number;
}) {
  return (
    <Field label={label} htmlFor={name} hint={hint}>
      <Input id={name} name={name} type="number" min={min} max={max} defaultValue={defaultValue} />
    </Field>
  );
}
