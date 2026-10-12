import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { getDb } from "@/server/db/client";
import { workflows } from "@/server/db/schema";
import { requireAdmin } from "@/server/session";
import { workflowFormProps } from "../form-props";
import { WorkflowForm } from "../workflow-form";

export default function EditWorkflowPage({ params }: PageProps<"/workflows/[id]">) {
  return (
    <>
      <PageHeader title="Editar workflow" />
      <Suspense fallback={<Skeleton className="h-96 w-full" />}>
        <EditWorkflow params={params} />
      </Suspense>
    </>
  );
}

async function EditWorkflow({ params }: { params: PageProps<"/workflows/[id]">["params"] }) {
  await requireAdmin();
  const { id } = await params;
  const workflow = getDb()
    .select()
    .from(workflows)
    .where(eq(workflows.id, Number(id)))
    .get();
  if (!workflow) notFound();

  const { id: workflowId, createdAt: _c, updatedAt: _u, lastScannedAt: _l, lastScanError: _e, ...initial } = workflow;
  return <WorkflowForm workflowId={workflowId} initial={initial} {...workflowFormProps()} />;
}
