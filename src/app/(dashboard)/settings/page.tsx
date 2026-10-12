import { Suspense } from "react";
import { PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";
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
  return <SettingsForm initial={getSettings()} timeZones={Intl.supportedValuesOf("timeZone")} />;
}
