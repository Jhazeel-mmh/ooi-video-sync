import { Suspense } from "react";
import { PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { env } from "@/server/env";
import { PROVIDER_LABELS, resolveProvider } from "@/server/naming/ai";
import { requireAdmin } from "@/server/session";
import { getSettings } from "@/server/settings";
import { SettingsForm } from "./settings-form";

export default function SettingsPage() {
  return (
    <>
      <PageHeader title="Ajustes" />
      <Suspense fallback={<Skeleton className="h-96 w-full" />}>
        <Settings />
      </Suspense>
    </>
  );
}

async function Settings() {
  await requireAdmin();
  const settings = getSettings();
  const provider = resolveProvider(settings);
  const ai = {
    hasClaudeKey: Boolean(env().ANTHROPIC_API_KEY),
    hasGeminiKey: Boolean(env().GEMINI_API_KEY),
    activeProvider: provider ? PROVIDER_LABELS[provider] : null,
  };
  return <SettingsForm initial={settings} timeZones={Intl.supportedValuesOf("timeZone")} ai={ai} />;
}
