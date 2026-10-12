import { Suspense } from "react";
import { PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { requireAdmin } from "@/server/session";
import { DEFAULT_WORKFLOW_VALUES, workflowFormProps } from "../form-props";
import { WorkflowForm } from "../workflow-form";

export default function NewWorkflowPage() {
  return (
    <>
      <PageHeader title="Nuevo workflow" description="Conecta una carpeta de OneDrive con un canal de YouTube." />
      <Suspense fallback={<Skeleton className="h-96 w-full" />}>
        <NewWorkflow />
      </Suspense>
    </>
  );
}

async function NewWorkflow() {
  await requireAdmin();
  const props = workflowFormProps();
  const initial = {
    ...DEFAULT_WORKFLOW_VALUES,
    onedriveAccountId: props.onedriveAccounts.length === 1 ? props.onedriveAccounts[0].id : null,
    youtubeAccountId: props.youtubeAccounts.length === 1 ? props.youtubeAccounts[0].id : null,
  };
  return <WorkflowForm workflowId={null} initial={initial} {...props} />;
}
