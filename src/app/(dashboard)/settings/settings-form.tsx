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

const MODEL_LABELS: Record<Settings["aiModel"], string> = {
  "claude-opus-5-5": "Claude Opus 5.5 (mejor calidad)",
  "claude-sonnet-5-5": "Claude Sonnet 5.5 (equilibrado)",
  "claude-haiku-5-5": "Claude Haiku 5.5 (más económico)",
};

export function SettingsForm({ initial, timeZones }: { initial: Settings; timeZones: string[] }) {
  const [model, setModel] = useState(initial.aiModel);
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
      <input type="hidden" name="aiModel" value={model} />
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
          <CardTitle>Nombrado</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <Field label="Modelo de IA">
            <Select value={model} onValueChange={(v) => setModel(v as Settings["aiModel"])}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(MODEL_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
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
