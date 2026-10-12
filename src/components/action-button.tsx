"use client";

import { useTransition, type ComponentProps, type ReactNode } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/lib/action-result";

type Props = Omit<ComponentProps<typeof Button>, "onClick"> & {
  action: () => Promise<ActionResult<unknown>>;
  /** When set, asks for confirmation first. */
  confirm?: { title: string; description?: ReactNode; confirmLabel?: string };
  pendingLabel?: string;
};

/** Runs a server action and reports the result with a toast. */
export function ActionButton({ action, confirm, pendingLabel, children, disabled, ...props }: Props) {
  const [pending, startTransition] = useTransition();

  const run = () =>
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        if (result.message) toast.success(result.message);
      } else {
        toast.error(result.error);
      }
    });

  const button = (
    <Button {...props} disabled={disabled || pending} onClick={confirm ? undefined : run}>
      {pending && pendingLabel ? pendingLabel : children}
    </Button>
  );

  if (!confirm) return button;
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{button}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{confirm.title}</AlertDialogTitle>
          {confirm.description && <AlertDialogDescription>{confirm.description}</AlertDialogDescription>}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction onClick={run}>{confirm.confirmLabel ?? "Confirmar"}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
