import { Suspense } from "react";
import { PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { requireAdmin } from "@/server/session";

export default function HomePage() {
  return (
    <>
      <PageHeader title="Inicio" description="Resumen de la sincronización de OneDrive a YouTube." />
      <Suspense fallback={<Skeleton className="h-32 w-full" />}>
        <Overview />
      </Suspense>
    </>
  );
}

async function Overview() {
  await requireAdmin();
  return <p className="text-sm text-muted-foreground">Todavía no hay actividad.</p>;
}
