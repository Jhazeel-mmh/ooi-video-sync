import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NavLinks } from "@/components/nav-links";
import { logout } from "../login/actions";

export default function DashboardLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="flex items-center justify-between gap-4 border-b p-3 md:w-56 md:flex-col md:items-stretch md:justify-start md:border-r md:border-b-0 md:p-4">
        <div className="px-3 text-sm font-semibold md:py-2">OOI Video Sync</div>
        <NavLinks />
        <form action={logout} className="md:mt-auto">
          <Button type="submit" variant="ghost" size="sm" className="w-full justify-start text-muted-foreground">
            <LogOut className="size-4" />
            <span className="hidden sm:inline">Salir</span>
          </Button>
        </form>
      </aside>
      <main className="min-w-0 flex-1 p-4 md:p-8">{children}</main>
    </div>
  );
}
